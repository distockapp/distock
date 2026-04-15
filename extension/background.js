// Distock Extension — Background Service Worker
// Fully mimics original Disbox download proxy while adding robust POST proxy for CORS circumvention

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Distock Extension] Installed. Service worker ready.');
});

function fastBase64ToBlob(base64Data, contentType = 'application/octet-stream') {
  // Strip the "data:...;base64," prefix safely
  let b64 = base64Data;
  const commaIdx = base64Data.indexOf(',');
  if (commaIdx !== -1) {
    b64 = base64Data.substring(commaIdx + 1);
  }

  // Decode base64 to binary string
  const byteCharacters = atob(b64);
  const len = byteCharacters.length;
  
  // Allocate exactly one contiguous Uint8Array (prevents garbage collector / watchdog crash)
  const bytes = new Uint8Array(len);
  
  // V8 perfectly optimizes this single, flat typed-array iteration to ~10ms for 10MB
  for (let i = 0; i < len; i++) {
    bytes[i] = byteCharacters.charCodeAt(i);
  }
  
  return new Blob([bytes], { type: contentType });
}

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
    
    try {
      // Decode synchronously using the ultra-fast typed array pipeline
      const blob = fastBase64ToBlob(base64);
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
    } catch (err) {
      sendResponse({ error: 'Failed fast decoding: ' + err.message });
    }
      
    return true; // Keep message channel open for async fetch
  }
});
