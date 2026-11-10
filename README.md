# SoundCampaign Monitor — Option 2 (lecture de la réponse JSON du navigateur)

Cette version utilise Playwright pour ouvrir la page Tracks Feed. Elle observe la requête `available-reviews` que la page SoundCampaign déclenche elle-même, puis lit `meta.itemCount` dans sa réponse JSON. Elle n'utilise aucun sélecteur CSS `TRACK_*` et n'effectue pas de requête API SoundCampaign séparée depuis le script.

## Fichiers à remplacer dans le dépôt

- `monitor.mjs`
- `.github/workflows/monitor.yml`
- `state/seen.json`

Garder les autres fichiers existants, notamment `package.json` et `save-session.mjs`.

## Configuration GitHub

Secrets (Settings → Secrets and variables → Actions → Secrets) :

- `SOUND_CAMPAIGN_STORAGE_STATE` : stockage de session exporté et encodé en base64
- `PUSHOVER_USER_KEY`
- `PUSHOVER_API_TOKEN`

Variables (Settings → Secrets and variables → Actions → Variables) :

- `SOUND_CAMPAIGN_URL` : URL de la page Tracks Feed dans le navigateur, pas l'URL de l'API
- `BASELINE_ONLY` : `true` pour le premier lancement de référence, puis `false`

Aucune variable `TRACK_CARD_SELECTOR`, `TRACK_ID_SELECTOR`, `TRACK_TITLE_SELECTOR`, `TRACK_ARTIST_SELECTOR`, `TRACK_LINK_SELECTOR` ou `TRACK_READY_SELECTOR` n'est nécessaire.

## Premier lancement

1. Remplacer les trois fichiers ci-dessus et committer.
2. Vérifier que les quatre secrets/variables ci-dessus sont correctement configurés.
3. Laisser `BASELINE_ONLY=true` et lancer Actions → SoundCampaign Monitor → Run workflow. Cette exécution enregistre le nombre initial de soumissions sans notification.
4. Après le succès, régler `BASELINE_ONLY=false` dans les variables GitHub.
5. Les exécutions ultérieures envoient une notification Pushover uniquement lorsque `meta.itemCount` augmente.

## Limite importante

La détection repose sur le nombre total `meta.itemCount`, pas sur des identifiants individuels. Si une soumission disparaît au même moment qu'une autre arrive, le nombre peut rester identique et cette arrivée pourrait ne pas être signalée. Ce choix évite d'enregistrer ou d'afficher les détails des morceaux.

Le cron `*/5 * * * *` demande une exécution toutes les cinq minutes, mais GitHub Actions peut retarder les lancements. Vérifier que l'automatisation de navigation/lecture est autorisée par SoundCampaign et ne pas contourner les CAPTCHA, restrictions ou limites du service.

Ne jamais committer `storage-state.json` ni partager sa valeur : il contient des données de session.
