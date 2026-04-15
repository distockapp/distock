// Background Service Worker — Distock Extension
// Gère l'état de l'extension et répond aux messages du content script

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Distock] Extension installée. Bypass CORS Discord CDN actif.');
  chrome.storage.local.set({ enabled: true, installDate: Date.now() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DISTOCK_PING') {
    sendResponse({ type: 'DISTOCK_PONG', version: chrome.runtime.getManifest().version });
    return true;
  }

  if (message.type === 'DISTOCK_GET_STATUS') {
    chrome.storage.local.get(['enabled'], (result) => {
      sendResponse({ enabled: result.enabled !== false });
    });
    return true;
  }

  if (message.type === 'DISTOCK_SET_ENABLED') {
    chrome.storage.local.set({ enabled: message.enabled }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Ouvrir Distock si l'utilisateur clique sur l'icône sans popup sur une page non-Distock
chrome.action.onClicked.addListener(() => {
  // Géré par le popup par défaut
});
