# Etude : diff au niveau entite, inspire de `Ataraxy-Labs/sem`

Date : 2026-10-03. Statut : **etude, aucun code**. Decision d'implementation
suspendue a la mesure de la section 4.

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

Source : la trace decrite dans `.claude/CLAUDE.local.md` (transcripts
`~/.claude/projects/<repo>/<session>.jsonl`). Absente du conteneur cloud ou
cette etude a ete faite, a executer sur le poste.

1. **Frequence.** Compter les `tool_use` `Bash` dont `input.command` matche
   `\bgit (diff|show|log -p)\b`. Rendre separement : nombre d'appels, nombre
   de sessions distinctes, et ventilation `--stat` / `--name-only` / brut.
2. **Poids.** Pour chaque appel, taille du `tool_result` correspondant
   (octets, puis tokens au tarif ~4,2-4,5 octets / token deja observe).
   Rendre la mediane ET la somme, jamais un seul des deux.
3. **Suite.** Dans les 3 appels qui suivent, l'agent fait-il un `Read` d'un
   fichier present dans le diff ? Si oui, quelle portion (fichier entier vs
   `offset/limit`) ? C'est ce `Read` que la feature supprimerait.
4. **Signal cosmetique.** Sur ~50 commits reels du poste, lancer `sem diff
   --format json` et compter `structuralChange: false` au niveau ENTITE
   DISTINCTE, pas au niveau fichier. Si la part est negligeable, le hash
   structurel n'apporte rien.
5. **Plafond.** Verifier qu'une sortie entite-niveau tient sous 100 lignes
   pour les diffs reellement observes (cf. `plain` : 4 734 octets sur
   `481d280`).

Seuil de decision propose (a valider par l'operateur) : poursuivre si les
appels `git diff` pesent une part non marginale des tool-results ET si au
moins un `Read` de fichier entier suit dans une proportion significative des
cas. Sinon, fermer la piste et l'ajouter aux pistes closes.

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
A/B decrit en section 4 / M5 de cette etude est l'instrument a construire
avant toute implementation ici.
