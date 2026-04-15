// Global constants
export const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB — safe max with FormData overhead
export const UPLOAD_TIMEOUT_MS = 180_000; // 3 minutes per chunk
export const API_TIMEOUT_MS = 30_000; // 30s for metadata server calls
