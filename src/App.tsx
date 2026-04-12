import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { LandingPage } from './pages/LandingPage';
import { DrivePage } from './pages/DrivePage';
import { useDriveStore } from './store/useDriveStore';
import { useEffect } from 'react';

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const webhookUrl = useDriveStore(s => s.webhookUrl);
  if (!webhookUrl) return <Navigate to="/" />;
  return <>{children}</>;
}

export default function App() {
  const { webhookUrl, initManager, isLoading } = useDriveStore();

  useEffect(() => {
    if (webhookUrl) {
      initManager(webhookUrl).catch(e => {
        toast.error("Échec de la connexion Disbox", { description: e.message });
      });
    }
  }, [webhookUrl, initManager]);

  if (isLoading && webhookUrl) {
    return <div className="h-screen w-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-discord"></div>
    </div>;
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
