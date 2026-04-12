import { useState } from 'react';
import type { FormEvent } from 'react';
import { useDriveStore } from '../store/useDriveStore';
import { Shield, Zap, Cloud } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export function LandingPage() {
  const [webhook, setWebhook] = useState('');
  const setWebhookUrl = useDriveStore(s => s.setWebhookUrl);
  const navigate = useNavigate();

  const handleSetup = (e: FormEvent) => {
    e.preventDefault();
    if (!webhook.trim() || (!webhook.includes('discord.com') && !webhook.includes('discordapp.com'))) {
      alert("URL invalide.");
      return;
    }
    setWebhookUrl(webhook.trim());
    navigate('/drive');
  };

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col">
      <nav className="p-4 flex items-center justify-between bg-surface/50 backdrop-blur border-b border-white/5">
        <div className="text-2xl font-bold bg-gradient-to-r from-discord to-indigo-400 bg-clip-text text-transparent">
          Distock
        </div>
        <a href="https://github.com/DisboxApp/web" className="text-sm text-textSecondary hover:text-white">Github</a>
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-4xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 mt-12 bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
          Stockage Cloud Illimité sur Discord
        </h1>
        <p className="text-xl text-textSecondary mb-12 max-w-2xl">
          Contournez les limites. Gratuit, rapide, sécurisé.
          Entrez un Webhook URL Discord pour commencer.
        </p>

        <form onSubmit={handleSetup} className="w-full max-w-xl bg-surface/80 p-8 rounded-2xl shadow-xl border border-white/10 backdrop-blur">
          <div className="text-left mb-6 space-y-4">
            <h3 className="text-lg font-semibold text-discord">Configuration Rapide</h3>
            <ol className="list-decimal pl-5 space-y-2 text-textSecondary text-sm">
              <li>Créez un serveur Discord privé.</li>
              <li>Allez dans Paramètres du Serveur {">"} Intégrations {">"} Webhooks.</li>
              <li>Cliquez sur Créer, puis Copier l'URL du Webhook.</li>
              <li>Collez l'URL ci-dessous. Elle sera hachée et ne quittera jamais votre appareil en l'état.</li>
            </ol>
          </div>
          <input
            type="password"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://discord.com/api/webhooks/..."
            className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-discord transition-all mb-4"
          />
          <button type="submit" disabled={!webhook} className="w-full bg-discord hover:bg-discord/80 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-lg transition-colors">
            Accéder au Drive
          </button>
        </form>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full mt-24 mb-12">
           <div className="bg-surface p-6 rounded-xl border border-white/5 text-left">
              <Zap className="w-8 h-8 text-discord mb-4"/>
              <h3 className="text-lg font-bold mb-2">Très Rapide</h3>
              <p className="text-textSecondary text-sm">Streaming direct depuis les CDN de Discord. Fichiers immenses supportés via chunking asynchrone.</p>
           </div>
           <div className="bg-surface p-6 rounded-xl border border-white/5 text-left">
              <Cloud className="w-8 h-8 text-discord mb-4"/>
              <h3 className="text-lg font-bold mb-2">Illimité</h3>
              <p className="text-textSecondary text-sm">Stockez autant de données que vous avez de messages disponibles. Pas de frais, jamais.</p>
           </div>
           <div className="bg-surface p-6 rounded-xl border border-white/5 text-left">
              <Shield className="w-8 h-8 text-discord mb-4"/>
              <h3 className="text-lg font-bold mb-2">Local & Sûr</h3>
              <p className="text-textSecondary text-sm">L'extension Chrome ou l'API Proxy gère les flux en RAM locale. Votre Webhook est sécurisé au hash.</p>
           </div>
        </div>
      </main>
    </div>
  );
}
