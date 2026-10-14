# Nos Cartes

Un petit jeu de cartes à collectionner privé, avec nos photos. Un booster de 5 cartes toutes les 4 heures, 5 raretés, une collection chacun.

## Comment ça marche

- **Site statique** (HTML, CSS, JS, sans étape de build), hébergé gratuitement sur Vercel.
- **Supabase** (version gratuite) pour les comptes, les photos (bucket privé `cards`) et les collections.
- Le booster est tiré côté serveur par la fonction `open_pack()` : impossible de tricher sur l'attente de 4 h.
- Seuls les comptes listés dans la table `allowed_emails` peuvent exister et voir quoi que ce soit.
- On se connecte avec un **pseudo** (il devient `pseudo@tcg-couple.app` dans Supabase, aucun email n'est envoyé).

## Probabilités par carte

| Rareté | Chance |
| --- | --- |
| Commune | 60 % |
| Peu commune | 25 % |
| Rare | 10 % |
| Épique | 4 % |
| Légendaire | 1 % |

La 5e carte de chaque booster est au moins peu commune.

## Versions spéciales

- **Holo** : une épique tirée a 1 chance sur 4 d'être en version Holo (feuille arc-en-ciel).
- **Gold** : une légendaire tirée a 1 chance sur 4 d'être en version Gold (cadre en or).

Chaque version se collectionne à part. Les taux se changent dans `open_pack()` sur Supabase (`holo_chance`, `gold_chance`).

## Mettre en ligne sur Vercel

1. Aller sur https://vercel.com/new et se connecter avec GitHub.
2. Importer le dépôt `tcg-couple`.
3. Framework : « Other », sans commande de build. Cliquer sur Deploy.

## Fichiers

- `index.html`, `style.css`, `app.js` : l'app
- `config.js` : adresse et clé publique Supabase, durée d'attente
- `sw.js`, `manifest.webmanifest`, `icons/` : installation sur l'écran d'accueil
- `vendor/supabase.js` : bibliothèque Supabase 2.45.4 (copiée pour ne dépendre d'aucun CDN)
