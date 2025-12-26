import http from 'http';
import https from 'https';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 8080;

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to make proxy request with retry logic
function makeProxyRequest(req, res, targetUrl, url, protocol, headers, maxRetries = 3) {
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method || 'GET',
    headers: headers,
    // Disable keep-alive to prevent socket hang up errors with Cloudflare
    agent: false
  };

  let attempt = 0;
  
  const attemptRequest = () => {
    attempt++;
    
    const proxyReq = protocol.request(options, (proxyRes) => {
      const isStreaming = targetUrl.includes('.m3u8') || targetUrl.includes('workers.dev');
      const contentType = proxyRes.headers['content-type'] || '';
      const isM3U8 = targetUrl.includes('.m3u8') || contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL');
      console.log(`[Proxy] ${req.method} ${targetUrl} -> ${proxyRes.statusCode}${isStreaming ? ' (streaming)' : ''}${isM3U8 ? ' [M3U8]' : ''}${attempt > 1 ? ` (retry ${attempt})` : ''}`);
      
      // Copy response status and headers
      res.status(proxyRes.statusCode);
      
      // Copy all response headers except those that shouldn't be forwarded
      // Note: We preserve content-encoding so the browser can decompress (zstd/gzip/deflate)
      // Also preserve Content-Range and Accept-Ranges for Range requests (206 Partial Content)
      const responseHeadersToSkip = ['connection', 'transfer-encoding'];
      Object.keys(proxyRes.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!responseHeadersToSkip.includes(lowerKey)) {
          // Preserve important headers for streaming
          if (lowerKey === 'content-range' || lowerKey === 'accept-ranges' || 
              lowerKey === 'content-length' || lowerKey === 'content-type' ||
              lowerKey === 'content-encoding') {
            res.setHeader(key, proxyRes.headers[key]);
          } else {
            res.setHeader(key, proxyRes.headers[key]);
          }
        }
      });
      
      // Handle CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization, X-Api-Key, X-Request-Timestamp, X-Request-Nonce, X-Request-Signature, X-Client-Fingerprint, X-Only-Sources, X-Server, bW90aGFmYWth');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
      
      // For m3u8 playlists, we need to rewrite relative URLs to go through the proxy
      if (isM3U8 && proxyRes.statusCode === 200) {
        console.log(`[Proxy] Processing m3u8 playlist: ${targetUrl}`);
        let chunks = [];
        let totalLength = 0;
        
        proxyRes.on('data', (chunk) => {
          chunks.push(chunk);
          totalLength += chunk.length;
        });
        
        proxyRes.on('end', () => {
          try {
            // Combine all chunks and convert to string
            const buffer = Buffer.concat(chunks, totalLength);
            let playlistContent = buffer.toString('utf8');
            
            console.log(`[Proxy] Original m3u8 content (first 500 chars):`, playlistContent.substring(0, 500));
            
            // Rewrite relative URLs in the playlist to go through the proxy
            // Pattern: lines starting with / that contain streaming domains or file paths
            // Examples: /frostveil88.live/file2/... or /foggycrest91.online/file2/...
            let rewriteCount = 0;
            playlistContent = playlistContent.replace(
              /^([^\r\n]+)$/gm,
              (match, line) => {
                const trimmed = line.trim();
                
                // Skip if it's a comment, tag, or empty line
                if (trimmed.startsWith('#') || trimmed === '') {
                  return match;
                }
                
                // Skip if it's already a proxy URL (don't double-proxy)
                if (trimmed.startsWith('/proxy-stream') || trimmed.includes('/proxy-stream?')) {
                  return match;
                }
                
                // Skip if it's already an absolute URL (http:// or https://)
                if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                  return match;
                }
                
                // Only process relative paths starting with /
                if (!trimmed.startsWith('/')) {
                  return match;
                }
                
                // Check if it's a streaming resource path
                if (trimmed.includes('frostveil88.live') || 
                    trimmed.includes('foggycrest91.online') ||
                    trimmed.includes('rainflare53.pro') ||
                    trimmed.includes('file2/') ||
                    trimmed.match(/^\/[^\/]+\.(live|online|net|com|org|pro)\//)) {
                  // Resolve relative URL to full URL and proxy it
                  const fullUrl = `https://p.10014.workers.dev${trimmed}`;
                  const proxiedUrl = `/proxy-stream?url=${encodeURIComponent(fullUrl)}`;
                  rewriteCount++;
                  if (rewriteCount <= 5) { // Only log first 5 to avoid spam
                    console.log(`[Proxy] Rewriting m3u8 URL ${rewriteCount}: ${trimmed} -> ${proxiedUrl}`);
                  }
                  return proxiedUrl;
                }
                
                // For other relative paths, resolve against the base URL
                try {
                  const baseUrl = new URL(targetUrl);
                  const resolvedUrl = new URL(trimmed, baseUrl.origin + baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf('/'))).href;
                  const proxiedUrl = `/proxy-stream?url=${encodeURIComponent(resolvedUrl)}`;
                  rewriteCount++;
                  if (rewriteCount <= 5) { // Only log first 5 to avoid spam
                    console.log(`[Proxy] Rewriting m3u8 URL ${rewriteCount}: ${trimmed} -> ${proxiedUrl}`);
                  }
                  return proxiedUrl;
                } catch {
                  // Return original if URL construction fails
                  return match;
                }
              }
            );
            
            console.log(`[Proxy] Rewrote ${rewriteCount} URLs in m3u8 playlist`);
            console.log(`[Proxy] Modified m3u8 content (first 500 chars):`, playlistContent.substring(0, 500));
            
            // Update content length
            const modifiedBuffer = Buffer.from(playlistContent, 'utf8');
            res.setHeader('Content-Length', modifiedBuffer.length);
            
            // Send modified content
            res.end(modifiedBuffer);
          } catch (error) {
            console.error('[Proxy] Error processing m3u8 playlist:', error);
            // Fallback: send original content
            res.end(Buffer.concat(chunks, totalLength));
          }
        });
        
        proxyRes.on('error', (err) => {
          console.error('[Proxy] Error reading m3u8 response:', err);
          if (!res.headersSent) {
            res.status(502).json({ error: 'Error reading playlist: ' + err.message });
          } else {
            res.destroy();
          }
        });
      } else {
        // For non-m3u8 responses, pipe directly without buffering
        // This is critical for HLS streams and Range requests
        proxyRes.pipe(res);
        
        // Handle upstream errors for non-m3u8 responses
        proxyRes.on('error', (err) => {
          if (!res.headersSent) {
            console.error('[Proxy] Upstream response error:', err.message);
            res.status(502).json({ error: 'Upstream error: ' + err.message });
          } else {
            res.destroy();
          }
        });
      }
      
      // Handle client disconnection (common with HLS as it makes many rapid requests)
      req.on('close', () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });
    });

    proxyReq.on('error', (err) => {
      const errorMessage = err.message || err.toString();
      const isSocketHangUp = errorMessage.includes('socket hang up') || 
                            errorMessage.includes('ECONNRESET') ||
                            errorMessage.includes('EPIPE');
      
      if (isSocketHangUp && attempt < maxRetries && !res.headersSent) {
        console.log(`[Proxy] Socket hang up on attempt ${attempt}, retrying... (${maxRetries - attempt} retries left)`);
        // Wait a bit before retrying (exponential backoff)
        setTimeout(() => {
          attemptRequest();
        }, Math.min(100 * Math.pow(2, attempt - 1), 1000));
        return;
      }
      
      console.error('[Proxy] Request error:', errorMessage, err.stack || '');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Proxy error: ' + errorMessage });
      }
    });
    
    // Handle client disconnection before response
    req.on('close', () => {
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    // Handle request body for POST/PUT/PATCH
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      if (typeof req.body === 'string') {
        proxyReq.write(req.body);
      } else {
        proxyReq.write(JSON.stringify(req.body));
      }
    }
    
    proxyReq.end();
  };
  
  attemptRequest();
}

// Proxy endpoint that modifies headers for streaming and API requests
app.all('/proxy-stream', async (req, res) => {
  try {
    let targetUrl;
    try {
      targetUrl = decodeURIComponent(req.query.url || '');
    } catch (decodeError) {
      console.error('[Proxy] URL decode error:', decodeError.message, 'Raw URL:', req.query.url);
      return res.status(400).json({ error: 'Failed to decode URL parameter: ' + decodeError.message });
    }
    
    if (!targetUrl || !targetUrl.startsWith('http')) {
      console.error('[Proxy] Invalid URL parameter:', req.query.url, 'Decoded:', targetUrl);
      return res.status(400).json({ error: 'Invalid or missing URL parameter' });
    }

    let url;
    try {
      url = new URL(targetUrl);
    } catch (urlError) {
      console.error('[Proxy] URL parse error:', urlError.message, 'Target URL:', targetUrl);
      return res.status(400).json({ error: 'Invalid URL format: ' + urlError.message });
    }
    
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      console.error('[Proxy] Invalid protocol:', url.protocol, 'for URL:', targetUrl);
      return res.status(400).json({ error: 'Invalid protocol: ' + url.protocol });
    }
    
    const protocol = url.protocol === 'https:' ? https : http;
    
    // Headers that should NOT be forwarded (forbidden or proxy-specific)
    const headersToSkip = [
      'host',
      'connection',
      'content-length', // Let Node.js calculate this
      'transfer-encoding',
      'upgrade',
      'proxy-connection',
      'proxy-authorization'
    ];
    
    // Copy ALL headers from the incoming request
    // Use rawHeaders to preserve original header case (important for custom headers)
    const headers = {};
    const headersToSkipLower = headersToSkip.map(h => h.toLowerCase());
    
    // Build a map of lowercase header names to their original case and values
    const headerMap = new Map();
    if (req.rawHeaders) {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const headerName = req.rawHeaders[i];
        const headerValue = req.rawHeaders[i + 1];
        const lowerName = headerName.toLowerCase();
        
        if (!headersToSkipLower.includes(lowerName)) {
          // Store with original case
          headerMap.set(lowerName, { name: headerName, value: headerValue });
        }
      }
    } else {
      // Fallback: if rawHeaders not available, use normalized headers
      Object.keys(req.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!headersToSkipLower.includes(lowerKey)) {
          headerMap.set(lowerKey, { name: key, value: req.headers[key] });
        }
      });
    }
    
    // Copy headers with original case preserved
    headerMap.forEach(({ name, value }) => {
      headers[name] = value;
    });
    
    // Debug: Log important headers being forwarded (only for API requests)
    if (targetUrl.includes('/api/')) {
      const importantHeaders = ['x-api-key', 'x-request-timestamp', 'x-request-nonce', 
                                'x-request-signature', 'x-client-fingerprint'];
      const forwardedHeaders = {};
      importantHeaders.forEach(h => {
        const header = headerMap.get(h);
        if (header) {
          forwardedHeaders[header.name] = header.value.substring(0, 30) + (header.value.length > 30 ? '...' : '');
        }
      });
      // Check for bW90aGFmYWth header (case-sensitive)
      headerMap.forEach(({ name, value }, lowerName) => {
        if (lowerName.includes('bw90') || name.includes('bW90')) {
          forwardedHeaders[name] = value;
        }
      });
      if (Object.keys(forwardedHeaders).length > 0) {
        console.log(`[Proxy] Forwarding headers to ${url.hostname}:`, Object.keys(forwardedHeaders));
      }
    }
    
    // Override Referer and Origin to match flixer.sh
    headers['Referer'] = 'https://flixer.sh/';
    headers['Origin'] = 'https://flixer.sh';
    
    // Force Connection: close to prevent keep-alive issues with Cloudflare
    // This prevents "socket hang up" errors by ensuring each request uses a fresh connection
    headers['Connection'] = 'close';
    
    // Ensure Accept-Encoding is set (but don't decompress responses - pass through as-is)
    if (!headers['Accept-Encoding']) {
      headers['Accept-Encoding'] = 'gzip, deflate, br';
    }
    
    // Use the retry-enabled proxy request function
    makeProxyRequest(req, res, targetUrl, url, protocol, headers);
  } catch (error) {
    console.error('Proxy setup error:', error.message || error.toString(), error.stack || '');
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid URL: ' + (error.message || error.toString()) });
    }
  }
});

// Handle OPTIONS for CORS
app.options('/proxy-stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Authorization, X-Api-Key, X-Request-Timestamp, X-Request-Nonce, X-Request-Signature, X-Client-Fingerprint, X-Only-Sources, X-Server, bW90aGFmYWth');
  res.sendStatus(200);
});

// Catch streaming URLs that look like relative paths from m3u8 playlists
// This must be BEFORE static file serving and SPA routing
app.use((req, res, next) => {
  const path = req.path;
  
  // Check if this looks like a streaming resource path (from m3u8 playlists)
  const isStreamingPath = (path.includes('frostveil88.live') || 
                          path.includes('foggycrest91.online') ||
                          path.includes('file2/') ||
                          path.match(/^\/[^\/]+\.(live|online|net|com|org)\//) ||
                          (path.includes('.m3u8') && !path.startsWith('/proxy-stream')) ||
                          (path.includes('.ts') && !path.startsWith('/proxy-stream'))) &&
                          !path.startsWith('/proxy-stream');
  
  if (isStreamingPath) {
    // Resolve relative URL to full URL and proxy it
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const fullUrl = `https://p.10014.workers.dev${path}${queryString}`;
    const proxyUrl = `/proxy-stream?url=${encodeURIComponent(fullUrl)}`;
    console.log(`[Streaming Route] Redirecting relative path: ${path} -> ${proxyUrl}`);
    
    // Redirect to proxy endpoint (HLS.js will follow redirects for GET requests)
    return res.redirect(proxyUrl);
  }
  
  next();
});

// Serve static files (must be after proxy routes)
// Use a custom handler that doesn't send 404 for SPA routes
app.use(express.static(__dirname, {
  // Don't send 404 for files that don't exist - let SPA routing handle it
  fallthrough: true
}));

// Proxy API routes (like /api/subtitle) to flixer.sh
app.use('/api/subtitle', async (req, res) => {
  const subtitleUrl = req.query.url;
  if (!subtitleUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  
  // Proxy the subtitle request to flixer.sh
  const targetUrl = `https://flixer.sh/api/subtitle?url=${encodeURIComponent(subtitleUrl)}`;
  console.log(`[Subtitle Proxy] Proxying: ${req.url} -> ${targetUrl}`);
  
  try {
    // Fetch the subtitle from flixer.sh
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Referer': 'https://flixer.sh/',
        'Origin': 'https://flixer.sh',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': req.headers.accept || '*/*',
      },
    });
    
    if (!response.ok) {
      return res.status(response.status).send(`Subtitle fetch failed: ${response.statusText}`);
    }
    
    // Copy response headers
    const contentType = response.headers.get('content-type') || 'text/vtt; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Stream the response
    response.body.pipe(res);
  } catch (error) {
    console.error('[Subtitle Proxy] Error:', error);
    res.status(500).json({ error: 'Failed to fetch subtitle' });
  }
});

// Handle SPA routing - serve index.html for all non-API routes
// This must be AFTER static file serving and proxy routes
app.use((req, res, next) => {
  // Skip if it's an API route, proxy route, or has a file extension
  if (req.path.startsWith('/proxy-stream') || 
      req.path.startsWith('/api/') ||
      req.path.startsWith('/assets/') ||
      req.path.startsWith('/manifest.webmanifest') ||
      req.path.startsWith('/sw.js') ||
      /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json|xml|txt|md|webmanifest)$/i.test(req.path)) {
    // If it's a file request that doesn't exist, return 404
    return res.status(404).send('File not found');
  }
  
  // For all other routes (like /watch/movie/83533), serve index.html (SPA routing)
  console.log(`[SPA Route] Serving index.html for: ${req.path}`);
  res.sendFile(join(__dirname, 'index.html'), (err) => {
    if (err) {
      console.error(`[SPA Route] Error serving index.html for ${req.path}:`, err);
      res.status(500).send('Error loading page');
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ Proxy server running on http://localhost:${PORT}`);
  console.log('📡 This server modifies Referer/Origin headers to flixer.sh');
  console.log('🔧 Streaming requests will be proxied with correct headers');
  console.log('🔄 SPA routing enabled - all routes serve index.html');
  console.log(`🌐 Open http://localhost:${PORT} in your browser\n`);
});
