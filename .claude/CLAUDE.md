# AiDex -- CLAUDE.md

Serveur MCP de code-indexing persistant. Donne aux assistants IA (Claude Code, Claude Desktop, etc.) un acces structure a la codebase, plus rapide et precis que `Grep` / `Glob`.

## Fork VOCSAP

Ce repo est un fork local `VOCSAP/AiDex`, base sur `CSCSoftware/AiDex`. Voir `git remote -v` pour les remotes :
- `origin` : `VOCSAP/AiDex` (publique du fork)
- `upstream` : `CSCSoftware/AiDex` (auteur d'origine, suivi pour pull les nouvelles features)

Patches locaux versionnes sur la branche `local-patches`. Notes de developpement privees au fork sous `docs/dev-notes/` (exclus de git via `.gitignore` -- commit `e3dff85`).

## Contrainte runtime

**Node 22.x obligatoire** sur Windows 11 (builds recents type 26200). Un bug libuv dans Node 20.20.0 fait planter `npm install` au build natif (`tree-sitter`, `better-sqlite3`) avec `AssignProcessToJobObject: ERROR_INVALID_PARAMETER (87)` qui abort le process.

Configuration verifiee de la station courante :
- Node 22.11.0 via nvm4w (`C:\Users\USERNAME\AppData\Local\nvm\v22.11.0\node.exe`)
- npm 11.15.0 + node-gyp 12.3.0 bundled
- Build natifs (tree-sitter, better-sqlite3, @xenova/transformers, sqlite-vec) compiles sous Node 22 ABI

Si tu changes de version de Node, prevois `npm rebuild` pour recompiler les addons natifs sous le nouveau ABI.

Depuis upstream 2.2.1, le plancher declare est **Node >= 20** (`engines`, `.nvmrc`, check runtime dans `src/index.ts`) et `better-sqlite3` est passe en `^12` pour disposer des prebuilds Node 24. La contrainte Node 22 du fork reste plus stricte que le plancher upstream, pour la raison libuv ci-dessus.

## Build & Run

```bash
npm install                     # First-time install
npm run build                   # After code changes (tsc + copy-assets)
```

Si tu veux skip les optional deps (`@xenova/transformers` ~50 MB, `sqlite-vec` ~5 MB), utilise :
```bash
npm install --omit=optional
```
Mais dans ce cas les embeddings semantiques restent inactifs (stub).

### Enregistrement MCP

Le serveur est expose sous le nom `aidex`. Prefixe des outils : `mcp__aidex__aidex_*`.

**Claude Code** (`~/.claude.json`) :
```json
"mcpServers": {
  "aidex": {
    "command": "C:\\Users\\USERNAME\\AppData\\Local\\nvm\\v22.11.0\\node.exe",
    "args": ["D:\\AI\\MCPServer\\AiDex\\build\\index.js"]
  }
}
```

**Claude Desktop** (`%APPDATA%/Claude/claude_desktop_config.json`) :
```json
"mcpServers": {
  "aidex": {
    "command": "C:\\Users\\USERNAME\\AppData\\Local\\nvm\\v22.11.0\\node.exe",
    "args": ["D:\\AI\\MCPServer\\AiDex\\build\\index.js"]
  }
}
```

Note sur le path Node : il est version-pinned a 22.11.0. Si tu installes 22.12 et desinstalles 22.11, ce path casse. Alternative : pointer vers le junction `C:\nvm4w\nodejs\node.exe` qui suit la version active de nvm4w (au risque d'ABI mismatch si tu fais `nvm use 20.x`).

**Apres modification du code** : `npm run build`, puis redemarrer Claude Code / Desktop pour que le serveur MCP soit relance.

## Outils

### Recherche & Index
| Outil | Description |
|-------|-------------|
| `aidex_init` | Indexer un projet (param optionnel `embeddings: true`) |
| `aidex_query` | Rechercher un terme (modes exact/contains/starts_with) avec filtres temporels |
| `aidex_search` | Recherche semantique (vector KNN) + exact + hybrid via RRF (v1.22+) |
| `aidex_status` | Statistiques d'index |
| `aidex_update` | Reindexer un fichier |
| `aidex_remove` | Retirer un fichier de l'index |

### Signatures (a privilegier sur `Read`)
| Outil | Description |
|-------|-------------|
| `aidex_signature` | Signature d'un fichier (Types + Methods) |
| `aidex_signatures` | Signatures de plusieurs fichiers via glob |

### Vue d'ensemble du projet
| Outil | Description |
|-------|-------------|
| `aidex_summary` | Apercu projet + entry points |
| `aidex_tree` | Arborescence avec stats |
| `aidex_describe` | Documentation auto vers `summary.md` |
| `aidex_files` | Lister les fichiers par type, avec `modified_since` |

### Cross-projet
| Outil | Description |
|-------|-------------|
| `aidex_link` / `aidex_unlink` / `aidex_links` | Lier des dependances entre projets |
| `aidex_scan` | Trouver les projets deja indexes |

### Session (v1.2+)
| Outil | Description |
|-------|-------------|
| `aidex_session` | Demarrer une session, detecter les modifs externes |
| `aidex_note` | Notes de session (persistees en DB) |
| `aidex_viewer` | Explorateur navigateur avec live-reload (v1.3) |

### Task Backlog (v1.8+)
| Outil | Description |
|-------|-------------|
| `aidex_task` | CRUD task + log + scheduler (due/interval/action/auto_go) |
| `aidex_tasks` | Lister tasks, filtrer par status/priority/tag |

Etats : `backlog -> active -> done | cancelled`.

### Log Hub (v1.16+)
| Outil | Description |
|-------|-------------|
| `aidex_log` | Universal-Logging : init/free/status/query/clear/write + control_get/control_set. Serveur HTTP recoit des logs externes |

Actions : `init` (start server) -> `query` (read logs) -> `free` (stop server).
Controles (v2.2+) : `control_get` lit toutes les valeurs du dashboard, `control_set` en modifie une (meme set-point que le slider cote utilisateur).

### Screenshots (v1.9+, optim v1.13)
| Outil | Description |
|-------|-------------|
| `aidex_screenshot` | Capture d'ecran + optim (`scale`, `colors`) |
| `aidex_windows` | Lister les fenetres ouvertes (helper pour le mode `window`) |

### Global Search (v1.11+)
| Outil | Description |
|-------|-------------|
| `aidex_global_init` | Scanner un arbre, enregistrer les projets dans `~/.aidex/global.db`. `index_unindexed` : auto-index <=500 fichiers. `show_progress` : UI navigateur |
| `aidex_global_status` | Lister les projets enregistres avec leurs stats |
| `aidex_global_query` | Rechercher un terme sur TOUS les projets (ATTACH DATABASE, cache 5 min) |
| `aidex_global_signatures` | Methodes/types par nom sur tous les projets |
| `aidex_global_refresh` | Rafraichir les stats, retirer les projets obsoletes |

## Langues supportees

C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby, HCL/Terraform, Kotlin, Swift (14 langages depuis 2.3.0).
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
│   └── global/                  # Global Search (v1.11)
│       ├── global-init.ts       # Scan + bulk index
│       ├── global-query.ts      # ATTACH DATABASE queries
│       ├── global-signatures.ts # Symbol search
│       ├── global-status.ts     # Project overview
│       └── global-refresh.ts    # Stats refresh
├── embeddings/                  # Semantic search subsystem (v1.19+)
│   ├── index.ts          # Public API (lazy-loading stub)
│   ├── pipeline.ts       # Real impl, instantiated on enable()
│   ├── embedder.ts       # Transformers.js wrapper (ONNX)
│   ├── model-registry.ts # jina-code / nomic-text / bge-small
│   ├── chunker*.ts       # 3-tier chunking (code/docs/workspace)
│   ├── search.ts         # vec0 KNN + RRF hybrid
│   ├── store.ts          # SQLite schema migration
│   └── schema.sql        # embeddings table + projects columns
├── loghub/                      # Log Hub (v1.16) + Dashboard (v2.1/2.2)
│   ├── log-types.ts       # Shared types
│   ├── log-buffer.ts      # Ring buffer (FIFO)
│   ├── panel-types.ts     # Widget types (label/progress/gauge/plot/slider/number/toggle/button)
│   ├── panel-store.ts     # Etat des slots du dashboard
│   ├── control-store.ts   # Back-channel { id: value } (v2.2)
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

## Fonctionnalites cles

### Embeddings semantiques (v1.19+, stable v2.1)

L'embedder est **100% local** via `@xenova/transformers` (runtime ONNX). Aucun appel reseau hors du 1er DL du modele.

```
aidex_init({ path: ".", embeddings: true })          # Active + indexe
aidex_search({ query: "retry with backoff",          # Recherche naturelle
               mode: "hybrid", k: 20 })
aidex_search({ query: "specific_fn", mode: "exact" }) # Identifier match
```

Modeles disponibles (cf. `src/embeddings/model-registry.ts`) :
- `jina-code` (defaut) : `jinaai/jina-embeddings-v2-base-code`, 768 dims, 30 langages, Apache-2.0
- `nomic-text` : 768 dims, Apache-2.0, generaliste
- `bge-small` : 384 dims, MIT, English only, compact

Stockage :
- Modele cache : `~/.aidex/models/` (custom, survit aux `npm install`)
- Vecteurs : `~/.aidex/global.db` table `embeddings`, partagee cross-projets

LLM-layer optionnel (pour reranking, expansion de query) via `llm_endpoint` + `llm_model` + privacy switch `llm_send_code` (defaut `false`).

### Filtres temporels (v1.1)
```
aidex_query({ term: "render", modified_since: "2h" })
aidex_files({ path: ".", modified_since: "30m" })
```
Formats acceptes : `30m`, `2h`, `1d`, `1w`, ISO date.

### Notes de session (v1.2)
```
aidex_note({ path: ".", note: "Test the fix" })          # Write
aidex_note({ path: ".", append: true, note: "+" })       # Append
aidex_note({ path: "." })                                # Read
aidex_note({ path: ".", clear: true })                   # Delete
```

### Viewer interactif (v1.3)
```
aidex_viewer({ path: "." })                              # http://localhost:3333
aidex_viewer({ path: ".", action: "close" })
```
Arborescence clic, signatures, live-reload (chokidar), syntax-highlight, git-status avec icones chat (v1.3.1).

### Task Backlog (v1.8)
```
aidex_task({ path: ".", action: "create", title: "Fix bug",
             priority: 1, tags: "bug" })
aidex_task({ path: ".", action: "read", id: 1 })
aidex_task({ path: ".", action: "update", id: 1, status: "done" })
aidex_task({ path: ".", action: "log", id: 1, note: "Root cause found" })
aidex_tasks({ path: ".", status: "active", tag: "bug" })
```
Priorities : 1=high, 2=medium (default), 3=low.
Auto-log sur changement de statut. Viewer expose un onglet Tasks.

### Task Scheduler (v1.17)
```
aidex_task({ path: ".", action: "create", title: "Check PR",
             due: "3d", interval: "3d", task_action: "gh pr list" })
aidex_task({ path: ".", action: "create", title: "One-shot", due: "1w" })
```
- `due` : `"30m"`, `"2h"`, `"3d"`, `"1w"` ou ISO date
- `interval` : automatiquement re-arme apres trigger
- One-shot : `due` est supprime apres trigger
- Cross-project : `aidex_session` rapporte les tasks dues de tous les projets
- `auto_go: true` execute la commande sans confirmation

### Screenshots (v1.9, optim v1.13)
```
aidex_screenshot()                                       # Full screen
aidex_screenshot({ mode: "active_window" })
aidex_screenshot({ mode: "window", window_title: "VS Code" })
aidex_screenshot({ scale: 0.5, colors: 2 })              # B&W, half-size
aidex_screenshot({ colors: 16 })                         # 16 colors
aidex_screenshot({ mode: "region" })                     # Drag rectangle
aidex_windows({ filter: "chrome" })                      # Find windows
```
- Pas d'index requis (outil standalone)
- Cross-platform : Windows (PowerShell), macOS (screencapture), Linux (maim/scrot)
- Defaut : `os.tmpdir()/aidex-screenshot.png` (ecrasement systematique)
- Options : `filename`, `save_path`
- Strategie LLM : commencer par `scale: 0.5, colors: 2`, monter a `colors: 16` si illisible, puis `scale: 0.75`

### Global Search (v1.11)
```
aidex_global_init({ path: "D:/AI" })                                # Register only
aidex_global_init({ path: "D:/AI", index_unindexed: true,
                    show_progress: true })                          # Index + UI
aidex_global_query({ term: "JobObject", mode: "contains" })
aidex_global_signatures({ term: "Render", kind: "method" })
aidex_global_status({ sort: "recent" })
aidex_global_refresh()
```
- `~/.aidex/global.db` reference toutes les DB de projet
- SQLite `ATTACH DATABASE`, pas de copie de donnees
- Cache de session (TTL 5 min) pour les queries repetees
- Bulk-index : <=500 fichiers code auto, sinon liste pour validation manuelle
- Progress UI : SSE port 3334, auto-open navigateur
- Auto-dedup : projets parents avec sous-projets indexes sont skips

### Log Hub (v1.16)
```
aidex_log({ action: "init" })                            # Port 3335
aidex_log({ action: "init", port: 3336, buffer_size: 5000 })
aidex_log({ action: "init", persist: true, path: "." })  # DB persistence
aidex_log({ action: "query" })                           # Last 50 entries
aidex_log({ action: "query", since: "10m", level: "error" })
aidex_log({ action: "query", source: "MyApp", contains: "crash" })
aidex_log({ action: "write", message: "Debug started" })
aidex_log({ action: "status" })
aidex_log({ action: "clear" })
aidex_log({ action: "free" })
```
- API HTTP : `POST /log`, `POST /logs`, `GET /health`
- Ring buffer fixed-size FIFO
- Viewer : onglet Logs avec WS live-stream + filtres
- Zero-cost : pas de serveur ni de buffer tant que `init` n'est pas appele

### Auto-cleanup (v1.3.1)
`aidex_init` retire automatiquement les fichiers desormais exclus (ex. `build/` ajoute aux ignores). Sortie : `Files removed: N`.

## CLI

```bash
node build/index.js              # MCP server (stdin/stdout)
node build/index.js scan <path>  # Discover projects
node build/index.js init <path>  # Index a project
```

## Details d'implementation

- **Tree-sitter** : buffer 1 MB pour les gros fichiers
- **Hash-diff** : les timestamps de ligne sont preserves si le hash ne change pas
- **Arrow functions** : detectees comme methodes (volontaire, un peu de bruit)
- **Filtres keyword** : par langue dans `src/parser/languages/`

## LogHub Developer Guide

### Vue d'ensemble

LogHub est un recepteur de logs universel. N'importe quel programme peut envoyer des logs via HTTP POST, sans library ni SDK. L'IA peut interroger les logs, l'utilisateur les voit en live dans le Viewer.

### Setup (cote IA)

```
1. aidex_log({ action: "init" })             # Start server (port 3335)
2. aidex_viewer({ path: "." })                # Open Viewer -> Logs tab
3. Wire logging into the target program (see below)
4. aidex_log({ action: "query", since: "5m" })
5. aidex_log({ action: "free" })              # Stop server
```

### API HTTP

| Endpoint | Methode | Body | Description |
|----------|---------|------|-------------|
| `/log` | POST | `{ level, source, message, data? }` | Single entry |
| `/logs` | POST | `[{ level, source, message, data? }, ...]` | Batch |
| `/health` | GET | -- | Status + buffer fill |
| `/panel` | POST | `{ id, type, value, ... }` | Widget du dashboard (slot fixe, ecrase en place) |
| `/panel/clear` | POST | -- | Vide widgets + valeurs de controle |
| `/control` | POST / GET | `{ id, value }` / -- | Set une valeur ; GET renvoie tout en `{ id: value }` (la source poll) |
| `/control/press` | POST | `{ id }` | Signale un appui bouton -- c'est le hub qui incremente, pas l'appelant |

Champs :
- `level` : `"debug"` / `"info"` / `"warn"` / `"error"` (defaut `info`)
- `source` : nom de l'app/composant (ex. `"MyApp"`, `"Parser"`)
- `message` : texte du log (requis)
- `data` : objet JSON libre (optionnel)
- `timestamp` : Unix ms (optionnel, sinon heure serveur)

### Dashboard Live (v2.1, controles v2.2/2.3)

A cote du flux de logs qui defile, un dashboard a slots fixes : chaque valeur a une `id`, renvoyer la meme `id` ecrase la valeur en place au lieu de scroller. Adapte aux valeurs haute frequence (niveau audio, remplissage de buffer, FPS, capteurs). Visible dans l'onglet **Live** du viewer (nomme `Debug` jusqu'a 2.2.2 ; l'id de tab `debug` reste inchange cote API).

Types de widgets :
- **Affichage** : `label`, `progress`, `gauge` (champ `state` = couleur LED, independant du texte), `plot` (champs `scale` `linear`/`log`, `autoMin`, `decimals`)
- **Interactifs** (la valeur redescend vers la source qui la recupere via `GET /control`) : `slider`, `number` (`min`/`max`/`step`), `toggle` (0/1, `unit` = `"ON|OFF"`), `button`

Piege du `button` : sa valeur est un **compteur monotone**, pas un booleen. La source poll a son propre rythme, donc un flag serait perdu entre deux polls. Elle compare avec le dernier compte vu -- la difference donne le nombre d'appuis. Un saut vers le bas (overflow a 1e6, `/panel/clear`, redemarrage du hub) signifie "redemarrage, adopter la valeur", pas un million d'appuis.

Cote IA : `aidex_log({ action: "control_get" })` lit toutes les valeurs, `aidex_log({ action: "control_set", id, value })` en pilote une. C'est le meme set-point que le slider de l'utilisateur, donc Claude peut regler un programme en cours d'execution (seuil, gain, sample rate) et observer l'effet.

### Exemples par langage

**C# (.NET)**
```csharp
using var http = new HttpClient();
http.PostAsJsonAsync("http://localhost:3335/log", new {
    level = "info",
    source = "MyApp",
    message = "Player spawned",
    data = new { x = 10, y = 20 }
});
```

**C# (helper minimal)**
```csharp
static readonly HttpClient _log = new();
static void Log(string msg, string level = "info", object? data = null) {
    var body = new { level, source = "MyApp", message = msg, data };
    _ = _log.PostAsJsonAsync("http://localhost:3335/log", body);
}
```

**Python**
```python
import requests
requests.post("http://localhost:3335/log", json={
    "level": "info",
    "source": "MyScript",
    "message": "Processing complete",
    "data": {"items": 42}
})
```

**JavaScript / Node.js**
```javascript
fetch("http://localhost:3335/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        level: "info",
        source: "MyApp",
        message: "Server started",
    })
});
```

**PowerShell**
```powershell
Invoke-RestMethod -Uri "http://localhost:3335/log" -Method POST `
  -ContentType "application/json" `
  -Body '{"level":"info","source":"MyApp","message":"Task done"}'
```

### Tips pour l'IA

- Proposer le Viewer (`aidex_viewer`) pour streamer les logs en live.
- Choisir un `source` parlant -> facilite le filtrage cote query.
- Niveaux : `error` pour les erreurs, `warn` pour les warnings, `debug` pour le verbose.
- Batch (`POST /logs`) si le programme genere beaucoup de logs/seconde.
- Pattern consume : `aidex_log({ action: "query", consume: true })` retire les entries lues du buffer (poll-style).
- Fire-and-forget cote client : pas besoin d'attendre la reponse, ca evite de bloquer le code metier.
- Aucune gestion d'erreur cote client : si LogHub n'est pas demarre, le POST echoue silencieusement, c'est OK.

## Posture securite du fork

Etat releve apres `npm install` (Node 22.11.0, npm 11.15.0) le 2026-05-21 :
- 4 vulnerabilites reportees par `npm audit` (3 high + 1 critical)
- Warnings deprecated transitifs : `inflight@1.0.6` (memory leak), `glob@7.2.3` (x4, CVE), `prebuild-install@7.1.3` (non maintenu), `glob@10.5.0`

Aucun de ces packages n'est en dependance directe -- tous sont des transitifs (`jest`, `rimraf@5`, `better-sqlite3`, etc.).

Plan de hardening candidat pour un patch fork futur :
1. Ajouter des `overrides` dans `package.json` (npm 8.3+) pour forcer `glob@^11`, `rimraf@^6` sur les transitives.
2. Tester en CI dedie avant merge sur `local-patches`.
3. Surveiller les CVE upstream sur `tree-sitter` et `better-sqlite3` qui sont les addons natifs les plus exposes.

Ces actions ne sont **pas urgentes** : aucun des warnings ne casse le build. A traiter dans une session dediee, pas pendant un fix fonctionnel.

## Documentation complementaire

| Fichier | Contenu |
|---------|---------|
| `README.md` | Documentation publique (upstream + VOCSAP) |
| `MCP-API-REFERENCE.md` | API MCP complete |
| `CHANGELOG.md` | Historique des versions |
| `docs/dev-notes/` | Notes privees au fork VOCSAP (exclues de git) |
