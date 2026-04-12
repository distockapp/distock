# Distock

**Stockage cloud gratuit et illimité via Discord**

Distock est un client web moderne ("Serverless" côté fichiers) qui détourne l'usage principal de l'API Webhook de Discord pour l'utiliser comme un cloud personnel extrêmement performant et sans aucune limite d'espace de stockage.

🔴 **Live Demo** : [https://distockapp.github.io/distock/](https://distock.github.io/distock/)

---

## 🛠️ Table des Fonctionnalités (100% Fonctionnel)

| Feature | Statut |
|---|---|
| Login via Webhook URL | ✅ |
| Upload fichiers (avec chunking asynchrone + rate limit) | ✅ |
| Création de dossiers | ✅ |
| Téléchargement fichiers (proxy universel) | ✅ |
| Partage de fichiers publics via presse-papier | ✅ |
| Suppression fichiers / dossiers vides | ✅ |
| Renommage (inline double-clic) | ✅ |
| Navigation dossiers | ✅ |
| Tri par colonne | ✅ |
| Filtrage par colonne (Recherche Globale) | ✅ |
| Icônes dynamiques de fichiers | ✅ |
| Déplacement de fichiers (Modal GUI) | ✅ |
| Édition de fichiers (Re-upload sur même path) | ✅ |
| Menu clic-droit contextuel complet | ✅ |
| Support mobile responsive (PWA-ready) | ✅ |
| Suppression récursive profonde de dossiers non vides | ✅ |
| Upload de dossiers entiers (Drag & Drop) | ✅ |
| Téléchargement de dossiers entiers compressés en ZIP | ✅ |

---

## 🔒 Comment ça marche ?

1. **Architecture** : Vos métadonnées (chemin, taille, nom du fichier) sont stockées dans une petite base de données Cloudflare/Fly.io. Vos *données binaires réelles* sont poussées en tant que `Message Attachments` invisibles via l'API Webhook de Discord.
2. **Chunking WebWorker** : Discord limite les pièces jointes à 25MB. Distock prend n'importe quel fichier (ex: 2Go), le coupe asynchroniquement dans un `Web Worker` sans figer votre écran, et uploade chaque morceau l'un après l'autre.
3. **Sécurité Totale** : Distock **ne stocke ni ne log** votre URL Discord nulle part dans son code réseau ou de rendu. Lors de la connexion, votre URL est convertie en empreinte locale SHA-256 servant d'identifiant unique. Vos fichiers ne peuvent pas être usurpés.

---

## 🚀 Installation & Lancement en local

Assurez-vous d'avoir Node.js (v18+) installé.

```bash
# 1. Cloner le repository
git clone https://github.com/evan96969/distock.git
cd distock

# 2. Installer les dépendances
npm install

# 3. Lancer le serveur de développement local
npm run dev
```

Ouvrez ensuite le port affiché (généralement `http://localhost:5173/`).

---

## 🔑 Instructions de connexion

1. Créez un compte Discord (gratuit) si vous n'en avez pas.
2. Créez un **Nouveau Serveur** (nommez-le "Mon Cloud" par exemple).
3. Allez dans **Paramètres du Serveur > Intégrations > Webhooks**.
4. Cliquez sur **Nouveau Webhook**.
5. Cliquez sur **Copier l'URL du webhook**.
6. Allez sur Distock et collez cette URL dans le champ de connexion.

> ⚠️ **Sécurité** : Gardez cette URL privée ! Toute personne ayant cette URL peut modifier ou lire vos fichiers. Ne la partagez jamais avec aucun bot.
