import { useState } from 'react';
import type { FormEvent } from 'react';
import { useDriveStore } from '../store/useDriveStore';
import { Shield, Zap, Cloud, Info, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export function LandingPage() {
  const [webhook, setWebhook] = useState('');
  const [showMultiHookTutorial, setShowMultiHookTutorial] = useState(false);
  const setWebhookUrl = useDriveStore(s => s.setWebhookUrl);
  const navigate = useNavigate();

  const handleSetup = (e: FormEvent) => {
    e.preventDefault();
    const rawUrls = webhook.split(/[\n, ]+/).map(s => s.trim()).filter(Boolean);
    if (rawUrls.length === 0) {
       alert("Veuillez entrer au moins une URL.");
       return;
    }
    for (const url of rawUrls) {
      if (!url.includes('discord.com') && !url.includes('discordapp.com')) {
        alert("Une ou plusieurs URLs sont invalides : " + url);
        return;
      }
    }
    setWebhookUrl(rawUrls.join(','));
    navigate('/drive');
  };

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col">
      <nav className="p-4 flex items-center justify-between bg-surface/50 backdrop-blur border-b border-white/5">
        <div className="text-2xl font-bold bg-gradient-to-r from-discord to-indigo-400 bg-clip-text text-transparent">
          Distock
        </div>
        <a href="https://github.com/distockapp/distock" target="_blank" rel="noopener noreferrer" className="text-sm text-textSecondary hover:text-white">Github</a>
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-4xl mx-auto">
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 mt-12 bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
          Stockage Cloud Illimité sur Discord
        </h1>
        <p className="text-xl text-textSecondary mb-12 max-w-2xl">
          Contournez les limites. Gratuit, rapide, sécurisé.
          Entrez un Webhook URL Discord pour commencer.
        </p>

        <form onSubmit={handleSetup} className="w-full max-w-xl bg-surface/80 p-8 rounded-2xl shadow-xl border border-white/10 backdrop-blur relative z-10">
          <div className="text-left mb-6 space-y-4">
            <div className="flex items-center justify-between">
               <h3 className="text-lg font-semibold text-discord">Configuration Rapide</h3>
               <button 
                  type="button" 
                  onClick={() => setShowMultiHookTutorial(true)}
                  className="px-3 py-1 bg-discord/20 hover:bg-discord/30 text-discord text-xs font-bold rounded-full flex items-center gap-1.5 transition-colors"
               >
                  <Info className="w-3.5 h-3.5" />
                  Tutoriel MultiHook
               </button>
            </div>
            <ol className="list-decimal pl-5 space-y-2 text-textSecondary text-sm">
              <li>Créez un serveur Discord privé.</li>
              <li>Allez dans Paramètres du Serveur {">"} Intégrations {">"} Webhooks.</li>
              <li>Cliquez sur Créer, puis Copier l'URL du Webhook.</li>
              <li>Collez l'URL ci-dessous. Par mesure de sécurité, elle est chiffrée localement : personne d'autre n'y aura jamais accès.</li>
            </ol>
          </div>
            <textarea
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://discord.com/api/webhooks/...\nhttps://discord.com/api/webhooks/..."
              className="w-full h-32 bg-background border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-discord transition-all mb-4 resize-y"
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

      {showMultiHookTutorial && (
         <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
            <div className="bg-surface border border-white/10 rounded-2xl p-6 max-w-lg w-full shadow-2xl relative">
               <button 
                  onClick={() => setShowMultiHookTutorial(false)}
                  className="absolute top-4 right-4 text-textSecondary hover:text-white transition-colors p-1"
               >
                  <X className="w-5 h-5" />
               </button>
               
               <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-full bg-discord/20 flex items-center justify-center text-discord">
                     <Zap className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">Le réseau MultiHook</h2>
                    <p className="text-xs text-discord uppercase tracking-wider font-semibold">Tutoriel & Optimisation</p>
                  </div>
               </div>

               <div className="space-y-4 text-sm text-textSecondary leading-relaxed">
                  <p>
                     Distock permet l'envoi de fichiers extrêmement volumineux (ex: 15 Go). Pour que Discord ne bloque pas la connexion, **l'application répartit la charge simultanément sur plusieurs Webhooks**.
                  </p>
                  <div className="bg-black/30 p-4 rounded-xl border border-white/5 relative overflow-hidden">
                     <div className="absolute left-0 top-0 bottom-0 w-1 bg-discord"></div>
                     <p className="font-semibold text-white mb-2">Vaut-il mieux créer mes webhooks dans des salons ou des serveurs différents ?</p>
                     <p>
                        **Toujours dans des serveurs différents !**<br/>
                        Discord possède une sécurité anti-DDoS "par serveur". Si vous lancez 5 webhooks sur un même serveur en même temps, le serveur entier sera paralysé. En recréant 3 ou 4 serveurs Discord vierges (ce qui prend 30 secondes), vous isolez vos limites.
                     </p>
                  </div>
                  <ol className="list-decimal pl-4 space-y-2 mt-4 text-white/90">
                     <li>Créez le Serveur A, le Serveur B et le Serveur C.</li>
                     <li>Générez un Webhook dans chacun.</li>
                     <li>Collez les 3 URLs ici-même dans le champ texte, les unes en dessous des autres.</li>
                  </ol>
                  <p className="mt-4 text-xs italic text-white/50">
                     Le premier lien sera toujours le "Maître" qui retiendra vos fichiers. Les suivants ne serviront que d'espace d'envoi.
                  </p>
               </div>

               <div className="mt-6 flex justify-end">
                  <button 
                     onClick={() => setShowMultiHookTutorial(false)}
                     className="px-5 py-2.5 bg-discord hover:bg-discordHover text-white font-semibold rounded-xl transition-colors"
                  >
                     J'ai compris !
                  </button>
               </div>
            </div>
         </div>
      )}
    </div>
  );
}
