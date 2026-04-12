import { create } from 'zustand';
import { DisboxFileManager } from '../lib/disbox';
import type { DisboxFile } from '../lib/types';

interface DriveState {
  webhookUrl: string | null;
  fileManager: DisboxFileManager | null;
  currentPath: string;
  files: DisboxFile[];
  isLoading: boolean;
  searchQuery: string;
  
  setWebhookUrl: (url: string | null) => void;
  initManager: (url: string) => Promise<void>;
  setCurrentPath: (path: string) => void;
  refreshFiles: () => void;
  setSearchQuery: (query: string) => void;
}

export const useDriveStore = create<DriveState>((set, get) => ({
  webhookUrl: localStorage.getItem('webhookUrl'),
  fileManager: null,
  currentPath: '',
  files: [],
  isLoading: false,
  searchQuery: '',

  setWebhookUrl: (url) => {
    if (url) localStorage.setItem('webhookUrl', url);
    else localStorage.removeItem('webhookUrl');
    set({ webhookUrl: url });
  },

  initManager: async (url) => {
    set({ isLoading: true });
    try {
      const manager = await DisboxFileManager.create(url);
      set({ fileManager: manager });
      get().refreshFiles();
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

  refreshFiles: () => {
    const { fileManager, currentPath, searchQuery } = get();
    if (!fileManager) return;
    
    let resultFiles: DisboxFile[] = [];

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

    set({ files: resultFiles });
  }
}));
