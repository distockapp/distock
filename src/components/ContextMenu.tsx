import { useEffect, useRef } from 'react';
import type { DisboxFile } from '../lib/types';
import { Download, Share2, Edit2, Move, Eye, Trash2, FolderOpen, Archive } from 'lucide-react';

interface ContextMenuConfig {
  x: number;
  y: number;
  file?: DisboxFile;
}

export function ContextMenu({ 
  config, 
  onClose, 
  actions 
}: { 
  config: ContextMenuConfig, 
  onClose: () => void,
  actions: Record<string, (file?: DisboxFile) => void>
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [onClose]);

  if (!config.file) return null; // Can render standard empty space context menu later
  
  const isDir = config.file.type === 'directory';

  // Prevent right-edge overflow
  const menuWidth = 224; // w-56 = 14rem = 224px
  const x = config.x + menuWidth > window.innerWidth ? config.x - menuWidth : config.x;
  
  // Prevent bottom-edge overflow (approximate height 250px)
  const approxHeight = isDir ? 200 : 250;
  const y = config.y + approxHeight > window.innerHeight ? window.innerHeight - approxHeight - 16 : config.y;

  return (
    <div 
      ref={ref}
      style={{ top: y, left: x }}
      className="fixed z-50 w-56 bg-surface/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-lg py-1 text-sm text-textPrimary"
    >
      {isDir ? (
        <>
          <MenuItem icon={<FolderOpen />} label="Ouvrir" onClick={() => actions.open(config.file)} />
          <MenuItem icon={<Archive />} label="Télécharger en ZIP" onClick={() => actions.downloadZip(config.file)} />
          <div className="h-px bg-white/10 my-1 mx-2" />
          <MenuItem icon={<Edit2 />} label="Renommer" onClick={() => actions.rename(config.file)} />
          <MenuItem icon={<Move />} label="Déplacer vers..." onClick={() => actions.move(config.file)} />
          <div className="h-px bg-white/10 my-1 mx-2" />
          <MenuItem icon={<Trash2 />} label="Supprimer" danger onClick={() => actions.delete(config.file)} />
        </>
      ) : (
        <>
          <MenuItem icon={<Eye />} label="Aperçu / Infos" onClick={() => actions.properties(config.file)} />
          <MenuItem icon={<Download />} label="Télécharger" onClick={() => actions.download(config.file)} />
          <MenuItem icon={<Share2 />} label="Copier le lien de partage" onClick={() => actions.share(config.file)} />
          <div className="h-px bg-white/10 my-1 mx-2" />
          <MenuItem icon={<Edit2 />} label="Renommer" onClick={() => actions.rename(config.file)} />
          <MenuItem icon={<Move />} label="Déplacer vers..." onClick={() => actions.move(config.file)} />
          <div className="h-px bg-white/10 my-1 mx-2" />
          <MenuItem icon={<Trash2 />} label="Supprimer" danger onClick={() => actions.delete(config.file)} />
        </>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode, label: string, onClick: () => void, danger?: boolean }) {
  return (
    <button 
      onClick={() => { onClick(); }} 
      className={`w-full flex items-center gap-3 px-3 py-1.5 hover:bg-white/10 transition-colors ${danger ? 'text-red-400 hover:bg-red-500/10' : ''}`}
    >
      <span className="[&>svg]:w-4 [&>svg]:h-4">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
