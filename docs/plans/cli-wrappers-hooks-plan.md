# Plan — Wrappers CLI et hooks de lecture : réduire le contexte hors recherche

> **Statut (mise à jour 2026-09-14)** : inventaire du poste et Phase 0 (§3.1, §3.2,
> §3.3) MESURÉS le 2026-09-14 sur la trace réelle. Verdict : piste Read ouverte
> (rang 1), retrait deny-list de dix outils MCP ouvert (rang 2), piste git au seuil
> (rang 3, périmètre réduit), piste test fermée côté tokens, `aidex git history`
> fermé. Voir la section « 0. Inventaire et mesure du 2026-09-14 » ci-dessous.
> Rien n'est codé. Script et sortie brute (privés au fork, `docs/dev-notes/`) :
> `measure-tool-results.mjs`, `measure-tool-results.out.txt`.
>
> Statut d'origine (2026-09-13) : document d'intention ; chaque proposition était
> étiquetée SUPPOSÉ tant que la Phase 0 n'avait pas rendu ses chiffres.

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

## 0. Inventaire et mesure du 2026-09-14

Cette section documente l'inventaire du poste (§11) et la Phase 0 (§3) exécutés le
2026-09-14 sur la station de l'opérateur. Elle ne remplace aucune décision arbitrée
(§2) : elle ouvre, ferme ou reporte chaque piste par la mesure. Étiquetage : tout ce
qui est chiffré ci-dessous est MESURÉ sauf mention DÉDUIT ou SUPPOSÉ.

### 0.1 Inventaire du poste

| # | Point | État mesuré | Preuve |
|---|-------|-------------|--------|
| 1 | `~/.claude/CLAUDE.md` | Aucun bloc AiDex. 19 062 octets, 0 marqueur `AIDEX-START`/`AIDEX-END`. Trois mentions génériques d'AiDex dans la doctrine outillage (lignes 8, 11, 69), deux citations de preuve dans `rules/agent-forge.md` et `rules/git.md`. L'affirmation de l'opérateur (« rien porté ») est confirmée. | `wc -c`, `grep -n "AIDEX-START\|AIDEX-END"` -> 0, `grep -ni aidex` sur l'arbre `~/.claude/` |
| 2 | Hooks | Installés au niveau GLOBAL seulement (`~/.claude/settings.json`, symlink vers `claude-config/settings.json`), identiques au template : PreToolUse `Grep\|Bash` -> `aidex-grep-nudge.py` ; PostToolUse `Edit\|Write` -> `aidex-queue-edit.py` (timeout 5) ; Stop -> `aidex-queue-drain.py` (timeout 15). Les trois scripts existent. Le `.claude/settings.json` du projet (132 octets) et `settings.local.json` (171 octets) ne portent aucune clé `hooks`. | diff contre `hooks/claude/settings.json.template` : zéro divergence |
| 3 | Skill `aidex` | EXISTE : `~/.claude/claude-config/skills/aidex/SKILL.md` (via symlink `~/.claude/skills`), 10 975 octets, 166 lignes. Contenu : substitution Grep/Glob/Read par `aidex_query`/`aidex_signature`, règle « AiDex pour trouver, grep pour prouver une absence ». Aucune mention des sous-commandes CLI. | `wc -c`, `wc -l` |
| 4 | Serveur MCP `aidex` | Déclaré dans `~/.claude.json`, bloc `mcpServers` global : `command` = binaire Node 22.11.0 de nvm, `args` = `build/index.js` du dépôt, PAS de clé `env`, donc `AIDEX_TOOLS_DISABLE` non définie (le défaut `DEFAULT_DISABLED_TOOLS` s'applique). `tools/list` réel : **22 outils, 16 430 octets de payload JSON**. Concorde avec la doctrine (33 - 11 = 22). Non comparable aux 27 745 octets de §6.2, qui sont de la source TypeScript. | `initialize` puis `tools/list` en JSON-RPC stdio sur le binaire déclaré |
| 5 | Corpus de trace | `~/.claude/projects/` : 80 projets, 2 305 fichiers `.jsonl` (dont 446 transcripts de sous-agents sous `<session>/subagents/`), 2 083 258 095 octets. Période : premier timestamp interne 2026-05-14T10:45Z, dernier 2026-09-14. Écart avec le plan (1 923 / 70 au 2026-09-02) : croissance normale sur 12 jours. | `find ... -name "*.jsonl" \| wc -l`, somme des tailles |
| 6 | Node | `node` du PATH : v24.18.0. Binaire déclaré dans `CLAUDE.local.md` : v22.11.0, existe (80 511 640 octets). `.nvmrc` = `20`, `engines.node` = `>=20.0.0` (plancher upstream, cohérent avec la contrainte plus stricte du fork). | `node --version`, `ls -la` |

Vérification §3.3 (prérequis du hook Read) : **un `Read` borné suffit à débloquer
`Edit`.** MESURÉ dans la session du 2026-09-14 : `Read` avec `offset=1`, `limit=3`
sur un fichier jamais lu dans la session (`docs/dev-notes/next-session-prompt.md`),
puis `Edit` d'une chaîne de la ligne 1 ; sortie décisive : « The file ... has been
updated successfully », aucune erreur « File has not been read yet » ; puis retour
arrière par un second `Edit`. D3 tient. Non mesuré : un `Edit` d'une chaîne située HORS de la
plage lue (sans intérêt pour le hook, qui borne la plage que l'agent va éditer).

### 0.2 Phase 0 : méthode

Script `docs/dev-notes/measure-tool-results.mjs` (privé au fork), Node 22.11.0.
Unité unique : octets UTF-8 du `content` de chaque bloc `tool_result` (somme des
blocs `text` quand `content` est un tableau ; 216 blocs image comptés à part, hors
octets). Appariement `tool_use` -> `tool_result` par `tool_use_id` dans le même
fichier, dédoublonnage global par `tool_use_id` (6 579 doublons de transcripts repris
ou forkés ignorés ; 5 résultats orphelins, 51 appels sans résultat). « Même tour » :
entre deux messages utilisateur ne portant aucun `tool_result` et non `isMeta`.
Bash : segments coupés sur `&&`, `||`, `;`, `|`, retour à la ligne (découpe naïve,
ignore les guillemets) ; premier segment effectif après `cd`, `export` et `VAR=val`.
Ce sont des octets comptés UNE fois à l'émission, pas le coût facturé : un résultat
lu en début de longue session est re-facturé à chaque inférence suivante (réserve de
§0.6).

Corpus principal : 1 860 transcripts de session, 0 fichier en erreur, 1 ligne JSON
invalide, 141 972 résultats appariés, **167 324 169 octets**. Les 446 transcripts de
sous-agents (6 248 résultats, 13,2 Mo) sont mesurés à part et ont le même profil
(Read 49,9 pourcent, Bash 34,2 pourcent). Tous les chiffres des §0.2 à §0.4 viennent
d'un seul run, le seul présent sur disque, horodaté 2026-09-14T07:43:46Z (période
couverte 2026-05-14T10:45:41Z à 2026-09-14T07:43:35Z). Fichiers lus : 2 306 contre
2 305 à l'inventaire, corpus vivant (il inclut la session de mesure).

### 0.3 Classement commun (§3.1)

Pourcentages sur le total tous outils confondus, corpus principal.

| Outil | Appels | Pourcent appels | Octets | Pourcent octets |
|-------|-------:|----------------:|-------:|----------------:|
| Read | 19 074 | 13,4 | 74,4 M | **44,5** |
| Bash | 66 064 | 46,5 | 60,4 M | **36,1** |
| `roadmap_get` (MCP) | 845 | 0,6 | 5,66 M | 3,4 |
| Grep | 5 397 | 3,8 | 5,26 M | 3,1 |
| Edit | 17 912 | 12,6 | 3,45 M | 2,1 |
| Write | 7 637 | 5,4 | 1,45 M | 0,9 |
| Glob | 669 | 0,5 | 0,34 M | 0,2 |
| tous les noms `mcp__aidex__*` | 5 417 | 3,8 | 2,75 M | 1,6 |
| Tous MCP | 22 500 | 15,8 | 20,8 M | 12,4 |

Bash par premier mot (part du total tous outils) : `sed` 3 582 appels / 8,32 M / 5,0
pourcent ; `grep` 9 380 / 6,93 M / 4,1 ; `echo` 4 896 / 5,97 M / 3,6 ; `kleos-cli`
7 192 / 4,83 M / 2,9 ; `cat` 2 887 / 4,62 M / 2,8 ; `git diff` 1 629 / 3,85 M / 2,3 ;
`git show` 1 180 / 2,89 M / 1,7 ; `bun test` 4 488 / 2,29 M / 1,4.

Lecture déguisée en Bash, premier segment strict, sans pipe : `sed -n` 2 679 appels /
7,21 M ; `cat <fichier>` 610 / 2,64 M ; `head`/`tail` 422 / 0,51 M. Soit, pour `cat`
plus `sed -n`, **3 289 appels, 9,84 M, 5,9 pourcent du total**. Les commandes entières
qui CONTIENNENT `head` ou `tail` n'importe où pèsent 26,7 M ; ce sont les octets de ces
commandes complètes, pas ceux de `head`/`tail`. DÉDUIT de l'écart avec les 0,51 M en
premier segment : ce poste est presque entièrement du pipe réducteur (`| tail -N`), pas
du dump. Cible, formule (relatif + sous `cwd`) / total de la même table (premier
segment strict, pipes confondus) : `sed -n` (6 738 567 + 687 401) / 8 226 128 = 90,3
pourcent ; `cat` (2 307 845 + 692 920) / 3 547 219 = 84,6 pourcent. DÉDUIT : un
préfixe `cd DIR &&` est compté relatif sans vérification.

### 0.4 Mesures par piste (§3.2)

**Read.**
- Taille des résultats : p50 2 225 octets, p90 8 717, p99 27 977, max 67 376.
- Le plafond de 2 000 lignes n'est JAMAIS atteint (max observé 1 531 lignes sur
  18 500 Read portant `numLines`). La borne réelle est le plafond de tokens : 19
  erreurs « exceeds maximum allowed tokens », 29 résultats tronqués (0,2 pourcent).
  Le §1 (« lit jusqu'à 2 000 lignes ») est exact mais non contraignant en pratique.
- Sans `offset` ni `limit` : **6 428 appels (33,7 pourcent), 41,8 M (56,2 pourcent des
  octets Read, 25,0 pourcent du total tous outils)**.
- Suivis d'un `Edit`/`Write`/`MultiEdit`/`NotebookEdit` du même chemin dans le même
  tour : 9 818 appels (51,5 pourcent), 31,0 M (41,7 pourcent).
- Sans borne ET suivis d'édition : 1 968 appels, 13,6 M. Donc **sans borne et NON
  édités : 6 428 - 1 968 = 4 460 appels, 41,83 M - 13,58 M = 28,25 M, 16,9 pourcent du
  total tous outils**. C'est le gisement du hook Read.
- Profil de ce sous-ensemble (compte direct du même run : 4 460 appels, 28 254 530
  octets, égal à la différence ci-dessus) : p50 3 895 octets, p90 15 048, p99 41 259.
  Seuils : au-dessus de 2 Ko, 68,4 pourcent des appels et 96,3 pourcent des octets ;
  au-dessus de 5 Ko, 41,2 et 81,8 ; au-dessus de 10 Ko, 18,1 et 55,7 ; au-dessus de
  20 Ko, 5,7 et 28,2.
- Extensions (appels / octets / part des octets du sous-ensemble) : `.md` 794 /
  7 401 725 / 26,2 ; `.py` 1 057 / 7 049 581 / 25,0 ; `.ts` 726 / 5 620 939 / 19,9 ;
  `.diff` 151 / 1 701 060 / 6,0 ; `.go` 240 / 1 392 916 / 4,9 ; `.rs` 127 / 983 112 /
  3,5 ; `.txt` 130 / 703 434 / 2,5 ; `.tsx` 65 / 590 564 / 2,1 ; `.json` 284 / 581 150
  / 2,1 ; `.sh` 80 / 397 931 / 1,4.
  DÉDUIT : `.md` + `.diff` + `.txt` = 34,7 pourcent des octets sur des fichiers que
  `aidex_signature` ne structure pas en méthodes.
- Fichier sous un projet ayant un `.aidex/index.db` sur disque AUJOURD'HUI (remontée
  des parents depuis le fichier, chemin résolu contre le `cwd` de la ligne) : 61,7
  pourcent des appels, **68,1 pourcent des octets** ; hors de tout projet indexé : 36,8
  et 31,8 ; non résolvable : 63 appels. Sous-agents, profil inversé : 68,9 pourcent des
  octets hors projet indexé. Limites : projet indexé ne veut pas dire fichier indexé
  (croisement extension x indexé non calculé) ; état du disque du jour, pas de la date
  de la session.

**git.**
- Formes à hunks : `git diff` nu (sans `--stat`/`--name-only`/`--numstat`/
  `--shortstat`/`--name-status`) 1 121 appels / 3,45 M / 2,1 pourcent ; `git show`
  avec hunks 892 / 2,21 M / 1,3 ; `git log -p` 6 / 9 917 octets. **Total exclusif :
  2 019 appels, 5,67 M, 3,4 pourcent** du total tous outils. Borne haute (commandes
  composées CONTENANT une forme à hunks) : 3 282 appels, 8,07 M, 4,8 pourcent.
- `git blame` 1 appel / 576 octets, `git log -L` 3 / 2 058, `git log -S`/`-G` 39 /
  10 474 : **43 appels, 13 108 octets, 0,008 pourcent**.
- Échelle : `git show --stat` 288 / 0,68 M ; `git diff --stat` 508 / 0,40 M ; git
  total 9 263 appels / 10,3 M / 6,2 pourcent.

**test / build.**
- `jest` 113 appels / 183 495 octets ; `npm run build` 235 / 157 971 ; `tsc` 190 /
  71 220 ; `npm test` 17 / 24 079 ; `npx jest` 3 / 4 355. **Total des classes du
  brief : 558 appels, 441 120 octets, 0,26 pourcent** du total.
- Échelle des autres runners (autres projets du poste) : `bun test` 4 488 / 2,29 M
  (1,4 pourcent), `pytest` 326 / 0,29 M, `cargo test` 213 / 0,15 M. Toutes classes
  test/build confondues : 8,5 pourcent des appels Bash, 5,3 pourcent des octets Bash.
- Part des runs en échec : les deux critères DIVERGENT (`is_error` du bloc contre
  motif `FAIL`/`failed`/`error TS` dans le texte) : jest 5 contre 37 (recouvrement 2),
  tsc 26 contre 39 (recouvrement 9), `npm run build` 8 contre 14. Cause DÉDUITE, non
  vérifiée : les pipes `| tail` masquent le code de sortie, et `failed` attrape des
  logs. La question reste ouverte mais sans objet, la piste étant fermée par le volume.

**Appels agent par nom `mcp__aidex__*`** (condition du §6.1 avant tout retrait),
corpus principal, appels / octets : `signature` 500 / 1 142 604 (41,5 pourcent des
octets `mcp__aidex__*`) ; `query` 2 754 / 1 026 286 (37,3) ; `update` 1 790 / 182 505 ;
`signatures` 25 / 99 651 ; `search` 54 / 99 559 ; `status` 71 / 34 233 ; `session` 3 /
23 300 ; `init` 70 / 22 910 ; `edges` 14 / 22 097 ; `tree` 18 / 17 519 ; `scan` 19 /
14 123 ; `files` 12 / 8 502 ; `global_status` 4 / 5 819 ; `settings` 10 / 3 030 ;
`screenshot` 15 / 2 938 ; `summary` 6 / 2 721 ; `global_refresh` 6 / 1 357 ; `remove`
19 / 1 111 ; `viewer` 5 / 630 ; `coverage` 3 / 593 ; `global_init` 1 / 290 ; `windows`
1 / 69. Hors `tools.ts` : `aidex_refs` 12 / 35 335 (prototype). Les 11 outils déjà
filtrés : `note` 3 / 2 698, `task` 1 / 122, `log` 1 / 47, les huit autres 0, soit 5
appels au total, le chiffre exact de la doctrine. Sous-agents : 136 appels, dont `query` 89 et `signature` 11 ; aucun appel
sur les 12 candidats sauf `update` 26, `status` 4, `init` 2, `scan` 1.

### 0.5 Verdict

| Piste ou candidat | Verdict | Chiffre qui tranche |
|-------------------|---------|---------------------|
| Read borné (hook + `aidex outline`) | **OUVRIR, rang 1** | 25,0 pourcent du total en Read sans borne, dont 16,9 points non suivis d'édition ; plus 5,9 pourcent en `cat`/`sed -n` directs, ce qui justifie le matcher `Read\|Bash` du §4.1 |
| Seuil du hook Read (§9.1) | 5 Ko comme point de départ, à tourner entre 2 et 10 Ko | au-dessus de 5 Ko : 41 pourcent des appels du sous-ensemble mais 82 pourcent de ses octets ; 2 Ko refuserait 68 pourcent des appels pour 14,5 points de plus |
| Hook Read hors projet indexé (§9.4) | Position par défaut (non) MAINTENUE | un hook limité aux projets indexés couvre 68,1 pourcent des octets du sous-ensemble ; les 31,8 pourcent restants (8,97 M) sont laissés hors hook, faute d'index pour rendre un plan (DÉDUIT : un hook sans plan à proposer ne ferait que refuser) |
| `aidex outline` markdown | OUVRIR avec la piste Read, pas après | `.md` = 26,2 pourcent des octets du sous-ensemble (première extension en octets ; en appels, `.py` passe devant) |
| git digest (`aidex git diff`) | **OUVRIR, rang 3, périmètre réduit** (digest seul ; `--callers` en option ultérieure) | 3,4 pourcent exclusif, 4,8 borne haute : au seuil « quelques pourcents » du §3.1, arbitrage opérateur demandé le 2026-09-14 |
| `aidex git history` | **FERMER** | 43 appels, 13 108 octets, 0,008 pourcent sur quatre mois |
| test / build digest (`aidex test`, `aidex build`) | **FERMER côté tokens** | 0,26 pourcent du total. Le garde des pièges d'environnement (D7 : refus de `--runInBand`, binaire Node) reste légitime mais c'est un hook de refus sans digest, hors de ce lot (SUPPOSÉ quant à sa taille) |
| Deny-list : `init`, `global_init`, `coverage`, `settings`, `global_status`, `scan`, `global_refresh`, `viewer`, `remove`, `session` | **OUVRIR, rang 2, manque une mesure** | 1 à 70 appels agent chacun sur quatre mois et 80 projets (`init` 70, `scan` 19, `remove` 19, `settings` 10, les six autres à un chiffre). `init` et `session` sont couverts par le hook `SessionStart` du §6.4 ; `remove`, `scan`, `settings` n'ont pas de déclencheur autre que `aidex --help` (DÉDUIT). Manque : le poids en octets de ces dix définitions dans les 16 430 octets du `tools/list`, à mesurer avant le retrait pour connaître le gain par session |
| Deny-list : `update` | **FERMER le retrait, manque une mesure** | 1 790 appels agent, deuxième outil en appels (derrière `query` 2 754), troisième en octets : ce n'est pas seulement un appelant hook. À mesurer avant de rouvrir : la part des appels postérieurs à l'installation des hooks `queue-edit`/`queue-drain` (les hooks sont entrés dans le dépôt au commit `fca6184` du 2026-08-11, MESURÉ par `git log -- hooks/claude/aidex-queue-edit.py` ; la date d'installation sur le poste reste à établir, SUPPOSÉ le même jour) |
| Deny-list : `status` | **FERMER le retrait** | 71 appels contre 6 pour `summary` : l'agent préfère `status`. Fusionner `summary` dans `status` serait la piste, hors de ce lot |
| `screenshot`, `windows` | inchangé (restent MCP, §6.4) | 15 et 1 appels ; non mesuré ici au-delà du compte |

### 0.6 Contradictions entre l'état du poste et le plan

1. **Le skill `aidex` existe déjà** (10 975 octets), orienté outils MCP. Le §6.4
   propose un skill `aidex-cli` séparé. Ajustement : étendre le skill existant d'une
   section CLI plutôt que d'en créer un second, une seule ligne de description par
   session au lieu de deux. Arbitrage mineur, à trancher au moment de l'écrire.
2. **Le bloc `CLAUDE_MD_BLOCK` de `aidex setup` n'est pas installé.** Le constat du
   §6.4 point 3 vaut pour le code de `setup.ts`, pas pour le poste : réduire ce bloc
   reste une correction du code, sans effet mesurable sur cette station.
3. **`update` est un geste agent, pas seulement un geste de hook** (1 790 appels). Le
   §6.2 le classe « appelant réel : les hooks git et Stop » ; la trace dit autre chose.
   Le retrait est suspendu (§0.5).
4. **Le plafond de 2 000 lignes de `Read` ne mord jamais** ; la borne réelle est le
   plafond de tokens (19 erreurs). Le §1 reste vrai, mais ce n'est pas lui qui coûte.
5. **Les hooks vivent au niveau global uniquement.** Le `settings.json` du projet n'en
   porte aucun ; un lecteur du dépôt seul ne peut pas le savoir. Pas une contradiction,
   une réserve à recopier dans tout brief.

### 0.7 Ordre de réalisation ajusté (sans coder)

Chaque rang démarre par sa vérification, pas par du code.

1. **Read** : (a) variante minimale du §5.1, `body_lines` exposé dans
   `aidex_signature` et ligne de fin des `types` ; (b) `aidex outline <file>` avec la
   branche markdown dès la première version ; (c) hook `aidex-read-nudge.py`, matcher
   `Read|Bash`, seuil 5 Ko, muet hors projet indexé, fail open. Mesure de l'effet
   ensuite par le harnais A/B du §3.4.
2. **Deny-list** des dix outils du §0.5 plus hook `SessionStart` pour `init`/`session`.
   Prérequis : vérifier que le stdout d'un hook `SessionStart` est injecté dans le
   contexte (réserve du §6.2, DÉDUIT de la documentation).
3. **git digest**, périmètre réduit, sous réserve de l'arbitrage opérateur ; `history`
   et `--callers` hors du premier lot.
4. **test / build** : pas de digest. Si le garde D7 est voulu, c'est un hook Bash
   autonome qui refuse `--runInBand` / `--maxWorkers=1` et un `node` non conforme,
   sans sous-commande CLI.

Réserve la plus rentable non mesurée (nommée par le worker, non faite) : pondérer
chaque `tool_result` par sa durée de vie dans le contexte (octets multipliés par le
nombre d'inférences suivantes jusqu'à compaction ou fin de session), recoupée avec
`usage.cache_read_input_tokens`. Un Read de 20 Ko en début de longue session coûte
bien plus qu'un `git diff` en fin de tour ; le classement pourrait changer, pas le
signe des verdicts ci-dessus (SUPPOSÉ).

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

Surface annoncée aujourd'hui : 22 outils, 27 745 octets. Les 12 candidats CLI
pèsent 12 082 octets, soit 44 pourcent de la surface annoncée (`screenshot` et
`windows`, 3 687 octets, restent MCP depuis la reclassification du §6.4).

| Outil | Octets | CLI existant | Destination | Pourquoi |
|-------|-------:|--------------|-------------|----------|
| `screenshot` | 3 083 | non | **reste MCP**, à dégraisser ou à fusionner avec `windows` | Reclassé le 2026-09-13 (§6.4) : geste à l'initiative de l'agent, sans situation déclenchante. Sa définition MCP est son seul point de découverte. Plus grosse définition annoncée : dégraisser les descriptions de paramètres. |
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
| `windows` | 604 | non | **reste MCP**, fusion dans `screenshot` (`action: list`) | Même raison que `screenshot`. Une seule définition au lieu de deux. |
| `status` | 498 | non | `aidex status` | Orientation ponctuelle ; ce que `summary` ne couvre pas peut y être fusionné. |

Restent MCP (15 663 octets) : `query`, `edges`, `signature`, `signatures`, `search`,
`summary`, `tree`, `files`, `screenshot`, `windows`. `tree` et `files` sont à mesurer
contre `Glob` et `ls` avant de trancher ; ils ne sont pas administratifs, donc hors
de ce lot.

Réserve sur `session` : vérifier que le harness injecte bien le stdout d'un hook
`SessionStart` dans le contexte de l'agent (DÉDUIT de la documentation des hooks,
non mesuré ici).

### 6.4 Découvrabilité : comment l'agent apprend qu'une commande CLI existe

Objection de l'opérateur (2026-09-13) : un hook PreToolUse peut forcer `query`, mais
rien ne force `screenshot` ou `init` ; une consigne en tête de CLAUDE.md se perd
dans la masse de la session ; et on ne peut pas y lister toutes les commandes.

Réponse en trois parties.

**1. Le déclencheur n'est pas toujours un blocage.** Claude Code offre trois moments
où un hook peut injecter du texte dans le contexte, et chacun couvre une famille de
commandes. Le texte n'est payé qu'au moment où il sert.

| Déclencheur | Mécanisme | Couvre |
|-------------|-----------|--------|
| `SessionStart` | stdout du hook injecté dans le contexte | `init` (projet sans `.aidex/` : une ligne « non indexé, `aidex init .` »), `status`, `session` (note de la session précédente, changements externes), fraîcheur de la DB globale |
| `UserPromptSubmit` | stdout injecté, déclenché par mots-clés du prompt utilisateur | `viewer`, `settings`, et un rappel de `screenshot` quand le prompt parle d'écran, de capture ou de fenêtre. Un faux déclenchement coûte une ligne. |
| `PreToolUse` | refus avec la commande à relancer | `query`, `read`, `git`, `test`, `update` |

Le hook `SessionStart` remplace la « Session-Start Rule » du bloc CLAUDE.md installé
par `aidex setup` (§6.4, point 3), qui demande au modèle de se souvenir d'appeler
`aidex_session` : c'est précisément le genre de consigne qui se perd.

**2. Ce qui n'a aucun déclencheur reste MCP.** `screenshot` et `windows` sont des
gestes à l'initiative de l'agent, au milieu d'une tâche, sans situation observable
par un hook. Leur définition MCP est leur seul point de découverte, donc ils y
restent, dégraissés. C'est la reclassification appliquée en §6.2. Le critère du
§6.1 se précise ainsi : passe en CLI ce qui a un déclencheur observable ; reste MCP
ce que seul l'agent décide.

**3. Le catalogue complet existe déjà, et c'est lui le problème.** `aidex setup`
installe dans `~/.claude/CLAUDE.md` un bloc `AIDEX-START` / `AIDEX-END`
(`src/commands/setup.ts`, constante `CLAUDE_MD_BLOCK`). MESURÉ : 9 012 octets, 153
lignes, payés à chaque session de chaque projet. Il cite les 11 outils de
`DEFAULT_DISABLED_TOOLS` comme s'ils étaient annoncés (`global_query`,
`global_signatures`, `global_guideline`, `describe`, `tasks`, `link`, `unlink`,
`links`, `task`, `log`, `note`), et contient un tableau « All Tools (30) ». Que ce
bloc soit effectivement installé sur le poste n'est pas vérifiable depuis ce
conteneur ; s'il l'est, c'est le plus gros texte AiDex du contexte, et il est
périmé depuis le filtre du 2026-09-02. Précision de l'opérateur le 2026-09-13 : le
bloc n'est PAS porté dans son CLAUDE.md global. Le constat vaut donc pour le code de
`setup`, pas pour l'état du poste ; l'inventaire de ce qui y est réellement configuré
est la première étape de la reprise (§11).

Décision proposée : réduire ce bloc à la notice de §6.3, et déplacer le catalogue
dans un **skill** `aidex-cli`. Un skill coûte une ligne de description par session
et ne charge son corps (la liste complète des sous-commandes, avec leurs usages)
qu'à l'invocation. C'est le mécanisme prévu pour « une liste trop longue pour
CLAUDE.md, disponible à la demande ». Le hook grep mentionne déjà un skill `aidex`
(levier B) ; il n'est pas dans ce dépôt, son état sur le poste est à vérifier.
`aidex --help` reste la seconde moitié du catalogue, pour l'agent comme pour
l'opérateur.

Réserve honnête sur la salience : tout ce qui est dans le system prompt est présent
à chaque tour, ce qui varie est l'attention que le modèle y porte. Ni la notice ni
le skill ne garantissent quoi que ce soit ; les hooks si. Le harness A/B de §3.4
peut mesurer le taux de conformité (part des `git diff` bruts contre `aidex git
diff`) avec et sans notice, si la question vaut une mesure.

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

---

## 11. Reprise sur le poste : inventaire avant mesure

La session du 2026-09-13 s'est tenue dans un conteneur distant, sans accès à la
configuration globale du poste ni à la trace. La reprise commence par un inventaire
MESURÉ de ce qui est configuré aujourd'hui, avant la Phase 0 (§3) :

1. `~/.claude/CLAUDE.md` : présence ou non d'un bloc AiDex, sa taille en octets.
2. `~/.claude/settings.json` et le `settings.json` du projet : hooks installés
   (événements, matchers, scripts), comparés à `hooks/claude/settings.json.template`.
3. Skills présents sous `~/.claude/skills/` : existe-t-il un skill `aidex` ?
4. Enregistrement MCP du serveur `aidex` : commande, `AIDEX_TOOLS_DISABLE`, nombre
   d'outils annoncés au `tools/list` de la session courante (`/context`).
5. Corpus de trace : emplacement et volume (`.claude/CLAUDE.local.md`), pour que la
   Phase 0 sache sur quoi elle mesure.
6. Binaire Node du poste et version, pour tout wrapper `aidex test`.

Le rapport d'inventaire s'ajoute à ce plan en section 0, sur le modèle de
`lsp-daemon-plan.md`, avant toute mesure et avant tout code.
