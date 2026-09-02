# AiDex -- CLAUDE.md

Serveur MCP de code-indexing persistant. Donne aux assistants IA (Claude Code, Claude Desktop, etc.) un acces structure a la codebase, plus rapide et precis que `Grep` / `Glob`.

> Les elements propres a un poste (chemins absolus, versions installees, corpus locaux, notes privees au fork) ne vivent PAS ici : ils sont dans `.claude/CLAUDE.local.md`, gitignore. Ne rien y reintroduire.

## Fork VOCSAP

Ce repo est un fork local `VOCSAP/AiDex`, base sur `CSCSoftware/AiDex`. Voir `git remote -v` :
- `origin` : `VOCSAP/AiDex` (publique du fork)
- `upstream` : `CSCSoftware/AiDex` (auteur d'origine, suivi pour pull les nouvelles features)

Patches locaux versionnes sur la branche `local-patches`. Notes de developpement privees au fork sous `docs/dev-notes/` (exclus de git via `.gitignore` -- commit `f2ad5bf`).

## Doctrine de developpement

Cette section arbitre TOUTE decision de feature sur AiDex. La lire avant d'ouvrir,
d'instruire ou d'implementer une carte de roadmap.

### Pourquoi AiDex existe

AiDex existe pour reduire fortement la consommation de TOKENS des agents. Ce n'est pas
un outil pour humain, et ce n'est pas d'abord un outil de confort de lecture. La valeur
livree est la substitution : un appel `aidex_query` ou `aidex_signature` remplace une
sequence `Grep` puis `Read` qui aurait deverse des fichiers entiers dans le contexte de
l'agent. Plus rapide est un effet secondaire ; moins cher est le but.

**Pour qui.** Upstream est un projet public ; ce depot est un fork que l'operateur
customise POUR SA PROPRE STATION. D'autres peuvent l'utiliser, ils ne sont pas la cible.
Consequence : une calibration ou une mesure faite sur le corpus local d'une machine est
legitime et suffisante. Ne pas exiger qu'un resultat generalise cross-utilisateurs, ne
pas ajouter de complexite pour couvrir des profils d'usage hypothetiques. Le caractere
mono-machine d'un corpus se mentionne une fois comme limite, jamais comme obstacle.

**Unite de jugement : le NOMBRE DE LIGNES DE SORTIE rendues a l'agent.** Pas le nombre
d'items indexes, pas le nombre de matchs, pas la couverture de l'index. `aidex_query`
plafonne deja sa sortie a 100 lignes et l'annonce (`Found 629 match(es) ... [showing
first 100]`). Le cout d'un appel est donc BORNE ; ce qui varie est la densite utile sous
le plafond.

Consequence directe, contre-intuitive et deja verifiee plusieurs fois : **indexer plus
n'est pas ameliorer**. Ajouter des items qui ne rendent aucune requete nouvellement
satisfaite degrade l'outil, parce que ces items concurrencent les bons sous un plafond
fixe et polluent le mode `contains`.

### Comment juger une feature candidate

Quatre questions, dans cet ordre. Un `non` a la premiere ou a la deuxieme suffit a
fermer la piste.

1. **Supprime-t-elle un `grep` que l'agent devait lancer ?** Ou augmente-t-elle la
   densite utile sous le plafond de 100 lignes ? Si elle ne fait ni l'un ni l'autre,
   elle ne vaut rien, quel que soit le nombre d'items qu'elle ajoute.
2. **Le besoin est-il MESURE, ou seulement plausible ?** Ce projet a paye un revert
   complet pour une feature ajoutee sans besoin mesure (prefilter trigramme, `7d29e98`
   puis `bd76216`).
3. **Le residu vise est-il du signal ou du bruit ?** Mesurer avant de coder, sur un
   corpus reel, avec un echantillon aleatoire lu verbatim.
4. **Le defaut choisi sera-t-il fige dans la surface MCP ?** Si oui, il doit etre
   calibre sur des requetes reellement emises, pas sur des exemples ecrits a la main.

### Discipline de mesure

**Mesurer avant de prescrire, y compris ses propres intuitions.** Sur la session
d'etude du 2026-08-12, quatre hypotheses portees par le team-lead ont ete detruites par
la mesure, sur quatre. Invalider sa propre recommandation est le resultat attendu, pas
un echec.

**Etiqueter chaque affirmation MESURE / DEDUIT / SUPPOSE.** Une affirmation MESURE
s'accompagne de sa commande et de la ligne de sortie decisive. Une affirmation nue se
renvoie a qui tient le contexte plutot que de se verifier soi-meme.

**Verifier qu'un corpus de mesure EXISTE avant de s'y fier.** Les corpus de reference
ont deja ete supprimes sans que la doctrine soit mise a jour. Etat courant du poste :
`.claude/CLAUDE.local.md`.

**Piege d'echantillonnage mesure le 2026-08-13, a ne pas reproduire.** Echantillonner un
ensemble de termes au niveau OCCURRENCE au lieu du TERME DISTINCT sur-represente les
mots frequents et fabrique une conclusion fausse. Un echantillon par occurrence rendait
0 sur 45 des litteraux rejetes deja atteignables par la dimension `symbol` ; le batch
complet au niveau terme distinct a rendu 61 pourcent NON atteignables. Sur toute mesure
de couverture d'index : echantillonner au niveau du terme distinct, et rendre SEPAREMENT
le poids en occurrences. Jamais un seul des deux chiffres.

**Ne jamais publier un RATIO sans avoir verifie que ses deux nombres viennent du meme
chemin.** Deux nombres qui portent le meme nom ne mesurent pas forcement la meme
grandeur. Ce depot a paye DEUX FOIS pour cette exacte erreur : la section 14 de
`LOCAL-PATCHES.md` raconte un facteur 10 inexplique, ne comparant en fait qu'un agregat
sur 20 repetitions a un appel unique, qui a motive un revert complet ; et le 2026-08-13,
des facteurs de croissance de 1,4 a 8,7 ont ete publies puis stockes en memoire longue
pour une reindexation qui n'avait fait bouger les index que de quelques pourcents.
Le piege exact : `init()` rend dans `itemsFound` une somme de PAIRES TERME-FICHIER,
tandis qu'`aidex_status` et `aidex_scan` rendent un compte de TERMES GLOBALEMENT
DISTINCTS (`src/db/database.ts:242`). Le rapport entre les deux vaut le nombre moyen de
fichiers par terme, donc il VARIE par projet : des facteurs qui melangent les deux
sources ne sont comparables ni a la realite, ni entre eux. Carte `740c6f5d` FERMEE : la
sortie d'indexation nomme desormais la premiere grandeur `Term-file pairs (raw case)`,
donc les deux chiffres ne sont plus confondables a la lecture. Les deux grandeurs
existent toujours et restent non comparables : la vigilance porte maintenant sur tout
NOUVEAU compteur rendu a un humain ou a un agent.

Trois reflexes qui en decoulent, par ordre d'efficacite :
1. Quand un ecart depasse un facteur 2 sans cause evidente, **suspecter l'unite avant de
   suspecter les donnees**. L'hypothese de depart etait une perte de 76 pourcent de
   l'index ; il n'y avait aucune perte.
2. **Preferer une question a reponse BINAIRE a un compte** quand la question s'y prete.
   Savoir si un index detient des litteraux multi-mots se tranche par un `aidex_query`
   en `kinds: ["literal"]`, en un appel. Aucun compte, quelle que soit son unite, ne
   repond a cette question.
3. **Une explication qui reproduit la valeur exacte ne se discute pas.** Le diagnostic a
   ete accepte parce qu'il rendait 55250 au chiffre pres, pas parce qu'il etait
   plausible.

**Une deduction qui reposait sur un chiffre faux devient INCONNUE, pas FAUSSE.** La
retenir comme refutee serait une seconde erreur, symetrique de la premiere. Retirer une
conclusion sans la remplacer est une fin legitime.

**Calibrer un defaut sur des requetes REELLEMENT emises**, jamais sur des exemples
ecrits a la main. La source de trace disponible est decrite dans
`.claude/CLAUDE.local.md`.

### Pistes CLOSES, ne pas rouvrir sans fait nouveau

Chacune a ete fermee par une mesure, pas par une opinion.

1. **Elargir `LITERAL_SHAPE` a la ponctuation.** +106 items sur 4977, deux tiers de
   boilerplate SQL duplique. La condition de reouverture ecrite dans la carte (tester un
   autre langage) a ete executee sur 629 fichiers Rust : meme profil, refuse.
2. **Assouplir le SEUIL de la gate de position.** Elle ecarte 5 fois plus que
   `LITERAL_SHAPE`, mais c'est un choix de conception mesure en amont, pas un accident.
3. **Etendre `literalPosition` aux positions Rust** (carte `abf0f501`, archivee `wont`
   le 2026-08-13). 61 pourcent des 4105 termes distincts rejetes ne sont pas atteignables
   par `symbol`, mais ils ne pesent que 24,7 pourcent des occurrences, sont singleton, et
   40 sur 40 en relecture aleatoire tombent dans trois buckets deja refuses : messages de
   diagnostic et de log, descriptions et fixtures de test, lexique de sentiment. Meme
   profil mesure deux fois, sur TypeScript puis sur Rust. Reouverture uniquement si un
   langage tiers exhibe des cles de protocole ou de configuration REPETEES en position
   rejetee.
4. **Optimiser le matching `contains`.** Il pese 5 a 12 pourcent du cout d'un appel ; le
   point chaud est la jointure d'occurrences, proportionnelle au fanout.
5. **Indexer les commentaires de rationale** (carte `70e5d584`, `wont`). 0,03 a 0,21
   pourcent des lignes de commentaire, et un `grep` fait mieux en 0,1 seconde.
6. **Le cout de reindexation comme argument contre une feature.** Tranche par
   l'operateur : ponctuel, non bloquant, definitivement. Ne plus l'invoquer.
7. **Boost de recence au classement (`focus_paths` / `recent_paths`), repris du moteur
   code-context de Kleos.** Mesure le 2026-08-23 sur la trace reelle, 880 sessions et
   975 appels, proxy comportemental : le fichier ouvert juste apres une recherche revele
   la cible. Sur 429 appels `aidex_query` exploitables, 211 soit 84,4 pourcent ont deja
   la bonne cible dans le top 3 ; le boost n'aurait aide que 13 cas sur 429, soit 3,0
   pourcent, et c'est une BORNE HAUTE qui suppose zero degradation des 211 cas deja
   corrects. Fait qui tue l'argument de densite : le plafond de 100 lignes ne mord que
   dans 5,4 pourcent des appels (50 sur 933). Les trois autres pistes de la meme etude
   sont fermees ou redondantes : porter `extract.rs` serait une REGRESSION (AiDex couvre
   14 langages contre 8), et l'incrementalite par hash de contenu existe deja
   (`src/commands/init.ts`).
8. **Couche LSP / graphe de relations, volet Rust.** Le volet TypeScript etait ferme
   depuis le 2026-08-21 sur trois raisons ; le volet Rust restait ouvert. Mesure le
   2026-08-23 sur un corpus Rust de reference (depuis retire) : une seule des trois
   raisons tombe. L'homonymie EXISTE bien en Rust, contrairement a TypeScript (6,9
   pourcent des noms de methodes et 8,5 pourcent des noms de types sont ambigus, pesant
   environ 20 pourcent des sites, et pas seulement sur des impls de traits :
   `SearchResult` 7 sites, `StoreResult` 6, `LinkedMemory` 5, `get_stats` 14). Mais elle
   ne tombe PAS sur ce que l'agent cherche : sur 18 termes reellement recherches, 1 seul
   est ambigu et 12 ne sont pas des symboles definis du tout (constantes, variables
   d'environnement). Les deux autres raisons tiennent : `rust-analyzer` joue le role de
   `tsc` pour le go-to-definition, et l'agent ne reclame pas d'outil semantique
   (`aidex_search` pese 4,3 pourcent des recherches, 42 appels contre 933).
   **Condition de reouverture** : une trace d'une VRAIE session de navigation dans le
   code Rust. Les 18 termes viennent de sessions CLI et debug, corpus faible et
   probablement non representatif ; c'est la seule reserve qui empeche de fermer
   definitivement.

### Pieges d'environnement, a recopier dans tout brief d'execution

- **`--runInBand` et `--maxWorkers=1` sont INTERDITS sur la suite de tests.** L'addon
  natif tree-sitter est charge une fois par processus alors que jest cree un contexte vm
  par fichier : des le deuxieme fichier d'un meme processus le parseur rend un arbre
  mort. Mesure : mono-processus 66 echecs sur 138, parallele par defaut 138 sur 138. Le
  compte varie d'un run a l'autre parce que jest tire l'ordre des fichiers de son cache
  de timings, ce qui donne l'illusion d'un defaut non deterministe dans le code. Ce piege
  a coute trois rapports de diagnostic dont deux avec une cause racine fausse.
- **Un mauvais binaire `node` casse l'ABI de `better-sqlite3`** et fait echouer toute la
  suite en bloc, avec une cause qui n'a rien a voir. Binaire a utiliser sur le poste
  courant : `.claude/CLAUDE.local.md`.

## Contrainte runtime

**Node 22.x obligatoire** sur Windows 11 (builds recents type 26200). Un bug libuv dans Node 20.20.0 fait planter `npm install` au build natif (`tree-sitter`, `better-sqlite3`) avec `AssignProcessToJobObject: ERROR_INVALID_PARAMETER (87)` qui abort le process.

Si tu changes de version de Node, prevois `npm rebuild` pour recompiler les addons natifs sous le nouveau ABI.

Depuis upstream 2.2.1, le plancher declare est **Node >= 20** (`engines`, `.nvmrc`, check runtime dans `src/index.ts`) et `better-sqlite3` est passe en `^12` pour disposer des prebuilds Node 24. La contrainte Node 22 du fork reste plus stricte que le plancher upstream, pour la raison libuv ci-dessus.

Version exacte et chemin du binaire installes sur le poste courant : `.claude/CLAUDE.local.md`.

## Build & Run

```bash
npm install                     # First-time install
npm run build                   # After code changes (tsc + copy-assets)
```

Si tu veux skip les optional deps (`@xenova/transformers` ~50 MB, `sqlite-vec` ~5 MB), utilise `npm install --omit=optional` (embeddings semantiques restent alors inactifs, stub).

**Apres modification du code** : `npm run build`, puis redemarrer Claude Code / Desktop pour que le serveur MCP soit relance.

L'enregistrement du serveur MCP (JSON `mcpServers`, chemins node par client) est documente dans `README.md` -- section "Install". Le nom du serveur est `aidex`, prefixe des outils `mcp__aidex__aidex_*`.

## Outils

Les outils MCP (`aidex_query`, `aidex_signature`, `aidex_search`, `aidex_global_*`, etc.) sont declares nativement par le serveur a chaque session : leurs descriptions n'ont pas besoin d'etre dupliquees ici. Reference complete des parametres et exemples : `MCP-API-REFERENCE.md`. Guide detaille du dashboard Live/panels/controles du Log Hub : `docs/loghub-panel-dashboard.md`.

**Le payload `tools/list` est du contexte, donc il obeit a la doctrine.** Il tombe dans chaque session qui monte le serveur, ce qui fait d'un outil jamais appele une taxe permanente. Mesure sur 1923 transcripts Claude Code (70 projets, 3941 appels reels) : les 33 outils coutent environ 10800 tokens, et 11 d'entre eux en portaient 4123, soit 38 pourcent, pour 5 appels au total. Ces 11 sont retires de la liste annoncee par defaut (`DEFAULT_DISABLED_TOOLS`, `src/server/tools.ts`) : `task`, `tasks`, `log`, `note`, `describe`, `link`, `unlink`, `links`, `global_query`, `global_signatures`, `global_guideline`.

Le filtre est purement soustractif sur `tools/list` : chaque bras de `handleToolCall` reste atteignable, un client qui appelle un outil filtre par son nom obtient toujours sa reponse. `AIDEX_TOOLS_DISABLE` arbitre : non definie, le defaut s'applique ; `none` ou vide, les 33 sont annonces ; une liste explicite separee par des virgules remplace entierement le defaut.

**Avant d'ajouter un outil, mesurer son cout.** Un nouvel outil ne se juge pas sur ce qu'il permet mais sur les tokens qu'il preleve sur chaque session, meme celles qui ne l'appellent jamais. Le tarif observe est de 4,2 a 4,5 octets de schema par token.

## Langues supportees

C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby, HCL/Terraform, Kotlin, Swift (14 langages).
Egalement indexes : `.astro` (frontmatter TypeScript parse via la grammaire TSX, template blanke pour preserver les numeros de ligne).

## Architecture

```
src/
├── index.ts              # Entry point (MCP + CLI)
├── server/
│   ├── mcp-server.ts     # MCP protocol
│   └── tools.ts          # Tool handlers
├── commands/             # Tool implementations
│   ├── init.ts, query.ts, signature.ts, update.ts
│   ├── summary.ts, link.ts, scan.ts, files.ts
│   ├── session.ts, note.ts, task.ts, log.ts
│   ├── screenshot/              # Platform screenshots
│   └── global/                  # Global Search
│       ├── global-init.ts       # Scan + bulk index
│       ├── global-query.ts      # ATTACH DATABASE queries
│       ├── global-signatures.ts # Symbol search
│       ├── global-status.ts     # Project overview
│       └── global-refresh.ts    # Stats refresh
├── embeddings/                  # Semantic search subsystem
│   ├── index.ts          # Public API (lazy-loading stub)
│   ├── pipeline.ts       # Real impl, instantiated on enable()
│   ├── embedder.ts       # Transformers.js wrapper (ONNX)
│   ├── model-registry.ts # jina-code / nomic-text / bge-small
│   ├── chunker*.ts       # 3-tier chunking (code/docs/workspace)
│   ├── search.ts         # vec0 KNN + RRF hybrid
│   ├── store.ts          # SQLite schema migration
│   └── schema.sql        # embeddings table + projects columns
├── loghub/                      # Log Hub + Dashboard
│   ├── log-types.ts       # Shared types
│   ├── log-buffer.ts      # Ring buffer (FIFO)
│   ├── panel-types.ts     # Widget types (label/progress/gauge/plot/slider/number/toggle/button)
│   ├── panel-store.ts     # Etat des slots du dashboard
│   ├── control-store.ts   # Back-channel { id: value }
│   └── log-server.ts      # HTTP server singleton (port 3335)
├── viewer/
│   ├── server.ts         # Interactive viewer (port 3333)
│   └── progress.ts       # SSE progress UI (port 3334)
├── db/
│   ├── database.ts       # SQLite (WAL)
│   ├── queries.ts        # Prepared statements
│   ├── schema.sql        # Project DB schema
│   └── global-database.ts # ~/.aidex/global.db
└── parser/
    ├── tree-sitter.ts    # Parser (1 MB buffer)
    ├── extractor.ts      # Identifiers + signatures
    └── languages/        # Per-language keyword filters (14 langages)
```

## Tables principales

| Table | Contenu |
|-------|---------|
| `files` | Arborescence (path, hash, last_indexed) |
| `lines` | Lignes avec line_hash + modified timestamp |
| `items` | Termes indexes (case-insensitive) |
| `occurrences` | Vues des termes |
| `methods` | Prototypes de methodes |
| `types` | Classes / structs / interfaces |
| `signatures` | Header comments |
| `project_files` | Tous les fichiers du projet, avec type |
| `metadata` | Cle-valeur (sessions, notes) |
| `tasks` | Backlog (priority, status, tags, scheduling) |
| `task_log` | Historique des tasks (auto-log sur change) |
| `scheduled_tasks` | Mirror global dans `~/.aidex/global.db` |
| `embeddings` | Vecteurs (vec0 virtual table) + content_hash |

## Details d'implementation

- **Tree-sitter** : buffer 1 MB pour les gros fichiers
- **Hash-diff** : les timestamps de ligne sont preserves si le hash ne change pas
- **Arrow functions** : detectees comme methodes (volontaire, un peu de bruit)
- **Filtres keyword** : par langue dans `src/parser/languages/`

## Posture securite du fork

Etat releve apres `npm install` sur upstream 2.3.0 (Node 22.11.0, npm 11.15.0) le 2026-08-10 :
- **15 vulnerabilites en dependances de production** : 1 critical, 10 high, 4 moderate (`npm audit --omit=dev`)
- 19 au total en comptant les devDependencies
- Critical : `simple-git` (RCE / bypass option-parsing)
- High notables : `ws`, `@modelcontextprotocol/sdk`, `@hono/node-server`, `path-to-regexp`, `minimatch` / `brace-expansion`, `fast-uri`, `sharp` et `@xenova/transformers` (qui en depend)
- Warnings deprecated transitifs toujours presents : `glob@7.2.3` (x3), `inflight`, `prebuild-install`

Aucun n'est une dependance directe du fork -- ce sont les transitifs d'upstream. Le chiffre a monte de 4 (releve 2.1.2 du 2026-05-21) a 15 parce que 2.2.x/2.3.0 ont elargi l'arbre de dependances, pas a cause d'un patch local.

Le seul `overrides` du fork est `protobufjs: ^7.5.8`. Il force protobufjs 7.6.5 sur `onnx-proto@4.0.4`, qui declare pourtant `^6.8.8` : violation semver majeure assumee, chemin embeddings uniquement. **Verifie fonctionnel le 2026-08-10** (embedding jina-code, vecteur 768 dims non degenere). A re-tester apres chaque refresh de dependances.

Hardening candidat (npm audit fix sur `ws`/`simple-git`, overrides `glob`/`rimraf`/`minimatch`, veille CVE tree-sitter/better-sqlite3) pas urgent, aucun warning ne casse le build : a traiter en session dediee, jamais pendant un fix fonctionnel ni un merge upstream.

## Documentation complementaire

| Fichier | Contenu |
|---------|---------|
| `README.md` | Documentation publique (upstream + VOCSAP), y compris l'enregistrement MCP par client et l'usage CLI |
| `MCP-API-REFERENCE.md` | API MCP complete : tous les outils, leurs parametres et exemples d'appel, y compris le Log Hub (endpoints HTTP, exemples client par langage) |
| `docs/loghub-panel-dashboard.md` | Guide detaille du dashboard Live du Log Hub (widgets, endpoints `/panel` et `/control`, piege du compteur `button`) |
| `CHANGELOG.md` | Historique des versions |
| `docs/dev-notes/` | Notes privees au fork VOCSAP (exclues de git) -- index dans `.claude/CLAUDE.local.md` |

## Configuration locale (optionnelle, hors git)

@./CLAUDE.local.md
