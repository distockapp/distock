// Distock Extension — Content Script
// Bridge between the Distock page and the extension's background.js
// Handles ONLY download proxying — uploads go direct to Discord

(function() {
  // Inject extension detection flag into the page's main world
  const script = document.createElement('script');
  script.textContent = `window.__DISTOCK_EXTENSION__ = true;`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // Listen for download proxy requests from the page
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'DISTOCK_PAGE') return;

    if (event.data.type === 'PING') {
      chrome.runtime.sendMessage({ type: 'DISTOCK_PING' }, (response) => {
        window.postMessage({
          source: 'DISTOCK_EXTENSION',
          type: 'PONG',
          version: response?.version
        }, '*');
      });
      return;
    }

    // Download proxy: page asks us to fetch a URL (bypasses CORS on CDN)
    if (event.data.type === 'FETCH_URL') {
      const { requestId, url } = event.data;

      chrome.runtime.sendMessage({
        type: 'DISTOCK_FETCH_URL',
        url: url
      }, (response) => {
        window.postMessage({
          source: 'DISTOCK_EXTENSION',
          type: 'FETCH_RESULT',
          requestId: requestId,
          data: response?.data || null
        }, '*');
      });
      return;
    }
  });

  console.log('[Distock Extension] Content script loaded — download proxy ready.');
})();
