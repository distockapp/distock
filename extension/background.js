// Distock Extension — Background Service Worker
// Handles download proxying from Discord CDN (bypasses CORS)
// Uploads go DIRECTLY from the page to Discord webhooks (no proxy needed)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Distock Extension] Installed. Download proxy active.');
});

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// Handle messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'DISTOCK_PING') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return true;
  }

  if (request.type === 'DISTOCK_FETCH_URL') {
    const url = request.url;
    console.log(`[Distock Extension] Proxying download: ${url.substring(0, 80)}...`);

    fetch(url)
      .then(response => response.blob())
      .then(blob => blobToBase64(blob))
      .then(base64 => {
        sendResponse({ data: base64 });
      })
      .catch(error => {
        console.error('[Distock Extension] Download proxy error:', error);
        sendResponse({ data: null, error: error.message });
      });

    return true; // Keep message channel open for async response
  }
});
