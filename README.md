# SoundCampaign Tracks Feed → Pushover (prototype Playwright)

Ce dépôt contrôle **l'interface web** de SoundCampaign avec Playwright/Chromium (pas d'appel direct à l'API SoundCampaign), puis notifie Pushover lorsqu'une carte nouvelle apparaît.

> **Important :** vérifie auprès de SoundCampaign que l'automatisation de navigation/lecture est autorisée. Le fait de passer par le navigateur ne garantit pas que cette automatisation soit permise. Respecte leurs conditions et arrête en cas de CAPTCHA, blocage, HTTP 429 ou avertissement. Ce projet ne contourne pas les protections anti-bot et n'automatise aucune review/acceptation.

## Ce qui est prêt / ce qui reste à configurer

Le workflow GitHub Actions est programmé toutes les 5 minutes. Le code est un squelette fonctionnel, mais les sélecteurs CSS des cartes et des champs doivent être relevés dans l'interface réelle : la capture Network seule ne les révèle pas. Aucun sélecteur SoundCampaign n'est inventé.

## 1. Créer le dépôt public

1. Crée un dépôt GitHub **public** vide.
2. Ajoute les fichiers de ce dossier (ou pousse-les avec Git).
3. Dans `Settings → Actions → General`, autorise les workflows et les permissions d'écriture si nécessaire.
4. Le workflow a `contents: write` pour sauvegarder `state/seen.json` après détection.

Le code sera public. Les secrets GitHub restent masqués, mais les journaux ne doivent jamais afficher les valeurs secrètes.

## 2. Préparer une session navigateur (sur ton ordinateur, une seule fois)

Prérequis : Node.js 20+.

```bash
npm install
npx playwright install chromium
npm run login
```

Un navigateur s'ouvre. Connecte-toi manuellement à SoundCampaign et ouvre Tracks Feed, puis reviens au terminal et appuie sur Entrée. Cela crée `storage-state.json`.

**Ne committe jamais `storage-state.json`, ne le joins pas à une conversation et ne le publie pas.** Il contient des cookies et peut permettre l'accès au compte. S'il est exposé, révoque la session.

Encode-le en base64 :

macOS / Linux :
```bash
base64 < storage-state.json | tr -d '\n'
```

Dans GitHub → `Settings → Secrets and variables → Actions → New repository secret`, crée :
- `SOUND_CAMPAIGN_STORAGE_STATE` = la chaîne base64 ci-dessus
- `PUSHOVER_USER_KEY` = User Key Pushover
- `PUSHOVER_API_TOKEN` = token de ton application Pushover

Le fichier local peut ensuite être supprimé de ton ordinateur si tu le souhaites.

## 3. Configurer les variables GitHub

Dans `Settings → Secrets and variables → Actions → Variables`, ajoute :

- `SOUND_CAMPAIGN_URL` : URL exacte de Tracks Feed (à récupérer dans la barre d'adresse du navigateur).
- `TRACK_CARD_SELECTOR` : sélecteur CSS d'une carte de morceau (obligatoire).
- `TRACK_ID_SELECTOR` : (facultatif) élément enfant contenant un identifiant stable, ou un élément ayant `data-id` / `id`.
- `TRACK_TITLE_SELECTOR` : (facultatif) élément enfant contenant le titre.
- `TRACK_ARTIST_SELECTOR` : (facultatif) élément enfant contenant l'artiste.
- `TRACK_LINK_SELECTOR` : (facultatif) élément enfant `<a>` vers le morceau.
- `TRACK_READY_SELECTOR` : (facultatif) sélecteur qui devient visible quand le feed est chargé.
- `BASELINE_ONLY` : `true` au premier lancement, puis supprime la variable ou remplace-la par `false`.

Pour trouver les sélecteurs : dans Chrome, ouvre Tracks Feed, clic droit sur une carte → Inspecter. Repère l'élément HTML qui englobe une carte entière, puis les éléments du titre/artiste/lien. Les sélecteurs doivent être CSS et relatifs à la carte pour les champs enfants.

## 4. Premier lancement

1. Mets `BASELINE_ONLY=true`.
2. Lance `Actions → SoundCampaign monitor → Run workflow`.
3. Vérifie les logs : le script doit indiquer `Baseline saved`.
4. Mets ensuite `BASELINE_ONLY=false` (ou supprime la variable).
5. Les exécutions suivantes notifient les nouvelles cartes.

La première exécution établit une référence et **n'envoie pas de notification** pour les morceaux déjà présents.

## 5. Fonctionnement et limites

- Cron `*/5 * * * *` : GitHub peut retarder les exécutions ; ce n'est pas une garantie d'exécution à la minute exacte.
- Le workflow est séquentiel (`concurrency`) pour éviter deux mises à jour d'état simultanées.
- Le dépôt conserve les identifiants détectés dans `state/seen.json` via un commit automatique.
- Le script ne clique pas sur les boutons d'acceptation/review et ne modifie aucune soumission.
- Si la session expire, relance `npm run login`, recrée le secret `SOUND_CAMPAIGN_STORAGE_STATE`, puis relance le workflow.
- Pushover est appelé uniquement lorsqu'un nouvel élément est détecté.
- GitHub Actions ne doit pas être utilisé pour contourner CAPTCHA, restrictions d'accès ou limites imposées par SoundCampaign.

## Dépannage

- `Missing environment variable` : secret ou variable manquant.
- `TRACK_CARD_SELECTOR` absent : configure le sélecteur CSS de carte.
- `SoundCampaign session appears expired` : renouvelle la session manuellement.
- `strict`/`timeout` Playwright : vérifie les sélecteurs et que Tracks Feed est chargé.
- Aucun résultat : la page peut avoir une liste vide, un sélecteur incorrect, ou des cartes rendues différemment. N'élargis pas les sélecteurs au hasard ; inspecte le DOM.

## Fichiers

- `.github/workflows/monitor.yml` : planification et exécution cloud.
- `monitor.mjs` : lecture du DOM, comparaison, notification.
- `save-session.mjs` : connexion manuelle initiale et sauvegarde de session.
- `state/seen.json` : créé/actualisé par le workflow.
