import { useState, useMemo } from 'react';
import { useDriveStore } from '../store/useDriveStore';
import type { DisboxFile } from '../lib/types';
import { formatSize } from '../lib/utils';
import { format } from 'date-fns';
import { 
  useReactTable, 
  getCoreRowModel, 
  getSortedRowModel, 
  flexRender 
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { ContextMenu } from './ContextMenu';
import { MoveDialog } from './MoveDialog';
import { toast } from 'sonner';
import { File, Folder, Image, FileText, Film, Music, Archive as ArchiveIcon } from 'lucide-react';
import pako from 'pako';

function getFileIcon(file: DisboxFile) {
  if (file.type === 'directory') return <Folder className="w-5 h-5 text-blue-400" />;
  const ext = file.name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return <Image className="w-5 h-5 text-purple-400" />;
    case 'txt': case 'md': case 'csv': return <FileText className="w-5 h-5 text-gray-400" />;
    case 'mp4': case 'mkv': case 'webm': return <Film className="w-5 h-5 text-red-400" />;
    case 'mp3': case 'wav': case 'ogg': return <Music className="w-5 h-5 text-yellow-400" />;
    case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return <ArchiveIcon className="w-5 h-5 text-orange-400" />;
    default: return <File className="w-5 h-5 text-gray-300" />;
  }
}

export function FileTable() {
  const { files, fileManager, setCurrentPath, refreshFiles } = useDriveStore();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file?: DisboxFile } | null>(null);
  const [moveDialogFile, setMoveDialogFile] = useState<DisboxFile | null>(null);

  const columns = useMemo<ColumnDef<DisboxFile>[]>(() => [
    {
      accessorKey: 'name',
      header: 'Nom',
      cell: (info) => (
        <div className="flex items-center gap-3">
          {getFileIcon(info.row.original)}
          <span className="font-medium truncate max-w-[300px]">{info.getValue() as string}</span>
        </div>
      ),
      sortingFn: 'alphanumeric'
    },
    {
      accessorKey: 'updated_at',
      header: 'Modifié le',
      cell: (info) => format(new Date(info.getValue() as string), 'dd/MM/yyyy HH:mm'),
    },
    {
      accessorKey: 'size',
      header: 'Taille',
      cell: (info) => formatSize(info.getValue() as number),
    }
  ], []);

  const table = useReactTable({
    data: files,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // --- ACTIONS ---

  const handleOpen = (f?: DisboxFile) => {
    if (!f) return;
    if (f.type === 'directory') {
      setCurrentPath(f.path!);
    } else {
      actions.properties(f);
    }
  };

  const actions = {
    open: handleOpen,
    rename: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      const newName = window.prompt("Nouveau nom:", f.name);
      if (!newName || newName === f.name) return;
      try {
        await fileManager.renameFile(f.path!, newName);
        toast.success("Renommé avec succès");
        refreshFiles();
      } catch(e: any) { toast.error(e.message); }
    },
    delete: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      if (!confirm(`Supprimer ${f.name} définitivement ?`)) return;
      
      const tId = toast.loading("Suppression en cours...");
      try {
        if (f.type === 'directory') {
          await fileManager.deleteDirectoryRecursive(f.path!, (del, tot) => {
             toast.loading(`Suppression... ${del}/${tot}`, { id: tId });
          });
        } else {
          await fileManager.deleteFile(f.path!);
        }
        toast.success("Supprimé !", { id: tId });
        refreshFiles();
      } catch(e: any) { 
        toast.error(`Erreur: ${e.message}`, { id: tId }); 
      }
    },
    move: (f?: DisboxFile) => {
      setContextMenu(null);
      if (f) setMoveDialogFile(f);
    },
    share: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager || f.type === 'directory') return;
      if (!confirm("Créer un lien de partage public ?")) return;
      try {
         const urls = await fileManager.getAttachmentUrls(f.path!);
         const encoded = btoa(String.fromCharCode.apply(null, Array.from(pako.deflate(JSON.stringify(urls)))))
            .replace(/\+/g, '~').replace(/\//g, '_').replace(/=/g, '-');
         
         const url = `${window.location.origin}${window.location.pathname}?name=${encodeURIComponent(f.name)}&size=${f.size}#${encoded}`;
         await navigator.clipboard.writeText(url);
         toast.success("Lien de partage copié dans le presse-papier");
      } catch(e: any) {
         toast.error("Échec du partage");
      }
    },
    download: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      try {
        // @ts-ignore fallback checking if showSaveFilePicker exists
        if (!window.showSaveFilePicker) {
          toast.error("Votre navigateur ne supporte pas le téléchargement direct."); return;
        }
        // @ts-ignore
        const handle = await window.showSaveFilePicker({ suggestedName: f.name });
        const writable = await handle.createWritable();
        const t = toast.loading(`Téléchargement de ${f.name}`);
        await fileManager.downloadFile(f.path!, writable, () => {
           // For big files, we could update toast, but throttling is needed.
        });
        toast.success("Téléchargement terminé", { id: t });
      } catch(e: any) {
        if (e.name !== 'AbortError') toast.error(`Erreur: ${e.message}`);
      }
    },
    downloadZip: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      const tId = toast.loading(`Création du ZIP pour ${f.name}...`);
      try {
        await fileManager.downloadFolderAsZip(f.path!, (done, total) => {
           toast.loading(`Zip: ${done}/${total}...`, { id: tId });
        });
        toast.success("ZIP prêt !", { id: tId });
      } catch (e: any) {
        toast.error(`Erreur ZIP: ${e.message}`, { id: tId });
      }
    },
    properties: (f?: DisboxFile) => {
       setContextMenu(null);
       if (!f) return;
       alert(`Propriétés:\nNom: ${f.name}\nTaille: ${formatSize(f.size)}\nCréé le: ${new Date(f.created_at).toLocaleString()}`);
    }
  };

  return (
    <div 
      className="flex-1 overflow-auto bg-surface"
      onContextMenu={(e) => {
        // Context menu sur la zone vide
        if (e.target === e.currentTarget) {
           e.preventDefault();
           // Peut-être ajouter "Nouveau Dossier" ici dans une itération future
        }
      }}
    >
      <table className="w-full text-left border-collapse min-w-[600px]">
        <thead className="sticky top-0 bg-surface/95 backdrop-blur z-10 shadow-sm border-b border-white/10">
          {table.getHeaderGroups().map(headerGroup => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map(header => (
                <th 
                  key={header.id} 
                  className="px-4 py-3 text-sm font-semibold text-textSecondary cursor-pointer hover:text-white select-none"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  <div className="flex items-center gap-2">
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: '↑', desc: '↓' }[header.column.getIsSorted() as string] ?? null}
                  </div>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr 
              key={row.id}
              className="border-b border-white/5 hover:bg-white/5 transition-colors group"
              onDoubleClick={() => handleOpen(row.original)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, file: row.original });
              }}
            >
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className="px-4 py-3 text-sm text-textPrimary">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {files.length === 0 && (
             <tr>
               <td colSpan={3} className="px-4 py-12 text-center text-textSecondary italic">
                 Dossier vide. Glissez des fichiers ici pour commencer.
               </td>
             </tr>
          )}
        </tbody>
      </table>

      {contextMenu && (
        <ContextMenu 
          config={contextMenu} 
          onClose={() => setContextMenu(null)}
          actions={actions}
        />
      )}

      {moveDialogFile && (
        <MoveDialog 
          file={moveDialogFile} 
          onClose={() => setMoveDialogFile(null)} 
        />
      )}
    </div>
  );
}
