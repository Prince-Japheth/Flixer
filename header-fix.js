// Inject this script to modify fetch/XHR requests
(function() {
  'use strict';
  
  // Store original fetch
  const originalFetch = window.fetch;
  
  // Override fetch
  window.fetch = function(...args) {
    const [url, options = {}] = args;
    
    // Check if this is a request to a streaming server
    if (typeof url === 'string' && (
      url.includes('p.10014.workers.dev') ||
      url.includes('plsdontscrapemelove.flixer.sh') ||
      url.includes('.m3u8') ||
      url.includes('workers.dev')
    )) {
      // Modify headers
      const modifiedOptions = {
        ...options,
        headers: {
          ...options.headers,
          'Referer': 'https://flixer.sh/',
          'Origin': 'https://flixer.sh',
        }
      };
      
      return originalFetch(url, modifiedOptions);
    }
    
    return originalFetch(...args);
  };
  
  // Override XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    // Don't set Referer/Origin - we'll override them
    if (header.toLowerCase() === 'referer' || header.toLowerCase() === 'origin') {
      return;
    }
    return originalSetRequestHeader.apply(this, arguments);
  };
  
  // Intercept send to add headers
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && (
      this._url.includes('p.10014.workers.dev') ||
      this._url.includes('plsdontscrapemelove.flixer.sh') ||
      this._url.includes('.m3u8') ||
      this._url.includes('workers.dev')
    )) {
      originalSetRequestHeader.call(this, 'Referer', 'https://flixer.sh/');
      originalSetRequestHeader.call(this, 'Origin', 'https://flixer.sh');
    }
    return originalSend.apply(this, args);
  };
  
  console.log('[Header Fix] Fetch and XHR interceptors installed');
})();

