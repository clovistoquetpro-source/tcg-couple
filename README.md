# Nos Cartes

Un petit jeu de cartes à collectionner privé, avec nos photos (interface en anglais). Un pack de 5 cartes toutes les 2 heures (jusqu'à 2 packs gardés en réserve), 5 raretés, une collection chacun.

## Comment ça marche

- **Site statique** (HTML, CSS, JS, sans étape de build), hébergé gratuitement sur Vercel.
- **Supabase** (version gratuite) pour les comptes, les photos (bucket privé `cards`) et les collections.
- Le pack est tiré côté serveur par la fonction `open_pack()` : impossible de tricher sur l'attente. `profiles.pack_clock` compte les packs en réserve, jusqu'à `game_settings.max_stored_packs`.
- Les taux de drop, les chances Holo/Gold et l'attente sont dans la table `game_settings` et se modifient dans l'onglet Profile de l'app. L'écran « Drop rates » les affiche.
- Seuls les comptes listés dans la table `allowed_emails` peuvent exister et voir quoi que ce soit.
- On se connecte avec un **pseudo** (il devient `pseudo@tcg-couple.app` dans Supabase, aucun email n'est envoyé).

## Probabilités par carte (réglages par défaut)

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

Chaque version se collectionne à part.

## Pièces

Chaque doublon rapporte des pièces (Commune 5, Peu commune 10, Rare 25, Épique 60, Légendaire 150, ×2 en Holo ou Gold). Un pack s'achète 150 pièces avec `buy_pack()`, sans attendre. Les valeurs se règlent dans Profile → Game settings.

## Jeux (onglet Play)

- **Blocks** : on glisse des formes sur une grille 8×8, chaque ligne ou colonne pleine disparaît. Chaque ligne rapporte 3 pièces (`blocks_lines()`), jusqu'à 300 pièces par jour. La partie est gardée dans le téléphone si on quitte la page.
- **Burger Shop** : des clients attendent au comptoir avec leur commande. Le steak, le bacon et les saucisses cuisent sur le grill et les frites dans la friteuse : il faut les sortir quand l'aiguille est dans le vert, sinon ils brûlent et partent à la poubelle (−2 $). Il y a 3 assiettes pour préparer plusieurs commandes à la fois : on glisse un pain sur une assiette, puis chaque ingrédient sur ce pain dans l'ordre de la bulle (burger ou hot-dog), on ajoute frites et boisson, puis on glisse l'assiette sur le client (ou à la poubelle). Chaque commande servie rapporte 4 pièces (`burger_serve()`), dans le même plafond du jour ; 3 clients fâchés et la boutique ferme.
- **Marbles** : un jeu à la Zuma. Une chaîne de billes roule vers le trou (sur une spirale ou un cœur, selon le niveau) ; on tire depuis le cœur au centre, et 3 billes de la même couleur ou plus disparaissent. Certaines billes donnent un bonus : ralentir, reculer ou exploser. Chaque niveau réussi rapporte 10 pièces (`marbles_level()`), dans le même plafond du jour ; le meilleur niveau est gardé dans `profiles.marbles_best`.
- **2048 Cards** : le 2048 avec vos cartes. On fait glisser la grille, deux cartes égales fusionnent ; 2 et 4 sont communes, puis peu communes, rares, épiques, légendaires, et Gold à partir de 2048, chacune avec une photo de votre collection. Chaque nouvelle carte de 128 ou plus dans une partie rapporte des pièces (`merge_tile()`, 5 × 1 à 128 et 256, × 2 à 512, × 4 à 1024…), dans le même plafond du jour.
- **7 Differences** : une de vos photos et une copie retouchée en 7 petits endroits aux bords fondus (morceau retourné, recopié, effacé, agrandi, légèrement recoloré ou assombri). On touche les différences sur l'une ou l'autre photo ; 3 vies, l'indice en coûte une. Chaque photo résolue rapporte des pièces (`spot_round()`, 15 par défaut, réglable dans le profil), dans le même plafond du jour.
- **Puzzle** : une photo de vos cartes découpée en 3×3, 4×4 ou 5×5 morceaux à remettre en place en les échangeant. Un puzzle fini rapporte 2 pièces par morceau (`claim_puzzle()`), dans le même plafond du jour que Blocks.
- **Memory** : 6 paires de vos cartes. La première partie du jour rapporte jusqu'à 50 pièces selon le nombre de coups (`claim_memory()`).

Le gain par ligne, par morceau, par commande, par niveau de billes et le plafond du jour se règlent dans Profile → Game settings.

## Mettre en ligne sur Vercel

1. Aller sur https://vercel.com/new et se connecter avec GitHub.
2. Importer le dépôt `tcg-couple`.
3. Framework : « Other », sans commande de build. Cliquer sur Deploy.

## Depuis la Chine

`*.vercel.app` est bloqué en Chine. La même app est aussi publiée par GitHub Pages sur https://clovistoquetpro-source.github.io/tcg-couple/ (même base de données, mise à jour à chaque push). Les polices sont dans `fonts/` au lieu de Google Fonts, qui est aussi bloqué là-bas.

## Fichiers

- `index.html`, `style.css`, `app.js` : l'app
- `config.js` : adresse et clé publique Supabase, durée d'attente
- `sw.js`, `manifest.webmanifest`, `icons/` : installation sur l'écran d'accueil
- `vendor/supabase.js` : bibliothèque Supabase 2.45.4 (copiée pour ne dépendre d'aucun CDN)
