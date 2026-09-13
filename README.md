# Courses — liste de courses et tickets de caisse

## Fichiers de liste sur le Drive
Nom : `courses_from_AAAA-MM-JJ_to_AAAA-MM-JJ.json`, n'importe où sur le Drive (par exemple `H:\courses\2026-09\`).
L'app retrouve les fichiers par leur nom ; le dossier est libre.

```json
{
  "version": 1,
  "from": "2026-09-14",
  "to": "2026-09-20",
  "createdAt": "2026-09-13T11:00:00.000Z",
  "updatedAt": "2026-09-13T11:00:00.000Z",
  "items": [
    { "id": "…", "category": "Fruits", "name": "pommes", "qty": "7", "checked": false, "extra": false }
  ],
  "tickets": []
}
```
- `items[].id` : identifiant unique (UUID) ; `qty` est un texte libre ; `checked` = acheté ; `extra` = ajouté pendant les courses (catégorie « Hors liste »).
- `tickets[]` est rempli par l'app : `{ fileId, name, date, magasin, total }` (copie des infos du ticket au moment de la liaison).
- `updatedAt` départage la copie locale du téléphone et le fichier Drive : la plus récente gagne.

## Tickets
Fichiers `*.json` produits par Parse-Ticket.ps1 dans le dossier `tickets` à la racine du Drive.
La date est lue dans le nom du fichier (`2026.09.13.080707.132.json`), sinon dans le champ `date` (`aa/mm/jj`).

## Mise en ligne
1. Coller le client ID dans `app.js` (le même que Muscu : même origine GitHub Pages).
2. Dans la Cloud Console → Google Auth Platform → Accès aux données, ajouter le scope `https://www.googleapis.com/auth/drive`.
3. Repo GitHub `courses`, Pages activé → `https://<user>.github.io/courses/`.
4. À la première connexion, Google affiche « Google n'a pas validé cette application » : Paramètres avancés → Accéder à Courses.
