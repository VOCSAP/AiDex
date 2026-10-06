# Etude : `oooscoos/Benzi`, ce qui peut servir a AiDex

Date : 2026-10-06. Statut : **etude, aucun code produit**, script de mesure
`scripts/eval/benzi_tools.py`. Version etudiee : clone `main` (depth 50,
dernier commit `9bd0158`, 2026-09-28).

Etiquetage : MESURE (commande + sortie), DEDUIT (lecture), SUPPOSE.

## 1. Ce qu'est Benzi, et ce que le depot contient vraiment

Agent de code complet (boucle agentique, edition, verifieur, VS Code, headless)
construit sur un index tree-sitter : symboles, aretes d'appel avec six etats de
confiance (`resolved`, `external`, `candidate`, `unresolved`, `observed`,
`unindexed`), heritage, flot de donnees, traceur d'execution (Python seul).
Expose aussi en MCP (`pip install benzi`, binaire `benzi-mcp`), "sans la boucle
agentique".

**Le depot GitHub ne contient aucun code source.** MESURE : les extensions
presentes sont `md` (504), `png` (31), `py` (8, uniquement le harnais de
benchmark), `jsonl`, `html`. Licence proprietaire (`LICENSE` : interdiction de
copier, adapter, creer des oeuvres derivees, decompiler). Toute connexion exige
`benzi-login` (compte, email). Consequences :

- rien n'est portable par lecture de code, et la licence l'interdit de toute
  facon ;
- les affirmations techniques du README (O(1), "resout" plutot que "retrouve")
  sont des declarations du vendeur, non verifiables ici : SUPPOSE ;
- en revanche le depot publie **ses propres traces d'usage**, et c'est la seule
  matiere mesurable. L'etude porte donc sur elles.

## 2. Ce qui est hors perimetre AiDex

Edition gardee par le parseur, `rollback_edit` par snapshot d'index, traceur
d'execution, verifieur, `upgrade_to_pro`, moteur markup HTML/CSS : ce sont des
fonctions de **harnais**, AiDex est un index en lecture seule servi a un harnais
existant. La memoire persistante (`remember`, 187 appels sur 500 sessions) a son
equivalent `note` deja retire de `tools/list` sur mesure (CLAUDE.md, section
Outils) ; son usage chez Benzi est vraisemblablement induit par leur prompt
systeme : SUPPOSE, non transposable. **Ne pas importer.**

## 3. Mesure : quels outils les agents de Benzi appellent reellement

Commande : `python -I scripts/eval/benzi_tools.py <clone Benzi>`.

### 3.1 SWE-bench Verified, 500 trajectoires (deepseek-v4-flash)

MESURE, sorties decisives :

```
[swebench] trajectories=500 listed_calls=18919 header_calls=18919
  shell                         7822 41.34%  sessions=496
  read_source                   4641 24.53%  sessions=500
  benzi_grep                    3127 16.53%  sessions=496
  get_definition                 344  1.82%  sessions=213
  search_symbols                 240  1.27%  sessions=162
  get_callers                    127  0.67%  sessions=113
  profile                         29  0.15%  sessions=25
  get_hierarchy                   24  0.13%  sessions=23
  skim_source                     12  0.06%  sessions=11
  call_tree / trace_path / backflow / forwardflow / external_calls   0
  read_source addressed by ::symbol: 3476/4641 = 74.9%
  shell heads: cd=3391, python=1168, git=662, cat=596, ls=291, python3=286
```

Le compte liste egale le compte annonce dans l'en-tete de chaque fichier
(18919 = 18919) : les deux viennent du meme fichier, ce n'est pas une
corroboration independante, seulement l'assurance qu'aucune ligne n'a ete
perdue au parsing.

### 3.2 Benchmark vendeur, 24 bugs (runs posterieurs au 2026-08-11T19:20)

MESURE :

```
[bench] ('benzi_product', 'sonnet') calls=2220 graph_tools={'get_callers': 14, 'profile': 0, 'get_hierarchy': 0, 'call_tree': 0, 'trace_path': 0, 'backflow': 0, 'forwardflow': 0}
[bench] ('benzi_product', 'deepseek') calls=310 graph_tools={'get_callers': 0, 'profile': 1, ...: 0}
```

### 3.3 Lecture

Deux sources, deux modeles, meme profil : **les outils qui differencient Benzi
(flot de donnees, chemins d'appel, arbre transitif) ne sont jamais appeles**,
0 sur 18919 puis 0 sur 2530. Le seul outil de graphe qui vit est l'appelant
direct (`get_callers`) : 0,67 pourcent des appels, mais present dans 22,6
pourcent des sessions (113 sur 500). Le travail reel reste grep + lecture +
shell : 82,4 pourcent des appels SWE-bench, et `cat` seul (596) depasse
`get_definition` (344).

## 4. Le chiffre phare ne mesure pas ce qu'il annonce

Le README oppose 9 125 lignes lues (Benzi) a 20 704 (Claude Code), "2,3x".
Lecture de `benchmark/lines_read.py`, DEDUIT :

- cote Claude Code, le nombre est reconstruit en comptant les lignes rendues
  par l'outil `Read` dans le transcript ;
- cote Benzi, il est lu dans le champ `source_lines_read` que l'agent Benzi
  ecrit lui-meme sur sa ligne de resultat, sans definition publiee ;
- la sortie shell est exclue des deux cotes, or le shell pese 41 pourcent des
  appels SWE-bench de Benzi, dont 596 `cat`.

Deux nombres de meme nom, deux chemins de mesure : c'est exactement le piege
"ratio" de la doctrine. Le 2,3x n'est pas recevable comme mesure de l'index.

La grandeur qui compte pour AiDex, les tokens d'entree, est disponible dans
`runs.jsonl` pour les deux bras par le meme chemin (`usage` de l'API). MESURE :

```
[bench] sonnet control: runs=25 turns/run=37.2 input_tokens/turn=84398
[bench] sonnet benzi_product: runs=75 turns/run=26.9 input_tokens/turn=59028
[bench] sonnet paired tasks=24 input_tokens control=76140577 benzi=47787643 ratio=0.63
```

Le gain de 37 pourcent est reel mais **non attribuable a l'index**. DEDUIT : il
se decompose en environ 28 pourcent de tours en moins et 30 pourcent de tokens
par tour en moins ; le second terme melange le prompt systeme et les schemas
d'outils (tres differents entre Claude Code et un harnais maison), la "symptom
map" injectee avant le premier tour (`SWE_BENCH_REPORT.md`, l. 50) et le
verifieur. Aucune ablation "harnais Benzi sans index" n'est publiee. Le
benchmark est par ailleurs un benchmark vendeur, ce que son README dit
lui-meme.

## 5. Ce qui recoupe AiDex, piste par piste

### 5.1 Graphe d'appels transitif, flot de donnees : NE PAS FAIRE

Question 1 de la doctrine : supprime-t-il un grep ? Sur les traces du seul
produit qui l'offre, l'agent ne l'appelle pas une fois en 21 449 appels. Cela
confirme la piste close 8 (couche LSP / graphe) par un corpus independant du
notre, et donne une borne pour toute suite du plan
`candidate-import-call-edges.md` : ses "likely follow-ups" (aretes transitives,
voisinage de graphe dans le classement) n'ont aucun besoin mesure.

### 5.2 Appelants directs : deja livre, `aidex_edges`

AiDex dispose deja de l'equivalent de `get_callers` (`aidex_edges`, commit
`481d280`, aretes `candidate`, annonce par defaut). Le contrat de confiance de
Benzi (refuser plutot que deviner, garder la cible ambigue visible) est celui
que `481d280` a deja implemente. Rien a importer.

Fait utile, MESURE chez Benzi : un outil d'appelants est utilise dans environ
une session sur cinq mais pese moins de 1 pourcent des appels. A comparer a
l'usage reel d'`aidex_edges` sur la trace de l'operateur, **non mesure ici** :
la trace locale (`.claude/CLAUDE.local.md`) n'est pas accessible depuis ce
conteneur. Si `aidex_edges` y est sous un seuil comparable, son schema est
candidat au filtre `DEFAULT_DISABLED_TOOLS`, au meme titre que les 21 outils
deja retires.

### 5.3 Lecture adressee par symbole : signal, pas de reouverture

MESURE : 74,9 pourcent des `read_source` de Benzi sont adresses par
`fichier::symbole`. C'est le seul usage massif d'une capacite d'index dans ces
traces. Mais la piste close 11 (carte `93b4ace0`) a deja mesure, sur notre
trace, que 54 pourcent des `aidex_query` sont suivis d'un `Read` PARTIEL : les
agents lisent deja par plage avec `Read` offset/limit et les numeros de ligne
rendus par AiDex. La condition de reouverture de la piste 11 est une mesure de
la precision de choix de l'agent ; les traces Benzi ne la fournissent pas (pas
de bras sans `::symbole`). **Pas de reouverture.**

### 5.4 "Symptom map" : hors perimetre en l'etat

Pre-calcul deterministe a partir du texte de l'issue (frames de traceback,
chaines citees, symboles nommes) injecte avant le premier tour. C'est
l'ingredient le plus plausible du gain de tours, mais il est confondu avec le
reste du harnais (section 4) : besoin SUPPOSE, non mesure. Chez AiDex, la seule
forme possible serait un hook `UserPromptSubmit` qui injecte du contexte, donc
des tokens payes a chaque prompt. A n'instruire que sur une mesure de
l'operateur : combien de sessions commencent par un grep d'un symbole ou d'une
chaine deja presents dans le premier message.

## 6. Conclusion

Aucune feature a importer. Benzi n'apporte pas de code (proprietaire, absent du
depot) mais apporte une **mesure externe** : sur 21 449 appels d'agents
equipes d'un graphe d'appels complet, les outils transitifs et de flot de
donnees totalisent zero appel, et l'appelant direct moins de 1 pourcent. Cela
renforce les pistes closes 8 et 11 sans les modifier, et borne le plan
`candidate-import-call-edges.md` a ce qui est deja livre.

Une seule action candidate, conditionnee a une mesure locale : compter les
appels `aidex_edges` sur la trace de l'operateur, et le soumettre au filtre
`DEFAULT_DISABLED_TOOLS` s'il reste marginal.

Limite : traces produites par le vendeur sur son propre harnais, avec un prompt
systeme non publie qui oriente le choix des outils. Le zero sur les outils
transitifs peut tenir au prompt autant qu'au besoin ; il reste que le vendeur,
qui a tout interet a les montrer utiles, ne les fait pas appeler.
