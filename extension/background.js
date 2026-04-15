// Background Service Worker — Distock Extension
// Gère l'état de l'extension et le PROXY d'upload vers Discord (bypass CORS)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Distock] Extension installée. Proxy upload Discord actif.');
  chrome.storage.local.set({ enabled: true, installDate: Date.now() });
});

// ─── Upload Proxy Handler ─────────────────────────────────────────────
// Reçoit les chunks depuis le content script et les uploade directement
// vers Discord via fetch (pas de CORS dans le contexte service worker).

async function handleUploadChunk(message) {
  const { webhookUrl, chunkData, chunkName } = message;
  
  try {
    const blob = new Blob([chunkData]);
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({}));
    formData.append('file', blob, chunkName);
    
    const response = await fetch(webhookUrl + '?wait=true', {
      method: 'POST',
      body: formData
    });
    
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') || 2);
      return { rateLimited: true, retryAfter };
    }
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { error: `Discord ${response.status}: ${errorText}` };
    }
    
    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    return { error: err.message || 'Unknown upload error in extension' };
  }
}

// ─── Message Router ────────────────────────────────────────────────────

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

  if (message.type === 'DISTOCK_UPLOAD_CHUNK') {
    handleUploadChunk(message)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }
});

// Ouvrir Distock si l'utilisateur clique sur l'icône sans popup sur une page non-Distock
chrome.action.onClicked.addListener(() => {
  // Géré par le popup par défaut
});
