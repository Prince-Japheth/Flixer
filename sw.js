// Service Worker to intercept and proxy requests with correct headers
const CACHE_VERSION = 'v2.3';
const CACHE_NAME = `flixer-proxy-${CACHE_VERSION}`;

self.addEventListener('install', event => {
  console.log('[SW] Installing service worker', CACHE_VERSION);
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Claim clients but don't force reload
      return self.clients.claim();
    })
  );
  // Don't skip waiting on activate - let it happen naturally
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const requestUrl = event.request.url;
  
  // Don't intercept navigation requests (page loads/refreshes) - let them go to the server
  // The server will serve index.html for SPA routes
  if (event.request.mode === 'navigate') {
    // Explicitly let navigation requests pass through to the network
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Don't intercept same-origin requests that are not streaming/API requests
  if (url.origin === self.location.origin) {
    // Check if it's a streaming/API request that needs proxying
    const isStreamingRequest = requestUrl.includes('frostveil88.live') || 
        requestUrl.includes('file2/') ||
        requestUrl.match(/^\/[^\/]+\.live\//);
    
    // If it's not a streaming request and not a proxy request, let it pass through
    // Also skip intercepting requests for external JS files that should go through fetch override
    if (!isStreamingRequest && 
        !requestUrl.includes('/proxy-stream') &&
        !requestUrl.includes('/sw.js')) {
      // Let same-origin non-streaming requests pass through normally
      return;
    }
  }
  
  // Don't intercept external JS/CSS files - let the fetch override handle them
  // This prevents service worker from interfering with external resource loading
  if (url.origin !== self.location.origin && 
      (requestUrl.includes('.js') || requestUrl.includes('.css') || requestUrl.includes('.wasm'))) {
    // Let external JS/CSS/WASM files pass through to fetch override
    return;
  }
  
  // Intercept ALL external API requests and streaming requests
  // Also intercept relative URLs that look like streaming paths (from m3u8 playlists)
  let targetUrl = requestUrl;
  if (url.origin === self.location.origin && requestUrl.startsWith('/') && 
      (requestUrl.includes('frostveil88.live') || 
       requestUrl.includes('file2/') ||
       requestUrl.match(/^\/[^\/]+\.live\//))) {
    // Relative URL from m3u8 playlist - resolve against p.10014.workers.dev
    targetUrl = `https://p.10014.workers.dev${requestUrl}`;
  }
  
  const needsProxy = (url.hostname.includes('p.10014.workers.dev') || 
      url.hostname.includes('plsdontscrapemelove.flixer.sh') ||
      url.hostname.includes('sub.wyzie.ru') || // Subtitle service
      requestUrl.includes('.m3u8') ||
      requestUrl.includes('.ts') || // HLS segment files
      url.hostname.includes('workers.dev') ||
      requestUrl.includes('/api/tmdb') ||
      requestUrl.includes('/api/time') ||
      requestUrl.includes('/api/subtitle') ||
      (url.hostname.includes('flixer.sh') && requestUrl.includes('/api/')) ||
      // Relative URLs from m3u8 playlists
      (url.origin === self.location.origin && requestUrl.startsWith('/') && 
       (requestUrl.includes('frostveil88.live') || 
        requestUrl.includes('file2/') ||
        requestUrl.match(/^\/[^\/]+\.live\//))));
  
  if (needsProxy) {
    // Route through our proxy which will add correct Referer header
    const proxyUrl = `/proxy-stream?url=${encodeURIComponent(targetUrl)}`;
    
    console.log('[SW] Intercepting external request:', requestUrl, '->', proxyUrl);
    
    event.respondWith(
      fetch(proxyUrl, {
        method: event.request.method,
        headers: {
          // Copy headers but exclude forbidden ones
          'Accept': event.request.headers.get('Accept') || '*/*',
          'Accept-Language': event.request.headers.get('Accept-Language') || 'en-US,en;q=0.9',
          'Range': event.request.headers.get('Range') || '',
        },
        body: event.request.method !== 'GET' && event.request.method !== 'HEAD' ? event.request.body : null,
        mode: 'cors',
        credentials: 'omit'
      }).catch(err => {
        console.error('[SW] Proxy fetch error:', err);
        throw err;
      })
    );
    return;
  }
  
  // For all other requests, just fetch normally
  event.respondWith(fetch(event.request));
});
