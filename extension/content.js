// Distock Extension — Content Script
// CSP-compliant Dataset approach

(function() {
  document.documentElement.dataset.distockExtension = 'true';

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'DISTOCK_PAGE') return;

    if (event.data.type === 'PING') {
      try {
        chrome.runtime.sendMessage({ type: 'DISTOCK_PING' }, (response) => {
          window.postMessage({
            source: 'DISTOCK_EXTENSION', type: 'PONG', version: response?.version
          }, '*');
        });
      } catch (e) {
        // Extension context invalidated
      }
      return;
    }

    if (event.data.type === 'FETCH_URL') {
      try {
        chrome.runtime.sendMessage({ type: 'DISTOCK_FETCH_URL', url: event.data.url }, (r) => {
          window.postMessage({ source: 'DISTOCK_EXTENSION', type: 'FETCH_RESULT', requestId: event.data.requestId, data: r?.data || null }, '*');
        });
      } catch (e) {
        window.postMessage({ source: 'DISTOCK_EXTENSION', type: 'FETCH_RESULT', requestId: event.data.requestId, data: null }, '*');
      }
      return;
    }

    if (event.data.type === 'UPLOAD_CHUNK') {
      try {
        chrome.runtime.sendMessage({
          type: 'DISTOCK_UPLOAD_CHUNK',
          url: event.data.url,
          filename: event.data.filename,
          base64: event.data.base64
        }, (r) => {
          window.postMessage({ source: 'DISTOCK_EXTENSION', requestId: event.data.requestId, ...r }, '*');
        });
      } catch (e) {
        window.postMessage({ source: 'DISTOCK_EXTENSION', requestId: event.data.requestId, error: e.message }, '*');
      }
      return;
    }
  });

  console.log('[Distock Extension] Content script loaded.');
})();
