import { useState, useEffect } from 'react';
import type { DisboxFile } from '../lib/types';
import { useDriveStore } from '../store/useDriveStore';
import { Folder, X } from 'lucide-react';
import { toast } from 'sonner';

export function MoveDialog({ files, onClose }: { files: DisboxFile[], onClose: () => void }) {
  const { fileManager, refreshFiles } = useDriveStore();
  const [targetPath, setTargetPath] = useState('');
  const [dirs, setDirs] = useState<{ path: string, name: string, depth: number }[]>([]);

  useEffect(() => {
    if (!fileManager) return;
    // Get all directories recursively
    const flattenDirs = (f: DisboxFile, p: string, depth: number): {path: string, name: string, depth: number}[] => {
      let d: {path: string, name: string, depth: number}[] = [];
      if (f.type === 'directory') {
         // Cannot move inside itself or any of the selected moving folders
         if (!files.some(mf => mf.path === p)) {
           d.push({ path: p, name: f.name || 'Maison', depth });
         }
         if (f.children && !files.some(mf => mf.path === p)) {
           Object.values(f.children).forEach(child => {
             d = d.concat(flattenDirs(child, p ? `${p}/${child.name}` : child.name, depth + 1));
           });
         }
      }
      return d;
    };
    
    // Add root
    let allDirs = [{ path: '', name: 'Maison', depth: 0 }];
    Object.values(fileManager.fileTree.children || {}).forEach(c => {
       allDirs = allDirs.concat(flattenDirs(c, c.name, 1));
    });
    setDirs(allDirs);
  }, [fileManager, files]);

  const handleMove = async () => {
    if (!fileManager || files.length === 0) return;
    try {
      for (const f of files) {
        if (f.path) await fileManager.moveFile(f.path, targetPath);
      }
      toast.success(`${files.length} élément(s) déplacé(s) avec succès`);
      refreshFiles();
      onClose();
    } catch(e: any) {
      toast.error(`Erreur: ${e.message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-surface border border-white/10 rounded-xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">
        <div className="flex justify-between items-center p-4 border-b border-white/5">
          <h3 className="font-semibold text-lg">Déplacer {files.length} élément(s) vers...</h3>
          <button onClick={onClose} className="p-1 hover:bg-white/10 rounded text-textSecondary hover:text-white"><X className="w-5 h-5"/></button>
        </div>
        
        <div className="p-4 overflow-y-auto flex-1">
          {dirs.map(d => (
            <div 
              key={d.path} 
              onClick={() => setTargetPath(d.path)}
              className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${targetPath === d.path ? 'bg-discord text-white' : 'hover:bg-white/5 text-textSecondary hover:text-white'}`}
              style={{ paddingLeft: `${(d.depth * 1.5) + 0.5}rem` }}
            >
              <Folder className="w-4 h-4" />
              <span className="truncate">{d.name}</span>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-white/5 flex justify-end gap-3 bg-black/20">
          <button onClick={onClose} className="px-4 py-2 rounded font-medium hover:bg-white/5 transition-colors text-textSecondary hover:text-white">Annuler</button>
          <button onClick={handleMove} className="px-4 py-2 rounded font-medium bg-discord hover:bg-discord/90 text-white transition-colors">Déplacer Ici</button>
        </div>
      </div>
    </div>
  );
}
