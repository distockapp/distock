import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, File as FileIcon, AlertTriangle, Folder as FolderIcon, FileText, Image, Film, Music, Archive as ArchiveIcon } from 'lucide-react';
import { formatSize } from '../lib/utils';
import pako from 'pako';
import { fetchUrl } from '../lib/disbox';
import { toast } from 'sonner';
import JSZip from 'jszip';

export function SharePage() {
  const location = useLocation();
  const [fileDetails, setFileDetails] = useState<{ name: string, size: number, urls: string[] } | null>(null);
  const [folderDetails, setFolderDetails] = useState<{ name: string, size: number, files: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const loadData = async () => {
      try {
        const params = new URLSearchParams(location.search);
        
        if (params.has('manifest')) {
           const manifestUrl = params.get('manifest')!;
           const blob = await fetchUrl(manifestUrl);
           const buffer = await blob.arrayBuffer();
           const decompressed = pako.inflate(new Uint8Array(buffer), { to: 'string' });
           const manifest = JSON.parse(decompressed);
           
           if (manifest.type === 'directory') {
              setFolderDetails(manifest);
              return;
           }
        }

        const name = params.get('name');
        const sizeStr = params.get('size');
        let encodedUrlData = params.get('data');
      if (!encodedUrlData) throw new Error("Lien de partage invalide ou expiré (pas de données).");

      encodedUrlData = encodedUrlData.replace(/~/g, '+').replace(/_/g, '/').replace(/-/g, '=');
      const binaryString = atob(encodedUrlData);
      const binaryLen = binaryString.length;
      const bytes = new Uint8Array(binaryLen);
      for (let i = 0; i < binaryLen; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const decompressed = pako.inflate(bytes, { to: 'string' });
      const urls = JSON.parse(decompressed);

        if (!name || urls.length === 0) throw new Error("Fichier introuvable ou lien corrompu.");

        setFileDetails({
          name: decodeURIComponent(name),
          size: Number(sizeStr) || 0,
          urls
        });
      } catch (e: any) {
        console.error(e);
        setError("Le lien de partage est invalide ou corrompu. Assurez-vous d'avoir copié le lien entier.");
      }
    };
    loadData();
  }, [location]);

  const handleDownload = async () => {
    if (!fileDetails) return;
    setIsDownloading(true);
    setProgress(0);
    let chunksDownloadedBytes = 0;
    
    try {
      // @ts-ignore fallback checking if showSaveFilePicker exists
      if (window.showSaveFilePicker) {
        // @ts-ignore
        const handle = await window.showSaveFilePicker({ suggestedName: fileDetails.name });
        const writable = await handle.createWritable();
        
        for (const url of fileDetails.urls) {
          const chunkBlob = await fetchUrl(url);
          const chunkData = new Uint8Array(await chunkBlob.arrayBuffer());
          await writable.write(chunkData);
          chunksDownloadedBytes += chunkData.byteLength;
          setProgress((chunksDownloadedBytes / Math.max(chunksDownloadedBytes, fileDetails.size)) * 100);
        }
        await writable.close();
      } else {
        // Fallback for Firefox/Safari
        const chunks: ArrayBuffer[] = [];
        for (const url of fileDetails.urls) {
          const chunkBlob = await fetchUrl(url);
          const chunkData = await chunkBlob.arrayBuffer();
          chunks.push(chunkData);
          chunksDownloadedBytes += chunkData.byteLength;
          setProgress((chunksDownloadedBytes / Math.max(chunksDownloadedBytes, fileDetails.size)) * 100);
        }
        const blob = new Blob(chunks);
        const urlObj = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = urlObj;
        a.download = fileDetails.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(urlObj);
      }
      toast.success("Téléchargement terminé !");
    } catch (err: any) {
      if (err.name !== 'AbortError') toast.error(`Erreur: ${err.message}`);
    } finally {
      setIsDownloading(false);
      setProgress(0);
    }
  };

  const handleDownloadFolderZip = async () => {
    if (!folderDetails) return;
    setIsDownloading(true);
    setProgress(0);
    try {
      const zip = new JSZip();
      let downloadedBytes = 0;
      
      for (const f of folderDetails.files) {
         const chunks: ArrayBuffer[] = [];
         for (const u of f.urls) {
             const chunkBlob = await fetchUrl(u);
             const chunkData = await chunkBlob.arrayBuffer();
             chunks.push(chunkData);
             downloadedBytes += chunkData.byteLength;
             setProgress((downloadedBytes / Math.max(downloadedBytes, folderDetails.size)) * 100);
         }
         zip.file(f.path, new Blob(chunks));
      }
      
      const content = await zip.generateAsync({ type: 'blob' });
      const urlObj = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = urlObj;
      a.download = folderDetails.name + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(urlObj);
      toast.success("Dossier téléchargé avec succès !");
    } catch(e: any) {
      if (e.name !== 'AbortError') toast.error(`Erreur ZIP: ${e.message}`);
    } finally {
      setIsDownloading(false);
      setProgress(0);
    }
  };

  const downloadSingleChild = async (f: any) => {
    try {
      toast.info(`Téléchargement de ${f.name}...`);
      const chunks: ArrayBuffer[] = [];
      for (const u of f.urls) {
         const chunkBlob = await fetchUrl(u);
         chunks.push(await chunkBlob.arrayBuffer());
      }
      const a = document.createElement('a');
      const urlObj = URL.createObjectURL(new Blob(chunks));
      a.href = urlObj;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(urlObj);
    } catch(e: any) { toast.error(e.message); }
  };

  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="bg-surface border border-white/10 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl">
          <AlertTriangle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Erreur de lien</h2>
          <p className="text-textSecondary text-sm mb-6">{error}</p>
          <a href="/" className="bg-discord text-white px-6 py-2 rounded-lg font-medium hover:bg-discordHover">Retour à l'accueil</a>
        </div>
      </div>
    );
  }

  if (!fileDetails) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><div className="animate-spin w-8 h-8 border-2 border-discord border-t-transparent rounded-full" /></div>;
  }

  const renderIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return <Image className="w-5 h-5 text-purple-400" />;
      case 'txt': case 'md': case 'csv': return <FileText className="w-5 h-5 text-gray-400" />;
      case 'mp4': case 'mkv': case 'webm': return <Film className="w-5 h-5 text-red-400" />;
      case 'mp3': case 'wav': case 'ogg': return <Music className="w-5 h-5 text-yellow-400" />;
      case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return <ArchiveIcon className="w-5 h-5 text-orange-400" />;
      default: return <FileIcon className="w-5 h-5 text-gray-300" />;
    }
  };

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col">
      <nav className="p-4 flex items-center justify-between bg-surface/50 backdrop-blur border-b border-white/5">
        <a href="/" className="text-2xl font-bold bg-gradient-to-r from-discord to-indigo-400 bg-clip-text text-transparent">Distock</a>
      </nav>

      {folderDetails ? (
         <main className="flex-1 flex flex-col items-center justify-start p-4 md:p-8">
            <div className="w-full max-w-4xl bg-surface/80 border border-white/10 rounded-2xl shadow-2xl backdrop-blur overflow-hidden flex flex-col max-h-[85vh]">
               <div className="p-6 border-b border-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                     <div className="w-12 h-12 bg-blue-500/10 flex items-center justify-center rounded-xl">
                        <FolderIcon className="w-6 h-6 text-blue-400" />
                     </div>
                     <div>
                        <h1 className="text-xl font-bold text-white leading-tight break-all">{folderDetails.name}</h1>
                        <p className="text-sm font-medium text-textSecondary">{folderDetails.files.length} fichier(s) • {formatSize(folderDetails.size)}</p>
                     </div>
                  </div>
                  <button 
                     onClick={handleDownloadFolderZip}
                     disabled={isDownloading}
                     className="shrink-0 bg-discord hover:bg-discordHover disabled:opacity-50 text-white font-bold py-2.5 px-5 rounded-xl flex items-center justify-center gap-2 transition-colors shadow-lg"
                  >
                     {isDownloading ? (
                        <>
                           <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                           <span>Zip ({progress.toFixed(0)}%)</span>
                        </>
                     ) : (
                        <>
                           <Download className="w-4 h-4" />
                           <span>Tout télécharger (ZIP)</span>
                        </>
                     )}
                  </button>
               </div>
               
               {isDownloading && (
                 <div className="w-full bg-black/50 h-1 overflow-hidden">
                    <div className="h-full bg-discord transition-all duration-300" style={{ width: `${progress}%`}}></div>
                 </div>
               )}

               <div className="flex-1 overflow-auto bg-surface/50">
                 <table className="w-full text-left border-collapse">
                   <thead className="sticky top-0 bg-surface border-b border-white/10 shadow-sm z-10">
                     <tr>
                       <th className="px-4 py-3 text-xs font-semibold text-textSecondary uppercase tracking-wider">Nom</th>
                       <th className="px-4 py-3 text-xs font-semibold text-textSecondary uppercase tracking-wider w-32">Taille</th>
                       <th className="px-4 py-3 text-xs font-semibold text-textSecondary uppercase tracking-wider w-16 text-right">Action</th>
                     </tr>
                   </thead>
                   <tbody>
                     {folderDetails.files.map((file, i) => (
                        <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                           <td className="px-4 py-3 flex items-center gap-3 w-full">
                              {renderIcon(file.name)}
                              <span className="text-sm text-textPrimary truncate">{file.path}</span>
                           </td>
                           <td className="px-4 py-3 text-sm text-textSecondary truncate">{formatSize(file.size)}</td>
                           <td className="px-4 py-3 text-right">
                              <button onClick={() => downloadSingleChild(file)} className="p-2 bg-white/5 hover:bg-discord/10 hover:text-discord rounded-lg text-textSecondary transition-colors" title="Télécharger">
                                <Download className="w-4 h-4" />
                              </button>
                           </td>
                        </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            </div>
         </main>
      ) : (
         <main className="flex-1 flex items-center justify-center p-4">
           <div className="bg-surface/80 border border-white/10 rounded-2xl p-8 max-w-md w-full shadow-2xl backdrop-blur text-center">
             <div className="w-20 h-20 bg-discord/10 flex items-center justify-center rounded-full mx-auto mb-6">
               <FileIcon className="w-10 h-10 text-discord" />
             </div>
             
             <h1 className="text-xl font-bold text-white mb-2 break-all">{fileDetails!.name}</h1>
             <p className="text-textSecondary text-sm font-medium mb-8">{formatSize(fileDetails!.size)}</p>

             <button 
               onClick={handleDownload}
               disabled={isDownloading}
               className="w-full bg-discord hover:bg-discordHover disabled:opacity-50 text-white font-bold py-3 px-4 rounded-xl flex items-center justify-center gap-3 transition-colors shadow-lg"
             >
               {isDownloading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Téléchargement... {progress.toFixed(0)}%</span>
                  </>
               ) : (
                  <>
                    <Download className="w-5 h-5" />
                    <span>Télécharger le fichier</span>
                  </>
               )}
             </button>
             
             {isDownloading && (
               <div className="mt-4 w-full bg-black/50 h-2 rounded-full overflow-hidden">
                  <div className="h-full bg-discord transition-all duration-300" style={{ width: `${progress}%`}}></div>
               </div>
             )}
           </div>
         </main>
      )}
    </div>
  );
}
