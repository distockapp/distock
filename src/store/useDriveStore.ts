import { create } from 'zustand';
import { DisboxFileManager } from '../lib/disbox';
import type { DisboxFile } from '../lib/types';

interface DriveState {
  webhookUrl: string | null;
  fileManager: DisboxFileManager | null;
  currentPath: string;
  files: DisboxFile[];
  totalSize: number;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
  
  setWebhookUrl: (url: string | null) => void;
  initManager: (url: string) => Promise<void>;
  setCurrentPath: (path: string) => void;
  refreshFiles: (forceSync?: boolean) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setError: (error: string | null) => void;
}

export const useDriveStore = create<DriveState>((set, get) => ({
  webhookUrl: localStorage.getItem('webhookUrl'),
  fileManager: null,
  currentPath: '',
  files: [],
  totalSize: 0,
  isLoading: false,
  error: null,
  searchQuery: '',

  setWebhookUrl: (url) => {
    if (url) localStorage.setItem('webhookUrl', url);
    else localStorage.removeItem('webhookUrl');
    set({ webhookUrl: url, error: null });
  },

  setError: (error) => set({ error }),

  initManager: async (url) => {
    set({ isLoading: true, error: null });
    try {
      const manager = await DisboxFileManager.create(url);
      set({ fileManager: manager });
      await get().refreshFiles();
    } catch (e: any) {
      set({ error: e.message });
      throw e;
    } finally {
      set({ isLoading: false });
    }
  },


  setCurrentPath: (path) => {
    set({ currentPath: path });
    get().refreshFiles();
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
    get().refreshFiles();
  },

  refreshFiles: async (forceSync = false) => {
    const { fileManager, currentPath, searchQuery } = get();
    if (!fileManager) return;
    
    if (forceSync) {
      set({ isLoading: true });
      try {
        await fileManager.syncWithServer();
      } finally {
        set({ isLoading: false });
      }
    }
    
    let resultFiles: DisboxFile[] = [];
    let newTotalSize = 0;

    const calcSize = (f: DisboxFile) => {
      if (f.type === 'file') newTotalSize += (f.size || 0);
      else if (f.children) Object.values(f.children).forEach(calcSize);
    };
    if (fileManager.fileTree) calcSize(fileManager.fileTree);

    if (searchQuery) {
      // Very basic flat search across everything
      const flatten = (file: DisboxFile, curPath: string): DisboxFile[] => {
        let f: DisboxFile[] = [];
        if (file.name.toLowerCase().includes(searchQuery.toLowerCase())) {
          f.push({ ...file, path: curPath ? `${curPath}/${file.name}` : file.name });
        }
        if (file.children) {
          Object.values(file.children).forEach(child => {
            f = f.concat(flatten(child, curPath ? `${curPath}/${file.name}` : file.name));
          });
        }
        return f;
      };
      
      const roots = Object.values(fileManager.fileTree.children || {});
      roots.forEach(r => {
        resultFiles = resultFiles.concat(flatten(r, ""));
      });
      // Deduplicate results and clean root names
      resultFiles = resultFiles.filter((v, i, a) => a.findIndex(t => (t.id === v.id)) === i);
    } else {
      try {
        resultFiles = Object.values(fileManager.getChildren(currentPath));
      } catch (e) {
        resultFiles = [];
        set({ currentPath: '' }); // reset if error
      }
    }

    set({ files: resultFiles, totalSize: newTotalSize });
  }
}));
