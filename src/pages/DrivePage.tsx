import { useState, useCallback } from 'react';
import { useDriveStore } from '../store/useDriveStore';
import { FileTable } from '../components/FileTable';
import { Search, Upload, FolderPlus, LogOut, ArrowLeft, RefreshCw, ServerCrash, Cloud } from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { toast } from 'sonner';
import { formatSize } from '../lib/utils';

export function DrivePage() {
  const { fileManager, currentPath, setCurrentPath, setWebhookUrl, webhookUrl, initManager, searchQuery, setSearchQuery, refreshFiles, totalSize } = useDriveStore();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!fileManager) return;
    setIsUploading(true);
    setProgress(0);
    let errorCount = 0;
    
    // Total sizes for global progress estimation
    const totalSize = acceptedFiles.reduce((acc, f) => acc + f.size, 0);
    let uploadedSize = 0;

    for (const file of acceptedFiles) {
      try {
        // webkitRelativePath allows folder uploads. E.g "myFolder/sub/file.txt"
        const relativePath = file.webkitRelativePath || file.name;
        
        let pathParts = relativePath.split('/');
        const fileName = pathParts.pop()!;
        const dirs = pathParts;
        
        // Ensure parent directories exist
        let builtPath = currentPath;
        for (const dir of dirs) {
          const dirPath = builtPath ? `${builtPath}/${dir}` : dir;
          if (!fileManager.getFile(dirPath)) {
             await fileManager.createDirectory(dirPath);
          }
          builtPath = dirPath;
        }

        const exactPath = builtPath ? `${builtPath}/${fileName}` : fileName;

        await fileManager.uploadFile(exactPath, file, (uploadedBytes, _totalBytes) => {
           setProgress(((uploadedSize + uploadedBytes) / totalSize) * 100);
        });
        uploadedSize += file.size;
        setProgress((uploadedSize / totalSize) * 100);

      } catch (err) {
        console.error(err);
        errorCount++;
        toast.error(`Échec upload: ${file.name} - ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    refreshFiles();
    setIsUploading(false);
    setProgress(0);
    if (errorCount === 0) toast.success(`${acceptedFiles.length} fichier(s) uploadé(s)`);
  }, [fileManager, currentPath, refreshFiles]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, noClick: true });

  const handleCreateFolder = () => {
    if (!fileManager) return;
    setNewFolderName("");
    setShowNewFolderDialog(true);
  };

  const handleCreateFolderSubmit = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (name.includes("/")) {
      toast.error("Le nom ne peut pas contenir '/'");
      return;
    }
    setShowNewFolderDialog(false);
    try {
      const path = currentPath ? `${currentPath}/${name}` : name;
      await fileManager!.createDirectory(path);
      refreshFiles();
      toast.success("Dossier créé");
    } catch(e: any) {
      toast.error(e.message);
    }
  };

  const handleLogout = () => {
    setShowLogoutConfirm(true);
  };

  const breadcrumbs = currentPath.split('/').filter(Boolean);

  const error = useDriveStore(s => s.error);
  const isRetrying = useDriveStore(s => s.isLoading);

  if (!fileManager) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background text-textPrimary">
        <ServerCrash className="w-16 h-16 text-red-400 mb-6" />
        <h2 className="text-2xl font-bold mb-2">Connexion échouée</h2>
        <p className="text-textSecondary mb-4 text-center max-w-md">
          {error === "SERVER_TIMEOUT"
            ? "Le serveur met trop de temps à répondre. Il est probablement en train de démarrer (cold start). Réessayez dans quelques secondes."
            : error
            ? `Erreur : ${error}`
            : "Impossible de se connecter au serveur. Vérifiez votre connexion internet et réessayez."}
        </p>
        <div className="flex gap-4">
          <button 
            onClick={() => initManager(webhookUrl!).catch(() => {})}
            disabled={isRetrying}
            className="bg-discord hover:bg-discordHover disabled:opacity-50 text-white px-6 py-3 rounded-xl font-medium transition-all shadow-lg flex items-center gap-2"
          >
            <RefreshCw className={`w-5 h-5 ${isRetrying ? 'animate-spin' : ''}`} />
            {isRetrying ? 'Connexion...' : 'Réessayer'}
          </button>
          <button 
            onClick={() => setWebhookUrl(null)}
            className="bg-surface hover:bg-surfaceLight text-textSecondary hover:text-white px-6 py-3 rounded-xl font-medium transition-all shadow-lg flex items-center gap-2"
          >
            <LogOut className="w-5 h-5" />
            Quitter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div {...getRootProps()} className={`flex flex-col h-screen text-textPrimary bg-background transition-colors ${isDragActive ? 'bg-discord/10 border-2 border-discord border-dashed' : ''}`}>
      <input {...getInputProps()} />
      {/* Header */}
      <header className="py-3 px-4 border-b border-white/5 bg-surface/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="font-bold text-xl text-discord shrink-0">Distock</div>
          
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap text-sm text-textSecondary select-none" style={{ scrollbarWidth: 'none' }}>
            <span className="cursor-pointer hover:text-white shrink-0" onClick={() => setCurrentPath('')}>Maison</span>
            {breadcrumbs.map((crumb, idx) => {
              const cp = breadcrumbs.slice(0, idx + 1).join('/');
              return (
                <span key={cp} className="flex items-center gap-2 shrink-0">
                  <span>/</span>
                  <span className="cursor-pointer hover:text-white font-medium" onClick={() => setCurrentPath(cp)}>
                    {crumb}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
        
        <div className="flex items-center gap-3 w-full sm:w-auto">
           <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-textSecondary bg-white/5 px-3 py-1.5 rounded-full border border-white/5 whitespace-nowrap">
             <Cloud className="w-4 h-4 text-discord" />
             <span className="text-white">{formatSize(totalSize)}</span> / Illimité
           </div>
           
           <div className="relative flex-1 sm:flex-none">
             <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-textSecondary" />
             <input type="text" placeholder="Rechercher..." 
               value={searchQuery}
               onChange={(e) => setSearchQuery(e.target.value)}
               className="bg-background border border-white/10 rounded-full pl-9 pr-4 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-discord w-full sm:w-64" />
           </div>
           
           <button onClick={() => refreshFiles(true)} className="p-2 rounded-lg hover:bg-white/5 text-textSecondary hover:text-white transition-colors shrink-0" title="Actualiser">
              <RefreshCw className="w-5 h-5"/>
           </button>
           <button onClick={handleLogout} className="p-2 rounded-lg hover:bg-red-500/10 text-red-400 transition-colors shrink-0" title="Déconnexion">
              <LogOut className="w-5 h-5"/>
           </button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="p-4 flex flex-wrap items-center gap-2 border-b border-white/5">
        {currentPath && (
          <button onClick={() => setCurrentPath(currentPath.substring(0, currentPath.lastIndexOf('/')))} className="px-3 py-1.5 rounded bg-surface hover:bg-surface/80 border border-white/5 flex items-center gap-2 text-sm font-medium">
             <ArrowLeft className="w-4 h-4" /> Retour
          </button>
        )}
        <label className="px-3 py-1.5 rounded border border-white/10 hover:bg-white/5 text-white cursor-pointer flex items-center gap-2 text-sm font-medium transition-colors">
          <Upload className="w-4 h-4" />
          <span>Fichiers</span>
          <input type="file" multiple className="hidden" onChange={(e) => {
             if (e.target.files) {
               const arr = Array.from(e.target.files);
               onDrop(arr);
               e.target.value = '';
             }
          }} />
        </label>
        <label className="px-3 py-1.5 rounded bg-discord hover:bg-discord/90 text-white cursor-pointer flex items-center gap-2 text-sm font-medium transition-colors">
          <FolderPlus className="w-4 h-4" />
          <span>Dossier</span>
          <input type="file" multiple className="hidden" webkitdirectory="" onChange={(e) => {
             if (e.target.files) {
               const arr = Array.from(e.target.files);
               onDrop(arr);
               e.target.value = '';
             }
          }} />
        </label>
        <button onClick={handleCreateFolder} className="px-3 py-1.5 rounded bg-surface hover:bg-surface/80 border border-white/5 flex items-center gap-2 text-sm font-medium transition-colors">
           <FolderPlus className="w-4 h-4" />
           <span className="hidden sm:inline">Nouveau Dossier</span>
           <span className="sm:hidden">Nouveau</span>
        </button>
        <div className="flex-1"></div>
        <span className="hidden md:inline text-textSecondary text-xs">Glissez-déposez des fichiers ici.</span>
      </div>

      {isUploading && (
         <div className="px-4 py-2 bg-discord/20 border-b border-discord/30 text-sm flex items-center gap-4">
            <span className="flex items-center gap-2 font-medium"><div className="w-4 h-4 rounded-full border-2 border-t-transparent border-white animate-spin"></div> Upload en cours...</span>
            <div className="flex-1 bg-black/50 h-2 rounded-full overflow-hidden">
               <div className="h-full bg-discord transition-all duration-300" style={{ width: `${progress}%`}}></div>
            </div>
            <span>{progress.toFixed(0)}%</span>
         </div>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col relative w-full">
         <FileTable />
      </main>
      
      {/* Mobile Footer Spacing if needed */}
      <div className="md:hidden h-16"/>

      {/* Modals */}
      {showNewFolderDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-4">Nouveau Dossier</h3>
            <input 
              type="text" 
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              placeholder="Nom du dossier"
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-discord mb-6" 
              autoFocus 
              onKeyDown={(e) => {
                 if (e.key === 'Enter') handleCreateFolderSubmit();
              }}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowNewFolderDialog(false)} className="px-4 py-2 rounded-lg text-textSecondary hover:text-white hover:bg-white/5 transition-colors">Annuler</button>
              <button onClick={handleCreateFolderSubmit} className="px-4 py-2 rounded-lg bg-discord hover:bg-discordHover text-white font-medium transition-colors">
                Créer
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-white/10 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Se déconnecter</h3>
            <p className="text-textSecondary text-sm mb-6">Êtes-vous sûr de vouloir vous déconnecter ? Le webhook sera oublié.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowLogoutConfirm(false)} className="px-4 py-2 rounded-lg text-textSecondary hover:text-white hover:bg-white/5 transition-colors">Annuler</button>
              <button onClick={() => { setShowLogoutConfirm(false); setWebhookUrl(null); }} className="px-4 py-2 rounded-lg bg-red-500/80 hover:bg-red-500 text-white font-medium transition-colors">Déconnexion</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// Add webkitdirectory shim for TS
declare module 'react' {
  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    webkitdirectory?: string;
  }
}
