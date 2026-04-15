// Distock Extension — Background Service Worker
// Fully mimics original Disbox download proxy while adding robust POST proxy for CORS circumvention

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Distock Extension] Installed. Service worker ready.');
});

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    try { reader.readAsDataURL(blob); } catch(e) { resolve(null); }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'DISTOCK_PING') {
    sendResponse({ version: chrome.runtime.getManifest().version });
    return true;
  }

  if (request.type === 'DISTOCK_FETCH_URL') {
    fetch(request.url)
      .then(response => response.blob())
      .then(blob => blobToBase64(blob))
      .then(base64 => sendResponse({ data: base64 }))
      .catch(error => sendResponse({ data: null, error: error.message }));
    return true; 
  }

  if (request.type === 'DISTOCK_UPLOAD_CHUNK') {
    const { url, filename, base64 } = request;
    
    // We fetch the data URL natively to avoid synchronous JS execution Limits that cause Watchdog to kill the SW!
    fetch(base64)
      .then(res => res.blob())
      .then(blob => {
        const formData = new FormData();
        formData.append('payload_json', JSON.stringify({}));
        formData.append('file', blob, filename);

        return fetch(url, { method: 'POST', body: formData });
      })
      .then(async (response) => {
         const status = response.status;
         if (status >= 400) {
            const text = await response.text().catch(()=>'');
            sendResponse({ status, error: `Upload proxy error: ${text}` });
         } else {
            const json = await response.json();
            sendResponse({ status, data: json });
         }
      })
      .catch(err => {
         sendResponse({ error: err.message });
      });
      
    return true; // Keep message channel open for async fetch
  }
});
