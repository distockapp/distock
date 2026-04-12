// Web Worker to handle chunking without blocking the main thread
self.onmessage = async (e: MessageEvent) => {
  const { file, chunkSize, offset } = e.data;
  
  if (!file) return;

  try {
    const end = Math.min(offset + chunkSize, file.size);
    const blob = file.slice(offset, end);
    const buffer = await blob.arrayBuffer();
    
    // Send back the array buffer
    (self as any).postMessage({ buffer, nextOffset: end, done: end >= file.size }, [buffer]);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Unknown chunking error' });
  }
};
