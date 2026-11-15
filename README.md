# SoundCampaign Monitor

Ce dépôt surveille le Tracks Feed SoundCampaign avec Playwright, lit la réponse JSON de l'endpoint utilisé par la page (`/curator/reviews/available`) et envoie une notification Pushover lorsque des soumissions sont disponibles.

Le workflow GitHub Actions se déclenche selon le cron défini dans `.github/workflows/monitor.yml` (environ toutes les cinq minutes). Chaque exécution utilise un runner temporaire : le fichier de session local est donc restauré depuis un secret GitHub au début de chaque exécution.

## Arborescence

```text
soundcampaign-monitor/
├── .github/
│   └── workflows/
│       ├── monitor.yml
│       └── test-pushover.yml
├── state/
│   └── seen.json
├── .gitignore
├── monitor.mjs
├── package.json
├── README.md
└── save-session.mjs
```

## Configuration GitHub

Dans **Settings → Secrets and variables → Actions → Secrets**, configurer :

- `SOUND_CAMPAIGN_STORAGE_STATE` : contenu Base64 du fichier local `storage-state.json` ;
- `PUSHOVER_USER_KEY` ;
- `PUSHOVER_API_TOKEN` ;
- `SESSION_SYNC_TOKEN` : facultatif pour l'exécution du monitoring, mais nécessaire à la mise à jour automatique du secret de session.

Dans **Settings → Secrets and variables → Actions → Variables**, configurer :

- `SOUND_CAMPAIGN_URL` : URL de la page Tracks Feed dans le navigateur, et non l'URL de l'API.

### Autorisations de SESSION_SYNC_TOKEN

Créer un token personnel GitHub **fine-grained**, limité au seul dépôt `soundcampaign-monitor`, avec la permission du dépôt **Secrets : Read and write**. Enregistrer sa valeur dans le secret `SESSION_SYNC_TOKEN`.

Ce token sert uniquement à demander la clé publique du dépôt, chiffrer la nouvelle valeur avec Libsodium, puis mettre à jour le secret `SOUND_CAMPAIGN_STORAGE_STATE` via l'API GitHub. Le contenu de la session n'est jamais envoyé en clair à l'API GitHub.

Si `SESSION_SYNC_TOKEN` est absent ou invalide, le monitoring continue normalement après une vérification SoundCampaign réussie, mais la synchronisation de session n'est pas effectuée ; un avertissement est inscrit dans les logs Actions.

## Création / renouvellement initial de la session

Sur ton ordinateur, à la racine du dépôt :

```bash
npm install
npx playwright install chromium
npm run login
```

Le navigateur s'ouvre. Connecte-toi en tant que **Playlist Curator**, ouvre le Tracks Feed, puis reviens au terminal et appuie sur Entrée. `save-session.mjs` enregistre les cookies, le localStorage et IndexedDB dans `storage-state.json`.

Le fichier `storage-state.json` est un identifiant de session sensible. Il est ignoré par Git via `.gitignore`. Ne le commite pas et ne le partage pas.

Encode ensuite le fichier en Base64 et remplace une fois le secret `SOUND_CAMPAIGN_STORAGE_STATE` :

```bash
node -e "process.stdout.write(require('fs').readFileSync('storage-state.json').toString('base64'))"
```

Copier la sortie dans le secret GitHub. Sur PowerShell, tu peux directement mettre le résultat dans le presse-papiers :

```powershell
node -e "process.stdout.write(require('fs').readFileSync('storage-state.json').toString('base64'))" | Set-Clipboard
```

## Synchronisation automatique de la session

Après une réponse API authentifiée et un JSON valide, `monitor.mjs` capture le nouvel état du navigateur avec `indexedDB: true`. Si l'état a changé, il :

1. sérialise l'état du navigateur ;
2. l'encode en Base64, comme attendu par l'étape de restauration du workflow ;
3. récupère la clé publique du dépôt GitHub ;
4. chiffre la valeur avec `libsodium-wrappers` ;
5. met à jour le secret `SOUND_CAMPAIGN_STORAGE_STATE`.

La synchronisation est tentée uniquement après une vérification API réussie. Une erreur de synchronisation produit un avertissement et n'annule pas une vérification valide ni une notification Pushover.

Cette fonction conserve les éventuels cookies ou jetons renouvelés par SoundCampaign. Elle ne peut pas prolonger une durée de session maximale imposée côté serveur. Si SoundCampaign redirige vers la connexion, il faut renouveler manuellement la session avec `npm run login` et mettre à jour le secret initial.

Le token GitHub `SESSION_SYNC_TOKEN` peut lui-même expirer ou être révoqué ; dans ce cas, il faudra le renouveler.

## Vérification

Lancer **Actions → SoundCampaign Monitor → Run workflow**. Dans les logs, rechercher notamment :

- `SoundCampaign response received: HTTP 200` ;
- `SoundCampaign browser state changed and was securely synchronized to GitHub.` ou `SoundCampaign browser state is unchanged...` ;
- un éventuel avertissement `Automatic SoundCampaign session sync failed`.

Ne jamais conclure qu'il n'y a aucune soumission si l'authentification, la requête API ou la lecture du JSON échoue.

## Sécurité

- Ne jamais commiter `storage-state.json`.
- Ne jamais publier `SOUND_CAMPAIGN_STORAGE_STATE` ou `SESSION_SYNC_TOKEN`.
- Ne jamais coller les contenus de ces secrets dans une issue, un log ou une conversation.
- Le workflow ne sauvegarde la session qu'après validation d'une réponse API réussie.
