import { sha256 } from 'js-sha256';
import type { DisboxFile, DisboxTree } from './types';
import { sleep } from './utils';
import JSZip from 'jszip';

import { CHUNK_SIZE } from './constants';

const SERVER_URL = 'https://disbox-server.fly.dev';
export const FILE_DELIMITER = '/';

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    if (err.name === 'AbortError') throw err;
    console.warn(`Direct fetch failed. Retrying via proxy: ${url}`);
    try {
      return await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, init);
    } catch (e) {
      throw err;
    }
  }
}


// Type pour la progression
export type ProgressCallback = (value: number, total: number) => void;

class DiscordWebhookClient {
  private baseUrl: string;
  private queue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private lastRequests: number[] = [];

  constructor(webhookUrl: string) {
    const parts = webhookUrl.split('/');
    const token = parts.pop();
    const id = parts.pop();
    this.baseUrl = `https://discordapp.com/api/webhooks/${id}/${token}`;
  }

  // File d'attente pour éviter le rate limiting strict (5 req / 2s)
  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      // On garde uniquement les requêtes des 2 dernières secondes
      this.lastRequests = this.lastRequests.filter(time => now - time < 2100);

      if (this.lastRequests.length >= 5) {
        // Trop de requêtes, on attend le plus vieux timestamp
        const waitTime = 2100 - (now - this.lastRequests[0]);
        await sleep(waitTime);
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
    const response = await fetch(`${this.baseUrl}${path}`, options);
    if (response.status === 429) {
      const retryAfterStr = response.headers.get('Retry-After');
      const retryAfter = Number(retryAfterStr || 2) * 1000;
      console.warn(`[Disbox] Rate limited by Discord. Waiting ${retryAfter}ms`);
      if (retries > 0) {
        await sleep(retryAfter);
        return this._doFetch(path, options, retries - 1); // Exactement pas via enqueue
      }
    }
    if (response.status === 413) {
      throw new Error(`Chunk trop volumineux (413). Le fichier excède la limite Discord.`);
    }
    if (response.status >= 400 && response.status !== 404) {
      throw new Error(`Failed Discord API ${options.method} with ${response.status}`);
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
  private currentUploadIndex = 0;

  constructor(webhookUrls: string[]) {
    this.webhookClients = webhookUrls.map(url => new DiscordWebhookClient(url));
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
        console.warn(`[Disbox] Message ${id} not found across all ${this.webhookClients.length} datanodes`);
      }
    }
    return urls;
  }

  async upload(sourceFile: File, namePrefix: string, onProgress?: ProgressCallback, abortSignal?: AbortSignal): Promise<string[]> {
    const resumeKey = `distock_resume_${encodeURIComponent(sourceFile.name)}_${sourceFile.size}`;
    const cached = localStorage.getItem(resumeKey);
    const ids: string[] = cached ? JSON.parse(cached) : [];
    let uploadedBytes = ids.length * CHUNK_SIZE;
    
    if (uploadedBytes > 0 && onProgress) {
      console.log(`[Disbox] Reprise de l'upload détectée (${ids.length} fragments déjà en ligne)`);
      onProgress(uploadedBytes, sourceFile.size);
    }

    for (let i = ids.length * CHUNK_SIZE; i < sourceFile.size; i += CHUNK_SIZE) {
      if (abortSignal?.aborted) throw new Error("Upload aborted");
      
      const chunkBlob = sourceFile.slice(i, i + CHUNK_SIZE);
      
      let attempts = 0;
      let success = false;
      let lastErr: any = null;

      while (attempts < 5 && !success) {
        if (abortSignal?.aborted) throw new Error("Upload aborted");
        attempts++;
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min timeout
        
        if (abortSignal) {
           abortSignal.addEventListener('abort', () => controller.abort());
        }
        
        try {
          const startTime = Date.now();
          const formData = new FormData();
          formData.append('payload_json', JSON.stringify({}));
          formData.append('file', chunkBlob, `${namePrefix}_chunk_${ids.length}`);

          // Rotation du client pour répartir la charge temporelle et IP (Load Balancer)
          const targetClient = this.webhookClients[this.currentUploadIndex % this.webhookClients.length];
          this.currentUploadIndex++;

          const response = await targetClient.fetchWithRateLimit('?wait=true', {
            method: 'POST',
            body: formData,
            signal: controller.signal
          });
          
          clearTimeout(timeout);
          const data = await response.json();
          
          // Cloudflare/Discord strict rate limit evasion (max ~25 requests/min)
          const elapsed = Date.now() - startTime;
          if (elapsed < 2500) {
            await new Promise(r => setTimeout(r, 2500 - elapsed));
          }
          
          ids.push(data.id);
          uploadedBytes += chunkBlob.size;
          
          if (onProgress) {
            onProgress(uploadedBytes, sourceFile.size);
          }
          
          // Save resumable progress block
          localStorage.setItem(resumeKey, JSON.stringify(ids));
          success = true;
        } catch (err: any) {
          clearTimeout(timeout);
          lastErr = err;
          if (err.name === 'AbortError' && abortSignal?.aborted) {
             throw new Error('Upload annulé.');
          }
          console.warn(`Upload chunk attempt ${attempts} failed:`, err);
          if (attempts < 5) {
             // Cloudflare IP bans usually last 1 minute. We back off aggressively: 15s, 30s, 45s...
             await new Promise(r => setTimeout(r, 15000 * attempts)); 
          }
        }
      }
      if (!success) {
         throw lastErr;
      }
    }
    
    // Upload fully completed, clean up resume cache
    localStorage.removeItem(resumeKey);
    return ids;
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
