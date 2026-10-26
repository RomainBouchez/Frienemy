# Frienemy

Un quiz entre amis à lancer sur ton PC. Pas de compte, pas d'appli à installer : chacun rejoint la partie depuis son téléphone en scannant un QR code.

## Prérequis

- **Node.js 22 ou plus** : https://nodejs.org
- **Git**, pour cloner le projet

## Lancer

```
git clone https://github.com/RomainBouchez/Frienemy.git
cd Frienemy
npm start
```

Au premier lancement, les dépendances s'installent toutes seules. Le terminal affiche alors :

- l'adresse à ouvrir dans le navigateur ;
- un QR code à scanner avec les téléphones (ils doivent être sur le même Wi-Fi que le PC) ;
- le **PIN admin**, généré au hasard, nécessaire pour la page d'administration.

Pour arrêter le serveur, reviens dans le terminal et fais `Ctrl+C`.

## Jouer

1. Chacun scanne le QR code. L'écran « Qui es-tu ? » s'ouvre : la tuile « + » permet de créer son pseudo. La photo est facultative ; sans photo, ton initiale s'affiche sur une pastille colorée.
2. L'hôte (le premier arrivé, ou le premier connecté ensuite) lance la partie depuis le salon.
3. Les questions tournent, les résultats s'affichent, et un débrief clôt la partie.

## Administration

Ouvre `http://<adresse du PC>:3000/admin.html` (le lien « Admin » est en bas de la page joueur) et saisis le PIN du terminal. La page permet de gérer les invités, les questions, les types de questions et les réglages de la partie.

Paramètres facultatifs au lancement, à mettre avant `npm start` :

- `PORT` : port du serveur (3000 par défaut) ;
- `ADMIN_PIN` : un PIN fixe au lieu du PIN aléatoire ;
- `DATA_DIR` : dossier des données (questions, invités, photos). Par défaut `data/`.

## Les 8 types de questions

- **QCU** : une seule réponse, parmi les options ou les joueurs.
- **QCM** : plusieurs réponses, avec un maximum facultatif.
- **Classement** : ranger des éléments du plus au moins.
- **Intelligent / Débile** : glisser le jeton « Intelligent » ou « Débile » sur la photo d'un joueur.
- **Tierlist** : ranger des éléments dans les rangs S, A, B, C ou D.
- **Anecdote** : chacun écrit une anecdote, puis chaque anecdote est reliée à son auteur.
- **Devine sa réponse** : un joueur tiré au hasard répond en secret, les autres devinent sa réponse.
- **Quelle était la question ?** : un joueur répond en secret à une question parmi plusieurs, les autres devinent laquelle.

## La roue qui balance

Après certaines questions, une roue peut désigner au hasard un joueur et révéler sa réponse à tout le monde. La chance qu'elle apparaisse se règle dans la page d'administration.

## Les questions

Huit questions d'exemple, une par type, sont fournies dans `data/questions.seed.json`. Elles sont copiées une fois dans `data/questions.json` au premier lancement. Tu peux ensuite les modifier, en ajouter ou en retirer depuis la page d'administration.
