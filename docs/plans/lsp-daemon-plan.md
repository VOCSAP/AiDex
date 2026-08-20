# Plan — Couche LSP AiDex : daemon par projet, LSP par langage

**Statut** : plan approuvé sur le principe par l'opérateur, en attente d'exécution.
**Date** : 2026-08-20.
**Branche de travail** : `claude/serena-lsp-layer-6c9f6t` (basée sur `local-patches`).
**Origine** : étude comparative avec [Serena](https://github.com/oraios/serena) (session CC du 2026-08-20).

Ce document est autoportant : il consigne toutes les décisions déjà arbitrées avec
l'opérateur pour qu'un agent CC ultérieur puisse exécuter sans re-poser de questions
résolues. Lire d'abord `.claude/CLAUDE.md` (doctrine de développement) — ce plan s'y
conforme, en particulier : **chaque phase démarre par une MESURE, pas par du code**.

---

## 1. Contexte et objectif

AiDex indexe *syntaxiquement* (tree-sitter → SQLite) : il répond à « où apparaît ce
terme ? » vite et à coût borné. Il ne fait **pas** de résolution sémantique : trois
méthodes homonymes `render` sont trois entrées indistinctes, et aucune n'est reliée à
ses appelants réels.

Un language server (LSP) fait l'inverse : analyse sémantique (résolution de noms,
types, imports) qui débloque `find references` (les usages de *ce* symbole précis, pas
les homonymes), `go to definition` cross-fichiers, hover/type info, diagnostics.

**Objectif produit** (aligné doctrine) : supprimer les séquences `Grep` → `Read` que
l'agent lance pour retrouver les usages réels d'un symbole. C'est de l'économie de
tokens (moins de lignes déversées dans le contexte) et de la fiabilité (pas de
faux-positifs homonymes).

**Pourquoi pas Serena** (évalué et écarté par l'opérateur) :
- doublons fonctionnels avec AiDex (recherche de symboles, navigation fichiers) ;
- contrainte rédhibitoire : Serena ne sert qu'**un projet à la fois**, alors que
  l'usage opérateur est multi-sessions CC sur plusieurs projets simultanément, y
  compris plusieurs sessions sur le *même* repo.

**Langages cibles, par ordre de valeur d'usage opérateur** : TypeScript, Rust, Python,
Go (un peu). TS et Rust quasi ex æquo. **Pilote : TypeScript** (tsserver est un paquet
npm, trivial à embarquer dans l'écosystème Node d'AiDex).

---

## 2. Décisions déjà arbitrées — NE PAS RE-POSER CES QUESTIONS

| # | Question | Décision | Raison |
|---|----------|----------|--------|
| D1 | Intégrer Serena ou sa couche `solidlsp` ? | **Non.** Couche LSP native à AiDex. | Doublons + mono-projet ; `solidlsp` est un sous-système Python énorme à maintenir. |
| D2 | LSP sur le serveur distant 24/24 de l'opérateur ? | **Non. Tout sur le poste de travail.** | Un LSP lit les sources sur SON disque (URIs `file://`, imports, `node_modules`, `Cargo.toml`) → il faudrait une copie synchronisée = complexité + risque de réponses sur des sources périmées. Et l'« indexation » du LSP n'est pas séparable de lui : l'analyse sémantique EST son indexation, elle tomberait sur la machine la plus faible. Aucune inférence ML en jeu (analyse statique pure). |
| D3 | Scoping du/des daemon(s) ? | **Un daemon par PROJET, hébergeant un LSP enfant par LANGAGE, démarré paresseusement.** | Ni daemon global par langage (les LSP sont scopés workspace : un « daemon Rust » global ne ferait que gérer N rust-analyzer en interne — même RAM, plus de routage, crash commun), ni daemon par projet×langage (multiplication de process de courtage inutile). Colle au modèle existant : une DB par projet. |
| D4 | Partage entre sessions CC ? | **Oui, natif.** N sessions CC sur un repo = N process MCP → 1 seul daemon → 1 seul LSP par langage sollicité. | Même modèle que la DB SQLite : chaque session a son process MCP mais tous ouvrent `<projet>/.aidex/index.db` en WAL (`src/db/database.ts:36`). Le daemon réplique ce pattern « état partagé, process par session ». |
| D5 | Découverte/élection du daemon ? | **bind-or-connect + portfile.** Premier arrivé binde et écrit le portfile ; les autres lisent le portfile et se connectent. | Pattern singleton HTTP déjà présent (LogHub port 3335, `src/loghub/log-server.ts:285` — il ne lui manque que le réflexe « EADDRINUSE ⇒ se connecter » au lieu d'« erreur »). |
| D6 | `aidex_query` dépend-il du LSP ? | **Jamais.** `aidex_query` lit SQLite directement, daemon vivant ou mort. | Seuls les nouveaux outils sémantiques (`aidex_refs`, `aidex_def`) touchent le daemon. |
| D7 | Redémarrage après arrêt du daemon ? | **Automatique et transparent** : connexion refusée / portfile mort → l'instance MCP respawne le daemon. Coût = cold start du LSP (tsserver 2–10 s ; pyright 2–5 s ; gopls quelques s ; rust-analyzer 30 s à plusieurs minutes sur gros workspace). | Mitigé par D8 + D9. |
| D8 | Timeouts | **Idle généreux (30–60 min) PAR LSP enfant** ; le daemon se termine quand plus aucun LSP enfant ni appel. Dans un repo mixte TS+Rust où le Rust n'est plus touché, rust-analyzer s'éteint seul, tsserver survit. | La réponse au coût RAM multi-projets, c'est le cycle de vie, pas la délocalisation. |
| D9 | Démarrage | **Hook `SessionStart` de Claude Code** lance `aidex lsp ensure <projet>` (idempotent, non bloquant, spawn détaché) ; le préchauffage des LSP se fait en arrière-plan DANS le daemon. Un appel sémantique qui arrive avant la fin du warm-up reçoit `{"status":"warming"}`, pas un blocage. | L'agent gère très bien un « réessaie » ; le temps qu'il ait besoin d'un refs, c'est chaud. |
| D10 | Quoi précharger ? | **Manifests à la racine (quels LSP PEUVENT tourner + leurs workspace roots) ∩ histogramme `project_files.extension` de la DB AiDex (quels langages PÈSENT dans le repo)**, cap à 2 LSP préchauffés, le reste lazy. Détail en §5. | La DB est déjà là (requête < 1 ms) ; les manifests sont nécessaires de toute façon pour les roots. |
| D11 | Périmètre fonctionnel initial | **Lecture seule** : references, definition, (hover à trancher en phase 2). **Pas de rename/édition sémantique.** | Les lectures se multiplexent sans verrou (JSON-RPC asynchrone, ids de requête) ; les écritures exigeraient une sérialisation inter-sessions — hors périmètre pilote. |
| D12 | Appels simultanés | **Non bloquant par conception.** Daemon = HTTP Node (event loop, N clients comme le LogHub) ; côté LSP, multiplexage JSON-RPC : le daemon attribue les ids et réapparie les réponses. rust-analyzer traite les lectures en parallèle sur son pool de threads. | Exigence explicite de l'opérateur. |
| D13 | Synchronisation des buffers | **Le disque est l'unique source de vérité.** Les agents CC écrivent sur disque, jamais dans des buffers d'éditeur → pas de problème multi-client de versions de buffers. Le daemon notifie le LSP des changements disque (watcher + `didChangeWatchedFiles`). | Le cas d'usage agent simplifie l'architecture par rapport à un IDE. |
| D14 | Coût de réindexation comme contre-argument | **Interdit d'invoquer** (doctrine, piste close n°6). | Tranché par l'opérateur. |

---

## 3. Phase 0 — MESURE (obligatoire avant tout code)

But : chiffrer ce que `find references` économiserait réellement, en **lignes rendues
au contexte de l'agent** (l'unité de jugement de la doctrine — pas en nombre d'appels,
pas en couverture).

Protocole :

1. Corpus : les transcripts Claude Code `~/.claude/projects/<repo>/*.jsonl` de la
   station opérateur (seul corpus d'usage réel disponible ; mono-machine, à mentionner
   une fois comme limite, jamais comme obstacle).
2. Extraire par `jq` les séquences où l'agent enchaîne `Grep` (pattern = un
   identifiant) puis un ou plusieurs `Read` sur les fichiers matchés — le motif
   « recherche d'usages d'un symbole » que `aidex_refs` remplacerait. Distinguer des
   `Grep` de littéraux/messages (non remplaçables par le LSP).
3. Pour chaque séquence : compter les lignes retournées par les `Read` (et par le
   `Grep` en mode content). C'est le coût actuel. Le coût LSP de remplacement est
   estimé à ~1–3 lignes par référence trouvée (fichier:ligne + extrait).
4. **Piège d'échantillonnage (mesuré le 2026-08-13, doctrine)** : échantillonner au
   niveau du TERME/SYMBOLE DISTINCT, pas de l'occurrence, et rendre séparément le
   poids en occurrences. Jamais un seul des deux chiffres.
5. Étiqueter chaque affirmation MESURE / DEDUIT / SUPPOSE, avec la commande et la
   ligne de sortie décisive pour chaque MESURE.
6. **Critère go/no-go** : à définir AVANT de lancer la mesure (proposition : la
   feature vaut si les séquences remplaçables pèsent ≥ 5 % des lignes totales rendues
   par Grep/Read sur le corpus, à faire valider par l'opérateur avec le résultat sous
   les yeux). Un no-go ferme la piste proprement : retirer une conclusion sans la
   remplacer est une fin légitime.

Cette phase produit un rapport court versionné à côté de ce plan
(`docs/plans/lsp-daemon-phase0-mesure.md`) — ou dans `docs/dev-notes/` si l'opérateur
préfère le garder privé au fork.

---

## 4. Architecture

### 4.1 Vue d'ensemble

```
Session CC #1 ─┐                       ┌─ tsserver (workspace: <repo>)
Session CC #2 ─┼─ process MCP AiDex ──►│
Session CC #3 ─┘   (1 par session)     │  daemon LSP du projet
                        │              │  (1 par projet, HTTP 127.0.0.1)
                        │              └─ rust-analyzer (workspace: <repo>)
                        └──── SQLite .aidex/index.db (WAL, partagée — inchangé)
```

- Le daemon est un process Node détaché, hors du cycle de vie des sessions CC.
- Un daemon par projet ; plusieurs projets en parallèle = daemons indépendants.
- LSP enfants démarrés à la demande par langage (+ préchauffage §5), chacun avec son
  idle-timeout.

### 4.2 Arborescence source proposée

```
src/lsp/
├── daemon.ts          # Entry point du daemon (spawné détaché par `aidex lsp ensure`)
├── daemon-client.ts   # Client côté process MCP : ensure() (bind-or-connect), call()
├── portfile.ts        # Lecture/écriture/validation de .aidex/lsp-daemon.json
├── ls-child.ts        # Cycle de vie d'un LSP enfant : spawn, initialize, idle-timeout
├── ls-protocol.ts     # JSON-RPC sur stdio : framing LSP, multiplexage par id
├── ls-registry.ts     # Par langage : binaire, args, manifests, extensions, workspace root
├── watcher.ts         # Watch disque → didChangeWatchedFiles vers les LSP actifs
└── prewarm.ts         # Logique de préchauffage (§5)
```

Outils MCP : handlers dans `src/server/tools.ts` comme les outils existants,
implémentation dans `src/commands/refs.ts` (qui parle à `daemon-client`).

### 4.3 Découverte et cycle de vie du daemon

- **Portfile** : `<projet>/.aidex/lsp-daemon.json` → `{ "port": N, "pid": N,
  "startedAt": ISO }`. Le daemon binde `127.0.0.1:0` (port éphémère attribué par
  l'OS — pas de hash du chemin, donc pas de collision possible), PUIS écrit le
  portfile (écriture atomique : tmp + rename).
- **ensure()** côté client MCP : lire le portfile → tenter `GET /status` → OK ⇒
  connecté. Échec (pas de portfile, connexion refusée, pid mort) ⇒ spawner le daemon
  détaché (`spawn(..., { detached: true, stdio: 'ignore' })`, `unref()`), puis
  re-poller le portfile (timeout court). Deux sessions qui spawnent en même temps :
  le second daemon échoue à créer le portfile en mode exclusif (`wx`) ou constate un
  portfile frais et valide → il se termine ; le client re-lit et se connecte. Simple,
  sans lock inter-process exotique.
- **Arrêt** : chaque LSP enfant meurt après son idle-timeout (défaut proposé 45 min,
  configurable) ; quand le dernier enfant est mort ET plus aucun appel depuis le même
  délai, le daemon supprime son portfile et se termine. Aussi `POST /shutdown` pour
  un arrêt manuel/test.
- **Windows** (station opérateur) : TCP sur 127.0.0.1 uniquement — pas de socket Unix,
  pas de named pipe (le portfile rend le port dynamique trivial). Attention aux
  chemins Windows dans les URIs LSP (`file:///C:/...`, échappement des `\`).

### 4.4 API HTTP du daemon (stateless, JSON)

| Endpoint | Corps | Réponse |
|---|---|---|
| `GET /status` | — | `{ project, uptime, children: [{lang, state: starting\|warming\|ready\|idle-closing, pid, memMB}] }` |
| `POST /refs` | `{ file, line, col }` | `{ status: ready, refs: [{file, line, col, excerpt}] }` ou `{ status: warming, retryAfterMs }` |
| `POST /def` | `{ file, line, col }` | idem, `defs: [...]` |
| `POST /hover` | `{ file, line, col }` | (si retenu en phase 2) |
| `POST /shutdown` | — | arrêt propre |

Le daemon route vers le LSP enfant d'après l'extension du fichier (`ls-registry`),
le spawne s'il n'existe pas encore (réponse `warming` pendant ce temps).

### 4.5 Multiplexage LSP et concurrence

- Une seule connexion JSON-RPC par LSP enfant, possédée par le daemon. Chaque requête
  HTTP entrante devient une requête JSON-RPC avec un id unique ; les réponses sont
  réappariées par id. Autant de requêtes en vol que nécessaire, aucune file d'attente
  côté daemon pour les lectures.
- Timeout par requête LSP (proposition : 15 s) → réponse d'erreur propre à l'agent
  plutôt qu'un hang.
- Périmètre lecture seule (D11) ⇒ aucun verrou. Ne pas implémenter rename dans ce
  lot ; si un jour il arrive, il exigera une sérialisation explicite (une seule
  écriture en vol, toutes sessions confondues).

### 4.6 Fraîcheur des analyses (D13)

- Watcher disque dans le daemon (fs.watch natif récursif — supporté sur Windows —
  filtré par les extensions des LSP actifs, avec debounce), qui pousse
  `workspace/didChangeWatchedFiles` aux enfants concernés.
- Ne PAS ouvrir les fichiers en mode `didOpen`/buffers gérés : laisser le LSP lire le
  disque. Les agents écrivent sur disque ; le disque est la vérité.

---

## 5. Préchauffage : sur quoi se baser (réponse arbitrée, D10)

Deux signaux, tous deux déjà disponibles sans rien indexer de plus :

1. **Manifests** — détermine quels LSP *peuvent* tourner et où est leur workspace
   root (information de toute façon indispensable au spawn) :
   - `tsconfig.json` ou `package.json` → tsserver
   - `Cargo.toml` → rust-analyzer
   - `pyproject.toml` / `requirements.txt` / `setup.py` → pyright
   - `go.mod` → gopls
   Recherche à la racine du repo + un niveau de sous-répertoires (monorepos), en
   s'appuyant sur `project_files` (la table porte déjà tous les fichiers du projet,
   type `config` inclus) plutôt qu'un scan disque.
2. **Histogramme des extensions** — détermine quels langages *pèsent* :
   `SELECT extension, COUNT(*) FROM project_files WHERE type IN ('code','test')
   GROUP BY extension` sur la DB projet (`src/db/schema.sql:131`, colonne
   `extension`). Mapping extension → langage : réutiliser `detectLanguage` du parser
   (`src/parser/tree-sitter.ts`), ne pas dupliquer la table.

**Règle de préchauffage** : précharger les langages ayant (manifest présent) ET (part
≥ seuil des fichiers code du repo), **cap à 2 LSP préchauffés** (RAM), le reste lazy.
Seuil initial proposé : 10 %. Ces deux constantes sont des réglages de daemon, pas
des défauts gelés dans la surface MCP — mais les calibrer quand même en phase 3 sur
les repos réels de la station (question 4 de la doctrine, par prudence).

Ce qui est explicitement écarté comme signal runtime : l'analyse des transcripts
(trop lourd pour un hook ; les transcripts servent en phase 0 et aux calibrations,
pas au runtime).

---

## 6. Hook SessionStart

Nouvelle commande CLI : `aidex lsp ensure [path]` (idempotente, retour immédiat, code
0 même si le daemon existait déjà). Hook côté projet consommateur :

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command",
            "command": "node C:/dev/AiDex/build/index.js lsp ensure \"$CLAUDE_PROJECT_DIR\"" }
        ]
      }
    ]
  }
}
```

(Chemin node/build à adapter par projet comme pour l'enregistrement MCP — cf.
`README.md` § Install. Sur la station : node 22 via nvm4w.)

Le hook ne précharge rien lui-même : il fait juste exister le daemon, qui applique
la règle §5 en arrière-plan. Une session sur un projet sans hook fonctionne aussi :
le premier appel sémantique fait l'ensure (juste un cold start visible).

---

## 7. Surface MCP

Deux outils nouveaux (pilote) :

- `aidex_refs { file, line, symbol? }` → références réelles du symbole à cette
  position. Sortie **plafonnée en lignes** comme `aidex_query` (100 lignes,
  `[showing first N]`) — l'unité de jugement de la doctrine s'applique à cette
  surface aussi. Format : `file:line: excerpt` groupé par fichier.
- `aidex_def { file, line, symbol? }` → définition(s).

États non-nominaux à rendre TELS QUELS à l'agent (pas d'échec silencieux) :
`warming` (avec consigne de réessayer), `no language server for .ext`,
`daemon unreachable` (après une tentative d'ensure).

`aidex_status` gagne une section LSP (enfants actifs, état, RAM) via `GET /status`.

Descriptions d'outils MCP : courtes, et disant explicitement quand préférer
`aidex_refs` à `aidex_query` (usages d'un symbole précis) et quand non (recherche
textuelle, littéraux) — c'est ce qui pilote le comportement de l'agent.

---

## 8. Phases d'implémentation

| Phase | Contenu | Livrable / critère |
|---|---|---|
| **0** | Mesure (§3). | Rapport + décision go/no-go validée par l'opérateur. **Aucun code avant.** |
| **1** | Squelette daemon : portfile, bind-or-connect, `ensure`, `GET /status`, `POST /shutdown`, cycle de vie sans aucun LSP. CLI `aidex lsp ensure/status/stop`. | Tests : 2 « sessions » (process) concurrentes → 1 seul daemon ; respawn après kill ; portfile stale nettoyé. |
| **2** | Pilote TypeScript : `ls-child` + `ls-protocol` + tsserver (dépendance `typescript` déjà présente dans l'arbre — vérifier, sinon dep explicite), `aidex_refs`/`aidex_def` bout en bout, watcher. | Mesure avant/après sur 3 requêtes réelles de la station : lignes rendues vs séquence Grep/Read équivalente. |
| **3** | Hook SessionStart + préchauffage (§5, §6) + idle-timeouts + calibration seuil/cap sur les repos réels de la station. | Cold start masqué : premier `aidex_refs` d'une session « normale » répond `ready`. |
| **4** | rust-analyzer (binaire attendu sur PATH via rustup ; sinon état `language server not installed` explicite). Attention cold start long : vérifier que `warming` + préchauffage suffisent sur un vrai workspace (Kleos, corpus Rust de `docs/reference/`). | Idem phase 2, sur le corpus Rust. |
| **5** | pyright (`pyright` npm) puis gopls, si l'usage mesuré le justifie. | Décision par langage sur mesure, pas par symétrie. |

Chaque phase = commits sur `claude/serena-lsp-layer-6c9f6t`, puis merge dans
`local-patches` selon le flux habituel du fork.

---

## 9. Pièges d'environnement (recopiés de la doctrine + spécifiques à ce lot)

- **Node du PATH = v24.18.0, casse l'ABI better-sqlite3** → toute la suite de tests
  échoue en bloc pour une cause sans rapport. Utiliser
  `C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe`.
- **`--runInBand` / `--maxWorkers=1` INTERDITS** sur la suite jest (addon tree-sitter
  chargé une fois par process, contexte vm par fichier → arbres morts dès le 2e
  fichier ; mesuré 66/138 échecs mono-process vs 138/138 OK en parallèle).
- **Tests du daemon** : ce sont des tests de process externes (spawn réel du daemon,
  ports éphémères). Ne pas les faire dépendre d'un LSP installé : mocker le LSP enfant
  par un faux serveur JSON-RPC stdio dans les tests de phases 1–2 ; un test
  d'intégration tsserver réel séparé, skippé si `typescript` absent.
- **Windows** : URIs LSP `file:///C:/...` (slash initial, casse du lecteur) ; spawn
  détaché testé sur Windows (comportement `detached` différent d'unix) ;
  `fs.watch` récursif OK sur Windows mais debouncer (rafales d'événements).
- **agent-forge** : collision sur répertoire de travail partagé si plusieurs agents —
  vérifier que le stdout lu est bien le sien.
- Après changement de version Node : `npm rebuild` (addons natifs).

---

## 10. Questions encore ouvertes (les SEULES à poser/trancher)

1. Critère go/no-go chiffré de la phase 0 (proposition §3 pt 6 — à valider par
   l'opérateur AVEC le résultat de mesure sous les yeux).
2. `aidex_hover` dans le pilote, ou lot suivant ?
3. Monorepos multi-`tsconfig` : un tsserver à la racine suffit-il sur les repos réels
   de la station, ou faut-il un enfant par sous-workspace ? (Mesurer sur cas réel en
   phase 2 — koryphaios-experimental dans `docs/reference/` comme corpus TS.)
4. Valeurs finales : idle-timeout (45 min ?), seuil de préchauffage (10 % ?), cap
   (2 ?), timeout requête LSP (15 s ?). Calibrer en phase 3, pas débattre avant.

---

## 11. Références code (état au 2026-08-20, branche `local-patches`)

| Quoi | Où |
|---|---|
| Pattern singleton HTTP + EADDRINUSE (à étendre en bind-or-connect) | `src/loghub/log-server.ts:285`, pattern module-level : `src/viewer/progress.ts` |
| DB projet partagée en WAL | `src/db/database.ts:36`, chemin : `src/commands/shared.ts:31` (`<projet>/.aidex/index.db`) |
| `INDEX_DIR = '.aidex'` | `src/constants.ts:14` |
| `project_files` (colonne `extension`, types `code`/`config`/`test`) | `src/db/schema.sql:131` |
| Détection de langage par extension | `src/parser/tree-sitter.ts` (`detectLanguage`) |
| Déclaration des outils MCP | `src/server/tools.ts` |
| Plafond de sortie 100 lignes d'`aidex_query` (modèle à répliquer) | `src/commands/query.ts` |
