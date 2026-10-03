# Etude : diff au niveau entite, inspire de `Ataraxy-Labs/sem`

Date : 2026-10-03. Statut : **etude, aucun code produit**. Scripts de mesure sous
`scripts/eval/`. Decision d'implementation suspendue a la mesure de la
section 4.

Etiquetage : MESURE (commande + sortie), DEDUIT (lecture de code), SUPPOSE.

## 1. Ce que fait `sem`

Outil Rust (~76k lignes dans `sem-core`), CLI + serveur MCP a 8 outils
(`sem_entities`, `sem_diff`, `sem_blame`, `sem_impact`, `sem_log`,
`sem_context`, `sem_find`, `sem_grep`). Il parse via tree-sitter, decoupe
chaque fichier en entites (fonction, classe, methode...) et compare les
entites avant / apres au lieu des lignes.

Appariement (`crates/sem-core/src/model/identity.rs:215`, DEDUIT) :

1. **ID exact** `fichier::kind::nom` : `modified` si `content_hash` differe,
   sinon inchange (filtre de la sortie).
2. **Hash de contenu, puis hash structurel** : rename / move.
3. **Meme signature a travers un rename de fichier** : move.
4. **Similarite > 80 pourcent de tokens** : rename probable.

Le **hash structurel** (`crates/sem-core/src/utils/hash.rs:22`) parcourt l'AST,
saute les noeuds commentaire, hashe le type des noeuds internes et le texte
trime des feuilles (xxh3). Une variante exclut la plage du nom de l'entite
pour detecter les renames. Il permet le marqueur `[cosmetic]` (formatage /
commentaires seulement) vs `[modified]`.

MESURE, sur un depot jouet (ajout d'un commentaire et d'espaces dans `a`,
rename `b -> bb`, `return 1` -> `return 42` dans `C::m`) :

```
~ function   a        [cosmetic]
↻ function   b -> bb  [renamed+cosmetic]
∆ method     C::m     [modified]
```

## 2. Ce que `sem diff` remplace reellement

**`sem diff` remplace `git diff --stat`, pas `git diff`.** La sortie texte par
defaut liste les noms d'entites ; le contenu n'est inline que pour les petits
changements. Pour avoir le code, il faut `-v`, qui pese autant que `git diff`.

MESURE : 40 derniers commits non-merge touchant `src/*.ts` d'AiDex, binaire
`sem` compile depuis `main` (cargo release), `SEM_NO_TELEMETRY=1`, filtre
`.ts` des deux cotes, `wc -c` :

| Sortie                              | Octets cumules |
|-------------------------------------|---------------:|
| `git diff c~1 c -- '*.ts'`          |        423 525 |
| `git diff --stat`                   |          7 810 |
| `sem diff --commit c` (texte)       |         73 727 |
| `sem diff --commit c --format plain`|         26 429 |

**Ne pas en tirer de ratio git diff / sem diff** : les deux sorties ne portent
pas la meme information (piege "deux nombres, deux grandeurs", voir
CLAUDE.md, Discipline de mesure). Exemples verbatim :

- `292cc5b` : `git diff` 8 369 octets, `sem` 450 octets qui disent seulement
  `∆ function main [modified]` pour +103 / -23 lignes.
- `7ad8f2d` : `sem -v` 4 184 octets contre 3 975 pour `git diff`.

La comparaison honnete est `--stat` (7,8k) contre `plain` (26,4k) : `sem` est
plus gros, mais a la granularite entite au lieu de fichier.

L'auteur le reconnait (`docs/benchmarks.html`, section "Tokens: parity,
honestly") : totaux de tokens a parite sur une session complete, -25 a -35
pourcent sur les seuls tool-results. Son gain revendique est le temps et la
precision de comprehension (0,96 vs 0,42 sur 3 commits, Sonnet 4.5, n tres
faible).

## 3. Transposition a AiDex

### Faisabilite (DEDUIT)

- L'extracteur calcule deja la fin de chaque methode
  (`src/parser/extractor.ts:542`, `endLineNumber`) mais la table `methods` ne
  la stocke pas ; `types` a deja `end_line`.
- `lines` porte `line_hash` et `modified` ; `modified_since` existe sur
  `aidex_query` et `aidex_files`.
- **Variante A, index seul** : entites dont l'intervalle de lignes contient
  une ligne modifiee depuis T. Couvre la phase 1. Limite : `modified` date la
  reindexation, pas l'edition (deja documente dans le message de
  `aidex_files`).
- **Variante B, contre une ref git** : `git show <ref>:<path>` passe dans
  l'extracteur existant, appariement par (kind, nom, parent). Necessaire pour
  les suppressions et renames, car l'index ne garde que l'etat courant.
- **Hash structurel** : seul apport reellement absent d'AiDex. Il augmente la
  densite utile (l'agent peut ignorer les `[cosmetic]`).

### Grille de la doctrine

1. *Supprime-t-elle un appel ?* Partiellement : `git diff --stat` + `Read`
   cibles. Pas la lecture du diff quand l'agent doit voir le code.
2. *Besoin mesure ?* **Non.** C'est le bloquant (section 4).
3. *Signal ou bruit ?* A mesurer : part des entites `[cosmetic]` sur des
   commits reels.
4. *Defaut fige dans la surface MCP ?* Eviter : passer par un parametre d'un
   outil existant ou par une sous-commande CLI (cout `tools/list` nul).

### A ne PAS reprendre (pistes closes, CLAUDE.md)

- `sem_impact` / `callers` / `context` : graphe de relations, piste 8.
- `sem grep` sur postings trigramme : prefilter trigramme reverte
  (`7d29e98` puis `bd76216`).
- Ranking par centralite (`sem_entities query`) : piste 7 (84,4 pourcent deja
  top 3).

### Non mesure (SUPPOSE)

- Hotspots / co-change (`sem log` sans argument).
- Hits de recherche annotes avec l'entite englobante.
- Injection de contexte via hook `UserPromptSubmit`.

## 4. Comment mesurer le besoin

Deux scripts, stdlib Python seulement, lecture seule :

- `scripts/eval/trace_measure.py` : mesures S1 a S3 sur les transcripts
  Claude Code (memes regles de lecture pour l'etude `mex`).
- `scripts/eval/sem_cosmetic.py` : mesures S4 et S5 sur des commits reels,
  necessite le binaire `sem`.

Les seuils ci-dessous sont **PROPOSES, a valider par l'operateur avant de
lancer la mesure**, pour qu'ils ne soient pas ajustes apres coup au
resultat.

### 4.1 Regles de lecture des transcripts

Verifiees sur un transcript reel de 2026-10 (245 entrees) ; le script les
applique, elles sont ecrites ici pour qu'un humain puisse contre-verifier.

- Emplacement : `~/.claude/projects/<repo-encode>/<session>.jsonl`, une
  entree JSON par ligne. Filtrer un projet avec `--project <sous-chaine>`.
- **Un message assistant est decoupe en plusieurs entrees**, une par bloc
  de contenu, qui partagent `message.id`. `usage` y est repete : toute somme
  de tokens doit dedupliquer par `message.id`.
- **Appariement appel / resultat** : `tool_use.id` (entree `assistant`) ==
  `tool_result.tool_use_id` (entree `user`). Le poids d'un resultat = octets
  UTF-8 du texte du `tool_result` (chaine, ou concatenation des blocs
  `text`).
- **Debut de tour** = entree `user` dont `content` est une chaine, ou une
  liste avec des blocs `text` / `image` et **sans** bloc `tool_result`, hors
  `isMeta` et `isCompactSummary`. Les entrees `user` qui portent des
  `tool_result` ne sont PAS un nouveau tour.
- **Fin de tour** : le hook `Stop` n'apparait pas dans le transcript ; la
  fin d'un tour se lit uniquement au debut du tour suivant.
- **Noms d'outils** : natifs `Bash`, `Read`, `Grep`, `Edit`, `Write`,
  `MultiEdit` ; MCP `mcp__aidex__aidex_query` etc. (le script accepte tout
  prefixe `...__aidex_<outil>`).
- **Fenetre "ce qui suit"** : les appels des `--window` (defaut 3) messages
  assistant suivants, **dans le meme tour**. Les appels lances en parallele
  dans le MEME message sont exclus : ils ne peuvent pas avoir ete causes par
  le resultat.
- **Sous-agents** : fichiers separes, `isSidechain: true`. Chaque fichier
  est traite comme une session ; `scope.sidechain_sessions` en donne le
  nombre. Pour "nombre de sessions", rendre les deux chiffres.
- **Chemins** : comparaison insensible a la casse, `\` -> `/`, egalite ou
  suffixe (un `Read` porte un chemin absolu, AiDex rend des chemins
  relatifs au projet).
- **Denominateurs** : `scope.result_bytes` = somme des resultats de TOUS les
  appels de toutes les sessions scannees, calculee par la meme fonction que
  les numerateurs. Tout pourcentage publie vient de ce meme chemin.

### 4.2 Mesures sur la trace (`trace_measure.py`, bloc `sem_git_diff`)

Commande :

```
python scripts/eval/trace_measure.py --json docs/dev-notes/trace-report.json
```

Sans `--project` : AiDex est monte dans tous les projets du poste, la trace
utile est l'ensemble de `~/.claude/projects`, pas le seul depot AiDex.
`--project` ne sert qu'a isoler un sous-ensemble pour verification. Le JSON
complet contient des extraits verbatim de sessions privees
(`random_sample`) : il va sous `docs/dev-notes/` (exclu de git), jamais
ailleurs dans le depot.

Classement des appels `Bash` qui matchent `git diff|show|log` : `diff-patch`,
`diff-stat` (`--stat`, `--numstat`...), `diff-names` (`--name-only`,
`--name-status`), idem pour `show-*` et `log-*` (`log` seulement avec `-p`),
et `show-blob` (`git show <ref>:<path>`, compte a part et EXCLU des
mesures, c'est une lecture de fichier).

- **S1, frequence.** `calls_by_kind`, `sessions_with_call` contre
  `scope.sessions`.
- **S2, poids.** `unpiped_result_bytes` (mediane ET somme) et
  `unpiped_share_of_all_result_bytes`. Les appels pipes (`| wc`, `| head`,
  `| grep`) sont comptes dans `piped_calls` et sortis du poids : ce que
  l'agent a lu n'est pas le diff. Verification faite : sur le transcript de
  test, les 3 appels `git diff` etaient tous des mesures pipees dans `wc`.
- **S3, suite.** `calls_followed_by_read_of_diffed_file`,
  `of_which_whole_file`, `followup_read_bytes`. Fichiers du diff extraits
  de `diff --git a/X b/Y`, `+++ b/X`, lignes `--stat` et `--name-status`.
- **Lecture verbatim obligatoire** : `random_sample` (20 par defaut,
  `--seed` fixe) dans le JSON. Les lire avant de conclure, pour reperer les
  faux positifs (commandes de mesure, scripts, hooks).

Seuils PROPOSES :
- continuer si `unpiped_share_of_all_result_bytes` >= 3 pourcent **et**
  `sessions_with_call` >= 10 pourcent des sessions non sidechain ;
- l'argument "supprime un Read" ne tient que si
  `calls_followed_by_read_of_diffed_file / result_bytes.n` >= 30 pourcent ;
- sinon fermer la piste et l'ajouter aux pistes closes de CLAUDE.md.

### 4.3 Mesures sur commits (`sem_cosmetic.py`)

```
python scripts/eval/sem_cosmetic.py --repo <depot> --sem <binaire sem> -n 50
```

- **S4, signal cosmetique.** `cosmetic_pair_share` (par paire commit x
  entite) ET `distinct_cosmetic_share` (entites distinctes jamais modifiees
  structurellement). Toujours les deux.
- **S5, plafond.** `plain_lines_median` et `plain_commits_over_100_lines`,
  a comparer au plafond de 100 lignes d'`aidex_query`.

MESURE sur AiDex (50 derniers commits non-merge, tous fichiers, binaire
`sem` compile depuis `main` le 2026-10-03) :

```
"modified_pairs": 326, "cosmetic_pairs": 38, "cosmetic_pair_share": 0.1166,
"distinct_modified_entities": 240, "distinct_only_ever_cosmetic": 34,
"distinct_cosmetic_share": 0.1417,
"plain_lines_median": 19.5, "plain_commits_over_100_lines": 4,
"git_diff_lines_median": 195.0
```

**Le drapeau cosmetique de `sem` n'est pas fiable sur TypeScript.**
Echantillon aleatoire de 8 changements `structuralChange: false`, lus
verbatim (`random.seed(1)`) : 4 sont reellement des commentaires seuls
(`initSchema`, deux blocs de module, un test), mais 4 sont des listes
`export { ... }` qui ont GAGNE des symboles (`CandidateEdgeKind`,
`astroHasNoFrontmatterFence`...), donc un vrai changement d'API. Sur cet
echantillon, environ la moitie des 11,7 pourcent est un faux "cosmetique".
Echantillon petit (8) : l'ordre de grandeur est INCONNU, pas "la moitie".
Les 111 entites Markdown modifiees n'ont aucun drapeau cosmetique.
Consequence : si AiDex calcule son propre hash structurel, il doit traiter
les `export` / `import` comme structurels ; reprendre l'heuristique de
`sem` telle quelle importerait ce defaut.

Seuils PROPOSES :
- hash structurel utile si `distinct_cosmetic_share` >= 10 pourcent APRES
  relecture d'un echantillon d'au moins 30 et retrait des faux cosmetiques ;
- sortie entite acceptable si `plain_commits_over_100_lines` <= 10 pourcent
  des commits (MESURE AiDex : 4 sur 50, 8 pourcent).

## 5. Quoi faire si la mesure est positive

Par ordre de cout croissant :

1. **Sous-commande CLI `aidex diff [--since T | --ref R]`**, sortie entite
   par ligne (`M function name file:start-end`), marqueur cosmetique. Zero
   cout `tools/list`. Variante A d'abord.
2. Stocker `end_line` dans `methods` (migration de schema, reindexation
   ponctuelle : non bloquante, piste close 6).
3. Hash structurel par entite calcule a l'indexation (colonne nouvelle),
   reutilisant le parcours tree-sitter existant.
4. Variante B (ref git) seulement si la mesure 3 montre des renames /
   suppressions recherches.
5. Exposition MCP (parametre `changed_since` sur `aidex_signature` ou
   `aidex_files`) seulement si l'usage CLI est mesure.

## 6. Lien avec l'etude `mex`

Voir `mex-study.md` : `mex` stocke aussi un hash de corps par symbole (derive
de doc). Une colonne de hash par entite servirait les deux usages. Le harnais
A/B decrit en section 4 / M5 de `mex-study.md` est l'instrument a construire
avant toute implementation ici.
