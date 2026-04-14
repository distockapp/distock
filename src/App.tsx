import { useState, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { LandingPage } from './pages/LandingPage';
import { DrivePage } from './pages/DrivePage';
import { useDriveStore } from './store/useDriveStore';

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const webhookUrl = useDriveStore(s => s.webhookUrl);
  if (!webhookUrl) return <Navigate to="/" />;
  return <>{children}</>;
}

export default function App() {
  const { webhookUrl, initManager, isLoading, error, fileManager } = useDriveStore();
  const [showSlowWarning, setShowSlowWarning] = useState(false);

  useEffect(() => {
    let slowTimer: any;
    if (webhookUrl && isLoading) {
      slowTimer = setTimeout(() => setShowSlowWarning(true), 3000);
    } else {
      setShowSlowWarning(false);
    }
    return () => clearTimeout(slowTimer);
  }, [webhookUrl, isLoading]);


  useEffect(() => {
    if (webhookUrl && !fileManager && !isLoading) {
      initManager(webhookUrl).catch(e => {
        if (e.message === "SERVER_TIMEOUT") {
           toast.error('Le serveur met trop de temps à répondre. Vérifiez votre connexion ou réessayez.');
        } else if (e.message === "Failed to fetch" || e.message === "NetworkError when attempting to fetch resource.") {
           toast.error("Échec de la connexion", { description: "Ton navigateur bloque l'accès à la base de données. Désactive ton AdBlock / Brave Shield ou vérifie ta connexion internet." });
        } else {
           toast.error("Échec de la connexion", { description: e.message });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhookUrl]);

  if (isLoading && webhookUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 min-h-screen bg-[#0f0f13]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#5865F2]" />
        
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-white text-sm font-medium">
            Chargement de votre espace de stockage...
          </p>
          <p className="text-[#8e8ea0] text-xs max-w-xs">
            Récupération des métadonnées en cours.<br />
            Veuillez patienter et ne pas rafraîchir la page.
          </p>
          {showSlowWarning && (
            <p className="text-yellow-500/90 text-xs mt-2 max-w-xs animate-pulse">
              Première connexion ? Le serveur peut mettre jusqu'à 30 secondes à démarrer (cold start).
            </p>
          )}
        </div>
        
        <div className="w-48 h-1 bg-[#1a1a24] rounded-full overflow-hidden">
          <div className="h-full bg-[#5865F2] rounded-full animate-pulse w-full opacity-75" />
        </div>
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/" element={webhookUrl ? <Navigate to="/drive" /> : <LandingPage />} />
          <Route path="/drive/*" element={<ProtectedRoute><DrivePage /></ProtectedRoute>} />
        </Routes>
      </HashRouter>
      <Toaster theme="dark" richColors position="bottom-right" />
    </QueryClientProvider>
  );
}
