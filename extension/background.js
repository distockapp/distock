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

function base64ToBlob(base64Data, contentType = '') {
  // Strip out the data url prefix if it exists
  const prefixIndex = base64Data.indexOf('base64,');
  const b64 = prefixIndex !== -1 ? base64Data.slice(prefixIndex + 7) : base64Data;
  
  const byteCharacters = atob(b64);
  const byteArrays = [];

  for (let offset = 0; offset < byteCharacters.length; offset += 512) {
    const slice = byteCharacters.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }

  return new Blob(byteArrays, { type: contentType });
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
    
    try {
      const blob = base64ToBlob(base64, 'application/octet-stream');
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify({}));
      formData.append('file', blob, filename);

      fetch(url, { method: 'POST', body: formData })
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
    } catch (e) {
      sendResponse({ error: 'Failed to build blob from Base64: ' + e.message });
    }
    return true;
  }
});
