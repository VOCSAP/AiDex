# Plan — Wrappers CLI et hooks de lecture : réduire le contexte hors recherche

> **Statut (2026-09-13)** : document d'intention. Rien n'est codé, rien n'est mesuré
> sur la trace. Chaque proposition ci-dessous est étiquetée SUPPOSÉ tant que la
> Phase 0 (§3) n'a pas rendu ses chiffres. Un `non` mesuré en Phase 0 ferme la
> piste concernée sans discussion.

**Date** : 2026-09-13.
**Branche** : `local-patches` (doc seul, aucune modification de code).
**Origine** : étude comparative avec [CodeSage](https://github.com/iliaal/codesage)
(session CC du 2026-09-13, branche `claude/codesage-repo-review-34kxq0`). L'étude n'a
retenu aucun outil de CodeSage à reprendre ; elle a débouché sur la question inverse,
posée par l'opérateur : « en te mettant à la place d'un agent, que manque-t-il à AiDex
pour réduire les tokens des outils internes d'une session de développement ? »

Ce document est autoportant. Lire d'abord `.claude/CLAUDE.md` (doctrine) : ce plan s'y
conforme, en particulier **chaque phase démarre par une MESURE, pas par du code**, et
l'unité de jugement reste le **nombre de lignes rendues au contexte de l'agent**.

---

## 1. Constat de départ

AiDex a résolu la **recherche** : `aidex_query` remplace `Grep` puis `Read`, le hook
`aidex-grep-nudge.py` rend ce remplacement déterministe, et le plafond de 100 lignes
ne mord que dans 5,4 pourcent des appels (doctrine, piste close n°7). La recherche
n'est plus le poste de dépense.

Observation faite par l'agent sur sa propre session du 2026-09-13 (MESURÉ sur un
tour, pas sur la trace) : les trois postes qui ont réellement consommé le contexte
ne sont pas des recherches.

1. **Lecture de fichiers entiers.** 33 Ko d'un README déversés pour en exploiter
   trois sections ; 700 lignes d'un fichier source lues pour en extraire 24 chaînes ;
   des fichiers entiers lus pour un en-tête de 40 lignes. `Read` sans `offset` ni
   `limit` lit jusqu'à 2000 lignes.
2. **Sorties de commandes.** `git diff`, `git show`, `git log -p` rendent des hunks
   entiers ; `npm test` imprime chaque fichier PASS et tous les `console.log` ;
   `tsc` et `npm run build` sont verbeux en cas d'échec.
3. **Relecture après édition**, en partie inévitable (l'outil `Edit` du harness exige
   un `Read` préalable du fichier).

Ce que le harness a fait de mieux pour l'agent pendant cette même session : persister
une sortie de 33 Ko dans un fichier et n'en rendre que 2 Ko plus le chemin. C'est le
modèle à reproduire.

---

## 2. Décisions déjà arbitrées — NE PAS RE-POSER CES QUESTIONS

| # | Question | Décision | Raison |
|---|----------|----------|--------|
| D1 | Outils MCP ou sous-commandes CLI ? | **CLI, sous le binaire `aidex` existant** (`aidex read`, `aidex git`, `aidex test`, `aidex build`). Pas de binaire séparé type `wrap-git`. | Un outil MCP déclaré coûte son schéma à chaque session, appelé ou non (mesure du 2026-09-02, 4,2 à 4,5 octets par token). Une sous-commande CLI ne coûte rien tant qu'elle n'est pas lancée. Un seul binaire réutilise `src/commands/` et la même DB, sans doublon. |
| D2 | Comment l'agent apprend-il à s'en servir ? | **Par le refus d'un hook PreToolUse**, dont le message contient la commande exacte à relancer. Rien dans le bloc `instructions` du serveur MCP. Une seule notice permanente, courte, dans le CLAUDE.md global du poste (§6.3), plafonnée à une centaine de tokens. | La notice complète n'est payée qu'au moment où elle sert. La phrase globale est un pari peu coûteux pour éviter des refus ; le hook reste la garantie : CodeSage a mesuré qu'une consigne CLAUDE.md seule ne déplace pas le choix d'outil (0 sur 10, `codesage-prompt-override.md`). |
| D3 | Le hook `Read` remplace-t-il `Read` ? | **Non. Il force un `Read` BORNÉ.** Refus d'un `Read` sans `offset`/`limit` sur un fichier indexé au-dessus d'un seuil ; le message de refus donne le plan du fichier et l'appel `Read` borné à refaire. | `Edit` exige un `Read` préalable du fichier dans la conversation. Détourner `Read` vers un autre outil casserait `Edit`. |
| D4 | Bloquer tout `git` ? | **Non.** Bloquer seulement les formes qui déversent des hunks : `git diff` nu, `git show`, `git log -p`. `--stat`, `--name-only`, `--oneline` passent. | Ces formes sont déjà denses ; les bloquer coûterait un aller-retour pour rien. |
| D5 | Sortie de secours | **Toujours.** `aidex git diff --raw` passe tout ; `aidex test --show <n>` rend un échec complet ; la sortie brute est toujours écrite sur disque et le digest se termine par son chemin. | Sans échappatoire explicite, le modèle contourne (`cat`, `git` déguisé dans un script), ce que le hook grep a précisément appris à éviter. |
| D6 | Comportement en cas d'erreur du hook | **Fail open, toujours**, comme `aidex-grep-nudge.py` : pas d'oracle, pas de verdict, pas de blocage. | Un blocage à tort apprend au modèle à contourner l'outillage ; un passage à tort coûte une lecture redondante. L'asymétrie est la même que pour grep. |
| D7 | Wrapper de tests : périmètre | **Encode les pièges d'environnement** en plus du digest : impose le binaire Node du poste (`.claude/CLAUDE.local.md`) et refuse `--runInBand` / `--maxWorkers=1`. | Ces deux pièges ont coûté trois rapports de diagnostic dont deux à cause racine fausse (doctrine, « Pièges d'environnement »). Un outil MCP ne peut pas empêcher un `npm test` lancé en Bash ; un hook plus un wrapper le peuvent. |
| D8 | Ordre de réalisation | **Read, puis git, puis test.** Chacun conditionné à sa mesure de Phase 0. | Par poids supposé décroissant dans le contexte. |
| D9 | Coût de démarrage du CLI | **Accepté.** Chaque appel paie Node plus `better-sqlite3`. | `aidex can` paie déjà ce coût dans le hook grep à chaque Grep intercepté ; il est connu. |
| D10 | Coût de réindexation comme contre-argument | **Interdit d'invoquer** (doctrine, piste close n°6). | Tranché par l'opérateur. |

---

## 3. Phase 0 — MESURE (obligatoire avant tout code)

But : chiffrer, en octets de `tool_result` rendus au contexte, ce que pèsent
réellement les trois postes du §1. Le corpus est celui déjà exploité pour le filtre
`tools/list` : les transcripts Claude Code sous `~/.claude/projects/` (1923
transcripts, 70 projets au 2026-09-02). Emplacement courant : `.claude/CLAUDE.local.md`.

### 3.1 Mesure commune

Sommer les octets de `tool_result` par outil interne : `Read`, `Grep`, `Glob`, et
`Bash` ventilé par forme de commande (premier mot, puis sous-commande git, puis
`npm test` / `jest` / `tsc` / `npm run build`). Rendre SÉPARÉMENT le nombre d'appels
et le poids en octets, jamais un seul des deux (piège d'échantillonnage de la
doctrine). Le résultat est un classement : il dit où part le contexte.

Seuil de décision : un poste qui pèse moins de quelques pourcents du total ne
justifie pas un hook et sa maintenance. Le chiffre exact se fixe à la lecture du
classement, pas à l'avance.

### 3.2 Mesures propres à chaque piste

- **Read** : distribution de la taille des résultats `Read` ; part des `Read` sans
  `offset`/`limit` ; part des `Read` suivis d'un `Edit` du même fichier dans le même
  tour. Ce dernier chiffre borne le gain : sur un fichier qui va être édité, le hook
  ne fait que réduire la plage lue, il ne supprime pas l'appel.
- **git** : part des `tool_result` Bash dont la commande commence par `git diff`,
  `git show`, `git log -p` ; à part, `git blame`, `git log -L`, `git log -S` pour
  décider si un `aidex git history` mérite d'exister (probablement non).
- **test / build** : part des `tool_result` pour `npm test`, `jest`, `tsc`,
  `npm run build` ; et parmi eux, la part des runs en échec (seuls ceux-là ont un
  digest non trivial).

### 3.3 Vérification préalable au hook Read

À vérifier sur le harness AVANT de coder le hook : **un `Read` partiel (avec
`offset`/`limit`) suffit-il à débloquer `Edit` sur ce fichier ?** L'agent le croit
(DÉDUIT du comportement observé), il ne l'a pas mesuré. Si la réponse est non, D3
tombe et la piste Read se réduit à exposer `body_lines` dans `aidex_signature`
(§5.1, variante minimale), sans hook.

### 3.4 Mesure de l'effet, après coup

Méthode empruntée à CodeSage (`bench/agent-task-runner`, non repris tel quel car
couplé à leur binaire) : même tâche lancée en `claude -p` headless dans deux bras,
AVEC et SANS les hooks, N runs, médiane des tokens lus dans `usage` du flux
stream-json, exécution non imbriquée dans une session CC. C'est la seule mesure qui
donne une économie réelle par tâche ; la trace rétrospective ne donne qu'un
potentiel. Le modèle et l'effort sont épinglés et nommés dans tout chiffre publié.

---

## 4. Architecture

### 4.1 Hooks (`hooks/claude/`)

Trois hooks PreToolUse, tous sur le modèle de `aidex-grep-nudge.py` : pré-filtre en
Python qui décide seulement d'INTERROGER, oracle CLI qui décide de BLOQUER, fail
open partout. Matchers dans `settings.json.template` :

| Hook | Matcher | Intercepte | Redirige vers |
|------|---------|------------|---------------|
| `aidex-read-nudge.py` | `Read\|Bash` | `Read` sans borne ; `cat`, `sed -n`, `head`, `tail` sur un fichier du projet | `Read` borné (`offset`/`limit`) |
| `aidex-git-nudge.py` | `Bash` | `git diff` nu, `git show`, `git log -p` | `aidex git diff [ref]` |
| `aidex-test-nudge.py` | `Bash` | `npm test`, `jest`, `tsc`, `npm run build` | `aidex test`, `aidex build` |

Règle anti-perte du hook Read : ne refuser que si le fichier fait plus de trois fois
la longueur du plan qui sera rendu, sinon le refus coûte plus que la lecture. Le
seuil absolu vient de §3.2.

### 4.2 Sous-commandes CLI (`src/index.ts`, `src/commands/`)

| Commande | Rend | Source |
|----------|------|--------|
| `aidex outline <file>` | Plan du fichier : symboles avec plage de lignes, ou titres markdown avec plage. Plafonné. | `methods.line_number` + `body_lines` (existants) ; ligne de fin des `types` (à ajouter, §5.1) ; `chunker-docs.ts` pour le markdown. |
| `aidex git diff [ref] [--symbol X] [--raw]` | Par fichier : symboles touchés (plages de lignes de l'index croisées avec les hunks), lignes ajoutées/retirées, bruit replié en compteur (lockfiles, générés, snapshots, hunks blancs). `--symbol` rend un seul hunk. `--raw` passe tout. | `git diff` piloté par le CLI, index pour la résolution des symboles. |
| `aidex test [--show <n>]` | Compte pass/fail ; par échec : nom du test, assertion attendue/reçue, première frame de stack dans le projet. `--show` rend un échec complet. | Exécute jest avec le binaire Node du poste, sans `--runInBand`. |
| `aidex build` | Erreurs `tsc` regroupées par fichier, une ligne par erreur. | Exécute `npm run build`. |

Principe commun : la sortie brute est toujours écrite sous `.aidex/runs/<horodatage>-<commande>.log`,
le digest se termine par ce chemin. Rotation à définir (garder les N derniers).

### 4.3 Ce que le graphe apporte au digest git

Un symbole touché par le diff, croisé avec `aidex_edges` (appelants candidats), donne
la liste de ce que l'agent doit vérifier après une modification. C'est le seul point
où le digest git dépasse ce qu'un `git diff --stat` sait faire ; il ne s'active que
sur demande (`--callers`), jamais par défaut, pour rester sous le plafond.

---

## 5. Détail par piste

### 5.1 Read borné

Variante minimale, à faire en premier et quelle que soit la réponse de §3.3 :
exposer `body_lines` dans la sortie de `aidex_signature`, pour que l'agent appelle
`Read` avec `offset` et `limit` exacts. Une colonne déjà indexée
(`src/db/schema.sql`, table `methods`), zéro item nouveau, zéro schéma nouveau.

Prérequis d'index pour les types : `types` n'a pas de ligne de fin
(`src/db/schema.sql`, table `types`) alors que l'extracteur la calcule déjà pour les
méthodes (`node.endPosition.row`, `src/parser/extractor.ts`). C'est une COLONNE, pas
des items nouveaux : aucune concurrence sous le plafond de 100 lignes, la doctrine
« indexer plus n'est pas améliorer » ne s'applique pas.

Markdown : `chunker-docs.ts` découpe déjà par titre avec `startLine` ; `aidex outline`
réutilise ce découpage sans l'indexer.

### 5.2 Digest git

Le bruit à replier se définit par une liste de motifs versionnée dans le CLI, pas
dans le hook : lockfiles (`package-lock.json`, `Cargo.lock`), dossiers générés,
`__snapshots__`, hunks dont la différence est blanche. Chaque catégorie repliée
rend une ligne de compteur, jamais zéro ligne : l'agent doit savoir qu'il y a eu
repli.

`aidex git history <file> [--symbol X]` (une ligne par commit : sha court, date,
sujet, sur la plage du symbole) n'est écrit que si §3.2 montre un usage de
`git blame` / `git log -L` qui le justifie. Sinon, piste fermée.

### 5.3 Digest de tests et de build

Le wrapper de tests est aussi une protection : il rend impossible le run
mono-processus qui fait mourir l'arbre tree-sitter au deuxième fichier (doctrine).
C'est un gain indépendant des tokens, à ne pas confondre avec lui dans le bilan.

---

## 6. Conséquence sur la surface MCP

### 6.1 Critère

Un outil reste MCP si son résultat nourrit le raisonnement suivant de l'agent et
s'il est appelé souvent au fil d'une session. Un outil passe en CLI s'il est
déterministe et relève de l'administration de l'index, de la configuration, ou d'un
appelant qui n'est pas l'agent (hook). Le passage en CLI se fait en deux temps :
sous-commande `aidex` si elle n'existe pas, puis ajout à `DEFAULT_DISABLED_TOOLS`
(`src/server/tools.ts`). Le bras de `handleToolCall` reste ; le filtre est purement
soustractif sur `tools/list`, donc un client qui appelle l'outil par son nom obtient
toujours sa réponse.

Condition avant chaque retrait : le compte d'appels agent dans la trace. La
deny-list échoue ouvert ; retirer un outil que l'agent appelle serait une régression
visible.

### 6.2 Candidats, état au 2026-09-13

Unité : octets de source TypeScript de l'objet de définition dans `src/server/tools.ts`
(commentaires et indentation inclus, donc supérieure au JSON réellement envoyé).
MESURÉ par appariement d'accolades sur les 33 objets. La même unité est appliquée
aux deux côtés, donc le pourcentage est légitime ; aucun de ces nombres ne se
compare au 10,8k tokens de la mesure du 2026-09-02, qui est une autre unité.

Surface annoncée aujourd'hui : 22 outils, 27 745 octets. Les 14 candidats CLI
pèsent 15 769 octets, soit 57 pourcent de la surface annoncée.

| Outil | Octets | CLI existant | Destination | Pourquoi |
|-------|-------:|--------------|-------------|----------|
| `screenshot` | 3 083 | non | `aidex screenshot` | Rend déjà un chemin de fichier pour `Read`, pas une image : un CLI qui écrit le PNG et imprime le chemin est strictement équivalent. |
| `init` | 2 170 | `aidex init` | deny-list | Cycle de vie de l'index, geste opérateur. |
| `global_init` | 1 828 | `aidex global-init` | deny-list | Idem, DB globale. |
| `coverage` | 1 362 | `aidex can` | deny-list | Appelant réel : le hook grep. `aidex_query` inline déjà le verdict sur résultat vide (`noticeFor`). |
| `settings` | 974 | non | `aidex settings` | Configuration par projet, geste opérateur. |
| `global_status` | 844 | non | `aidex global-status` | Administration. |
| `scan` | 836 | `aidex scan` | deny-list | Découverte de projets à lier, geste opérateur. |
| `global_refresh` | 793 | non | `aidex global-refresh` | Administration. |
| `viewer` | 760 | `aidex viewer` | deny-list | Ouvre une UI pour l'humain. |
| `remove` | 696 | non | `aidex remove` | Cycle de vie. |
| `update` | 689 | `aidex update` | deny-list | Appelant réel : les hooks git et Stop. |
| `session` | 632 | non | **hook `SessionStart`** | La sortie de `aidex session start` est injectée dans le contexte par le hook, au seul moment où elle sert. Zéro outil, zéro appel agent. |
| `windows` | 604 | non | `aidex windows` | Compagnon de `screenshot`. |
| `status` | 498 | non | `aidex status` | Orientation ponctuelle ; ce que `summary` ne couvre pas peut y être fusionné. |

Restent MCP (11 976 octets) : `query`, `edges`, `signature`, `signatures`, `search`,
`summary`, `tree`, `files`. Les deux derniers sont à mesurer contre `Glob` et `ls`
avant de trancher ; ils ne sont pas administratifs, donc hors de ce lot.

Deux réserves. `screenshot` et `windows` : vérifier dans la trace qu'ils ne sont pas
appelés en boucle serrée (capture, lecture, capture) ; si oui, l'aller-retour Bash
puis `Read` coûte deux appels au lieu d'un et le gain de schéma ne compense pas.
`session` : vérifier que le harness injecte bien le stdout d'un hook `SessionStart`
dans le contexte de l'agent (DÉDUIT de la documentation des hooks, non mesuré ici).

### 6.3 Notice dans le CLAUDE.md global du poste

Une seule, courte, hors dépôt (`~/.claude/CLAUDE.md`), payée à chaque session, donc
plafonnée à une centaine de tokens. Proposition :

```markdown
## AiDex en CLI
Dans un projet indexé (`.aidex/`), préférer `aidex` aux commandes brutes :
`aidex outline <fichier>` avant un Read entier, `aidex git diff [ref]` au lieu de
`git diff` / `git show`, `aidex test` et `aidex build` au lieu de `npm test` / `tsc`.
Même information, sortie condensée, brut conservé sous `.aidex/runs/`. Les hooks
refusent les formes brutes ; `aidex --help` liste le reste.
```

Elle n'est écrite qu'une fois les sous-commandes livrées : une consigne qui pointe
vers une commande absente apprend au modèle à ignorer la consigne.

Aucun des wrappers de ce plan ne devient un outil MCP, ni maintenant ni plus tard,
sauf mesure contraire. C'est la décision D1.

---

## 7. Pièges d'environnement (recopiés de la doctrine)

- **`--runInBand` et `--maxWorkers=1` sont INTERDITS** sur la suite de tests. Le
  wrapper `aidex test` doit les refuser, pas seulement les éviter.
- **Un mauvais binaire `node` casse l'ABI de `better-sqlite3`.** Binaire à utiliser :
  `.claude/CLAUDE.local.md`. Le wrapper le lit là, jamais en dur.
- **Aucun chemin absolu dans les hooks**, même en commentaire :
  `probe-hook-discovery.py` refuse le fichier entier.
- **Le message de refus est du contexte.** Le plan rendu par le hook Read est
  plafonné ; un plan de 150 méthodes n'est pas un gain sur un fichier de 300 lignes.

---

## 8. Ce que ce plan n'ajoute pas

- Résumé de code par LLM : coûte des tokens pour produire une approximation à
  vérifier.
- Navigation multi-sauts (`impact_analysis` à la CodeSage) : pas sans une trace qui
  montre des appels chaînés à `aidex_edges`.
- Champ `next` par réponse (CodeSage) : jusqu'à 2 Ko ajoutés sans condition,
  contraire à la densité sous plafond.
- Tout ce qu'un `Glob` fait en une ligne.

---

## 9. Questions encore ouvertes (les SEULES à trancher)

1. Seuil de taille du hook Read : lu dans §3.2, pas fixé ici.
2. `Read` partiel et `Edit` : §3.3.
3. Rotation des sorties brutes sous `.aidex/runs/` : nombre ou âge.
4. Faut-il que le hook Read s'applique aussi hors projet indexé (fichiers sans
   `.aidex/index.db`) ? Position par défaut : non, le hook ne parle que quand
   l'index peut rendre un plan.

---

## 10. Références code (état au 2026-09-13, branche `local-patches`)

- Hook modèle : `hooks/claude/aidex-grep-nudge.py` ; matchers :
  `hooks/claude/settings.json.template`.
- Oracle de couverture CLI : `aidex can` (`src/commands/coverage.ts`).
- Corps et longueur des méthodes : `src/db/schema.sql` (table `methods`, colonnes
  `body_text`, `body_lines`) ; calcul : `src/parser/extractor.ts` (`bodyEndRow`).
- Types sans ligne de fin : `src/db/schema.sql` (table `types`).
- Découpage markdown par titre : `src/embeddings/chunker-docs.ts`.
- Filtre de la liste d'outils : `src/server/tools.ts` (`DEFAULT_DISABLED_TOOLS`).
- Arêtes candidates pour `--callers` : `src/commands/edges.ts`,
  `docs/plans/candidate-import-call-edges.md`.
- Méthode A/B de référence (externe) : `bench/agent-task-runner` dans
  `iliaal/codesage`.
