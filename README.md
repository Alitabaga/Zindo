# Zindo — Fraîcheur et naturel

Site de commande de légumes préparés, avec espace admin : produits, commandes, tournée de livraison optimisée, ventes, service client.

- **Boutique (clients)** : `https://votre-site/`
- **Admin** : `https://votre-site/admin`

---

## 1. Installer et lancer sur votre ordinateur (Windows ou Mac)

### Une seule fois

1. Installez **Node.js 24 (LTS)** depuis https://nodejs.org (bouton « LTS »). Acceptez les options par défaut.
2. Téléchargez le projet :
   - depuis GitHub : `git clone https://github.com/VOTRE-COMPTE/zindo.git`
   - ou copiez simplement le dossier `zindo`.
3. Ouvrez un terminal **dans le dossier `zindo`** :
   - **Windows** : ouvrez le dossier dans l'Explorateur, tapez `powershell` dans la barre d'adresse, puis Entrée.
   - **Mac** : clic droit sur le dossier → *Nouveau terminal au dossier*.
4. Installez les dépendances :
   ```
   npm install
   ```
5. Créez votre fichier de réglages : copiez `.env.example` en `.env`, puis ouvrez `.env` et choisissez un mot de passe admin.
   - **Windows (PowerShell)** : `copy .env.example .env` puis `notepad .env`
   - **Mac** : `cp .env.example .env` puis `open -e .env`

### À chaque utilisation

```
npm start
```
Ouvrez ensuite http://localhost:3000 (boutique) et http://localhost:3000/admin (admin).
Pour arrêter : `Ctrl + C` dans le terminal.

> Sans fichier `.env`, le mot de passe admin par défaut est `zindo2026` (uniquement pour tester sur votre ordinateur).

---

## 2. Mettre en ligne gratuitement sur alwaysdata

Une fois en ligne, le site fonctionne même quand votre ordinateur est éteint, et vous gérez tout depuis votre téléphone.

### a) Créer le compte
1. Inscrivez-vous sur https://www.alwaysdata.com et choisissez l'offre **gratuite** (« Free »).
2. Notez le nom de compte choisi : votre site sera `https://NOMDUCOMPTE.alwaysdata.net`.

### b) Envoyer le code
Le plus simple, depuis GitHub :
1. Dans le panneau alwaysdata : **Accès distant → SSH**, activez la connexion par mot de passe pour votre utilisateur.
2. Ouvrez le terminal SSH, depuis le panneau (*Accès distant → SSH → lien « SSH web »*) ou depuis votre ordinateur :
   ```
   ssh NOMDUCOMPTE@ssh-NOMDUCOMPTE.alwaysdata.net
   ```
3. Dans ce terminal :
   ```
   git clone https://github.com/VOTRE-COMPTE/zindo.git
   cd zindo
   npm install --omit=dev
   ```
   Si votre dépôt GitHub est **privé**, GitHub demandera un identifiant : utilisez un *Personal access token* comme mot de passe.

### c) Choisir la version de Node.js
Panneau alwaysdata → **Environnement → Node.js** : sélectionnez la version **22.13 ou plus récente** (idéalement 24).

### d) Créer le site
Panneau → **Web → Sites → Ajouter un site** :

| Champ | Valeur |
|---|---|
| Adresses | `NOMDUCOMPTE.alwaysdata.net` |
| Type | **Node.js** |
| Commande | `node --env-file-if-exists=.env server.js` |
| Répertoire de travail | `zindo` |
| Variables d'environnement | `NODE_ENV=production` et `ADMIN_PASSWORD=un-mot-de-passe-solide` |

Dans l'onglet **SSL**, cochez « Forcer HTTPS ». Le https est indispensable pour que le bouton « Utiliser ma position » marche sur les téléphones.

Enregistrez, puis ouvrez `https://NOMDUCOMPTE.alwaysdata.net` : la boutique s'affiche. 🎉

### e) Mettre à jour le site plus tard
Après avoir poussé vos modifications sur GitHub :
```
ssh NOMDUCOMPTE@ssh-NOMDUCOMPTE.alwaysdata.net
cd zindo && git pull && npm install --omit=dev
```
Puis panneau → **Web → Sites → (votre site) → Redémarrer**.

> Les données en ligne (commandes, produits, photos) sont dans `zindo/data/` sur le serveur. `git pull` n'y touche **jamais**.

---

## 3. Première configuration (Admin → Paramètres)

1. **Numéro WhatsApp de la boutique** (ex. `05 04 00 40`) : affiché aux clients, utilisé pour les boutons Appeler et WhatsApp.
2. **Point de base** (privé) : départ par défaut de la tournée. Il n'est jamais montré aux clients.
3. **Livraison** : 250 F, tarif unique, modifiable.
4. **Horaires** : matin dès 7h (commande la veille avant minuit), soir dès 16h (commande le jour même jusqu'à 15h).
5. **Produits** : remplacez les produits d'exemple par les vôtres, avec des photos.

---

## 4. Utilisation au quotidien

1. Un client vous écrit sur WhatsApp → vous lui envoyez le lien du site.
2. Il remplit son panier, choisit matin ou soir, indique sa position et valide. Il peut aussi vous envoyer sa commande sur WhatsApp en un clic.
3. Dans l'admin :
   - **Commandes** : liste par date et par créneau, quantités à préparer, confirmation WhatsApp en un clic.
   - **Tournée** : ordre de livraison optimisé depuis votre position, heures d'arrivée estimées, itinéraire Google Maps, bouton « Livrée ».
   - **Messages** : demandes du service client (formulaire « Nous contacter »).
   - **Ventes** : chiffre d'affaires, produits les plus vendus, meilleurs clients.

---

## 5. Mot de passe admin

- **Changer** : Admin → Paramètres → *Mot de passe admin*. Entrez l'actuel, puis le nouveau deux fois (10 caractères minimum). Les autres appareils connectés sont déconnectés.
- **Oublié ?** Le mot de passe d'origine (celui de `ADMIN_PASSWORD` dans le fichier `.env` du serveur) peut être remis :
  ```
  ssh NOMDUCOMPTE@ssh-NOMDUCOMPTE.alwaysdata.net
  cd zindo && npm run reset-password
  ```

## 6. Sauvegardes

- **Admin → Paramètres → Télécharger une sauvegarde** : copie complète de la base (produits, commandes, messages, paramètres) sur votre ordinateur. À faire chaque semaine.
- alwaysdata garde aussi ses propres sauvegardes pendant quelques jours.
- **Restaurer** : arrêtez le site, remplacez `data/zindo.db` par le fichier de sauvegarde (renommé `zindo.db`), puis redémarrez.
- Les **photos** des produits sont dans `data/uploads/`.

---

## 7. GitHub

Ne sont **jamais** envoyés sur GitHub (voir `.gitignore`) :
- `data/` : vos commandes, les noms et numéros de vos clients, les photos ;
- `.env` : votre mot de passe admin.

Vous pouvez donc publier le code sans risque pour vos clients. Préférez quand même un dépôt **privé**.

---

## Logo

Le site utilise `public/logo.png` s'il existe. Sinon, il affiche `public/logo.svg` (une reconstitution). Pour utiliser votre fichier exact, enregistrez-le sous `public/logo.png`.

## Réglages techniques (`.env`)

| Variable | Rôle |
|---|---|
| `ADMIN_PASSWORD` | Mot de passe admin (obligatoire en ligne, 10 caractères min.) |
| `NODE_ENV` | `production` en ligne |
| `PORT` / `IP` | Fournis automatiquement par l'hébergeur |
| `DATA_DIR` | Dossier des données (par défaut `./data`) |
| `TZ` | Fuseau horaire (par défaut `Africa/Ouagadougou`) |
