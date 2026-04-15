// Content Script — injecté dans les pages Distock
// Pont entre la page web et le service worker de l'extension

(function() {
  // Inject flag into the page's main world (content scripts are isolated)
  const script = document.createElement('script');
  script.textContent = `
    window.__DISTOCK_EXTENSION__ = true;
    window.__DISTOCK_EXTENSION_VERSION__ = "${chrome.runtime.getManifest().version}";
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // ─── Upload Proxy Relay ──────────────────────────────────────────────
  // Relaye les requêtes d'upload de la page vers le background.js
  // et renvoie les réponses à la page.

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'DISTOCK_PAGE') return;

    // Handle PING
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

    // Handle UPLOAD_CHUNK — relay binary data to background.js
    if (event.data.type === 'UPLOAD_CHUNK') {
      const { requestId, webhookUrl, chunkData, chunkName } = event.data;
      
      chrome.runtime.sendMessage({
        type: 'DISTOCK_UPLOAD_CHUNK',
        webhookUrl,
        chunkData,  // ArrayBuffer — supported via structured cloning (Chrome 133+)
        chunkName
      }, (response) => {
        // Relay the response back to the page
        window.postMessage({
          source: 'DISTOCK_EXTENSION',
          type: 'UPLOAD_RESULT',
          requestId,
          ...response
        }, '*');
      });
      return;
    }
  });

  // Annonce immédiate à la page que l'extension est là
  window.dispatchEvent(new CustomEvent('distock-extension-ready', {
    detail: { version: chrome.runtime.getManifest().version }
  }));

  console.log(`[Distock Extension v${chrome.runtime.getManifest().version}] Actif — Proxy Upload Discord activé.`);
})();
