# Creatis Studio — CRM  ·  Version Supabase + Vercel

Application web de gestion (CRM) pour **Creatis Studio**, imprimerie basée à Abidjan
(*Création · Impression · Fournitures de bureau · Gadgets*).

**Architecture** : Vanilla JS · Supabase (base de données + auth) · Vercel (hébergement) · PWA installable.

---

## Fonctionnalités

- **Connexion sécurisée** — écran de login, création du compte admin au premier lancement, session persistante.
- **Comptes & rôles personnalisables** — l'admin crée les utilisateurs, leur attribue un rôle, configure les droits (aucun / lecture / édition) par module et les indicateurs affichés sur chaque tableau de bord.
- **Tableau de bord adapté** — chaque rôle a ses propres indicateurs (KPIs, graphes, listes).
- **Clients & prospects** — fiches segmentées, conversion prospect → client.
- **Devis & factures** — éditeur de lignes, remises, TVA, numérotation automatique, devis → facture, paiements partiels, impression conforme.
- **Commandes & projets** — Kanban (à traiter → production → contrôle qualité → livré → facturé), échéances.
- **Comptabilité & TVA** — journal des dépenses, TVA collectée − déductible, résultat.
- **Catalogue produits** — tarifs réutilisables dans les devis/factures.
- **Multi-postes** — données partagées en temps réel via Supabase (tous les postes voient les mêmes données).
- **Sauvegarde** — export/import JSON depuis les Paramètres.

## Rôles fournis par défaut

| Rôle | Accès |
|------|-------|
| **Administrateur** | Tout, y compris la gestion des comptes et des rôles |
| **Commercial** | Clients, devis, factures, commandes, catalogue (édition) |
| **Comptable** | Comptabilité & TVA, paiements ; le reste en lecture |
| **Production** | Commandes & projets (édition) ; clients/devis/catalogue en lecture |
| **Accueil / Information** | Clients & prospects (édition) ; le reste en lecture |

L'administrateur peut modifier ces rôles, en créer de nouveaux, et personnaliser le tableau de bord de chaque profil.

---

## 🚀 Déploiement en 3 étapes

### Étape 1 — Créer et configurer Supabase

1. Allez sur [supabase.com](https://supabase.com) → **New project** (ou utilisez votre projet existant).
2. Dans votre projet Supabase → **SQL Editor** → collez et exécutez le contenu de :
   ```
   supabase/migrations/20250101000000_init.sql
   ```
   Ce script crée toutes les tables, les politiques de sécurité (RLS) et les 5 rôles par défaut.
3. Dans votre projet Supabase → **Settings → API** :
   - Copiez **Project URL** (ex: `https://abcdef.supabase.co`)
   - Copiez **anon public** key (commence par `eyJhbGciOi...`)
4. Ouvrez le fichier **`app/js/config.js`** et remplacez les placeholders :
   ```javascript
   const SUPABASE_URL      = "https://VOTRE-ID.supabase.co";      // ← coller ici
   const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR...";       // ← coller ici
   ```

### Étape 2 — Pousser sur GitHub

```bash
# Dans le dossier du projet (là où se trouve index.html)
git init
git add .
git commit -m "Creatis Studio CRM — version Supabase"
git branch -M main
git remote add origin https://github.com/VOTRE-COMPTE/creatis-crm.git
git push -u origin main
```

> **Important** : créez le dépôt GitHub en **privé** (Private) — il contient les clés Supabase et les informations légales de Creatis.

### Étape 3 — Déployer sur Vercel

1. Allez sur [vercel.com](https://vercel.com) → **Add New → Project**.
2. Importez votre dépôt GitHub `creatis-crm`.
3. Vercel détecte automatiquement que c'est un site statique (le `vercel.json` est déjà configuré).
4. Cliquez **Deploy** → votre app est en ligne en moins de 2 minutes.

L'URL ressemblera à : `https://creatis-crm-XXXXX.vercel.app`

> Pour les mises à jour futures, un simple `git push` redéploie automatiquement via Vercel.

---

## Premier lancement

1. Ouvrez l'URL Vercel dans votre navigateur.
2. L'app affiche l'écran **"Bienvenue — Créez le compte administrateur"**.
3. Remplissez votre nom, identifiant et mot de passe → **Créer le compte & entrer**.
4. Dans **Utilisateurs & rôles** → créez les comptes de votre équipe et attribuez les rôles.

---

## Installer comme application (PWA)

Une fois déployée sur Vercel (HTTPS) :
- **Android / Chrome** : menu → *Ajouter à l'écran d'accueil*
- **iOS / Safari** : *Partager* → *Sur l'écran d'accueil*
- **Ordinateur / Chrome ou Edge** : icône d'installation dans la barre d'adresse

L'app s'ouvrira en plein écran, sans la barre du navigateur.

---

## Structure du projet

```
creatis-crm/
├── index.html                          # Landing page publique (Creatis Studio)
├── app/
│   ├── index.html                      # CRM app (accès équipe → /app)
│   ├── manifest.webmanifest            # PWA manifest du CRM
│   ├── sw.js                           # Service Worker du CRM
│   ├── css/
│   │   └── style.css                   # Styles (palette CMJN, layout, composants)
│   └── js/
│       ├── config.js                   # ← REMPLIR avec vos clés Supabase
│       └── app.js                      # Application complète (RBAC, modules, sync)
├── supabase/
│   └── migrations/
│       └── 20250101000000_init.sql     # Schéma SQL à exécuter dans Supabase
├── vercel.json                         # Config Vercel (routing landing + CRM)
├── icon-192.png                        # Icône CMJN 192×192
├── icon-512.png                        # Icône CMJN 512×512
├── icon-180.png                        # Icône Apple Touch
└── favicon-64.png                      # Favicon
```

### URLs après déploiement

| URL | Contenu |
|-----|---------|
| `https://votre-site.vercel.app/` | Landing page Creatis Studio (publique) |
| `https://votre-site.vercel.app/app` | CRM (équipe interne) |


---

## Sécurité

- La clé **anon** Supabase est conçue pour être publique (c'est son rôle).
- La protection des données est assurée par le **Row Level Security (RLS)** Supabase : sans la clé, aucune donnée n'est accessible.
- Les mots de passe sont hashés en **SHA-256** (Web Crypto API) côté client avant stockage — jamais en clair.
- Pour une sécurité renforcée future : migrer vers **Supabase Auth** (email/password natif) et des politiques RLS par utilisateur.

---

## Développé par

**MonWe Infinity LLC** pour Creatis Studio — Abidjan, Côte d'Ivoire.
