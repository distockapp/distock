import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, File as FileIcon, AlertTriangle } from 'lucide-react';
import { formatSize } from '../lib/utils';
import pako from 'pako';
import { fetchProxiedChunk } from '../lib/disbox';
import { toast } from 'sonner';

export function SharePage() {
  const location = useLocation();
  const [fileDetails, setFileDetails] = useState<{ name: string, size: number, urls: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    try {
      const params = new URLSearchParams(location.search);
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
          const chunkBlob = await fetchProxiedChunk(url);
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
          const chunkBlob = await fetchProxiedChunk(url);
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

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col">
      <nav className="p-4 flex items-center justify-between bg-surface/50 backdrop-blur border-b border-white/5">
        <a href="/" className="text-2xl font-bold bg-gradient-to-r from-discord to-indigo-400 bg-clip-text text-transparent">Distock</a>
      </nav>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="bg-surface/80 border border-white/10 rounded-2xl p-8 max-w-md w-full shadow-2xl backdrop-blur text-center">
          <div className="w-20 h-20 bg-discord/10 flex items-center justify-center rounded-full mx-auto mb-6">
            <FileIcon className="w-10 h-10 text-discord" />
          </div>
          
          <h1 className="text-xl font-bold text-white mb-2 break-all">{fileDetails.name}</h1>
          <p className="text-textSecondary text-sm font-medium mb-8">{formatSize(fileDetails.size)}</p>

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
    </div>
  );
}
