# Etude : `mex-memory/mex`, ce qui peut servir a AiDex

Date : 2026-10-03. Statut : **etude, aucun code produit**, scripts de
mesure sous `scripts/eval/`. Version etudiee : `mex`
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

Script : `scripts/eval/trace_measure.py` (stdlib Python, lecture seule).
Regles de lecture des transcripts (decoupage des messages, appariement
`tool_use.id` / `tool_use_id`, debut de tour, fenetre, sous-agents,
chemins, denominateurs) : `sem-entity-diff-study.md`, section 4.1. Elles
valent ici a l'identique.

```
python scripts/eval/trace_measure.py --project AiDex --json trace-report.json
```

Les seuils sont **PROPOSES, a valider par l'operateur avant la mesure**.
Chaque bloc du JSON porte un `random_sample` (20, `--seed` fixe) a lire
verbatim avant de conclure.

Formats de sortie AiDex parses (`src/server/tools.ts`) :
- `aidex_query` : ligne `<fichier>` puis lignes `  :<n> (<type>)` ;
- `aidex_signature` : `# Signature: <fichier>` puis `(line A-B)` par type et
  methode ;
- `aidex_signatures` : `## <fichier>` puis `  - <prototype> :A-B`.
Les transcripts anciens peuvent porter un format anterieur : un resultat
non parse donne zero fichier, donc sous-compte M1 et M3 sans les fausser.
Verifier sur le `random_sample` que `files` n'est pas vide.

**M1, `Read` apres recherche (pour 3.1)** -- bloc `mex_read_after_search`.
- `calls_by_tool` : appels `aidex_query` / `signature` / `signatures` /
  `search`.
- `calls_followed_by_read_of_returned_file` : appels suivis, dans la
  fenetre, d'un `Read` d'un fichier rendu par cet appel.
- `reads_whole_file` contre `reads_partial` (`offset` / `limit` presents).
- `partial_inside_returned_method_span` : la plage lue tient dans un span
  de methode (marge 3 lignes) rendu PLUS TOT DANS LA MEME SESSION par
  `aidex_signature(s)`. C'est le cas que `body_text` aurait servi. Pas de
  biais temporel : le span vient du transcript, pas de l'index actuel.
- `partial_covering_a_returned_hit_line` : la plage lue contient une ligne
  rendue par l'appel. Indice plus faible (le hit ne dit pas ou finit la
  methode).
- `followup_read_bytes` : mediane ET somme. C'est la borne haute du gain.

Seuil PROPOSE : poursuivre si `calls_followed_by_read_of_returned_file`
>= 20 pourcent des appels ET si `partial_inside_returned_method_span +
partial_covering_a_returned_hit_line` >= 30 pourcent des `Read` qui suivent.
Si la majorite des `Read` sont des fichiers entiers, le corps d'UNE methode
ne les remplace pas : fermer.

**M2, `body_text` utilisable (pour 3.1)** -- hors trace, sur l'index du
poste (`<projet>/.aidex/index.db`) :

```sql
SELECT COUNT(*), SUM(body_truncated), SUM(body_text IS NULL),
       AVG(body_lines) FROM methods;
```

Troncature au-dela de `MAX_BODY_CHARS` = 8000 caracteres
(`src/parser/extractor.ts:52`), tete + queue. Seuil PROPOSE : `body_text`
exploitable tel quel si la part tronquee ou nulle est <= 20 pourcent.

**M3, fraicheur (pour 3.2)** -- bloc `mex_stale`.
- `calls_hitting_file_edited_earlier_same_turn` sur `aidex_query_calls` :
  le resultat cite un fichier passe par `Edit` / `Write` / `MultiEdit` /
  `NotebookEdit` plus tot dans le MEME tour (le hook Stop n'a pas encore
  reindexe).
- Limites : une edition faite par un sous-agent n'est pas visible depuis
  la session parente (sous-compte) ; avant l'installation des hooks
  `aidex-queue-*`, la peremption depassait le tour (sous-compte aussi) ;
  les changements hors Claude Code (`git pull`, editeur) sont invisibles.
  Le chiffre est donc une borne BASSE.

Seuil PROPOSE : fermer si < 2 pourcent des `aidex_query`.

**M4, routes (pour 3.4)** -- bloc `mex_routes`.
- `distinct_patterns` ET `occurrences`, jamais un seul (piege
  d'echantillonnage du 2026-08-13). `patterns` donne la liste complete.
- Puis question binaire, sans compte : sur un projet Express ou FastAPI du
  poste, `aidex_query` d'une route connue avec `kinds: ["literal"]`. Si
  elle repond, la dimension `literal` couvre deja le besoin.

Seuil PROPOSE : fermer si < 10 motifs distincts sur toute la trace, ou si
la question binaire repond oui.

**M5, harnais A/B (pour 3.5)** -- pas de script a ce stade, protocole :
1. 10 a 20 taches tirees des transcripts (premier message utilisateur de
   sessions de navigation dans le code), pas ecrites a la main.
2. Deux bras : AiDex non monte contre AiDex monte. Ne pas utiliser
   `ENABLE_TOOL_SEARCH` pour "desactiver" : un outil differe est paye quand
   meme (CLAUDE.md, section Outils).
3. `claude -p "<tache>" --output-format stream-json --verbose`, ordre des
   bras alterne, au moins 2 repetitions par tache et par bras.
4. Tokens lus dans `usage`, dedupliques par `message.id` (section 4.1 de
   l'etude `sem`) : `input_tokens + cache_creation_input_tokens +
   output_tokens` d'un cote, `cache_read_input_tokens` rendu A PART.
5. Comparaison en **delta apparie par tache** (mediane des deltas), jamais
   en total absolu, a cause des caches de prompt cote fournisseur.
6. Reponses anonymisees, notees contre le source avant de savoir quel bras
   les a produites. Un gain de tokens avec perte de justesse n'est pas un
   gain.

Seuil PROPOSE pour qu'une feature soit retenue via ce harnais : mediane
des deltas apparies <= -10 pourcent, sans baisse du nombre de reponses
justes.

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
