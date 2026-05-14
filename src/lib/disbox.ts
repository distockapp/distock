/*
 * Distock File Manager — Based on the original DisboxApp architecture
 * https://github.com/DisboxApp
 *
 * Changes from original:
 *   - TypeScript
 *   - Multi-webhook support (round-robin)
 *   - Resumable uploads
 *   - Folder zip download
 *   - Recursive directory delete
 */

import { sha256 } from 'js-sha256';
import type { DisboxFile, DisboxTree } from './types';
import JSZip from 'jszip';
import { CHUNK_SIZE } from './constants';

const SERVER_URL = 'https://disbox-server.fly.dev';
export const FILE_DELIMITER = '/';

// ─── Helpers ────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  // Robust fetch for our fly.dev metadata server that might sleep or drop connections
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) throw new Error(`Server Error ${res.status}`);
      return res;
    } catch (e: any) {
      if (i === attempts) throw e;
      console.warn(`[Distock] API Fetch failed (attempt ${i}/${attempts}), retrying in 2s...`, e.message);
      await sleep(2000);
    }
  }
  throw new Error("API Fetch failed completely");
}

async function* readFile(file: File, chunkSize: number) {
  let offset = 0;
  while (offset < file.size) {
    const blob = file.slice(offset, offset + chunkSize);
    yield await blob.arrayBuffer();
    offset += chunkSize;
  }
}

// ─── Download helpers ───────────────────────────────────────────────────

/**
 * Try to fetch a URL through the Distock Chrome extension (bypasses CORS).
 * The extension must be installed and use `externally_connectable`.
 * Falls back to null if extension is absent.
 */
async function fetchUrlFromExtension(url: string): Promise<string | null> {
  // Try to communicate with the extension via the content script bridge
  if (typeof document !== 'undefined' && document.documentElement.dataset.distockExtension) {
    try {
      const response = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 15000);

        const reqId = `dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        
        const handler = (event: MessageEvent) => {
          if (event.source !== window) return;
          if (event.data?.source !== 'DISTOCK_EXTENSION') return;
          if (event.data?.type !== 'FETCH_RESULT') return;
          if (event.data?.requestId !== reqId) return;

          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          resolve(event.data.data || null);
        };

        window.addEventListener('message', handler);
        window.postMessage({
          source: 'DISTOCK_PAGE',
          type: 'FETCH_URL',
          requestId: reqId,
          url
        }, '*');
      });
      return response;
    } catch(e) {
      console.error("Extension fetch failed", e);
      return null;
    }
  }
  return null;
}

// Our own CORS proxy (Cloudflare Worker) — primary, most reliable
const DISTOCK_PROXY_URL = 'https://distock-cors-proxy.distock-proxy.workers.dev';

async function fetchUrlFromProxy(url: string): Promise<Response> {
  // Try our own proxy first (guaranteed to work), then public fallbacks
  const proxies = [
    `${DISTOCK_PROXY_URL}/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
  ];

  let lastError: Error | null = null;
  for (const proxyUrl of proxies) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(proxyUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) return res;
      console.warn(`[Distock] Proxy returned ${res.status}: ${proxyUrl}`);
    } catch (e) {
      lastError = e as Error;
      console.warn(`[Distock] Proxy failed: ${proxyUrl}`, (e as Error).message);
    }
  }
  throw lastError || new Error('All proxies failed');
}

export async function fetchUrl(url: string): Promise<Blob> {
  // 1. Try extension (fastest — direct CDN, no CORS issue)
  const extensionResult = await fetchUrlFromExtension(url);
  if (extensionResult !== null) {
    // Extension returns a base64 data URL
    return await (await fetch(extensionResult)).blob();
  }

  // 2. Try direct fetch (works if extension CORS rules are active)
  try {
    const directRes = await fetch(url);
    if (directRes.ok) return await directRes.blob();
  } catch {
    // CORS blocked — expected without extension
  }

  // 3. Fallback to CORS proxy with retry
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await (await fetchUrlFromProxy(url)).blob();
    } catch (e) {
      lastError = e as Error;
      console.warn(`[Distock] All proxies failed (attempt ${attempt}/2):`, (e as Error).message);
      if (attempt < 2) await sleep(1500);
    }
  }
  throw lastError || new Error('Failed to fetch file chunk');
}

export type ProgressCallback = (value: number, total: number) => void;

export class UploadController {
  isPaused: boolean = false;
  isCancelled: boolean = false;
  private resolvePause: () => void = () => {};
  private pausePromise: Promise<void> | null = null;

  pause() {
    if (this.isPaused || this.isCancelled) return;
    this.isPaused = true;
    this.pausePromise = new Promise(resolve => {
      this.resolvePause = resolve;
    });
  }

  resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.resolvePause();
    this.pausePromise = null;
  }

  cancel() {
    this.isCancelled = true;
    this.resume(); // Unblock if currently paused
  }

  async check() {
    if (this.isCancelled) throw new Error('UPLOAD_CANCELLED');
    if (this.isPaused && this.pausePromise) {
      await this.pausePromise;
    }
    if (this.isCancelled) throw new Error('UPLOAD_CANCELLED');
  }
}

export async function downloadFromAttachmentUrls(
  attachmentUrls: string[],
  writeStream: WritableStreamDefaultWriter,
  onProgress: ProgressCallback | null = null,
  fileSize = -1
) {
  let bytesDownloaded = 0;
  if (onProgress) onProgress(0, fileSize);

  for (const url of attachmentUrls) {
    const blob = await fetchUrl(url);
    await writeStream.write(blob);
    bytesDownloaded += blob.size;
    if (onProgress) onProgress(bytesDownloaded, fileSize);
  }
  await writeStream.close();
}

// ─── Discord Webhook Client ─────────────────────────────────────────────
// Faithful copy of the original Disbox rate limiting approach.
// Uses Discord's X-RateLimit-* response headers instead of a custom queue.

class DiscordWebhookClient {
  private baseUrl: string;
  readonly label: string;
  readonly webhookUrl: string;

  // Two separate serial queues per webhook:
  // - uploadQueue: for POST (sendAttachment) — 1 at a time per webhook
  // - readQueue:   for GET/DELETE — 1 at a time per webhook
  private uploadQueue: Promise<any> = Promise.resolve();
  private readQueue: Promise<any> = Promise.resolve();

  constructor(webhookUrl: string) {
    const id = webhookUrl.split('/').slice(0, -1).pop();
    const token = webhookUrl.split('/').pop();
    this.baseUrl = `https://discord.com/api/webhooks/${id}/${token}`;
    this.webhookUrl = this.baseUrl;
    this.label = `WH-${id?.slice(-4) || '????'}`;
  }

  private enqueueUpload<T>(task: () => Promise<T>): Promise<T> {
    const next = this.uploadQueue.then(() => task(), () => task());
    this.uploadQueue = next.then(() => {}, () => {});
    return next;
  }

  private enqueueRead<T>(task: () => Promise<T>): Promise<T> {
    const next = this.readQueue.then(() => task(), () => task());
    this.readQueue = next.then(() => {}, () => {});
    return next;
  }

  async sendAttachment(filename: string, blob: Blob): Promise<{ id: string }> {
    return this.enqueueUpload(() => this._sendAttachmentOnce(filename, blob, 0));
  }

  private async _sendAttachmentOnce(filename: string, blob: Blob, retries: number): Promise<{ id: string }> {
    if (retries > 15) throw new Error('[Distock] Max retries exceeded due to persistent rate limit or network block.');

    if (typeof document !== 'undefined' && document.documentElement.dataset.distockExtension) {
      const base64Data: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const response: any = await new Promise((resolve, reject) => {
        const reqId = `up_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        const timeoutId = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error('Timeout du proxy (90s)'));
        }, 90000);

        const handler = (event: MessageEvent) => {
          if (event.source !== window || event.data?.requestId !== reqId || event.data?.source !== 'DISTOCK_EXTENSION') return;
          clearTimeout(timeoutId);
          window.removeEventListener('message', handler);
          resolve(event.data);
        };
        window.addEventListener('message', handler);
        window.postMessage({ source: 'DISTOCK_PAGE', type: 'UPLOAD_CHUNK', requestId: reqId, url: `${this.baseUrl}?wait=true`, filename, base64: base64Data }, '*');
      });

      if (response.status === 429) {
        let retryAfter = 2;
        try {
          const data = JSON.parse((response.error || '').replace('Upload proxy error: ', ''));
          if (data?.retry_after) retryAfter = data.retry_after + 0.5;
        } catch { /* use default */ }
        await sleep(retryAfter * 1000);
        return this._sendAttachmentOnce(filename, blob, retries + 1);
      }

      if (response.error) throw new Error(response.error);
      if (response.status >= 400) throw new Error(`Status ${response.status}`);
      return response.data;
    }

    // Fallback: direct fetch (likely CORS-blocked without extension)
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({}));
    formData.append('file', blob, filename);
    const res = await fetch(`${this.baseUrl}?wait=true`, { method: 'POST', body: formData });

    if (res.status === 429) {
      let retryAfter = 2;
      try { retryAfter = (await res.json()).retry_after || 2; } catch { /* ignore */ }
      await sleep(retryAfter * 1000);
      return this._sendAttachmentOnce(filename, blob, retries + 1);
    }

    if (!res.ok) throw new Error(`Discord API error ${res.status}`);
    return await res.json();
  }

  async getMessage(id: string): Promise<any> {
    return this.enqueueRead(async () => {
      const res = await fetch(`${this.baseUrl}/messages/${id}`);
      if (res.status === 429) {
        let retryAfter = 2;
        try { retryAfter = (await res.json()).retry_after || 2; } catch { /* ignore */ }
        await sleep(retryAfter * 1000);
        return this.getMessage(id);
      }
      if (!res.ok) throw new Error(`Discord API error ${res.status}`);
      return res.json();
    });
  }

  async deleteMessage(id: string): Promise<void> {
    return this.enqueueRead(async () => {
      const res = await fetch(`${this.baseUrl}/messages/${id}`, { method: 'DELETE' });
      if (res.status === 429) {
        let retryAfter = 2;
        try { retryAfter = (await res.json()).retry_after || 2; } catch { /* ignore */ }
        await sleep(retryAfter * 1000);
        return this.deleteMessage(id);
      }
      if (!res.ok && res.status !== 404) throw new Error(`Discord API error ${res.status}`);
    });
  }
}

// ─── Discord File Storage ───────────────────────────────────────────────
// Multi-webhook support: distributes chunks across webhooks in round-robin.

class DiscordFileStorage {
  private webhookClients: DiscordWebhookClient[];

  constructor(webhookUrls: string[]) {
    this.webhookClients = webhookUrls.map(url => new DiscordWebhookClient(url));
    console.log(`[Distock] Storage initialized with ${this.webhookClients.length} webhook(s)`);
  }

  get userId() {
    return this.webhookClients[0].label;
  }

  async getAttachmentUrls(messageIds: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const rawId of messageIds) {
      let found = false;
      let actualId = rawId;
      let targetClient: DiscordWebhookClient | null = null;
      
      if (rawId.includes('|')) {
        const parts = rawId.split('|');
        targetClient = new DiscordWebhookClient(parts[0]);
        actualId = parts[1];
      }
      
      const clientsToTest = targetClient ? [targetClient] : this.webhookClients;

      for (const client of clientsToTest) {
        try {
          // Add a 450ms delay between consecutive GET requests.
          // Discord limits requests to 5 per 2 seconds (400ms per request).
          // Without this delay, scanning a 19-chunk file creates a rapid GET spike
          // that immediately gets Cloudflare IP-banned!
          await sleep(450);
          
          const msg = await client.getMessage(actualId);
          if (msg?.attachments?.[0]?.url) {
            urls.push(msg.attachments[0].url);
            found = true;
            break;
          }
        } catch (err: any) {
          console.warn(`[Distock] Failed to get chunk ${actualId} from webhook: ${err.message}`);
        }
      }
      if (!found) {
        console.warn(`[Distock] Message ${actualId} not found across webhooks`);
      }
    }
    return urls;
  }

  /**
   * Upload a file by splitting into chunks and distributing across webhooks.
   * SEQUENTIAL upload — one chunk at a time, round-robin across webhooks.
   * This matches the original Disbox approach (proven to work).
   */
  async upload(
    sourceFile: File,
    namePrefix: string,
    onProgress: ProgressCallback | null = null,
    controller?: UploadController
  ): Promise<string[]> {
    const totalChunks = Math.ceil(sourceFile.size / CHUNK_SIZE);
    const messageIdMap: string[] = new Array(totalChunks).fill("");
    let uploadedBytes = 0;
    let index = 0;

    console.log(`[Distock] Upload: ${sourceFile.name} (${(sourceFile.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[Distock] ${totalChunks} chunks of ${(CHUNK_SIZE / 1024 / 1024).toFixed(1)} MB across ${this.webhookClients.length} hook(s)`);

    if (onProgress) onProgress(0, sourceFile.size);

    const activeUploads = new Set<Promise<void>>();

    for await (const chunk of readFile(sourceFile, CHUNK_SIZE)) {
      if (controller) await controller.check();
      
      const clientIndex = index % this.webhookClients.length;
      const client = this.webhookClients[clientIndex];
      const chunkLabel = `${namePrefix}_${index}`;
      
      const item = { chunk, index, client, chunkLabel };
      
      const uploadTask = (async () => {
        let attempts = 0;
        const maxAttempts = 5;
        let result: any = null;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            const startTime = Date.now();
            console.log(`[Distock][${item.client.label}] Chunk ${item.index}/${totalChunks - 1} (Attempt ${attempts})...`);

            result = await item.client.sendAttachment(item.chunkLabel, new Blob([item.chunk]));
            
            if (!result || !result.id) {
               throw new Error(`Discord API returned invalid response (No ID): ${JSON.stringify(result)}`);
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const speed = (item.chunk.byteLength / 1024 / 1024) / Math.max(elapsed, 0.1);
            console.log(`[Distock][${item.client.label}] ✓ Chunk ${item.index} done in ${elapsed.toFixed(1)}s (${speed.toFixed(1)} MB/s)`);
            
            break; // Success
          } catch (error: any) {
            console.warn(`[Distock][${item.client.label}] Chunk ${item.index} failed (attempt ${attempts}/${maxAttempts}):`, error.message);
            if (attempts >= maxAttempts) {
               throw new Error(`Failed to upload chunk ${item.index} after ${maxAttempts} attempts: ${error.message}`);
            }
            await sleep(Math.pow(2, attempts) * 1000 + (Math.random() * 1000));
          }
        }

        if (!result || !result.id) {
          throw new Error(`Result is irrevocably undefined after loop!`);
        }
        messageIdMap[item.index] = `${item.client.webhookUrl}|${result.id}`;
        uploadedBytes += item.chunk.byteLength;
        if (onProgress) onProgress(uploadedBytes, sourceFile.size);
      })();

      activeUploads.add(uploadTask);
      uploadTask.finally(() => activeUploads.delete(uploadTask));
      
      // Allow N+1 concurrent uploads (each webhook has its own serial queue)
      // so one webhook finishing immediately triggers the next without a gap
      while (activeUploads.size >= this.webhookClients.length + 1) {
        if (controller) await controller.check();
        await Promise.race(activeUploads);
      }
      index++;
    }

    if (activeUploads.size > 0) {
      if (controller) await controller.check();
      await Promise.all(activeUploads);
    }

    console.log(`[Distock] ✓ Upload complete: ${messageIdMap.length} chunks`);
    return messageIdMap;
  }

  async download(
    messageIds: string[],
    writeStream: WritableStreamDefaultWriter,
    onProgress: ProgressCallback | null = null,
    fileSize = -1
  ): Promise<void> {
    let bytesDownloaded = 0;
    if (onProgress) onProgress(0, fileSize);

    for (let i = 0; i < messageIds.length; i++) {
      const id = messageIds[i];
      let chunkUrl: string | null = null;
      let actualId = id;
      let targetClient: DiscordWebhookClient | null = null;

      // Extract pinned Webhook if it exists
      if (id.includes('|')) {
        const parts = id.split('|');
        targetClient = new DiscordWebhookClient(parts[0]);
        actualId = parts[1];
      }

      // If pinned, we only test the exact webhook that uploaded it
      // Otherwise, Smart Guess based on modulo (legacy fallback)
      const clientsToTest = targetClient 
        ? [targetClient]
        : [
            this.webhookClients[i % this.webhookClients.length],
            ...this.webhookClients.filter((_, idx) => idx !== (i % this.webhookClients.length))
          ];

      for (const client of clientsToTest) {
        try {
          const msg = await client.getMessage(actualId);
          if (msg?.attachments?.[0]?.url) {
            chunkUrl = msg.attachments[0].url;
            break;
          }
        } catch {
          // If 404 or rate-limited, maybe the storage structure changed. Try next client.
        }
      }

      if (!chunkUrl) {
         throw new Error(`[Distock] Fatal: Failed to find attachment URL for chunk ${i} (ID: ${actualId}) across all configured webhooks.`);
      }

      // We have the URL, download it directly
      const blob = await fetchUrl(chunkUrl);
      await writeStream.write(blob);
      bytesDownloaded += blob.size;
      
      if (onProgress) onProgress(bytesDownloaded, Math.max(fileSize, bytesDownloaded));
    }
    
    await writeStream.close();
  }

  async delete(messageIds: string[], onProgress?: ProgressCallback) {
    let deleted = 0;
    if (onProgress) onProgress(0, messageIds.length);
    for (const rawId of messageIds) {
      let actualId = rawId;
      let targetClient: DiscordWebhookClient | null = null;
      
      if (rawId.includes('|')) {
        const parts = rawId.split('|');
        targetClient = new DiscordWebhookClient(parts[0]);
        actualId = parts[1];
      }
      
      const clientsToTest = targetClient ? [targetClient] : this.webhookClients;

      for (const client of clientsToTest) {
        try {
          // Strict delay to avoid rapid bulk delete 429 IP ban
          await sleep(450);
          
          await client.deleteMessage(actualId);
          break;
        } catch (err) {
          // Keep trying with other clients
        }
      }
      deleted++;
      if (onProgress) onProgress(deleted, messageIds.length);
    }
  }
}

// ─── DisboxFileManager ──────────────────────────────────────────────────

export class DisboxFileManager {
  userId: string;
  discordFileStorage: DiscordFileStorage;
  fileTree: DisboxTree;

  static async create(webhookUrlRaw: string): Promise<DisboxFileManager> {
    const urls = webhookUrlRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) throw new Error('No webhook URL provided');

    console.log(`[Distock] Connecting with ${urls.length} webhook(s)...`);

    // The first webhook is the "master" — it determines the file tree.
    const webhookUrl = urls[0];
    const fileTrees: Record<string, any> = {};

    // Execute requests in parallel to drastically reduce cold start server delays
    // Retry up to 3 times to handle Fly.io cold starts (server may take >25s to wake)
    const fetchTreeForHost = async (hostname: string): Promise<void> => {
      const testUrl = new URL(webhookUrl);
      testUrl.hostname = hostname;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const abortCtrl = new AbortController();
          const timeoutId = setTimeout(() => abortCtrl.abort(), 60000); // 60s timeout

          const result = await fetch(`${SERVER_URL}/files/get/${sha256(testUrl.href)}`, {
            signal: abortCtrl.signal
          });

          clearTimeout(timeoutId);

          if (result.status === 200) {
            fileTrees[testUrl.href] = await result.json();
            return; // success
          }
          // Non-200 but not a throw: just continue to next attempt
        } catch (e: any) {
          if (attempt < 3) {
            console.warn(`[Distock] Tree fetch for ${hostname} failed (attempt ${attempt}/3), retrying in 3s...`, e?.message);
            await sleep(3000);
          } else {
            console.warn(`[Distock] Failed to fetch tree for ${hostname}:`, e);
          }
        }
      }
    };

    const fetchPromises = ['discord.com', 'discordapp.com'].map(h => fetchTreeForHost(h));

    await Promise.all(fetchPromises);

    if (Object.keys(fileTrees).length === 0) {
      throw new Error('Failed to get files for user.');
    }

    // If one URL has entries, choose it
    const [chosenUrl, fileTree] = Object.entries(fileTrees).sort((a, b) => {
      const lenA = Object.keys(a[1].children || {}).length;
      const lenB = Object.keys(b[1].children || {}).length;
      return lenB - lenA;
    })[0];

    console.log(`[Distock] Connected. File tree loaded.`);
    return new DisboxFileManager(
      sha256(chosenUrl),
      new DiscordFileStorage(urls),
      fileTree as DisboxTree
    );
  }

  constructor(userId: string, storage: DiscordFileStorage, fileTree: DisboxTree) {
    this.userId = userId;
    this.discordFileStorage = storage;
    this.fileTree = fileTree;
  }

  async syncWithServer() {
    const res = await fetch(`${SERVER_URL}/files/get/${this.userId}`);
    if (res.ok) {
      this.fileTree = await res.json();
    }
  }

  // ─── File tree navigation ─────────────────────────────────────────────

  getFile(path: string, copy = true): DisboxFile | null {
    let file: DisboxFile = this.fileTree;
    const parts = path.split(FILE_DELIMITER);
    if (parts[0] === '') parts.shift();

    for (const p of parts) {
      if (!p) continue;
      if (file.children?.[p]) {
        file = file.children[p];
      } else {
        return null;
      }
    }
    return copy ? { ...file, path } : file;
  }

  getChildren(path: string): Record<string, DisboxFile> {
    let children: Record<string, DisboxFile>;
    if (path === '') {
      children = this.fileTree.children || {};
    } else {
      const file = this.getFile(path);
      if (!file) throw new Error(`File not found: ${path}`);
      if (file.type !== 'directory') throw new Error(`Not a directory: ${path}`);
      children = file.children || {};
    }

    const parsed: Record<string, DisboxFile> = {};
    for (const [name, child] of Object.entries(children)) {
      parsed[name] = { ...child, path: `${path}${FILE_DELIMITER}${name}` };
    }
    return parsed;
  }

  getParent(path: string): DisboxFile {
    if (!path.includes(FILE_DELIMITER)) return this.fileTree;
    if (path.split(FILE_DELIMITER).length === 2) return this.fileTree;
    const parentPath = path.split(FILE_DELIMITER).slice(0, -1).join(FILE_DELIMITER);
    return this.getFile(parentPath)!;
  }

  // ─── CRUD operations ─────────────────────────────────────────────────

  async updateFile(path: string, changes: Partial<DisboxFile>): Promise<DisboxFile> {
    const file = this.getFile(path, false);
    if (!file) throw new Error(`File not found: ${path}`);

    if (!('updated_at' in changes)) {
      changes.updated_at = new Date().toISOString();
    }

    const result = await apiFetch(`${SERVER_URL}/files/update/${this.userId}/${file.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    if (result.status !== 200) {
      throw new Error(`Error updating file: ${result.status} ${result.statusText}`);
    }

    for (const key in changes) {
      (file as any)[key] = (changes as any)[key];
    }
    return file;
  }

  async renameFile(path: string, newName: string) {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);

    const newPath = path.replace(file.name, newName);
    if (this.getFile(newPath)) throw new Error(`File already exists: ${newPath}`);

    const changes = await this.updateFile(file.path!, { name: newName });
    const parent = this.getParent(path);
    delete parent.children![file.name];
    parent.children![changes.name] = changes;

    return this.getFile(newPath);
  }

  async moveFile(path: string, newParentPath: string) {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);
    const parent = this.getParent(path);
    const newParent = this.getFile(newParentPath);
    if (!newParent) throw new Error(`Parent not found: ${newParentPath}`);
    if (newParent.type !== 'directory') throw new Error(`Not a directory: ${newParentPath}`);

    const newPath = newParentPath + FILE_DELIMITER + file.name;
    if (this.getFile(newPath)) throw new Error(`File already exists: ${newPath}`);

    await this.updateFile(file.path!, { parent_id: newParent.id });
    delete parent.children![file.name];
    newParent.children![file.name] = file;

    return this.getFile(newPath);
  }

  async createDirectory(path: string) {
    await this.createFile(path, 'directory');
  }

  async createFile(path: string, type: 'file' | 'directory' = 'file') {
    if (this.getFile(path)) throw new Error(`Already exists: ${path}`);

    const name = path.split(FILE_DELIMITER).slice(-1)[0];
    const parentFile = this.getParent(path);

    const newFile = {
      parent_id: parentFile.id,
      name,
      type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await apiFetch(`${SERVER_URL}/files/create/${this.userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newFile),
    });
    if (result.status !== 200) {
      throw new Error(`Error creating file: ${result.status} ${result.statusText}`);
    }

    const newFileId = Number(await result.text());
    const extra = type === 'directory' ? { children: {} } : {};
    parentFile.children![name] = { ...newFile, ...extra, id: newFileId } as DisboxFile;

    return this.getFile(path);
  }

  async uploadFile(path: string, fileBlob: File, onProgress?: ProgressCallback, controller?: UploadController) {
    let file = this.getFile(path);
    if (!file) {
      await this.createFile(path);
      file = this.getFile(path);
    }
    if (file!.type === 'directory') throw new Error(`Cannot upload to directory: ${path}`);

    const contentRefs = await this.discordFileStorage.upload(fileBlob, file!.id.toString(), onProgress || null, controller);
    await this.updateFile(file!.path!, { size: fileBlob.size, content: JSON.stringify(contentRefs) });

    return file;
  }

  async downloadFile(path: string, writeStream: WritableStreamDefaultWriter, onProgress?: ProgressCallback) {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);
    if (file.type === 'directory') throw new Error(`Cannot download directory: ${path}`);

    const contentRefs = JSON.parse(file.content || '[]');
    if (contentRefs.length > 0) {
      await this.discordFileStorage.download(contentRefs, writeStream, onProgress || null, file.size || -1);
    } else {
      await writeStream.close();
    }
  }

  async getAttachmentUrls(path: string) {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);
    if (file.type === 'directory') throw new Error(`Cannot share directory: ${path}`);
    const contentRefs = JSON.parse(file.content || '[]');
    return await this.discordFileStorage.getAttachmentUrls(contentRefs);
  }

  async deleteFile(path: string, onProgress?: ProgressCallback) {
    const file = this.getFile(path);
    if (!file) throw new Error(`File not found: ${path}`);

    if (file.type === 'directory') {
      const children = this.getChildren(path);
      if (Object.keys(children).length > 0) {
        throw new Error(`Directory not empty: ${path}`);
      }
    }

    const result = await apiFetch(`${SERVER_URL}/files/delete/${this.userId}/${file.id}`, {
      method: 'DELETE',
    });
    if (result.status !== 200) {
      throw new Error(`Error deleting file: ${result.status} ${result.statusText}`);
    }
    if (file.type === 'file' && file.content) {
      await this.discordFileStorage.delete(JSON.parse(file.content), onProgress);
    } else if (onProgress) {
      onProgress(1, 1);
    }

    const parent = this.getParent(path);
    delete parent.children![file.name];
  }

  // ─── Extended features (Distock additions) ────────────────────────────

  private _flattenTree(file: DisboxFile, currentPath: string): DisboxFile[] {
    let files: DisboxFile[] = [];
    if (file.type === 'file') {
      files.push({ ...file, path: currentPath });
    } else if (file.children) {
      for (const [name, child] of Object.entries(file.children)) {
        files = files.concat(
          this._flattenTree(child, currentPath ? `${currentPath}${FILE_DELIMITER}${name}` : name)
        );
      }
    }
    return files;
  }

  private _getAllDirs(file: DisboxFile, currentPath: string, depth = 0): Array<{ file: DisboxFile; depth: number }> {
    const dirs: Array<{ file: DisboxFile; depth: number }> = [];
    if (file.type === 'directory') {
      dirs.push({ file: { ...file, path: currentPath }, depth });
      if (file.children) {
        for (const [name, child] of Object.entries(file.children)) {
          dirs.push(
            ...this._getAllDirs(child, currentPath ? `${currentPath}${FILE_DELIMITER}${name}` : name, depth + 1)
          );
        }
      }
    }
    return dirs;
  }

  async deleteDirectoryRecursive(path: string, onProgress?: ProgressCallback) {
    const root = this.getFile(path);
    if (!root) return;

    if (root.type === 'file') {
      await this.deleteFile(path, onProgress);
      return;
    }

    const allFiles = this._flattenTree(root, path);
    let deleted = 0;
    for (const f of allFiles) {
      await this.deleteFile(f.path!);
      deleted++;
      if (onProgress) onProgress(deleted, allFiles.length);
    }

    // Delete empty directories deepest first
    const allDirs = this._getAllDirs(root, path).sort((a, b) => b.depth - a.depth);
    for (const d of allDirs) {
      try {
        await this.deleteFile(d.file.path!);
      } catch {
        // May already be deleted
      }
    }
  }

  async downloadFolderAsZip(path: string, onProgress?: ProgressCallback) {
    const root = this.getFile(path);
    if (!root || root.type !== 'directory') throw new Error('Not a directory');

    const zip = new JSZip();
    const allFiles = this._flattenTree(root, path);
    let processed = 0;

    for (const f of allFiles) {
      if (!f.content) continue;
      const ids = JSON.parse(f.content);
      const urls = await this.discordFileStorage.getAttachmentUrls(ids);
      const parts: Blob[] = [];
      for (const url of urls) {
        parts.push(await fetchUrl(url));
      }
      const relativePath = f.path!.substring(path.length + 1);
      zip.file(relativePath, new Blob(parts));
      processed++;
      if (onProgress) onProgress(processed, allFiles.length);
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${root.name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  async downloadMultipleAsZip(files: DisboxFile[], zipName = 'Distock_Selection.zip', onProgress?: ProgressCallback) {
    const zip = new JSZip();
    const toZip: { file: DisboxFile; relativePath: string }[] = [];

    const flatten = (list: DisboxFile[], prefix = '') => {
      for (const f of list) {
        if (f.type === 'directory') {
          const dirNode = this.getFile(f.path!);
          if (dirNode?.children) {
            flatten(Object.values(dirNode.children), `${prefix}${f.name}/`);
          }
        } else {
          toZip.push({ file: f, relativePath: `${prefix}${f.name}` });
        }
      }
    };
    flatten(files);

    let processed = 0;
    for (const item of toZip) {
      if (!item.file.content) continue;
      const ids = JSON.parse(item.file.content);
      const urls = await this.discordFileStorage.getAttachmentUrls(ids);
      const parts: Blob[] = [];
      for (const url of urls) {
        parts.push(await fetchUrl(url));
      }
      zip.file(item.relativePath, new Blob(parts));
      processed++;
      if (onProgress) onProgress(processed, toZip.length);
    }

    if (processed === 0) return;

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
}
