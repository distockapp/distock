// Content Script — injecté dans les pages Distock
// Signale à l'application web que l'extension est bien installée et active

(function() {
  // Inject a script tag into the page's main world so the flag is accessible
  // by the page's JavaScript (content scripts run in isolated world)
  const script = document.createElement('script');
  script.textContent = `
    window.__DISTOCK_EXTENSION__ = true;
    window.__DISTOCK_EXTENSION_VERSION__ = "${chrome.runtime.getManifest().version}";
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // Écoute les messages de la page web
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
    }
  });

  // Annonce immédiate à la page que l'extension est là
  window.dispatchEvent(new CustomEvent('distock-extension-ready', {
    detail: { version: chrome.runtime.getManifest().version }
  }));

  console.log(`[Distock Extension v${chrome.runtime.getManifest().version}] Actif — Mode Proxy Direct CDN activé.`);
})();
