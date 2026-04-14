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
import { File as FileIcon, Folder, Image, FileText, Film, Music, Archive as ArchiveIcon, MoreVertical, X, DownloadCloud, Trash2, FolderInput } from 'lucide-react';
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
    default: return <FileIcon className="w-5 h-5 text-gray-300" />;
  }
}

export function FileTable() {
  const { files, fileManager, setCurrentPath, refreshFiles } = useDriveStore();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState({});
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file?: DisboxFile } | null>(null);
  const [moveDialogFiles, setMoveDialogFiles] = useState<DisboxFile[] | null>(null);
  const [renameDialog, setRenameDialog] = useState<DisboxFile | null>(null);
  const [propertiesDialog, setPropertiesDialog] = useState<DisboxFile | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DisboxFile | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<boolean>(false);

  const columns = useMemo<ColumnDef<DisboxFile>[]>(() => [
    {
      id: 'select',
      header: ({ table }) => (
        <div className="pl-2">
          <input 
            type="checkbox" 
            checked={table.getIsAllPageRowsSelected()}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            className="w-4 h-4 rounded border-white/20 bg-transparent text-discord focus:ring-discord accent-discord cursor-pointer"
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="pl-2 flex items-center h-full" onClick={e => e.stopPropagation()}>
           <input 
             type="checkbox" 
             checked={row.getIsSelected()}
             onChange={row.getToggleSelectedHandler()}
             className="w-4 h-4 rounded border-white/20 bg-transparent text-discord focus:ring-discord accent-discord cursor-pointer"
           />
        </div>
      ),
    },
    {
      accessorKey: 'name',
      header: 'Nom',
      cell: (info) => (
        <div className="flex items-center gap-3">
          {getFileIcon(info.row.original)}
          <span className="font-medium truncate max-w-[300px] select-none">{info.getValue() as string}</span>
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
    },
    {
      id: 'actions',
      header: '',
      cell: (info) => (
        <div className="flex justify-end pr-2">
          <button 
            className="p-2 rounded-lg text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY, file: info.row.original });
            }}
            title="Options"
          >
            <MoreVertical className="w-5 h-5"/>
          </button>
        </div>
      )
    }
  ], []);

  const table = useReactTable({
    data: files,
    columns,
    state: { sorting, rowSelection },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const selectedFiles = table.getSelectedRowModel().flatRows.map(r => r.original);

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
    rename: (f?: DisboxFile) => {
      setContextMenu(null);
      if (f) setRenameDialog(f);
    },
    delete: (f?: DisboxFile) => {
      setContextMenu(null);
      if (f) setDeleteConfirm(f);
    },
    move: (f?: DisboxFile) => {
      setContextMenu(null);
      if (f) setMoveDialogFiles([f]);
    },
    share: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      
      const tId = toast.loading("Génération du lien de partage...");
      try {
         if (f.type === 'directory') {
            toast.loading("Génération du manifeste (scan du dossier)...", { id: tId });
            
            const collectFiles = async (node: DisboxFile, curPath: string) => {
               const list: any[] = [];
               for (const child of Object.values(node.children || {})) {
                  const childPath = curPath ? `${curPath}/${child.name}` : child.name;
                  if (child.type === 'file') {
                     const urls = await fileManager.getAttachmentUrls(child.path!);
                     list.push({ path: childPath, name: child.name, size: child.size, type: 'file', urls });
                  } else {
                     list.push(...await collectFiles(child, childPath));
                  }
               }
               return list;
            };
            
            const flatFiles = await collectFiles(f, "");
            const totalSize = flatFiles.reduce((acc, curr) => acc + (curr.size || 0), 0);
            
            const manifestData = {
               manifestVersion: 1,
               type: 'directory',
               name: f.name,
               size: totalSize,
               files: flatFiles
            };
            
            toast.loading("Transfert de l'URL du dossier au nuage...", { id: tId });
            
            const compressed = pako.deflate(JSON.stringify(manifestData));
            const blob = new Blob([compressed], { type: 'application/octet-stream' });
            const fileObj = new File([blob], 'dir_manifest.bin');
            
            const msgIds = await fileManager.discordFileStorage.upload(fileObj, "manifest");
            const manifestUrls = await fileManager.discordFileStorage.getAttachmentUrls(msgIds);
            
            const url = `${window.location.origin}${window.location.pathname}#/share?manifest=${encodeURIComponent(manifestUrls[0])}`;
            await navigator.clipboard.writeText(url);
            toast.success("Lien de partage du dossier copié !", { id: tId });
            
         } else {
            const urls = await fileManager.getAttachmentUrls(f.path!);
            const encoded = btoa(String.fromCharCode.apply(null, Array.from(pako.deflate(JSON.stringify(urls)))))
               .replace(/\+/g, '~').replace(/\//g, '_').replace(/=/g, '-');
            
            const url = `${window.location.origin}${window.location.pathname}#/share?name=${encodeURIComponent(f.name)}&size=${f.size}&data=${encoded}`;
            await navigator.clipboard.writeText(url);
            toast.success("Lien de partage copié dans le presse-papier", { id: tId });
         }
      } catch(e: any) {
         toast.error(`Échec du partage: ${e.message}`, { id: tId });
      }
    },
    download: async (f?: DisboxFile) => {
      setContextMenu(null);
      if (!f || !fileManager) return;
      try {
        // @ts-ignore fallback checking if showSaveFilePicker exists
        if (window.showSaveFilePicker) {
          // @ts-ignore
          const handle = await window.showSaveFilePicker({ suggestedName: f.name });
          const writable = await handle.createWritable();
          const t = toast.loading(`Téléchargement de ${f.name}`);
          await fileManager.downloadFile(f.path!, writable, () => {});
          toast.success("Téléchargement terminé", { id: t });
        } else {
          // Fallback for Firefox/Safari: collect chunks into a blob
          const t = toast.loading(`Téléchargement de ${f.name}`);
          const chunks: ArrayBuffer[] = [];
          const writableStream = new WritableStream<Uint8Array>({
            write(chunk) { chunks.push((chunk.buffer as ArrayBuffer).slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)); }
          });
          const writer = writableStream.getWriter();
          await fileManager.downloadFile(f.path!, writer, () => {});
          const blob = new Blob(chunks);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = f.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          toast.success("Téléchargement terminé", { id: t });
        }
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
       if (f) setPropertiesDialog(f);
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
               <td colSpan={5} className="px-4 py-12 text-center text-textSecondary italic">
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

      {moveDialogFiles && (
        <MoveDialog 
          files={moveDialogFiles} 
          onClose={() => {
            setMoveDialogFiles(null);
            setRowSelection({}); // Clear selection after moving
          }} 
        />
      )}

      {/* Floating Bulk Action Bar */}
      {selectedFiles.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-surface/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl flex items-center px-4 py-3 gap-4 animate-in slide-in-from-bottom-5">
           <div className="flex items-center gap-2 border-r border-white/10 pr-4">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-discord text-white text-xs font-bold">{selectedFiles.length}</span>
              <span className="text-sm font-medium hidden sm:inline">sélectionné(s)</span>
           </div>
           
           <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
              <button 
                onClick={() => setMoveDialogFiles(selectedFiles)}
                className="px-3 py-1.5 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-2 transition-colors"
                title="Déplacer"
              ><FolderInput className="w-4 h-4"/> <span className="hidden sm:inline">Déplacer</span></button>

              <button 
                onClick={async () => {
                  if (!fileManager) return;
                  const tId = toast.loading("Création du ZIP global...");
                  try {
                    await fileManager.downloadMultipleAsZip(selectedFiles, "Distock_Selection.zip", (done, tot) => toast.loading(`Zip: ${done}/${tot}...`, { id: tId }));
                    toast.success("ZIP global prêt !", { id: tId });
                    setRowSelection({});
                  } catch(e: any) { toast.error(e.message, { id: tId }); }
                }}
                className="px-3 py-1.5 rounded-lg hover:bg-white/10 text-sm font-medium flex items-center gap-2 transition-colors"
                title="Télécharger ZIP"
              ><DownloadCloud className="w-4 h-4"/> <span className="hidden sm:inline">Télécharger</span></button>

              <button 
                onClick={() => {
                  if (!fileManager) return;
                  setBulkDeleteConfirm(true);
                }}
                className="px-3 py-1.5 rounded-lg hover:bg-red-500/10 text-red-400 text-sm font-medium flex items-center gap-2 transition-colors"
                title="Supprimer"
              ><Trash2 className="w-4 h-4"/> <span className="hidden sm:inline">Supprimer</span></button>

              <button onClick={() => setRowSelection({})} className="ml-2 p-1.5 rounded-full hover:bg-white/10 text-textSecondary hover:text-white transition-colors" title="Annuler">
                 <X className="w-4 h-4" />
              </button>
           </div>
        </div>
      )}
      {renameDialog && (
        <RenameDialog 
          file={renameDialog} 
          onClose={() => setRenameDialog(null)} 
          onRename={async (newName) => {
            if (!fileManager || newName === renameDialog.name) return;
            try {
              await fileManager.renameFile(renameDialog.path!, newName);
              toast.success("Renommé avec succès");
              refreshFiles();
            } catch(e: any) { toast.error(e.message); }
          }} 
        />
      )}
      
      {deleteConfirm && (
        <ConfirmDialog 
          title="Supprimer le fichier"
          message={`Supprimer ${deleteConfirm.name} définitivement ?`}
          onClose={() => setDeleteConfirm(null)} 
          onConfirm={async () => {
            if (!fileManager) return;
            const f = deleteConfirm;
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
          }} 
        />
      )}

      {bulkDeleteConfirm && (
        <ConfirmDialog 
          title="Supprimer les éléments"
          message={`Supprimer ${selectedFiles.length} élément(s) définitivement ?`}
          onClose={() => setBulkDeleteConfirm(false)} 
          onConfirm={async () => {
            if (!fileManager) return;
            const tId = toast.loading("Suppression globale...");
            try {
              for (const sf of selectedFiles) {
                if (sf.type === 'directory') await fileManager.deleteDirectoryRecursive(sf.path!);
                else await fileManager.deleteFile(sf.path!);
              }
              toast.success("Tout supprimé !", { id: tId });
              refreshFiles();
              setRowSelection({});
            } catch (err: any) { toast.error(err.message, { id: tId }); }
          }} 
        />
      )}

      {propertiesDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Propriétés</h3>
            <div className="space-y-3 text-sm text-textSecondary mb-6">
               <p><strong className="text-white">Nom :</strong> <span className="break-all">{propertiesDialog.name}</span></p>
               <p><strong className="text-white">Taille :</strong> {formatSize(propertiesDialog.size)}</p>
               <p><strong className="text-white">Créé le :</strong> {new Date(propertiesDialog.created_at).toLocaleString()}</p>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPropertiesDialog(null)} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium transition-colors">Fermer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameDialog({ file, onClose, onRename }: { file: DisboxFile, onClose: () => void, onRename: (n: string) => Promise<void> }) {
  const [val, setVal] = useState(file.name);
  const [loading, setLoading] = useState(false);
  
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-4">Renommer</h3>
        <input 
          type="text" 
          value={val} 
          onChange={e => setVal(e.target.value)} 
          className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-discord mb-6" 
          autoFocus 
          onKeyDown={(e) => {
             if (e.key === 'Enter') { setLoading(true); onRename(val).then(onClose).finally(() => setLoading(false)); }
          }}
        />
        <div className="flex justify-end gap-3">
          <button onClick={onClose} disabled={loading} className="px-4 py-2 rounded-lg text-textSecondary hover:text-white hover:bg-white/5 transition-colors">Annuler</button>
          <button onClick={() => { setLoading(true); onRename(val).then(onClose).finally(() => setLoading(false)); }} disabled={loading} className="px-4 py-2 rounded-lg bg-discord hover:bg-discordHover text-white font-medium transition-colors">
            {loading ? 'Renommage...' : 'Renommer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ title, message, onClose, onConfirm }: { title: string, message: string, onClose: () => void, onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
        <p className="text-textSecondary text-sm mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-textSecondary hover:text-white hover:bg-white/5 transition-colors">Annuler</button>
          <button onClick={() => { onConfirm(); onClose(); }} className="px-4 py-2 rounded-lg bg-red-500/80 hover:bg-red-500 text-white font-medium transition-colors">Confirmer</button>
        </div>
      </div>
    </div>
  );
}
