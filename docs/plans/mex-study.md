# Etude : `mex-memory/mex`, ce qui peut servir a AiDex

Date : 2026-10-03. Statut : **etude, aucun code**. Version etudiee : `mex`
0.8.3 (clone `main`, depth 50).

Etiquetage : MESURE (commande + sortie), DEDUIT (lecture de code), SUPPOSE.

## 1. Ce qu'est `mex`

TypeScript (~133k lignes sous `src/`, `wc -l`), Node >= 22.5, SQLite FTS5,
tree-sitter. Deux produits dans un :

1. **Memoire projet d'equipe** : wiki Markdown versionne sous `.mex/`
   (architecture, decisions, conventions), Inbox (propositions revues),
   Relays (passations entre personnes), Members, Activity, `mex log` /
   `mex timeline`, Hub web local, TUI. Partage par Git.
2. **Code Graph** : TS/TSX, JS, Python, Rust, C# partiel ; resolveurs de
   routes Express, Next.js, FastAPI, Flask, NestJS. Commandes `graph scope
   "<tache en langage naturel>"`, `graph query where-defined|who-calls`,
   `impact`.

Interface agent : **CLI + skills**, pas MCP. Le paquet `packages/mex-mcp`
existe mais n'est pas publie (README, section "MCP server - source only").
Telemetrie pseudonyme **activee par defaut**.

## 2. Ce qui est hors perimetre AiDex

Toute la partie memoire d'equipe (wiki, Inbox, Relays, Members, timeline,
Hub). AiDex a deja retire de `tools/list` les equivalents `note`, `task`,
`tasks`, `log` sur mesure : 0 a 5 appels agent sur la trace (CLAUDE.md,
section Outils). L'operateur travaille seul ; la doctrine refuse la
complexite pour des profils hypothetiques. **Ne pas importer.**

## 3. Ce qui recoupe AiDex, piste par piste

### 3.1 `graph scope` : un appel, un paquet de preuves borne

DEDUIT (`src/graph/scope.ts`, 2 742 lignes) : requete en langage naturel
decoupee en composants d'identifiants, fusion RRF (k=60) entre FTS sur les
noeuds du graphe et chunks de source, expansion par aretes (`calls`,
`references`, `imports`...), puis rendu avec **le source complet des
symboles retenus** (`reason: complete-symbol`), des flots d'appel et des
tests, sous budget.

Resultat publie par l'auteur (`evaluate/RESULTS.md`, non reproduit ici) :
12 taches x 1 repetition, Sonnet, bras "files" (Read/Grep/Glob) contre bras
"scope force en premier" : -54,5 pourcent de tokens nouveaux, 7/12 contre
6/12 reponses correctes. Ses propres limites : une repetition, un modele,
et sur Hono seul le gain total tombe a -7,4 pourcent.

Grille de la doctrine :
- Le volet **graphe / flots** est la piste close 8 : ne pas rouvrir.
- Le volet **langage naturel** se heurte a une mesure locale : `aidex_search`
  pese 4,3 pourcent des recherches (42 contre 933). L'agent formule des
  identifiants, pas des phrases.
- Le volet **source complet du symbole dans la reponse** n'est PAS couvert
  par une piste close. C'est le mecanisme qui supprime le `Read` qui suit
  une recherche. AiDex stocke deja `methods.body_text` (+ `body_lines`,
  `body_truncated`) mais ne l'utilise que pour l'affichage embeddings
  (`src/embeddings/migrate-display.ts:136`) : aucun outil MCP ne le rend
  (DEDUIT, `grep body_text src`).

### 3.2 Resultats marques "stale" et repli sur le texte vivant

DEDUIT : `scope` marque `textOnly` les fichiers non indexes, mal parses ou
modifies depuis l'indexation, et rend alors des fenetres du texte actuel
plutot que des numeros de ligne perimes (`src/graph/scope.ts:1192`, `2608`).

Cote AiDex : `src/commands/query.ts` ne contient aucune verification de
fraicheur (`grep -n stale` vide ; seul `outline.ts:111` en a une). La
reindexation passe par la paire de hooks `aidex-queue-edit.py` (PostToolUse)
puis `aidex-queue-drain.py` (Stop) : **pendant un tour**, un fichier edite
rend des lignes perimees ; les changements hors Claude Code (`git pull`,
`checkout`, editeur) ne sont couverts que par `aidex_update`. Ampleur reelle :
inconnue (SUPPOSE qu'elle est faible, a mesurer).

### 3.3 Grounding et derive : hash de corps par symbole

DEDUIT (README, `src/graph/fingerprint.ts`, `grounding.ts`) : une affirmation
du wiki pointe vers un noeud du graphe ; `mex` stocke l'ID, une empreinte
d'identite et un **hash du corps**, et classe chaque reference en intact /
change / deplace / manquant / ambigu.

Interet pour ce fork : CLAUDE.md et `docs/` citent du code (`src/db/
database.ts:242`, `DEFAULT_DISABLED_TOOLS`, `src/server/tools.ts`...). Un
controle de derive de ces references eviterait qu'une doc ne pointe a faux.
Mais il ne supprime aucun `grep` de l'agent : question 1 de la doctrine en
echec, priorite basse.

Convergence a noter : `sem` (voir `sem-entity-diff-study.md`) et `mex` ont
chacun un **hash par entite** (structurel chez `sem`, de corps chez `mex`).
Si AiDex en ajoute un, une seule colonne servirait aux deux usages (diff
entite et derive de doc).

### 3.4 Resolveurs de routes de frameworks

Repondent a "quel handler sert `/api/x`", question typiquement resolue par un
`grep` de la chaine de route. Aucune mesure du besoin sur la trace locale
(SUPPOSE). A verifier d'abord : la dimension `literal` d'AiDex rend-elle deja
ces chaines ? Question binaire, un `aidex_query` en `kinds: ["literal"]`
sur un projet Express ou FastAPI du poste suffit.

### 3.5 Le harnais d'evaluation : l'apport le plus aligne sur la doctrine

DEDUIT (`EVAL_SYSTEM_PLAN.md`, `evaluate/compare/`) : sessions headless
`claude -p ... --output-format stream-json --verbose`
(`evaluate/compare/lib/runner.mjs:153`), deux bras par tache, ordre des bras
equilibre, reponses anonymisees puis notees contre le source avant levee de
l'identite des bras, tokens lus dans `usage` (`input_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`), comparaison en
**delta apparie par tache** et non en total absolu, a cause des caches de
prompt cote fournisseur.

Ces principes recoupent ceux deja payes par ce depot : "`/context` n'est pas
un instrument de facturation, lire `usage`" ; "ne jamais publier un ratio
dont les deux nombres ne viennent pas du meme chemin". AiDex mesure
aujourd'hui par proxy sur la trace (fichier ouvert apres une recherche). Un
A/B headless mesure directement la grandeur pour laquelle AiDex existe.

## 4. Comment mesurer

Source trace : `.claude/CLAUDE.local.md` (absente du conteneur cloud ou cette
etude a ete faite ; a executer sur le poste).

**M1, `Read` apres recherche (pour 3.1).** Pour chaque `aidex_query` /
`aidex_signature` de la trace, regarder les 3 `tool_use` suivants. Compter
les `Read` d'un fichier present dans le resultat, et ventiler : fichier
entier vs `offset/limit` ; taille du `tool_result` du `Read` (octets).
Rendre separement le nombre d'appels, de sessions, la mediane et la somme.
Puis : la plage lue recouvre-t-elle une methode presente dans `methods` ? Si
oui, `body_text` aurait pu la servir. C'est la borne haute du gain.

**M2, `body_text` utilisable (pour 3.1).** Sur l'index du poste : part des
methodes avec `body_truncated = 1`, distribution de `body_lines`. Un corps
tronque ne supprime pas le `Read`.

**M3, fraicheur (pour 3.2).** Pour chaque `aidex_query` de la trace,
le fichier du resultat a-t-il ete `Edit` / `Write` plus tot dans le meme
tour, sans Stop intermediaire ? Compter les cas. Si quasi nul, fermer.

**M4, routes (pour 3.4).** Compter les `Grep` / `Bash grep` dont le motif
ressemble a une route (`^/` ou `'/api`). Puis la question binaire
`kinds: ["literal"]` ci-dessus.

**M5, harnais A/B (pour 3.5).** Reprendre la methode, pas le code : 10 a 20
taches reelles tirees de la trace (pas ecrites a la main), deux bras
"AiDex desactive" (`AIDEX_TOOLS_DISABLE` sur tous les outils, ou serveur non
monte) contre "AiDex monte", ordre alterne, au moins 2 repetitions, delta
apparie de `cache_creation_input_tokens + input_tokens + output_tokens`,
`cache_read_input_tokens` rendu a part. Attention au piege de
`ENABLE_TOOL_SEARCH` : le schema d'un outil differe est paye quand meme
(CLAUDE.md, section Outils).

## 5. Quoi faire, par ordre de priorite

1. **M5 d'abord** : un harnais A/B donne l'instrument qui manque pour juger
   toutes les autres pistes, y compris celles de `sem`. Script hors `src/`
   (par exemple `scripts/eval/`), aucun cout `tools/list`.
2. **M1 + M2** : si le `Read` apres recherche pese, exposer `body_text` via
   un parametre d'un outil existant (par exemple `include_body` sur
   `aidex_signature`), plafonne, plutot qu'un nouvel outil. Mesurer le cout
   du schema ajoute (tarif 4,2 a 4,5 octets / token).
3. **M3** : si non negligeable, marquer `[stale]` les resultats de fichiers
   dont le hash disque differe de `files.hash` (stat + hash a la demande,
   uniquement sur les fichiers rendus).
4. **3.3 et 3.4** : seulement apres mesure, priorite basse.
5. **Ne pas importer** : memoire d'equipe (section 2), recherche langage
   naturel (contredite par la mesure `aidex_search`), graphe / flots (piste
   close 8).
