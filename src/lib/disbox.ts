import { sha256 } from 'js-sha256';
import type { DisboxFile, DisboxTree } from './types';
import { sleep } from './utils';
import JSZip from 'jszip';

import { CHUNK_SIZE, UPLOAD_TIMEOUT_MS, API_TIMEOUT_MS } from './constants';

const SERVER_URL = 'https://disbox-server.fly.dev';
export const FILE_DELIMITER = '/';

// ─── Extension Proxy Upload ─────────────────────────────────────────────
// Sends chunks through the Chrome extension's background.js (no CORS)

function hasExtensionProxy(): boolean {
  return typeof window !== 'undefined' && (window as any).__DISTOCK_EXTENSION__ === true;
}

let _extensionProxyMessageId = 0;

/**
 * Upload a chunk via the Chrome extension's background.js service worker.
 * This bypasses all CORS restrictions since the extension has full network access.
 * Returns the Discord message data { id, ... } or throws on failure.
 */
async function uploadChunkViaExtension(
  webhookUrl: string, 
  chunkBlob: Blob, 
  chunkName: string
): Promise<{ id: string }> {
  const arrayBuffer = await chunkBlob.arrayBuffer();
  const requestId = `req_${++_extensionProxyMessageId}_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension proxy timeout (3min)'));
    }, UPLOAD_TIMEOUT_MS);

    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.source !== 'DISTOCK_EXTENSION') return;
      if (event.data?.type !== 'UPLOAD_RESULT') return;
      if (event.data?.requestId !== requestId) return;

      clearTimeout(timeoutId);
      window.removeEventListener('message', handler);

      if (event.data.error) {
        reject(new Error(event.data.error));
      } else if (event.data.rateLimited) {
        // Rate limited — caller should retry after delay
        reject(new Error(`RATE_LIMITED:${event.data.retryAfter || 2}`));
      } else if (event.data.data) {
        resolve(event.data.data);
      } else {
        reject(new Error('Extension proxy: no response data'));
      }
    };

    window.addEventListener('message', handler);

    // Send chunk data to content script → background.js
    window.postMessage({
      source: 'DISTOCK_PAGE',
      type: 'UPLOAD_CHUNK',
      requestId,
      webhookUrl,
      chunkData: arrayBuffer,
      chunkName
    }, '*');
  });
}

/**
 * Fetch wrapper with timeout and automatic CORS proxy fallback for the metadata server.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // Merge signals: respect caller's signal AND our timeout
  const callerSignal = init?.signal;
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError' && callerSignal?.aborted) throw err;
    
    console.warn(`[Distock] Direct API fetch failed for ${url}:`, err.message);
    console.warn(`[Distock] Retrying via CORS proxy...`);
    
    // Retry with proxy
    const proxyController = new AbortController();
    const proxyTimeout = setTimeout(() => proxyController.abort(), API_TIMEOUT_MS);
    if (callerSignal) {
      callerSignal.addEventListener('abort', () => proxyController.abort(), { once: true });
    }
    
    try {
      const response = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
        ...init,
        signal: proxyController.signal
      });
      clearTimeout(proxyTimeout);
      return response;
    } catch (e) {
      clearTimeout(proxyTimeout);
      console.error(`[Distock] Proxy also failed for ${url}:`, e);
      throw err;
    }
  }
}


// Type pour la progression
export type ProgressCallback = (value: number, total: number) => void;

class DiscordWebhookClient {
  private _baseUrl: string;
  private queue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private lastRequests: number[] = [];
  readonly label: string; // For logging

  constructor(webhookUrl: string) {
    const parts = webhookUrl.split('/');
    const token = parts.pop();
    const id = parts.pop();
    // Use discord.com (modern endpoint) — discordapp.com may redirect causing POST→GET conversion
    this._baseUrl = `https://discord.com/api/webhooks/${id}/${token}`;
    this.label = `WH-${id?.slice(-4) || '????'}`;
  }

  get webhookUrl(): string {
    return this._baseUrl;
  }

  // File d'attente pour éviter le rate limiting strict (5 req / 2s)
  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      // On garde uniquement les requêtes des 2 dernières secondes
      this.lastRequests = this.lastRequests.filter(time => now - time < 2100);

      if (this.lastRequests.length >= 4) {
        // Conservative: 4 req / 2s instead of 5 to avoid edge cases
        const waitTime = 2100 - (now - this.lastRequests[0]);
        await sleep(Math.max(waitTime, 100));
        continue;
      }

      this.lastRequests.push(Date.now());
      const task = this.queue.shift();
      if (task) {
        await task();
      }
    }

    this.isProcessingQueue = false;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      this.processQueue();
    });
  }

  private async _doFetch(path: string, options: RequestInit, retries = 3): Promise<Response> {
    const url = `${this._baseUrl}${path}`;
    let response: Response;
    
    try {
      response = await fetch(url, options);
    } catch (fetchErr: any) {
      console.error(`[Distock][${this.label}] Network error on ${options.method} ${path}:`, fetchErr.message);
      throw fetchErr;
    }
    
    if (response.status === 429) {
      const retryAfterStr = response.headers.get('Retry-After');
      const retryAfter = Number(retryAfterStr || 2) * 1000;
      console.warn(`[Distock][${this.label}] Rate limited (429). Waiting ${retryAfter}ms. Retries left: ${retries}`);
      if (retries > 0) {
        await sleep(retryAfter + 500); // Add 500ms buffer
        return this._doFetch(path, options, retries - 1);
      }
      throw new Error(`[${this.label}] Rate limited after all retries`);
    }
    if (response.status === 413) {
      throw new Error(`Chunk trop volumineux (413). Le fichier excède la limite Discord.`);
    }
    if (response.status >= 500) {
      console.warn(`[Distock][${this.label}] Server error ${response.status}`);
      if (retries > 0) {
        await sleep(2000);
        return this._doFetch(path, options, retries - 1);
      }
    }
    if (response.status >= 400 && response.status !== 404) {
      const body = await response.text().catch(() => '');
      throw new Error(`Discord API ${options.method} failed: ${response.status} — ${body}`);
    }
    return response;
  }

  async fetchWithRateLimit(path: string, options: RequestInit, retries = 3): Promise<Response> {
    return this.enqueue(async () => {
      return this._doFetch(path, options, retries);
    });
  }

  async sendAttachment(filename: string, blob: Blob, signal?: AbortSignal): Promise<{ id: string }> {
    const formData = new FormData();
    formData.append('payload_json', JSON.stringify({}));
    formData.append('file', blob, filename);
    const response = await this.fetchWithRateLimit('?wait=true', {
      method: 'POST',
      body: formData,
      signal
    });
    return response.json();
  }

  async getMessage(id: string): Promise<any> {
    const response = await this.fetchWithRateLimit(`/messages/${id}`, {
      method: 'GET'
    });
    if (response.status === 404) return null;
    return response.json();
  }

  async deleteMessage(id: string): Promise<void> {
    await this.fetchWithRateLimit(`/messages/${id}`, {
      method: 'DELETE'
    });
  }
}

export async function fetchProxiedChunk(url: string): Promise<Blob> {
  // Si l'extension Chrome Distock est installée, elle gère les headers CORS.
  // On peut donc tenter le CDN direct sans proxy.
  const hasExtension = typeof window !== 'undefined' && (window as any).__DISTOCK_EXTENSION__ === true;

  if (hasExtension) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.blob();
    } catch (e) {
      console.warn('[Distock] Extension détectée mais fetch direct a échoué, repli sur proxy.', e);
    }
  }

  const proxies = [
    url, // Direct CDN (might work if CORS allows)
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];
  
  let lastError: any = null;
  for (const proxyUrl of proxies) {
    try {
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`Proxy HTTP ${response.status}`);
      // Await full blob to catch premature TCP cutoffs by proxies before writing to disk
      return await response.blob();
    } catch (e) {
      console.warn(`Proxy failed: ${proxyUrl}`, e);
      lastError = e;

    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

class DiscordFileStorage {
  private webhookClients: DiscordWebhookClient[] = [];

  constructor(webhookUrls: string[]) {
    this.webhookClients = webhookUrls.map(url => new DiscordWebhookClient(url));
    console.log(`[Distock] Storage initialisé avec ${this.webhookClients.length} webhook(s)`);
  }

  async getAttachmentUrls(messageIds: string[]): Promise<string[]> {
    const urls: string[] = [];
    for (const id of messageIds) {
      let found = false;
      for (const client of this.webhookClients) {
        try {
          const msg = await client.getMessage(id);
          if (msg && msg.attachments && msg.attachments[0]) {
            urls.push(msg.attachments[0].url);
            found = true;
            break; // found it
          }
        } catch(e) {
          // ignore error, try next client
        }
      }
      if (!found) {
        console.warn(`[Distock] Message ${id} not found across all ${this.webhookClients.length} datanodes`);
      }
    }
    return urls;
  }

  /**
   * Upload a file, splitting it into chunks and distributing across webhooks IN PARALLEL.
   * Each webhook gets its own "lane" and uploads independently.
   */
  async upload(sourceFile: File, namePrefix: string, onProgress?: ProgressCallback, abortSignal?: AbortSignal): Promise<string[]> {
    const resumeKey = `distock_resume_${encodeURIComponent(sourceFile.name)}_${sourceFile.size}`;
    const cached = localStorage.getItem(resumeKey);
    let completedChunks: { index: number; id: string }[] = cached ? JSON.parse(cached) : [];
    
    // Calculate total number of chunks
    const totalChunks = Math.ceil(sourceFile.size / CHUNK_SIZE);
    const numWebhooks = this.webhookClients.length;
    
    console.log(`[Distock] Upload démarré: ${sourceFile.name} (${(sourceFile.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[Distock] ${totalChunks} chunks de ${(CHUNK_SIZE / 1024 / 1024).toFixed(0)} MB, ${numWebhooks} webhook(s)`);

    // Build set of already-completed chunk indices
    const completedSet = new Set(completedChunks.map(c => c.index));
    
    if (completedSet.size > 0) {
      console.log(`[Distock] Reprise: ${completedSet.size}/${totalChunks} chunks déjà uploadés`);
      if (onProgress) {
        onProgress(completedSet.size * CHUNK_SIZE, sourceFile.size);
      }
    }

    // Determine which chunks still need uploading
    const pendingIndices: number[] = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!completedSet.has(i)) pendingIndices.push(i);
    }

    if (pendingIndices.length === 0) {
      console.log(`[Distock] Tous les chunks sont déjà uploadés (reprise complète)`);
      localStorage.removeItem(resumeKey);
      completedChunks.sort((a, b) => a.index - b.index);
      return completedChunks.map(c => c.id);
    }

    // Progress tracking (thread-safe via closure)
    let uploadedBytes = completedSet.size * CHUNK_SIZE;
    const uploadStartTime = Date.now();

    const reportProgress = () => {
      if (onProgress) {
        onProgress(Math.min(uploadedBytes, sourceFile.size), sourceFile.size);
      }
    };

    // Assign pending chunks to webhook lanes (round-robin)
    const lanes: number[][] = Array.from({ length: numWebhooks }, () => []);
    pendingIndices.forEach((chunkIdx, i) => {
      lanes[i % numWebhooks].push(chunkIdx);
    });

    console.log(`[Distock] Répartition des chunks:`, lanes.map((l, i) => `WH${i}: ${l.length} chunks`).join(', '));

    // Upload function for a single chunk with retries
    const uploadSingleChunk = async (chunkIndex: number, client: DiscordWebhookClient, laneLabel: string): Promise<{ index: number; id: string }> => {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, sourceFile.size);
      const chunkBlob = sourceFile.slice(start, end);
      const chunkName = `${namePrefix}_chunk_${chunkIndex}`;

      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        if (abortSignal?.aborted) throw new Error("Upload annulé.");
        attempts++;

        const controller = new AbortController();
        const timeout = setTimeout(() => {
          console.warn(`[Distock][${laneLabel}] Chunk ${chunkIndex} timeout après ${UPLOAD_TIMEOUT_MS / 1000}s`);
          controller.abort();
        }, UPLOAD_TIMEOUT_MS);

        // Link abort signals with cleanup
        const onAbort = () => controller.abort();
        if (abortSignal) {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        try {
          console.log(`[Distock][${laneLabel}] Chunk ${chunkIndex}/${totalChunks - 1} (tentative ${attempts}) — ${((end - start) / 1024 / 1024).toFixed(1)} MB`);
          const startTime = Date.now();
          let data: any;

          // ─── Strategy: Extension proxy first, direct fetch as fallback ───
          if (hasExtensionProxy()) {
            try {
              data = await uploadChunkViaExtension(client.webhookUrl, chunkBlob, chunkName);
              console.log(`[Distock][${laneLabel}] ✓ Chunk ${chunkIndex} uploadé via extension proxy`);
            } catch (extErr: any) {
              // Handle rate limit from extension proxy
              if (extErr.message?.startsWith('RATE_LIMITED:')) {
                const waitSec = parseInt(extErr.message.split(':')[1]) || 2;
                console.warn(`[Distock][${laneLabel}] Rate limited via extension. Waiting ${waitSec}s...`);
                await sleep(waitSec * 1000 + 500);
                throw extErr; // Go to retry loop
              }
              console.warn(`[Distock][${laneLabel}] Extension proxy failed: ${extErr.message}. Trying direct fetch...`);
              // Fall through to direct fetch below
              data = null;
            }
          }

          // Direct fetch fallback (if extension proxy unavailable or failed)
          if (!data) {
            const formData = new FormData();
            formData.append('payload_json', JSON.stringify({}));
            formData.append('file', chunkBlob, chunkName);

            const response = await client.fetchWithRateLimit('?wait=true', {
              method: 'POST',
              body: formData,
              signal: controller.signal
            });
            data = await response.json();
          }

          clearTimeout(timeout);
          if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

          const elapsed = Date.now() - startTime;
          const speed = ((end - start) / 1024 / 1024) / (elapsed / 1000);
          console.log(`[Distock][${laneLabel}] ✓ Chunk ${chunkIndex} uploadé en ${(elapsed / 1000).toFixed(1)}s (${speed.toFixed(1)} MB/s)`);

          // Minimal delay to avoid burst
          if (elapsed < 500) {
            await sleep(500 - elapsed);
          }

          return { index: chunkIndex, id: data.id };

        } catch (err: any) {
          clearTimeout(timeout);
          if (abortSignal) abortSignal.removeEventListener('abort', onAbort);

          if (err.name === 'AbortError' && abortSignal?.aborted) {
            throw new Error('Upload annulé.');
          }

          console.warn(`[Distock][${laneLabel}] ✗ Chunk ${chunkIndex} tentative ${attempts}/${maxAttempts} échouée:`, err.message);

          if (attempts >= maxAttempts) {
            throw new Error(`Échec upload chunk ${chunkIndex} après ${maxAttempts} tentatives: ${err.message}`);
          }

          // Exponential backoff with jitter: 3s, 8s, 18s, 38s
          const baseDelay = Math.min(Math.pow(2, attempts) * 1500, 40000);
          const jitter = Math.random() * 2000;
          const delay = baseDelay + jitter;
          console.log(`[Distock][${laneLabel}] Attente ${(delay / 1000).toFixed(1)}s avant retry...`);
          await sleep(delay);
        }
      }

      throw new Error(`Chunk ${chunkIndex} failed (should not reach here)`);
    };

    // Run all lanes in parallel
    const lanePromises = lanes.map(async (chunkIndices, laneIdx) => {
      const client = this.webhookClients[laneIdx];
      const laneLabel = `Lane${laneIdx}`;
      const results: { index: number; id: string }[] = [];

      for (const chunkIndex of chunkIndices) {
        if (abortSignal?.aborted) throw new Error("Upload annulé.");

        const result = await uploadSingleChunk(chunkIndex, client, laneLabel);
        results.push(result);

        // Update shared progress
        uploadedBytes += Math.min(CHUNK_SIZE, sourceFile.size - chunkIndex * CHUNK_SIZE);
        reportProgress();

        // Update resumable state (merge with existing completed chunks)
        completedChunks.push(result);
        localStorage.setItem(resumeKey, JSON.stringify(completedChunks));
      }

      return results;
    });

    try {
      await Promise.all(lanePromises);
    } catch (err) {
      // Save what we have so far for resume
      localStorage.setItem(resumeKey, JSON.stringify(completedChunks));
      const elapsed = (Date.now() - uploadStartTime) / 1000;
      console.error(`[Distock] Upload échoué après ${elapsed.toFixed(0)}s. ${completedChunks.length}/${totalChunks} chunks sauvegardés pour reprise.`);
      throw err;
    }

    // All done — sort by chunk index and return ordered IDs
    completedChunks.sort((a, b) => a.index - b.index);
    const orderedIds = completedChunks.map(c => c.id);

    localStorage.removeItem(resumeKey);
    const totalElapsed = (Date.now() - uploadStartTime) / 1000;
    const avgSpeed = (sourceFile.size / 1024 / 1024) / totalElapsed;
    console.log(`[Distock] ✓ Upload terminé: ${totalChunks} chunks en ${totalElapsed.toFixed(0)}s (${avgSpeed.toFixed(1)} MB/s moyen)`);

    return orderedIds;
  }


  async download(messageIds: string[], writeStream: WritableStreamDefaultWriter, onProgress?: ProgressCallback, fileSize = -1): Promise<void> {
    const urls = await this.getAttachmentUrls(messageIds);
    let bytesDownloaded = 0;
    if (onProgress) onProgress(0, fileSize);

    for (const url of urls) {
      const chunkBlob = await fetchProxiedChunk(url);
      const chunkData = new Uint8Array(await chunkBlob.arrayBuffer());
      await writeStream.write(chunkData);
      
      bytesDownloaded += chunkData.byteLength;
      if (onProgress) onProgress(bytesDownloaded, Math.max(fileSize, bytesDownloaded));
    }
    await writeStream.close();
  }

  async delete(messageIds: string[], onProgress?: ProgressCallback) {
    let deleted = 0;
    for (const id of messageIds) {
      // Broadcast delete to all clients since we don't know who owns it
      await Promise.all(this.webhookClients.map(client => client.deleteMessage(id).catch(() => {})));
      deleted++;
      if (onProgress) onProgress(deleted, messageIds.length);
    }
  }
}

export class DisboxFileManager {
  userId: string;
  discordFileStorage: DiscordFileStorage;
  fileTree: DisboxTree;

  static async create(webhookUrlRaw: string): Promise<DisboxFileManager> {
    const urls = webhookUrlRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) throw new Error("No webhook provided");
    
    console.log(`[Distock] Initialisation avec ${urls.length} webhook(s)...`);
    
    // Le NameNode (Maître) est la première URL. Il détient l'arborescence.
    const masterWebhook = urls[0];
    const hostnames = ["discord.com", "discordapp.com"];
    
    // Fetch both in parallel to save time
    const results = await Promise.allSettled(hostnames.map(async (hostname) => {
      const fetchUrl = new URL(masterWebhook);
      fetchUrl.hostname = hostname;
      const hashed = sha256(fetchUrl.href);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for cold starts

      try {
        const res = await apiFetch(`${SERVER_URL}/files/get/${hashed}`, { 
          signal: controller.signal, 
          cache: 'no-store' 
        });
        clearTimeout(timeout);
        
        if (res.ok) {
          return { url: fetchUrl.href, tree: await res.json() };
        }
        return null;
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') throw new Error("SERVER_TIMEOUT");
        throw err;
      }
    }));

    const fileTrees: Record<string, any> = {};
    let hasTimeout = false;

    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) {
        fileTrees[res.value.url] = res.value.tree;
      } else if (res.status === 'rejected' && res.reason?.message === "SERVER_TIMEOUT") {
        hasTimeout = true;
      }
    }

    if (Object.keys(fileTrees).length === 0) {
      if (hasTimeout) throw new Error("SERVER_TIMEOUT");
      throw new Error(`Failed to get files for user.`);
    }

    const [chosenUrl, fileTree] = Object.entries(fileTrees).sort((a, b) => {
      const lenA = Object.keys(a[1].children || {}).length;
      const lenB = Object.keys(b[1].children || {}).length;
      if (lenA === lenB) return a[0].localeCompare(b[0]);
      return lenB - lenA;
    })[0];
    
    console.log(`[Distock] Connecté avec succès. Arborescence chargée.`);
    return new DisboxFileManager(sha256(chosenUrl), new DiscordFileStorage(urls), fileTree as DisboxTree);
  }


  async syncWithServer() {
    const res = await apiFetch(`${SERVER_URL}/files/get/${this.userId}`, { cache: 'no-store' });
    if (res.ok) {
      this.fileTree = await res.json();
    }
  }

  constructor(userId: string, storage: DiscordFileStorage, fileTree: DisboxTree) {
    this.userId = userId;
    this.discordFileStorage = storage;
    this.fileTree = fileTree;
  }

  getFile(path: string, copy = true): DisboxFile | null {
    let file: DisboxFile = this.fileTree;
    let parts = path.split(FILE_DELIMITER);
    if (parts[0] === "") parts.shift();
    
    for (const p of parts) {
      if (!p) continue;
      if (file.children && file.children[p]) {
        file = file.children[p];
      } else {
        return null;
      }
    }
    return copy ? { ...file, path } : file;
  }

  getChildren(path: string): Record<string, DisboxFile> {
    const file = path === "" ? this.fileTree : this.getFile(path);
    if (!file) throw new Error(`Path not found: ${path}`);
    
    // Only strictly enforce directory type checking if it's not the virtual root,
    // as the API may return the fileTree object without a 'type' property at the root level.
    if (path !== "" && file.type !== "directory") throw new Error(`Not a directory: ${path}`);
    
    const children = file.children || {};
    const parsed: Record<string, DisboxFile> = {};
    for (const [name, child] of Object.entries(children)) {
      parsed[name] = { ...child, path: path === "" ? name : `${path}${FILE_DELIMITER}${name}` };
    }
    return parsed;
  }

  getParent(path: string): DisboxFile {
    if (!path.includes(FILE_DELIMITER)) return this.fileTree;
    const parentPath = path.substring(0, path.lastIndexOf(FILE_DELIMITER));
    const parent = this.getFile(parentPath);
    if (!parent) throw new Error(`Parent not found for: ${path}`);
    return parent;
  }

  private async updateAPI(path: string, changes: Partial<DisboxFile>): Promise<DisboxFile> {
    const file = this.getFile(path, false);
    if (!file) throw new Error(`File not found: ${path}`);
    
    changes.updated_at = new Date().toISOString();
    
    const result = await apiFetch(`${SERVER_URL}/files/update/${this.userId}/${file.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes)
    });
    if (!result.ok) throw new Error(`Update failed: ${await result.text()}`);
    Object.assign(file, changes);
    return file;
  }

  async renameFile(path: string, newName: string) {
    const file = this.getFile(path);
    if (!file) throw new Error(`Not found: ${path}`);
    
    const parent = this.getParent(path);
    const newPath = path.substring(0, path.lastIndexOf(FILE_DELIMITER) + 1) + newName;
    if (this.getFile(newPath)) throw new Error(`Already exists: ${newName}`);

    await this.updateAPI(file.path!, { name: newName });
    
    // Update local tree
    const parentNode = this.getFile(parent.path || "", false)!;
    delete parentNode.children![file.name];
    file.name = newName;
    parentNode.children![newName] = file;
    
    return this.getFile(newPath);
  }

  async moveFile(path: string, newParentPath: string) {
    const file = this.getFile(path);
    if (!file) throw new Error(`Not found: ${path}`);
    const newParent = this.getFile(newParentPath);
    if (!newParent || newParent.type !== 'directory') throw new Error(`Invalid destination`);

    const newPath = (newParentPath ? newParentPath + FILE_DELIMITER : "") + file.name;
    if (this.getFile(newPath)) throw new Error(`File already exists at destination`);

    await this.updateAPI(path, { parent_id: newParent.id });

    // Update local tree
    const oldParentNode = this.getFile(this.getParent(path).path || "", false)!;
    const newParentNode = this.getFile(newParentPath, false)!;
    
    delete oldParentNode.children![file.name];
    if (!newParentNode.children) newParentNode.children = {};
    newParentNode.children[file.name] = file;

    return this.getFile(newPath);
  }

  async createDirectory(path: string) {
    await this.createFileNode(path, 'directory');
  }

  private async createFileNode(path: string, type: 'file' | 'directory' = 'file') {
    if (this.getFile(path)) throw new Error(`Already exists: ${path}`);
    const name = path.split(FILE_DELIMITER).pop()!;
    const parentPath = path.includes(FILE_DELIMITER) ? path.substring(0, path.lastIndexOf(FILE_DELIMITER)) : "";
    const parent = this.getFile(parentPath);
    
    const newFile = {
      parent_id: parent!.id,
      name,
      type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    console.log(`[Distock] Création noeud: ${path} (${type})`);
    
    // Explicitly exclude 'children' from the body to avoid 400 Bad Request
    const res = await apiFetch(`${SERVER_URL}/files/create/${this.userId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newFile)
    });
    
    if (!res.ok) throw new Error(`Creation failed: ${await res.text()}`);
    
    const newIdText = await res.text();
    const newId = Number(newIdText);

    const parentNode = this.getFile(parentPath, false)!;
    if (!parentNode.children) parentNode.children = {};
    parentNode.children[name] = { 
      ...newFile, 
      id: newId, 
      ...(type === 'directory' ? { children: {} } : {}) 
    } as DisboxFile;
    
    return this.getFile(path);
  }

  async uploadFile(path: string, fileBlob: File, onProgress?: ProgressCallback, signal?: AbortSignal) {
    let file = this.getFile(path);
    if (!file) {
      await this.createFileNode(path, 'file');
      file = this.getFile(path);
    }
    if (file!.type === 'directory') throw new Error(`Cannot upload content to directory`);

    console.log(`[Distock] uploadFile: ${path} — ${(fileBlob.size / 1024 / 1024).toFixed(1)} MB — fileId=${file!.id}`);
    
    const ids = await this.discordFileStorage.upload(fileBlob, file!.id.toString(), onProgress, signal);
    await this.updateAPI(path, { size: fileBlob.size, content: JSON.stringify(ids) });
    return this.getFile(path);
  }

  async downloadFile(path: string, writeStream: WritableStreamDefaultWriter, onProgress?: ProgressCallback) {
    const file = this.getFile(path);
    if (!file || file.type === 'directory') throw new Error(`Invalid file for download`);
    const ids = JSON.parse(file.content || "[]");
    if (ids.length > 0) {
      await this.discordFileStorage.download(ids, writeStream, onProgress, file.size || -1);
    } else {
      await writeStream.close(); // Empty file
    }
  }

  async getAttachmentUrls(path: string) {
    const file = this.getFile(path);
    if (!file || file.type === 'directory') throw new Error(`Invalid file`);
    const ids = JSON.parse(file.content || "[]");
    return await this.discordFileStorage.getAttachmentUrls(ids);
  }

  // --- NOUVELLES FONCTIONNALITÉS CIBLES ---

  private _flattenTree(file: DisboxFile, currentPath: string): DisboxFile[] {
    let files: DisboxFile[] = [];
    if (file.type === 'file') {
      files.push({ ...file, path: currentPath });
    } else if (file.children) {
      for (const [name, child] of Object.entries(file.children)) {
        files = files.concat(this._flattenTree(child, currentPath ? `${currentPath}${FILE_DELIMITER}${name}` : name));
      }
    }
    return files;
  }

  private _getAllDirs(file: DisboxFile, currentPath: string, depth = 0): Array<{ file: DisboxFile, depth: number }> {
    let dirs: Array<{ file: DisboxFile, depth: number }> = [];
    if (file.type === 'directory') {
      dirs.push({ file: { ...file, path: currentPath }, depth });
      if (file.children) {
        for (const [name, child] of Object.entries(file.children)) {
          dirs = dirs.concat(this._getAllDirs(child, currentPath ? `${currentPath}${FILE_DELIMITER}${name}` : name, depth + 1));
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
    let deletedCount = 0;
    
    for (const f of allFiles) {
       await this.deleteFile(f.path!);
       deletedCount++;
       if (onProgress) onProgress(deletedCount, allFiles.length);
    }

    const allDirs = this._getAllDirs(root, path).sort((a, b) => b.depth - a.depth);
    for (const d of allDirs) {
      await this._deleteEmptyAPI(d.file);
    }
  }

  private async _deleteEmptyAPI(file: DisboxFile) {
    const result = await apiFetch(`${SERVER_URL}/files/delete/${this.userId}/${file.id}`, { method: 'DELETE' });
    if (!result.ok) throw new Error("Delete failed");
    
    if (file.path) {
      const parentNode = this.getFile(this.getParent(file.path).path || "", false);
      if (parentNode && parentNode.children) {
         delete parentNode.children[file.name];
      }
    }
  }

  async deleteFile(path: string, onProgress?: ProgressCallback) {
    const file = this.getFile(path);
    if (!file) throw new Error("Not found");
    
    if (file.type === 'directory') {
      const children = Object.keys(file.children || {});
      if (children.length > 0) throw new Error("Directory not empty");
      await this._deleteEmptyAPI(file);
      return;
    }

    const result = await apiFetch(`${SERVER_URL}/files/delete/${this.userId}/${file.id}`, { method: 'DELETE' });
    if (!result.ok) throw new Error("Delete failed");

    if (file.content) {
      const ids = JSON.parse(file.content);
      await this.discordFileStorage.delete(ids, onProgress);
    } else if (onProgress) {
        onProgress(1, 1);
    }

    const parentNode = this.getFile(this.getParent(path).path || "", false)!;
    delete parentNode.children![file.name];
  }

  async downloadFolderAsZip(path: string, onProgress?: ProgressCallback) {
    const root = this.getFile(path);
    if (!root || root.type !== 'directory') throw new Error("Not a directory");

    const zip = new JSZip();
    const allFiles = this._flattenTree(root, path);
    
    let processed = 0;
    for (const f of allFiles) {
      if (!f.content) continue;
      const ids = JSON.parse(f.content);
      const urls = await this.discordFileStorage.getAttachmentUrls(ids);
      const fileBlobParts: Blob[] = [];
      
      for (const url of urls) {
        const chunkBlob = await fetchProxiedChunk(url);
        fileBlobParts.push(chunkBlob);
      }
      
      const fullBlob = new Blob(fileBlobParts);
      // Remove root path from zip path
      const relativePath = f.path!.substring(path.length + 1);
      zip.file(relativePath, fullBlob);
      
      processed++;
      if (onProgress) onProgress(processed, allFiles.length);
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    
    // We can use a trick to download the blob directly in browser
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `${root.name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  }
  async downloadMultipleAsZip(files: DisboxFile[], zipName: string = "Distock_Selection.zip", onProgress?: ProgressCallback) {
    const zip = new JSZip();
    const allFilesToZip: { file: DisboxFile, relativePath: string }[] = [];

    const flattenToZip = (list: DisboxFile[], currentPath: string = "") => {
       for (const f of list) {
          if (f.type === 'directory') {
             const dirNode = this.getFile(f.path!);
             if (dirNode && dirNode.children) {
                 flattenToZip(Object.values(dirNode.children), `${currentPath}${f.name}/`);
             }
          } else {
             allFilesToZip.push({ file: f, relativePath: `${currentPath}${f.name}` });
          }
       }
    };

    flattenToZip(files);

    let processed = 0;
    for (const item of allFilesToZip) {
      const f = item.file;
      if (!f.content) continue;
      const ids = JSON.parse(f.content);
      const urls = await this.discordFileStorage.getAttachmentUrls(ids);
      const fileBlobParts: Blob[] = [];
      
      for (const url of urls) {
        const chunkBlob = await fetchProxiedChunk(url);
        fileBlobParts.push(chunkBlob);
      }
      
      const fullBlob = new Blob(fileBlobParts);
      zip.file(item.relativePath, fullBlob);
      
      processed++;
      if (onProgress) onProgress(processed, allFilesToZip.length);
    }

    if (processed === 0) return; // Nothing to zip

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  }
}
