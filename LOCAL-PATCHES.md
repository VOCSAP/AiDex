# Patches locaux du fork VOCSAP

Ce fichier existe pour une seule raison : **un merge depuis upstream ne doit jamais obliger a redecouvrir l'intention d'un patch local**. Un diff montre ce qui a change, jamais pourquoi, et c'est le pourquoi qui permet de trancher un conflit sans casser la propriete qu'un patch protegeait.

Il decrit donc, pour chaque patch : ce qu'il fait, **la raison qui l'a rendu necessaire**, et ce qu'il ne faut pas reintroduire en le rebasant.

- Branche : `local-patches`, basee sur `master` (miroir de `CSCSoftware/AiDex`).
- Convention de commit : prefixe `[LOCAL]` pour tout patch propre au fork.
- Les notes de travail detaillees (mesures brutes, chiffres par regle, journal des sessions) vivent dans `docs/dev-notes/`, **exclu de git**. Ce fichier-ci doit donc se suffire a lui-meme.

---

## 1. Couverture litterale interrogeable (le gros morceau)

### Le probleme, en une phrase

AiDex n'indexe que des SYMBOLES, jamais le contenu des chaines de caracteres, et **rien dans sa reponse ne le disait** : un zero se lisait donc comme une preuve d'absence alors qu'il ne prouvait rien.

Mesure fondatrice, rejouable sur n'importe quel depot indexe :

```
aidex_query term:'sandbox:changed'   -> 0
grep -rn "sandbox:changed"           -> 7 occurrences dans 4 fichiers
```

Sur **une seule ligne** d'un composant React : le symbole appele `restoreWorkspace` rend 12 resultats, le nom de classe CSS `restore-prev` juste a cote en rend 0.

Le 2026-08-10, deux conclusions fausses ont ete produites dans la meme journee sur cette base, dont une affirmation d'absence de lecteur d'un fichier, dementie par un `grep` qui a exhume un tableau `MIGRATE_FILES = ['config.json', 'sessions.json']`.

### La contrainte qui prime sur tout le reste

**Un index partiel de litteraux, presente comme complet, serait PIRE que l'absence actuelle.** Aujourd'hui la frontiere est nette et memorisable : "AiDex ne connait aucun litteral". "AiDex connait certains litteraux" rend chaque zero ambigu.

Tout ce qui suit decoule de cette contrainte. Si un merge upstream oblige a arbitrer, c'est elle qui tranche.

### 1.1 L'oracle de couverture -- `src/coverage/rule.ts`, `src/commands/coverage.ts`

Un point d'entree qui repond a **"peux-tu repondre a ceci ?"** : MCP `aidex_coverage({path, pattern, target?})` et CLI `aidex can <pattern>`, une ligne JSON en sortie.

- Exit `0` = **un verdict a ete produit, verdicts negatifs compris**. Non nul = aucun verdict, l'appelant doit laisser passer.
- Un verdict negatif ne doit **jamais** etre encode dans le code de sortie, sinon il devient indistinguable d'un oracle casse.
- Dix raisons enumerees ; **seule `covered` autorise un blocage**.

`src/coverage/rule.ts` est le **producteur unique** : l'indexeur y appelle `literalQualifies()` pour decider ce qu'il indexe, l'oracle y appelle `classifyPattern()` pour predire ce qu'une requete rendra. Deux predicats separes -- un qui decide ce qui entre, un qui predit ce qui sort -- auraient derive, et la derive se serait vue comme un index ne contenant pas ce que l'oracle promet.

**A ne pas casser en rebasant** : la separation des deux dimensions dans `classifyPattern`. Un mot minuscule nu est A LA FOIS un symbole valide et un candidat litteral dont le cote litteral n'est indexe qu'en certaines positions ; les evaluer ensemble a produit de faux `covered` sur `ok` et `field`.

### 1.2 Reponse vide honnete -- `src/commands/query.ts`, `src/server/tools.ts`

Une reponse vide enonce sa propre couverture, en deux lignes au plus :

```
No matches found for "restore-prev" (mode: exact, kinds: symbol)
Literal coverage ABSENT (schema 1.2) and "restore-prev" is literal-shaped:
this zero proves nothing. Use grep. Rebuild: <commande exacte>
```

Les pourcentages par langage ne sont **pas** dans cette reponse : elle est emise a chaque resultat vide de chaque session, et le but de l'index est d'economiser du contexte.

### 1.3 La dimension d'index -- `occurrences.kind` et le parametre `kinds`

`src/db/schema.sql`, `src/db/queries.ts`, `src/db/database.ts`, `src/commands/query.ts`.

- Colonne `occurrences.kind` : `symbol` / `literal` / `both`, ajoutee par `ALTER TABLE` idempotent, sans reconstruction.
- Nouveau parametre `kinds`, **defaut `['symbol']`**, pour que toute requete ecrite avant les litteraux rende exactement ce qu'elle rendait.
- Compteur d'amorce `otherKindMatches` sur les reponses vides : `3 match(es) exist in other kinds -- re-run with kinds: ["literal"]`.

**Pourquoi un parametre separe et pas `type_filter`** : mesure faite avant de coder, 79 % des occurrences litterales atterrissent sur une ligne portant deja un `line_type`, presque toujours `code`. Donc `type_filter: ['code']` remonterait des litteraux (faux pour tout appelant existant) et `type_filter: ['string']` n'en rendrait que 21 % (faux negatif silencieux). Un parametre, une dimension. **`type_filter` doit rester strictement sur `line_type`.**

**Pourquoi `kind` n'est pas dans la cle primaire** : l'y mettre forcerait une reconstruction de table sur chaque index existant, pour un cas rare -- 158 occurrences sur 10 376 (1,5 %) ou le meme terme est symbole ET litteral sur la meme ligne. Ces cas s'effondrent en `both`, ce qui garde une ligne et ne perd rien : un filtre sur l'une ou l'autre dimension la trouve toujours.

### 1.4 Extraction des litteraux -- `src/parser/extractor.ts`, `src/parser/languages/index.ts`

Regle retenue (`ruleId: strict+typepos`, **version 2 depuis le 2026-08-12**, commit `34532c8`) : **forme identifiant** ET (separateur `: - . _ /` OU espace unique OU casse mixte), OU mot minuscule seul en position `literal_type` / `jsx_attribute` / valeur de `pair`. `LITERAL_SHAPE` vaut desormais `/^[A-Za-z0-9_:.\-/ ]+$/`. Le nombre d'espaces interieurs n'est PAS borne : une phrase entiere qualifie. Ce qui est exclu, ce sont les suites de blancs et les tabulations, parce que `classifyPattern` normalise l'entree AVANT le test (voir 15) et qu'une suite ne survit donc jamais jusqu'a la regex.

**Effet du bump de version, a ne pas manquer en rebasant** : un index construit sous la regle 1 remonte `ruleOutdated: true` et **refuse** de repondre sur la dimension litterale plutot que de mentir sur ce qu'il contient (il ne detient aucun litteral multi-mots, par construction de l'ancienne garde). Ce refus est garde par `kinds.includes('literal')` (`src/commands/query.ts:145`) alors que le defaut de `kinds` reste `['symbol']` : aucune requete par defaut n'est cassee sur un index non reindexe. Voir section 15 pour le detail.

`LanguageConfig.stringNodes` par langage. **Chaque nom a ete lu par sondage des grammaires, jamais devine** : ils ne suivent aucune convention (`interpreted_string_literal` en Go, `encapsed_string` en PHP, `line_string_literal` en Swift, `string_lit` en HCL, `multiline_string_literal` en Kotlin contre `multi_line_string_literal` en Swift). Un merge qui ajoute un langage doit sonder sa grammaire, pas extrapoler.

**Quatre pieges, tous mesures, a ne jamais reintroduire :**

1. **Garder `node.isNamed`.** Les tokens ANONYMES portent leur propre texte comme `node.type`, donc le mot-cle TypeScript `string` a `node.type === 'string'` et entrerait comme litteral.
2. **Ne pas recurser dans le TEXTE d'une chaine**, sinon `string` vers `string_fragment` double-compte et les template literals se fragmentent.
3. **Mais recurser dans les interpolations.** Un `return` sec sur le noeud chaine supprimait des SYMBOLES deja indexes : les identifiants dans `` `hello ${userName}` `` ou `"pre-$x"` en PHP. La regle retenue -- tout enfant nomme qui n'est ni contenu ni delimiteur disqualifie le litteral et continue d'etre visite -- filtre l'interpolation sans avoir a suivre 14 grammaires, et coute un litteral plutot qu'un faux.
4. **Jamais de `setLineType` pour un litteral.** `LINE_TYPE_PRIORITY` place `string` au-dessus de `code` : appliquer la regle retournerait 9 175 lignes de `code` en `string` sur un seul depot, cassant toute requete `type_filter: ['code']` existante. Seules les lignes creees ex nihilo par un litteral recoivent `line_type = 'string'`.

### 1.5 Couverture MESUREE, jamais ecrite en dur -- `src/commands/init.ts`

A la fin d'un reindex COMPLET, les compteurs par langage sont ecrits dans `metadata.literal_coverage`, puis seulement alors `schema_version` passe a `1.3`.

**Le pourcentage n'est pas une constante du code ni de la doc.** Mesure : sous la meme regle, TypeScript va de 18,8 % a 45,6 % **selon le projet**, Go de 9,8 % a 29,4 %. Un chiffre en dur mentirait sur tous les depots sauf un.

Le record porte `{percent, seen, indexed}` **par langage, taille d'echantillon comprise**. Raison : le premier run reel a sorti `java: 100 %` -- exact, et vide de sens, le depot ayant deux fichiers Java pour un seul litteral. Un pourcentage nu rend un echantillon de 1 identique a un echantillon de 10 000, ce qui est le meme defaut qu'un zero non qualifie.

Ecriture reservee aux runs complets : un run incremental saute les fichiers inchanges, donc ses chiffres decrivent les fichiers qui ont change, pas le depot.

### 1.6 Migration : `aidex_init` est le chemin -- `src/commands/init.ts`, `src/commands/update.ts`

Un index qui ne declare pas la couverture courante (schema < 1.3, record absent, ou record ecrit sous une autre regle) est **reindexe integralement, saut par hash ignore**, puis declare 1.3.

**Pourquoi ignorer le saut par hash** : les fichiers inchanges sont precisement ceux dont les litteraux n'ont jamais ete extraits. Un incremental migrerait la declaration sans migrer le contenu.

**Pourquoi `init` et pas seulement la CLI** : decision operateur du 2026-08-11, qui renverse un choix plus conservateur. La version conservatrice etait traitre dans l'autre sens -- un agent reindexe, on lui dit que l'index est frais, et l'index reste muet sur les litteraux sans que rien ne le signale.

La migration est **annoncee** dans le resultat (`literalCoverageUpgraded`) et non deduite du temps ecoule : l'appelant a demande un incremental et recoit un reindex complet, qui efface avant de reconstruire.

`aidex_update` n'insere aucun litteral dans un index non declarant, pour que le contenu ne contredise jamais la declaration.

**Ce qui survit a un reindex force** (verifie) : `tasks`, `task_log`, `metadata`. Seuls `files` et `items` sont vides puis reconstruits. **Si le run est interrompu** : l'index reste vide, `schema_version` reste en 1.2, et la reponse honnete par index continue de s'appliquer. Le remede est de relancer.

### 1.7 La garde de dimension -- `src/commands/query.ts`

`aidex_query` **refuse** la dimension litterale sur un index qui ne la declare pas, au lieu d'y repondre partiellement. Refus en bloc sur un `kinds` mixte : repondre la moitie symbole en taisant une moitie litterale peu fiable est le meme mensonge en plus discret.

Ce cas n'etait pas atteignable avant l'extraction : c'est elle qui l'a cree, en permettant a un `aidex_update` d'ecrire des litteraux dans un index encore declare 1.2.

### 1.8 La fenetre de termes -- `src/db/queries.ts`, `src/commands/query.ts`

`searchItems` appliquait `LIMIT 1000` **sans `ORDER BY` et avant le filtre `kinds`**. Trois defauts en un :

- Les items dont toutes les occurrences sont litterales occupaient la fenetre meme quand l'appelant ne demandait que des symboles. Mesure : 14 % a 22 % des items d'un index reel sont dans ce cas, et sur un `contains 'id'` dans un depot Rust, 307 termes sur 1649.
- **La troncature etait silencieuse.** Un terme evince ne produit AUCUNE ligne de resultat, donc un symbole pouvait disparaitre sans que rien ne le signale. C'est le meme defaut epistemique que le zero non qualifie, un etage plus tot.
- Sans `ORDER BY`, aucun ordre n'est garanti par SQL, donc aucune pagination n'etait possible.

Corriges ensemble, parce qu'ils ne se separent pas : le filtre `kinds` descend dans le SQL, l'ordre devient TOTAL (egalite exacte, puis prefixe, puis longueur croissante, puis alphabetique et id), et `item_offset` / `item_limit` permettent de lire la tranche suivante, la reponse annoncant `Terms 1-1000 of 1342 examined`.

**Les deux derniers criteres de tri n'apportent aucune pertinence** : ils existent pour rendre l'ordre total. Sans depart, deux lignes de meme rang peuvent permuter entre deux appels et la pagination redevient fausse, pour une raison plus subtile que l'absence d'ordre.

**Pas de reranker semantique**, decision explicite : `aidex_query` est le chemin lexical deterministe, `aidex_search` porte le semantique (embeddings, RRF, rerank LLM optionnel). Melanger les deux effacerait la seule distinction claire entre ces outils et couterait latence et tokens, a rebours du but.

Piege rencontre en ecrivant le test : la pagination porte sur les TERMES, pas sur les lignes. Plusieurs termes distincts peuvent tomber sur la meme ligne, et la deduplication par `file:line` n'opere qu'a l'interieur d'un appel. Une assertion de disjonction ecrite au niveau des lignes est donc fausse, et c'est le code qui a raison.

### 1.9 Pas de levier de configuration

Ni pour le defaut de `kinds`, ni pour la regle d'indexation, **et surtout pas par variable d'environnement**.

Raison qui tranche : l'oracle doit predire ce que la requete rendra REELLEMENT. Si le defaut vit dans l'environnement, l'oracle doit le lire aussi pour rester juste, et on a reconstruit le devineur qu'il remplace, avec un canal de divergence en plus. Un agent ne voit pas cette variable : la meme requete rendrait des resultats differents selon le poste, sans que rien dans la reponse ne le dise.

Si un levier devient necessaire, il va **par projet** dans les metadata de l'index, jamais par variable d'environnement -- c'est deja la forme maison (`embeddings`, `llm_send_code`).

**Contradiction apparente a resoudre explicitement, pour qu'un futur mainteneur ne croie ni que ce principe est mort, ni qu'il a ete viole** : le commit `16d8512` (section 16) introduit bien une variable d'environnement, `AIDEX_INIT_SUCCESS_MODE`, renommee `AIDEX_SUCCESS_MODE` par la carte `bfb7bf8f` (l'ancien nom reste un alias de compatibilite, voir section 16). Le principe ci-dessus reste entier, parce que la frontiere qu'il protege n'est pas celle que cette variable traverse. `AIDEX_SUCCESS_MODE` ne touche ni la regle d'indexation (`literalQualifies` / `classifyPattern`), ni le defaut de `kinds`, ni rien de ce que l'oracle de couverture PREDIT -- ces trois-la restent sans aucun levier. Elle change uniquement la facon dont `init()` **rapporte** un echec par fichier deja collecte dans `errors[]`, une decision orthogonale a ce que l'index contient ou a ce qu'une requete y trouvera. Predire un resultat de requete et rapporter le succes d'une commande sont deux promesses differentes ; seule la premiere est couverte par l'interdiction ci-dessus.

---

## 2. Le hook Claude Code -- `hooks/claude/aidex-grep-nudge.py`

Hors du produit : ce hook s'installe dans le profil utilisateur (`~/.claude/hooks/`) et detourne les recherches vers AiDex. Il est versionne ici parce qu'il est indissociable de l'oracle.

Il interroge l'oracle et **ne bloque que sur `covered: true`**. Tout le reste passe : tout autre verdict, et **tout echec a en obtenir un** (binaire absent, exit non nul, sortie illisible, timeout).

**L'asymetrie qui gouverne tout** : un blocage errone coute une recherche legitime refusee, ce qui apprend au modele a contourner l'outillage -- exactement le comportement que le mecanisme veut supprimer. Un passage errone coute un grep redondant. D'ou le fail-open systematique.

- **Ne bloque jamais une preuve d'absence** : `-c`, `-l`, `-L`, `-q`, un `wc -l` en aval, ou l'outil `Grep` natif en `output_mode` `count` / `files_with_matches`. Chercher une occurrence et prouver qu'il n'y en a aucune sont deux gestes differents ; bloquer le second contredirait le conseil que le meme systeme donne dans ses propres refus.
- **Le texte de refus est construit a partir du verdict de l'index** (schema, `ruleId@version`, dimension, `kinds` a passer). La version precedente citait une mesure recopiee a la main depuis une session sur un autre depot : exacte le jour de sa redaction, infalsifiable ensuite, et sans lien avec l'index qui refusait.
- **Le pre-filtre est un second devineur, tolere sous une seule condition** : il decide uniquement s'il faut INTERROGER l'oracle, jamais s'il faut bloquer. Direction obligatoire de toute evolution : **elargir ce qu'il laisse passer vers l'oracle, jamais ce qu'il tranche seul.**
- **Aucun chemin en dur**, pas meme en commentaire : l'interpreteur et le point d'entree sont derives de la declaration `mcpServers.aidex` que l'utilisateur a deja ecrite dans sa configuration Claude. `AIDEX_NODE` / `AIDEX_ENTRY` restent prioritaires.

Tests dans `tests/hooks/` : motifs (29), decisions de bout en bout (12), fail-open (6), portabilite (6). Ils ciblent la copie **versionnee** du depot, pas celle installee dans le profil.

---

## 3. Le test differentiel -- `tests/coverage-oracle.test.js`

**C'est la garde du dispositif.** L'oracle PROMET de predire ce qu'une requete rendra ; rien d'autre ne verifie cette promesse.

- La **verite terrain est un scan du source** (donc grep), jamais l'index : confronter l'index a lui-meme ne prouverait rien.
- Les motifs sont **tires du depot**, jamais enumeres en dur, sauf les ancres de regression -- chacune a deja produit une reponse fausse pendant le developpement et a donc gagne sa place.
- Assertion principale : aucun motif pour lequel l'oracle dit `covered: true` et la requete rend un zero **silencieux**. Un zero accompagne de `otherKindMatches > 0` ne declare pas une absence, il designe la dimension a interroger.

Prouve non vacueux par mutation : forcer `literalQualifies` a `false` fait rougir quatre tests, dont l'assertion principale.

**Regle de branchement, a respecter apres tout merge : le hook ne doit bloquer que si ce test est vert.** "Oracle stable" se definit par ce test, pas par une impression.

---

## 4. Chemins et registre global

- **`init()` resout son chemin de projet en absolu des l'entree.** Un chemin relatif indexait correctement puis fuitait : `basename('.')` vaut `.`, donc `rebuild-index .` enregistrait un projet nomme `.` pointant sur `.`, doublon fantome du vrai, et la meme chaine allait dans `metadata.project_root` ou elle ne veut plus rien dire une fois le cwd oublie.
- **`global_refresh` retire toute entree de chemin relatif.** Corollaire non evident : `existsSync('.')` est vrai depuis n'importe ou, donc le fantome aurait survecu a chaque nettoyage en designant le repertoire courant du moment.
- **`tryUpdateGlobalRegistry` ignore les projets sous le repertoire temporaire du systeme.** Les fixtures de test appellent `init()`, donc chaque `npm test` enregistrait une entree par fixture dans le registre global de l'utilisateur : 91 lignes mortes accumulees en deux jours, et six reinjectees dans la minute suivant un nettoyage. La frontiere est testee au separateur, pour qu'un voisin nomme `Temp-projets` ne soit pas avale.

---

## 5. Robustesse decouverte en chemin

Petits patchs sans rapport avec la couverture, mais qui protegent des proprietes reelles.

- **`PRAGMA journal_mode = WAL` n'est plus emis sur une ouverture readonly** (`src/db/database.ts`). C'est une ECRITURE : tout index pas deja en WAL (sauvegarde restauree, copie `VACUUM INTO`, partage reseau) rendait `attempt to write a readonly database`. Trouve parce que l'oracle a echoue sur sa propre fixture -- et le contrat de fail-open a tenu.
- **`Queries` sonde `PRAGMA table_info(occurrences)` une fois par instance** (`src/db/queries.ts`). `migrateLegacySchema` ne tourne que sur les ouvertures en ecriture, et une connexion readonly ne peut pas faire d'`ALTER` : tout index pre-existant rendait `no such column: o.kind`. Trouve en sondant un index REEL, pas par la fixture de test, toujours construite depuis le schema courant.
- **Le point d'entree charge ses modules a la demande** (`src/index.ts`). Il importait statiquement le serveur MCP, le viewer et le log hub avant d'atteindre la branche demandee : 355 ms par spawn, ramenes a 76 ms, pour environ 5 ms de travail utile.
- **`rebuildCommand` nomme l'interpreteur courant et le point d'entree d'AiDex** (`src/commands/coverage.ts`). Deux defauts corriges dans la meme fonction : `node` en dur echouait sur `NODE_MODULE_VERSION` quand le `node` du PATH n'etait pas celui qui fait tourner le serveur (addons natifs), et `process.argv[1]` designait le script APPELANT, donc la commande de remede relancait l'appelant au lieu de reconstruire quoi que ce soit.
- **`.gitignore` : negation explicite `!src/coverage/`.** Un motif `coverage/` destine aux rapports de test matchait `src/coverage/` a n'importe quelle profondeur : le predicat unique n'aurait jamais ete commite, **en silence**.

---

## 6. Securite et dependances

- `overrides` : `protobufjs: ^7.5.8`, force sur `onnx-proto@4.0.4` qui declare pourtant `^6.8.8`. **Violation semver majeure assumee**, chemin embeddings uniquement, verifiee fonctionnelle (embedding jina-code, vecteur 768 dimensions non degenere). A retester apres chaque rafraichissement de dependances.
- Etat releve sur upstream 2.3.0 : 15 vulnerabilites en dependances de production, toutes transitives d'upstream, aucune dependance directe du fork. Detail et plan de durcissement dans `.claude/CLAUDE.md`.

---

## 7. Extensions MESUREES puis ECARTEES

A ne pas retenter sans nouvelle mesure : ces regles paraissent raisonnables sur le papier, et le terrain les a refusees. Campagne du 2026-08-11 sur cinq depots reels (Go, Python x2, Rust, TypeScript), hors fichiers de test, en ne comptant que les litteraux qui seraient NOUVELLEMENT indexes.

- **Litteraux en position array : ECARTES.** Meme restreints aux tableaux lies a une const annotee ou en majuscules, ils sont majoritairement des TABLES DE DONNEES : un bucket de 760 candidats s'est revele etre un dictionnaire de sentiment et des listes de mots vides (`"the"`, `"a"`, `"is"`, `"were"`). Gain de 0,6 a 2,4 points de couverture contre l'injection de centaines de mots anglais courants dans l'espace de noms des symboles.
- **Litteral en argument d'appel, en Go : ECARTE.** 77 % des candidats sont les clefs du logging structure (`slog.Warn("msg", "error", err)`).
- **Idem en TypeScript et en Python : ECARTES.** Tables de mapping et noms d'evenements en un seul mot.
- **Idem en Rust : viable, mais seulement en excluant les appels de diagnostic** (`expect`, `unwrap_or`, `panic`, `assert*`), qui font 18 % du bucket et l'essentiel du bruit. Le reste est domine par `get` (391 occurrences), soit des clefs de lookup. Non implemente : le gain ne concerne qu'un langage et coute un changement de `ruleVersion`, donc la reindexation de tous les index.

**Lecon de methode, plus utile que le resultat** : la precision Rust avait ete annoncee a 82 % sur un echantillon de 34. Sur le depot complet elle tombe a environ 64 %, et a 36 % de bruit si les fichiers de test sont inclus. Un echantillon de quelques dizaines ne voit pas un motif qui pese 15 % du total.

## 8. Portage vers l'upstream

Ordre de PR = ordre de livraison, du moins engageant au plus opinione.

- **Oracle et reponse honnete** : tres portables, additifs, sans changement de schema. Un outil qui sait dire "je ne peux pas repondre a ca, et voici pourquoi" corrige un defaut **epistemique** que subit tout utilisateur.
- **Dimension `kinds`** : portable, mais engage la surface publique (colonne, parametre, defaut). Conversation attendue.
- **Extraction par langage** : le plus difficile. Des regles d'extraction par langage sont un choix de produit, pas une correction.

**Deux pieges de redaction.** Ne jamais justifier l'oracle par notre hook : il est invisible pour l'upstream, alors que "un consommateur MCP doit pouvoir distinguer *absent* de *hors couverture*" est un argument universel. Et les mesures citees ici ont ete faites sur des depots prives : elles devront etre rejouees sur des depots publics qu'un mainteneur peut cloner et verifier.

**Mise a jour 2026-08-12** : les patches multi-mots/espacement de la section 15 s'ajoutent au meme lot "Extraction par langage" (ils touchent `LITERAL_RULE_VERSION`, `LITERAL_SHAPE` et le meme fichier `rule.ts`) et n'en changent pas la place, le plus difficile a porter. Le contrat de `init()` (section 16) et l'infrastructure de test (section 17) sont independants de la couverture litterale et portables separement, sans conversation attendue sur la surface publique.

---

## 9. Reorganisation de `hooks/` -- commit `5f1bc06`

`hooks/aidex-grep-nudge.py` deplace en `hooks/claude/aidex-grep-nudge.py` par `git mv`, creation de `hooks/git/`. Motif : deux familles de hooks allaient cohabiter, hooks Claude Code et hooks git, avec des mecanismes d'installation et des contrats d'entree/sortie sans rapport.

Cinq references internes au depot portaient le chemin en dur et ont ete corrigees dans le meme commit : quatre fichiers sous `tests/hooks/` et la section 2 de ce fichier elle-meme.

**Point important pour un futur mainteneur** : la copie EXECUTEE du hook vit dans le profil utilisateur (`$USERPROFILE/.claude/hooks/`), pas dans le depot, donc ce deplacement n'a pas casse le hook en cours d'execution. Sondes rejouees depuis la nouvelle arborescence : 29 motifs, 12 decisions de bout en bout, 6 fail-open, 6 portabilite, tous verts et identiques a l'avant-deplacement.

---

## 10. Sous-commande CLI `update` -- commits `a7293de`, puis durcissements `3a79c86` et `d30abf3`

Expose `node build/index.js update <project> <file...>`. La logique existait deja cote MCP dans `src/commands/update.ts` ; le patch l'expose au CLI, il ne la reecrit pas. **Raison d'etre** : prerequis bloquant des deux mecanismes de reindexation automatique (sections 11 et 12), un hook git ne pouvant pas appeler un outil MCP.

**Contrat, chaque point etant load-bearing** : multi-fichiers obligatoire en un seul spawn, silencieux en succes, code retour 0 MEME en cas d'echec et meme quand il n'y a rien a faire (un post-commit ne doit jamais ressembler a un echec), no-op propre sur un repertoire sans `.aidex` (c'est ce qui rend sur un hook git en portee globale), un fichier problematique ne fait jamais echouer les autres du lot, hash-diff non contourne.

Mesures a citer : spawn a vide 58 ms, un fichier reel 148 ms, vingt fichiers en un seul spawn 356 ms contre 2925 ms en vingt spawns, soit un facteur 8,2. L'ecart entre spawn a vide et spawn utile, environ 90 ms, est le chargement des addons natifs tree-sitter et better-sqlite3, pas le demarrage de Node.

Deux passes de durcissement apres revue, a documenter comme telles :
- `3a79c86` a ajoute un try/catch de boucle (une base illisible faisait sortir en code 1 avec une trace de pile et abandonnait le reste du lot, parce que `withDatabase` ouvre la base AVANT son try), un garde-fou unique de normalisation des chemins qui ecarte tout chemin hors projet et referme du meme coup les cas cross-volume et UNC, et une resolution de la casse reelle sous Windows.
- `d30abf3` a corrige un `break` devenu du code mort (il etait branche dans le `catch` alors que l'erreur de verrou remonte dans la valeur de retour, pas en exception) et un doublon de ligne en base sur un renommage de casse pure.

Mesure du correctif de verrou : 16638 ms avant contre 5652 ms apres sur un lot de trois fichiers sous verrou reel.

**Piege durable a signaler pour le futur mainteneur** : le code retour etant force a 0 par conception, il ne porte AUCUNE information sur le resultat par fichier. Le seul signal est la ligne de synthese en mode `--verbose`. Un test de contrat verrouille ce format, voir section 13.

---

## 11. Hooks git de reindexation -- commit `ee71aa2`

Quatre hooks dans `hooks/git/` (`post-commit`, `post-merge`, `post-checkout`, `post-rewrite`), plus `aidex-reindex-common.sh` et un `README.md`. Installation MANUELLE assumee, l'operateur etant seul sur le fork : ce commit ne touche aucune configuration git globale.

**Fait de configuration decisif a documenter, car il surprendra quiconque reprend ce code** : `core.hooksPath` est pose en GLOBAL sur la station, ce qui fait IGNORER le repertoire `.git/hooks` local de tous les depots. Un hook pose dans `.git/hooks` ne se declencherait donc jamais. **Corollaire structurant** : un hook global se declenche sur TOUS les depots de la machine, d'ou l'auto-limitation -- sortie immediate en code 0 sans rien ecrire si le depot courant n'a pas de `.aidex` a sa racine.

Debounce a fenetre glissante en front descendant, defaut 2 secondes, surchargeable par `AIDEX_DEBOUNCE_SECS`. Mesure : huit commits rapides produisent huit mises en file et exactement UN drainage. Sans cela, un rebase de trente commits lancerait trente reindexations.

Resolution d'interpreteur reprise du hook de nudge existant (section 2), sans aucun chemin en dur. **Enjeu a expliquer** : le `node` du PATH de la station est en version 24 et casse l'ABI de `better-sqlite3` compile sous Node 22, et un client git graphique n'a pas nvm dans son PATH.

**Point ouvert honnete a consigner** : le critere "un client git graphique declenche le hook aussi bien que la ligne de commande" n'a PAS pu etre mesure faute de client graphique disponible. Un substitut a ete joue -- la fonction de decouverte reste correcte avec un environnement vide, ce qui prouve l'independance au PATH interactif mais pas le cas reel.

---

## 12. Hooks Claude Code de reindexation -- commits `83ef31b`, `1d4a74a`, `4a05ec1`

Deux hooks dans `hooks/claude/` (`aidex-queue-edit.py`, `aidex-queue-drain.py`) plus un module commun (`aidex_hook_common.py`). `PostToolUse`, matcher `Edit|Write`, se contente d'ajouter une ligne dans un fichier de file d'attente scope par session et ne lance aucun Node. `Stop` lit la file, dedoublonne, groupe par projet et lance un seul appel du CLI `update` par groupe, par tranches de 100 fichiers (`CHUNK_SIZE`, contre la limite argv de `CreateProcess` sous Windows).

**Justification du decoupage en deux hooks, a expliquer** : le hook `Stop` ne recoit PAS la liste des fichiers edites, et `PostToolUse` la recoit mais couterait un demarrage de process par edition.

**FAIT IMPORTANT POUR UN FUTUR MAINTENEUR** : l'outil `MultiEdit` n'existe plus dans Claude Code 2.1.228. Un matcher ecrit `Edit|Write|MultiEdit` aurait sa troisieme alternative morte. Les editions multiples passent aujourd'hui par `Edit` avec `replace_all`.

**Detection d'echec, et c'est le piege principal de ce patch** : le code retour du CLI `update` etant force a 0 par conception (section 10), le drain lit la ligne de synthese en mode `--verbose` et cherche le compteur `Errors: N`. C'est un couplage par le TEXTE entre deux modules. Un test de contrat le verrouille desormais des deux cotes (section 13).

**Comportement du verrou, contre-intuitif et mesure** : le CLI ne leve PAS d'erreur face a un ecrivain concurrent ordinaire, `better-sqlite3` bloque et attend environ 5 secondes puis reussit. La retention du lot en contention ne vient donc pas d'une detection d'erreur mais du timeout de 3 secondes cote hook (`AIDEX_UPDATE_TIMEOUT_S`), seul mecanisme reellement actif.

Mesures a citer, prises avec un vrai Claude Code : `PostToolUse` 45 a 53 ms par edition, `Stop` 190 a 209 ms, soit 0,7 pour cent d'un tour de 27 secondes. Sous verrou tenu le tour paie 3,07 s. Un lot de 403 fichiers donne 5 spawns et 1,18 s. Un tour a trois editions donne exactement un spawn.

`1d4a74a` corrige en plus trois defauts trouves en revue (stdin malforme non-dict, `session_id` non-chaine, `subprocess.TimeoutExpired` avale par un `except` generique qui retentait sur chaque entree de `NODE_CANDIDATES`) et bascule la reecriture de la file sur `tempfile` + `os.replace` pour l'atomicite.

`4a05ec1` ajoute `hooks/claude/settings.json.template` (et sa documentation `settings.json.template.md`), modele de ce que l'utilisateur doit ajouter a son `settings.json`.

---

## 13. Tests ajoutes -- commits `f90af5b`, `18e9201`, `cea76ca`

- `f90af5b` : corpus de requetes de reference sous `tests/fixtures/query-corpus.json` et son harnais de rejeu `tests/query-corpus.test.js`, 30 requetes en trois familles (identifiant, multi-mot, `contains`), verite terrain etablie par grep. Il produit des chiffres comparables avant et apres un changement de classement, pas un simple vert ou rouge.
- `18e9201` : suite de regression de la sous-commande CLI `update` (`tests/cli-update.test.js`), 17 cas, incluant les quatre voies d'echappement hors projet (relatif, absolu, cross-drive, UNC), la base corrompue, le renommage de casse pure et le lot mixte.
- `cea76ca` : test de contrat (`tests/cli-update-summary-contract.test.js`) sur le format de la ligne de synthese, qui verrouille le couplage par le texte decrit en section 12.
- `0d2c7e4` : `tests/whitespace-tolerance.test.js`, 20 cas, sur la tolerance a la difference d'espacement des litteraux multi-mots (section 15). Preuve par mutation, raison d'etre du fichier : neutraliser la normalisation cote REQUETE fait rougir 11 cas, neutraliser la normalisation cote INDEXATION en fait rougir exactement 3, les deux ensembles etant disjoints et couvrant ensemble les 14 cas sensibles a la normalisation. C'est ce qui prouve que les deux points d'appel (`extractor.ts` et `db/queries.ts`) sont tous les deux porteurs de la garantie, ce qu'une suite verte seule ne prouve pas -- une suite verte est aussi compatible avec un seul des deux points d'appel qui ferait tout le travail.
- `16d8512` : `tests/init-success-modes.test.js`, 23 cas, sur le contrat de succes de `init()` (section 16) : `resolveInitSuccessMode` (6, renommee `resolveSuccessMode` par `bfb7bf8f`), `computeInitSuccess` en table de decision pure pour les trois modes (11), et trois suites de bout en bout a travers le vrai `init()` (6).
- `bfb7bf8f` : extension du meme fichier -- `resolveSuccessMode(raw, legacyRaw)` sur les deux noms de variable et leur alias, `rebuild-index` de bout en bout via CLI (`tests/init-success-modes.test.js`), et `printIndexWarnings` sur un `errors[]` fabrique (`tests/cli-warnings.test.js`, 5 cas).

Total de la suite apres ces ajouts : **177 tests** (9 fichiers de test), contre 118 avant (section 14).

**Detail non evident a consigner** : ouvrir un fichier texte avec `better-sqlite3` REUSSIT ; l'erreur de base invalide n'est levee qu'a la premiere ecriture, en pratique le pragma WAL. Quiconque "nettoierait" cet appel supprimerait aussi le declencheur de l'erreur.

---

## 14. Prefiltre trigramme -- tente puis REVERTE (commits `e7a0c8d` puis `7ca37e2`)

Patch tente sur `src/db/queries.ts` (mode `contains` de `aidex_query`), puis reverte sur decision de l'operateur par le commit `7ca37e2` (382 lignes retirees, `tests/trigram-prefilter.test.js` supprime avec). Suite complete : 118 tests verts apres revert, contre 134 avant -- l'ecart correspond aux 16 tests du prefilter partis avec le patch.

**Ecart carte / implementation.** La carte de tracage prescrivait un index trigramme FTS5 persiste dans SQLite. L'implementation livree etait une Map JavaScript en memoire. L'ecart n'a ete detecte qu'a la revue, parce que la chaine de supervision a lu les mesures rapportees et non le code.

**Mecanisme de l'echec, coeur du probleme.** `withDatabase`, dans `src/commands/shared.ts`, ouvre la base, cree un objet `Queries`, et le ferme dans son `finally`. Chaque appel MCP `aidex_query` passe par la, donc obtient un `Queries` neuf au cache vide, jete a la fin. L'index trigramme, mesure a 43 ms de construction et 19 Mo de tas pour 25000 items, etait donc reconstruit puis jete a chaque requete. Mesure sur index reel de 25136 items, avec un `Queries` froid comme en production : 34.95 ms pour le prefilter contre 2.13 ms pour le scan complet, soit 16.4 fois plus lent, et jusqu'a 18.6 fois sur une aiguille absente de l'index.

Le gain rapporte par l'auteur, 0.40 ms contre 2.20 ms, etait reel mais mesure dans une forme d'execution que la production n'a jamais : son harnais creait l'objet `Queries` une seule fois puis bouclait vingt fois dessus, cache deja chaud. C'est un piege de harnais a signaler comme tel, pas une faute de mesure.

**Piege couple, mesure.** Le cache etant porte par l'instance `Queries`, et un troisieme chemin d'ecriture sur la table `items` (un `DELETE FROM items` en SQL brut dans `src/db/database.ts`) contournant `Queries` sans rien invalider, trois scenarios ont ete mesures ou un cache perime fait disparaitre silencieusement des lignes. Ce bug etait inoffensif pour une seule raison : le cache ne vivait jamais assez longtemps pour perimer. Le patch etait donc protege du bug de coherence par ce qui detruisait sa performance, et corriger l'un ouvrait l'autre.

**Ce qui etait irreprochable et reste acquis.** La correction du prefilter a ete validee par 45507 assertions octet-identiques au scan complet, sur index reel et sur un corpus adversarial construit pour provoquer les collisions d'ordre, avec un compteur prouvant que le prefilter s'etait reellement declenche plutot que d'avoir repondu null. Ordre total et pagination intacts, aucune regression sur les modes `exact` et `starts_with` ni sur le filtre `kinds`.

**Deux faits pour une reprise future.** La garde de selectivite a 10 pour cent ne se declenche jamais sur un corpus reel, les trigrammes les plus communs plafonnant a environ 6.4 pour cent du corpus. Et `src/commands/global/global-query.ts`, la recherche multi-projets qui scanne N bases attachees, a son propre SQL brut et ne beneficiait pas du prefilter. Ce second fait etait alors formule comme « le seul endroit ou un `LIKE` fait vraiment souffrir » : le profilage du 2026-08-12 l'a refute, le `LIKE` y pese environ 5 pour cent et le point chaud est la jointure d'occurrences (voir plus bas).

**Contradiction resolue le 2026-08-12 : c'etait une erreur d'unite.** Ce paragraphe affirmait que deux mesures du scan complet sur des index de taille comparable ne concordaient pas, 19 a 29 ms sur graphify-8 (22816 items) contre 2.1 ms sur Kleos (25136 items), soit un facteur 10 inexplique, et c'est cette contradiction qui avait motive le revert plutot qu'une reecriture en FTS5. Le rejeu des deux mesures dans la meme unite montre qu'il n'y a jamais eu d'ecart : le chiffre de 19 a 29 ms est un AGREGAT SUR 20 REPETITIONS, celui de 2.1 ms un APPEL UNIQUE. Ramenes a l'appel, les deux index mesurent 1.0 a 1.9 ms, rapport 1.0 a 1.1. La comparaison d'origine, faite ici meme, opposait deux chiffres d'unites differentes. Six hypotheses ont ete testees et ecartees par la mesure (taille de la table items, distribution de longueur des termes, volume d'occurrences, selectivite de l'aiguille, cache de pages froid contre chaud, langage indexe) : la plus ample, le cache de pages, ne rend qu'un facteur 1.5.

**Il n'y a pas de probleme de performance sur le matching `contains`.** Profil a froid du chemin mono-projet, dans la forme reelle d'un appel MCP : `open` 2.3 a 2.6 ms, `countItems` 2.2 a 4.9 ms, `searchItems` 1.0 a 1.9 ms, `getOccurrencesByItems` 0.04 a 17.8 ms, bout en bout 10.6 a 54.5 ms. `searchItems`, seule cible du patch reverte, pese 5 a 12 pour cent du cout total : le ramener a zero rendrait moins de 2 ms. Sur le chemin multi-projets, 14 bases attachees, le passage de `exact` a `contains` sur une aiguille absente coute 6 ms au total, soit environ 0.45 ms par projet, tandis que la jointure d'occurrences va jusqu'a 137 ms. Le point chaud est proportionnel au FANOUT, le nombre d'occurrences ramenees, pas au nombre d'items scannes. Aucune technique d'acceleration du matching ne peut rendre plus de 2 ms en mono-projet ni 7 ms en multi-projets. La carte de tracage a ete fermee sur ce constat.

**Lecon generale.** La carte prescrivait une technique avant d'avoir localise le probleme, et c'est cela qui a coute le travail. Une carte de tracage a ete creee pour la possibilite d'accelerer la recherche `contains`, cadree autour de la mesure prealable.

---

## 15. Litteraux multi-mots -- commits `34532c8`, `0d2c7e4`, `2c4eb99` (carte `f08aeeb1`)

Carte scindee de `10096483` sur decision de l'operateur du 2026-08-11, apres mesure refutant la premisse initiale (le blocage multi-mots etait cote indexation, dans la garde de `classifyPattern`, pas cote requete).

### Ce qui marche maintenant

Phrase exacte, sous-chaine CONTIGUE, prefixe, casse differente, et **tolerance aux differences d'espacement** (double espace, tabulation, indentation, padding en debut/fin) -- dans les trois modes `exact`, `contains` et `starts_with`. Le mecanisme est une forme canonique unique, `normalizeLiteralWhitespace` (`src/coverage/rule.ts`) : collapse toute suite de blancs en un seul espace, puis trim. Elle est appliquee aux **deux bouts du meme pipe** : `src/parser/extractor.ts` a l'indexation (le terme ECRIT dans l'index est deja la forme canonique, pas seulement teste contre elle), `src/db/queries.ts` (`countItems`, `searchItems`) et `src/commands/global/global-query.ts` a la requete.

**Piege a ne jamais reintroduire** : un index canonicalise interroge par une requete brute produit des silences invisibles -- exactement le defaut corrige par `0d2c7e4`, voir plus bas. Toute nouvelle voie de lecture ou d'ecriture des litteraux doit passer par cette meme fonction, aucune autre normalisation locale.

### Ce qui ne marche toujours pas, PAR DESIGN

Sous-ensemble de mots non contigu, et ordre libre (chercher "Restart Service" quand la source dit "Restart the Service", ou "Service Restart"). Le moteur ne fait **aucun split par mot** : `itemMatchParam` (`src/db/queries.ts:497`) enveloppe le terme entier, normalise, dans un seul `LIKE`. C'est le perimetre reste ouvert sous la carte `10096483`.

### Volume reel mesure, et l'ecart avec la prevision

Apres reindexation complete de ce depot : **6397 items avant, 6749 apres**, dont **258 multi-mots**, soit 3,82 % de l'index et 5,5 % de croissance. La prevision faite la veille (2026-08-11) annoncait +1921 items, soit +29,9 % : une surestimation d'un facteur 5,5.

Cause probable, **non mesuree, a traiter comme telle** : `LITERAL_SHAPE` (voir section 1.4) n'admet que `[A-Za-z0-9_:.\-/ ]`, donc tout litteral portant une virgule, une parenthese ou une apostrophe reste rejete -- ce que le script jetable de la prevision ne modelisait vraisemblablement pas. Meme lecon de methode que la section 7 : un chiffre de prevision batie sur un script hors-production, non confronte au code de production reel, se trompe d'un facteur significatif.

### Deux defauts trouves en revue -- `0d2c7e4`, tous deux des reponses fausses se presentant comme vraies

1. **`global-query.ts` passait le terme BRUT** a `buildItemSearch` et a `getCacheKey`, donc la recherche multi-projets ratait ce que la mono-projet trouvait des que l'espacement de la requete differait de la source. Mesure sur quatre orthographes : **1/0/0/0** cote multi-projets contre **1/1/1/1** cote mono-projet, avant correctif. Corrige en appliquant `normalizeLiteralWhitespace` au terme avant `buildItemSearch` et avant le calcul de la cle de cache (deux orthographes en espacement d'une meme requete partagent desormais une seule entree, au lieu de payer chacune un scan complet).
   **Lecon generale, plus large que ce bug** : l'ECRITURE (l'indexation) n'avait qu'un seul chemin, la LECTURE (la requete) en avait quatre (`query.ts` mono-projet x3 modes en interne, plus `global-query.ts`). Une garantie dite "structurelle par point de passage unique" ne l'est que si elle a ete verifiee contre TOUS les chemins de lecture, pas seulement celui qu'on vient de modifier.
2. **Un terme de blancs se normalisait en chaine vide** et produisait `LIKE '%%'`, qui rend l'index entier -- pendant que `classifyPattern` repondait correctement `not_indexable` pour ce meme terme. Corrige par un court-circuit dans `countItems`/`searchItems` : un terme non vide qui normalise vers `''` rend 0 resultat plutot que de construire ce `LIKE`.

### Fait mesure non evident : la portee reelle de la restriction `below`

La restriction positionnelle `below` (litteral indexe seulement en position `literal_type`/`jsx_attribute`/valeur de `pair`, voir section 1.4) ne s'applique en pratique qu'aux phrases **tout en minuscules et sans ponctuation**. Toute phrase avec un separateur ou une majuscule resout deja `above` et est indexee sans condition de position -- ce qui couvre la quasi-totalite des phrases anglaises ordinaires : "Failed to load config" et "Error while loading" tombent en `above` via `isMixedCase`, dans toutes les positions. La regle elle-meme est inchangee par ce patch ; seule sa portee pratique est desormais documentee dans le code (`2c4eb99`).

### Le hook `aidex-grep-nudge` n'est pas affecte

Son pre-filtre `CANDIDATE_RE` (section 2) n'admet pas l'espace : un pattern multi-mots n'atteint donc jamais l'oracle et ne peut jamais produire de blocage sur ce cas. Elargir ce pre-filtre pour couvrir les phrases reste un changement distinct et volontaire, non fait ici -- cela resterait conforme a la direction obligatoire deja fixee en section 2 (elargir ce que le pre-filtre laisse passer vers l'oracle, jamais ce qu'il tranche seul).

### Reindexation requise

`LITERAL_RULE_VERSION` passe de 1 a 2 (section 1.4) : tout index anterieur remonte `ruleOutdated` sur la dimension litterale au lieu de repondre partiellement. Ce depot est reindexe ; le reste de la station peut l'etre au fil de l'eau.

---

## 16. Contrat de succes de `init()` -- commit `16d8512` (carte `a7039829`)

### Le defaut n'etait pas l'indexation, c'etait le RAPPORT

`init()` empile chaque echec par fichier dans `errors[]` sans jamais faire varier `success`, code en dur a `true` sur le chemin de retour principal. Le CLI (`src/index.ts`) n'imprimait `errors[]` que si `success` etait faux. Un fichier qui echoue reellement produisait donc "Done!" suivi d'un compteur de fichiers indexes silencieusement diminue -- sans aucun signal visible.

### Deux correctifs

1. **Enrichissement inconditionnel** : `errors[]` est desormais imprime par le CLI meme sur succes (bloc `Warnings: N file(s) reported errors...`, 10 premieres entrees puis compteur du reste). Cote MCP (`handleInit`, `src/server/tools.ts`), c'etait deja le cas depuis le commit initial. Depuis `bfb7bf8f`, ce bloc est une seule fonction partagee, `printIndexWarnings(errors)` (`src/utils/cli-warnings.ts`), consommee par les deux blocs CLI (`init` et `rebuild-index` dans `src/index.ts`) plutot que dupliquee -- extraction motivee par le besoin de la tester directement sur un `errors[]` fabrique (`tests/cli-warnings.test.js`), `src/index.ts` ne pouvant pas s'importer sans declencher son propre `main()`.
2. **`success` peut desormais reagir a `errors[]`**, derriere UNE variable d'environnement, `AIDEX_SUCCESS_MODE`, resolue une fois par `resolveSuccessMode(raw, legacyRaw)` et appliquee une fois par `computeInitSuccess()`, toutes deux dans `src/commands/init.ts`. `AIDEX_INIT_SUCCESS_MODE` (le nom d'origine de ce patch) reste un alias de compatibilite : `AIDEX_SUCCESS_MODE` gagne si les deux sont definies et non vides, sinon `AIDEX_INIT_SUCCESS_MODE` est consultee ; les deux noms sont acceptes seuls. Renommage et alias introduits par la carte `bfb7bf8f`, qui etend aussi ce mode a `rebuild-index` (voir plus bas).

### Les trois modes

- `default` (silencieux si absent) : comportement inchange, `success` toujours vrai sur ce chemin.
- `empty` : `success` faux uniquement sur une panne TOTALE d'indexation -- `filesFound > 0 && filesIndexed === 0 && filesSkipped === 0`.
- `strict` : `success` faux des qu'`errors[]` n'est pas vide, et englobe aussi la condition de `empty` pour rester monotone (un total wipeout a zero erreurs ne doit pas echapper au mode le plus severe).

**Correction de specification a documenter, instructive en elle-meme** : la formulation litterale de la carte pour `empty` etait "echec si `filesIndexed` vaut 0 alors que des candidats ont ete trouves". Prise au pied de la lettre, cette condition se declenche sur un **re-run idempotent sain** -- la forme de re-run la plus courante, ou chaque fichier inchange court-circuite via le hash-diff dans `filesSkipped`, laissant `filesIndexed` a 0 sans qu'il y ait la moindre panne. La condition retenue exige les DEUX compteurs a zero (`filesIndexed === 0 && filesSkipped === 0`), ce qui exclut ce cas sain tout en couvrant la panne totale reelle que la carte visait.

**Valeur inconnue de la variable** : `resolveSuccessMode` **jette**, aucun repli silencieux vers `default`. Un repli silencieux aurait reintroduit exactement la classe de bug que ce patch corrige, un etage plus haut (un mode mal orthographie au lieu d'un succes code en dur). Le message d'erreur nomme la variable effectivement consultee (`AIDEX_SUCCESS_MODE` si elle est definie et non vide, `AIDEX_INIT_SUCCESS_MODE` sinon) : une valeur invalide sur l'alias legacy quand le nouveau nom est absent ou vide leve toujours, elle n'est jamais ignoree silencieusement. Seul cas non signale, assume par choix explicite (`bfb7bf8f`, non traite en scope creep) : une valeur invalide sur l'alias legacy quand le nom canonique est DEFINI et VALIDE -- l'alias est alors simplement ignore, sans avertissement.

### Contrainte permanente, a ne jamais assouplir en rebasant

**La logique de resolution/decision est scope a `init()` SEUL, sans duplication.** `resolveSuccessMode()` et `computeInitSuccess()` n'existent qu'a un seul endroit, `src/commands/init.ts`. Son EFFET, en revanche, n'est plus limite a la sous-commande CLI `init` depuis `bfb7bf8f` : `rebuild-index` appelle `init({ fresh: true })` en interne (`src/index.ts`), donc `AIDEX_SUCCESS_MODE`/`AIDEX_INIT_SUCCESS_MODE` gouverne aussi son `success` et son bloc `Warnings`, sans code de gating separe ni resolution dupliquee -- `rebuild-index` traverse simplement le meme chemin que `init`. La sous-commande `update` reste hors de ce perimetre, elle : contrat code retour 0 en TOUTES circonstances (section 10), ligne de synthese `--verbose` verrouillee par un test de contrat (section 13) parce que le hook de drain (section 12) la parse par le texte. La non-interference est prouvee structurellement, pas seulement par convention : `update` n'appelle jamais `init()` et tient ses propres compteurs locaux, independants de `errors[]`/`computeInitSuccess`.

Voir aussi 1.9 pour la resolution explicite de la contradiction apparente avec le principe "pas de levier par variable d'environnement" : cette variable ne touche ni la regle d'indexation ni ce que l'oracle de couverture predit, seulement le RAPPORT de `init()`.

**Trou identique, corrige** dans `rebuild-index` par la carte `bfb7bf8f` : le meme defaut de rapport (un `errors[]` non vide invisible derriere `success:true`) touchait `rebuild-index`, qui a sa propre boucle CLI dans `src/index.ts` bien qu'elle delegue a `init()`. Fixe en faisant consommer le meme `printIndexWarnings()` par les deux blocs CLI plutot qu'en dupliquant la logique d'impression -- voir point 1 ci-dessus.

---

## 17. Infrastructure de test -- commit `f0f6ee1` (carte `39e02f07`)

Piege qui a coute trois rapports de diagnostic dont deux avec une cause racine fausse avant d'etre identifie.

### Defaut 1 (severe) : l'addon natif tree-sitter est un singleton de PROCESSUS

`process.dlopen` charge l'addon natif tree-sitter une fois par processus OS. Jest donne a chaque FICHIER de test un contexte `vm` neuf, mais `--maxWorkers=1` (ou `--runInBand`/`-i`) force tous les fichiers a partager le MEME processus. Des le deuxieme fichier d'un processus partage qui indexe en direct, `parseFile()` rend un `rootNode` `undefined`, et `extract()` leve sur `node.startPosition` -- un plantage qui se lit exactement comme un bug du parseur AiDex, et n'en est pas un.

Mesure : `--maxWorkers=1` donne **66 echecs sur 138**, le parallelisme par defaut donne **138 sur 138**, trois runs chacun.

**Le nombre d'echecs varie d'un run a l'autre**, ce qui a cree l'illusion d'un defaut non deterministe dans le code : jest tire l'ordre des fichiers de son cache de timings, et seul le PREMIER fichier de l'ordre passe toujours (il a le processus pour lui seul avant que l'addon soit deja charge par un autre fichier). Trois runs consecutifs en `--maxWorkers=1` sur le meme arbre ont donne **64, 36 et 52 echecs**.

### Le remede retenu, et deux approches ecartees pour la MEME raison

Un `globalSetup` jest (`tests/guards/no-single-worker.globalSetup.js`) lit `globalConfig.maxWorkers` **une fois, avant tout worker ou fichier de test**, et jette si la valeur vaut 1. Deterministe par construction : il depend du MODE D'INVOCATION de jest, jamais de l'ordre des fichiers.

Deux approches ecartees en amont, pour la meme raison -- la dependance a l'ordre des fichiers :
- un test symptomatique qui verifie que `parseFile()` rend un `rootNode` defini : ne fait rougir que le fichier qui tombe en second (ou plus tard) dans le processus partage, verdict qui change a chaque run ;
- un marqueur PID cross-fichier : meme defaut, le premier fichier de l'ordre passerait toujours.

**Piege mesure a consigner pour un futur mainteneur** : le champ `runInBand` **n'existe pas** sur `globalConfig` -- jest le calcule en interne et ne l'expose pas sous ce nom. `--runInBand`/`-i` se normalise en `maxWorkers = 1` avant que `globalSetup` ne s'execute (confirme empiriquement), donc un seul controle sur `maxWorkers` couvre les deux orthographes du mode dangereux.

### Defaut 2 : racine du depot resolue depuis `process.cwd()`

Quatre fichiers de test (`tests/cli-update-summary-contract.test.js`, `tests/cli-update.test.js`, `tests/query-corpus.test.js`, `tests/coverage-oracle.test.js` via `cwdRoot()`) resolvaient `REPO_ROOT` depuis `process.cwd()`, cassant (`ENOENT` / module introuvable) des que la suite etait lancee depuis un repertoire hors du depot. Corrige en ancrant sur `dirname(dirname(fileURLToPath(import.meta.url)))`, une ligne par fichier.

**Verifie** : mode par defaut 138/138 (deux fois), `--maxWorkers=1` et `--runInBand` declenchent tous les deux le garde-fou avec le message descriptif, suite complete lancee depuis `/tmp` (hors de l'arbre du depot) 138/138 propre.

---

## 18. Fence de frontmatter `.astro` -- correctif d'un defaut UPSTREAM (hypothese `hyp_7d7728d9`)

### Le defaut, en une phrase

Les deux fences `---` d'un fichier `.astro` etaient reconnues par DEUX regles differentes, et seule l'une des deux tolerait le `\r` d'un fichier CRLF -- donc sur toute machine Windows, 100 % des fichiers `.astro` etaient rejetes comme non parsables.

```js
if (lines[0]?.trimEnd() !== '---') return null;   // ouvrante : tolere le CR
const closeIdx = lines.indexOf('---', 1);         // fermante : ne matche JAMAIS '---\r'
```

`source.split('\n')` laisse un `\r` en fin de chaque ligne d'un fichier CRLF. Git stocke ces blobs en LF, un checkout Windows avec `core.autocrlf=true` les materialise en CRLF (`git ls-files --eol` rend `i/lf  w/crlf`). L'ouvrante passait, la fermante ne matchait jamais : `closeIdx === -1`, `return null`, `parseFile` rendait `null`, `extract` rendait `null`, et `init()` classait le fichier en `Unsupported file type or parse error` -- sur un fichier bien forme d'un type que le projet declare supporter.

### Pourquoi il a survecu si longtemps : deux causes, aucune dans le parseur

1. **`.astro` n'avait aucun test.** `grep -rli "astro" tests/` ne rendait rien. La suite restait verte pendant que la totalite des `.astro` d'un arbre Windows echouaient.
2. **Le tableau `errors[]` d'un run `init()` REUSSI n'etait pas rendu a l'appelant** avant la carte `bfb7bf8f` (section 16). La premiere reindexation apres cette livraison est exactement ce qui a fait sortir les 30 avertissements. Le defaut de rapport masquait le defaut de parsing.

### Mesures

Sur le corpus `cocoindex` (338 fichiers indexes), `extract()` appele en direct sur chaque `.astro`, sans toucher aucun index :

| | fichiers en echec | items extraits |
|---|---|---|
| avant | **31 sur 31** | 0 |
| apres | **0 sur 31** | **2906** |

2906 items etaient silencieusement perdus. Aucun des 31 fichiers ne manque reellement de fence fermante.

**Portee sur la station** : compte de `*.astro` hors `node_modules` sur les dix racines indexees -- `31` cocoindex, `31` Argus (les MEMES fichiers physiques, sous `Argus/references/cocoindex`), `0` sur les huit autres (koryphaios, AiDex, Kleos, kerdoos, crawl4ai-rag-mcp, koryphaios-mcp, Semantic_Video_Search, `_aidex-hookbench`). La dette est donc bornee a un seul projet, et une reindexation de `cocoindex` apres commit doit rendre `errors[]` vide et un `itemsFound` en hausse d'environ 2900.

### Le correctif, et la decision qu'il fige

Les deux fences utilisent desormais la MEME regle, `trimEnd() === '---'`, via une boucle explicite qui remplace l'`indexOf`.

C'est un **elargissement DELIBERE** cote fermante : elle accepte maintenant `'---   '` avec des espaces en fin, ce que l'`indexOf` strict refusait. C'est voulu, par symetrie avec l'ouvrante qui le tolerait deja depuis l'arrivee de la feature -- l'incoherence etait de le refuser d'un cote seulement. **Ne pas "resserrer" cette moitie en croyant corriger une laxite** : `tests/astro-frontmatter-eol.test.js` la fige explicitement, et le commentaire en place nomme la cause pour que personne ne "simplifie" la boucle en revenant a `indexOf`.

`trimEnd()` et **pas** `trim()` : la fence reste ancree en colonne 0. C'est un **choix conservateur d'indexeur, plus strict que la grammaire Astro**, pas une restitution de cette grammaire -- ne pas lire les deux cas de test correspondants comme une affirmation sur ce qu'Astro accepte. Fige par test dans les deux sens (fence ouvrante indentee ET fence fermante indentee), pour qu'un futur `trimEnd` -> `trim` ne passe pas inapercu.

### Origine : UPSTREAM, pas le fork -- meilleur candidat de PR produit ici

Le support `.astro` vient d'upstream :

```
git log -1 --format='%h %an %ad %s' 31d478c
  31d478c Legein, Zach (SP) Tue May 19 19:25:52 2026 -0500 feat: add .astro file support
git branch -r --contains 31d478c   -> inclut upstream/master
```

Ce n'est donc pas un defaut du fork, c'est un **defaut d'upstream que le fork vient de trouver** : tout utilisateur Windows d'AiDex perd 100 % de ses fichiers `.astro`, silencieusement, depuis mai 2026. C'est le meilleur candidat de PR upstream produit par ce fork, et il ne depend d'aucun lot de la section 8 : correctif minimal, aucun changement de surface publique, aucun lien avec la couverture litterale, argument universel qui n'exige de citer aucune mesure faite sur un depot prive (il se reproduit sur n'importe quel depot `.astro` public clone sous Windows). A porter separement, et en premier.

### Test de regression -- `tests/astro-frontmatter-eol.test.js`

16 cas en cinq blocs : agnosticisme LF/CRLF (dont l'egalite des deux frontmatters apres normalisation du CR et la preservation des numeros de ligne), traversee complete de la chaine `extractAstroFrontmatter` -> `parseFile` -> `extract`, tolerance d'espaces en fin sur les DEUX fences (la decision figee) contre refus d'une fence indentee, cas negatifs legitimes (pas de fence, ouvrante sans fermante en LF ET en CRLF, source vide), et un cas d'integration `init()` sur un vrai `.astro` ecrit en CRLF qui exige `errors[]` STRICTEMENT vide.

**Prouve par mutation**, selon la discipline maison : le correctif remis a l'etat d'avant (`git stash push src/parser/tree-sitter.ts` puis `npm run build`) fait passer le fichier a **8 echecs sur 16**, et le cas d'integration rend alors la chaine de production exacte, `"src/Probe.astro: Unsupported file type or parse error"`.

Le critere exact du partage, qui est ce qui rend la mutation concluante : **rougissent les cas ou la fence fermante n'est pas `'---'` octet pour octet ET ou le resultat attendu est NON-NULL.** Les 8 verts ne sont donc pas "les cas independants de la fence fermante" -- deux d'entre eux en dependent bel et bien (ouvrante sans fermante, en LF et en CRLF), mais ils attendent `null`, verdict que les deux versions du code rendent. Un fichier qui aurait rougi EN BLOC aurait prouve qu'il teste autre chose que ce qu'il annonce.

**Verifie** : `npm run build` puis `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/astro-frontmatter-eol.test.js` -> 16/16, via `agent-forge verify` (2/2 steps). Attention, `npx jest` echoue en `Cannot use import statement outside a module` : le depot est `"type": "module"`, le `--experimental-vm-modules` du script `npm test` est obligatoire.

### Reste NON VERIFIE

La fonction blanchit les deux fences et le template, mais **conserve les `\r` en fin des lignes du CORPS du frontmatter**, qui partent tels quels dans la grammaire TSX. Les tests montrent que l'extraction rend les bons items, donc c'est benin sur ce qu'ils couvrent. Mais **personne n'a verifie qu'aucune position de COLONNE rapportee** (signatures, prototypes) ne compte ce `\r` en trop. A ecrire comme non verifie, pas comme sain.

### Defaut voisin, volontairement NON corrige ici -- carte `a9d43516`

Un `.astro` legitimement **sans** frontmatter (composant template pur) est un cas normal : `extractAstroFrontmatter` rend `null` par conception, et `init()` le rapporte comme une erreur. C'est un defaut de CLASSIFICATION, pas de parsing, et le melanger a celui-ci aurait masque la difference de nature entre les deux. Mesure : 0 fichier sur 31 dans ce cas, contribution nulle aux 30 avertissements observes.

---

## 19. Deux grandeurs "items" distinctes portaient le meme mot -- carte `740c6f5d`

### Le defaut, en une phrase

`init()` et `aidex_status`/`aidex_scan` rendaient deux quantites totalement differentes sous le meme mot "Items", ce qui a produit une fausse alerte de croissance/perte de donnees le 2026-08-13 avant d'etre tranchee (`hyp_f372407c`) : il n'y avait AUCUNE perte, seulement une unite ambigue.

### Les deux grandeurs, precisement

- **Grandeur A -- paires terme-fichier, casse brute.** `init()`/CLI `init`/CLI `rebuild-index` rendent la somme, sur tous les fichiers reindexes, d'un `Set` PAR FICHIER (`itemsInserted.size`, `src/commands/init.ts:556` et `:902`), jamais dedoublonne entre fichiers ni case-folde.
- **Grandeur B -- termes globalement distincts, casse repliee.** CLI `scan`/`aidex_status`/`aidex_scan`/`aidex_global_init` rendent `SELECT COUNT(*) FROM items` (`src/db/database.ts:242`), une table `COLLATE NOCASE`.

Le rapport entre les deux vaut le nombre moyen de fichiers par terme -- il VARIE par projet, donc aucune comparaison directe des deux valeurs n'a de sens, meme sur le meme projet au meme run.

### Le correctif, et ce qu'il ne touche PAS

**Texte et une seule cle JSON, aucun mecanisme.** Le calcul de `itemsFound`/`itemsInserted` dans `init.ts` et la requete `COUNT(*)` de `getStats()` dans `database.ts` sont restes identiques, octet pour octet -- la carte les declare corrects par construction, le defaut est uniquement dans le RENDU.

Sept surfaces renommees, chacune identifiee en lisant sa source jusqu'a la grandeur qu'elle rend plutot qu'en filtrant sur le mot "items" :

- CLI `init` et CLI `rebuild-index` (`src/index.ts`, meme texte aux deux emplacements) : `"Items: N"` -> `"Term-file pairs (raw case): N"` (grandeur A).
- CLI `scan` (`src/index.ts`) : `"Items: N"` -> `"Distinct terms (case-folded): N"` (grandeur B).
- `aidex_init` (`handleInit`, `src/server/tools.ts`) : `"Items found: N"` -> `"Term-file pairs found (raw case): N"` (grandeur A).
- `aidex_scan` (`handleScan`, `src/server/tools.ts`) : `"**Items:** N"` -> `"**Distinct terms (case-folded):** N"` (grandeur B).
- `aidex_global_init` (`handleGlobalInit`, `src/server/tools.ts`) : ligne de tableau `"Items | N"` -> `"Distinct terms (case-folded, summed) | N"` (grandeur B, sommee sur plusieurs projets).
- `aidex_status` (`handleStatus`, `src/server/tools.ts`) : la cle JSON `items` de `statistics` est renommee `distinctTerms` par une destructure/spread LOCALE juste avant `JSON.stringify` -- `db.getStats()` elle-meme garde son champ `items` partout ailleurs dans le code, seule la sortie MCP change.

`MCP-API-REFERENCE.md` mis a jour en miroir pour les sections `aidex_init`/`aidex_status`/`aidex_scan`.

### Ce qui a ete refuse en revue, et pourquoi

- **`aidex_update` (`itemsAdded`/`itemsRemoved`)** : le calcul sous-jacent est DEDUIT faux par lecture de code (`update.ts:181` case-folded contre `update.ts:275` casse brute), NON MESURE -- un mot precis colle sur un nombre dont l'exactitude n'est pas etablie serait pire que le mot ambigu qu'il remplacerait. Laisse en l'etat, hors carte : la mesure elle-meme est le premier pas obligatoire de la carte de suite `d42a01a5`.
- **`aidex_tree`/`entry.itemCount`** : le RENDU porte toujours le mot "items" nu (`tools.ts:1707`), mais son UNITE est MESUREE a la source (`summary.ts:288-292`, `COUNT(DISTINCT item_id) GROUP BY file_id`), portee PER-FICHIER -- donc hors du critere d'acceptation de cette carte, qui porte sur un total-de-run compare a un total-de-status, pas sur un compte per-fichier. Volontairement non retouche plus avant sur instruction explicite.
- **Tableaux de benchmark historiques (`README.md`, `docs/MARKETING.md`)** : la grandeur qu'ils mesuraient a l'epoque n'est plus connue avec certitude ; les renommer affirmerait une unite non verifiee. Carte de suite `d74f9101` deposee pour couvrir ce residu (libelle `aidex_tree` inclus).

### Reste NON VERIFIE

La puce `aidex_update` ci-dessus reste une DEDUCTION de lecture de code, pas une mesure executee : `update.ts:181` (case-folded) contre `update.ts:275` (casse brute) n'ont pas ete confrontes sur un cas reel ou les deux comptes divergent effectivement. La carte `d42a01a5` porte cette mesure comme premier pas obligatoire, avec sa propre condition de fermeture -- ne pas la relire comme un fait etabli tant qu'elle n'est pas cloturee.

### Test de regression -- `tests/items-label-rename.test.js`

Deux passes. Pass 1, trois cas via `handleToolCall()` en-processus (`aidex_init`, `aidex_scan`, `aidex_status` JSON key), qui n'exercent QUE le chemin MCP (`src/server/tools.ts`) -- confirme separement necessaire quand la revue a releve que le texte CLI et le texte MCP avaient deja diverge une fois (`"Term-file pairs (raw case): "` cote CLI contre `"Term-file pairs found (raw case): "` cote MCP), donc un vert sur l'un ne prouve rien sur l'autre. Pass 2, deux cas supplementaires par PROCESSUS SPAWNE (`spawnSync`, harnais repris de `tests/init-success-modes.test.js`, PAS de `tests/cli-warnings.test.js` qui ne fait que mocker `console.log`) pinnant `src/index.ts` `init` (ligne ~131) et `scan` (ligne ~103) -- les deux lignes que le critere d'acceptation de la carte designe explicitement ("la derniere ligne d'un run d'indexation mise cote a cote avec la sortie de `aidex_status`"). `rebuild-index` (meme texte que `init`, ligne ~183) et `handleGlobalInit` (`tools.ts`) sont deliberement laisses NON pinnes par ce fichier -- hors du critere d'acceptation, portes par une carte de suite.

**Prouve par mutation** : la ligne CLI `init` (`src/index.ts:131`) remise a l'ancien texte `"Items: N"`, `npm run build`, re-run -> **1 rouge (CLI init) sur 5, 4 verts inchanges**, dont le cas CLI `scan` qui partage le meme fichier source mais une ligne differente. Restaure, rebuild, re-run -> 5/5 vert.

**Verifie** : `C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe --experimental-vm-modules node_modules/jest/bin/jest.js tests/items-label-rename.test.js` -> `Tests: 5 passed, 5 total`, via `agent-forge verify` (tsc-build + targeted-test, 2/2 steps).

---

## 20. `.astro` sans frontmatter classe comme erreur -- carte `a9d43516`

### Le defaut, en une phrase

Un `.astro` legitimement sans frontmatter (composant template pur, sans fence `---` du tout) est un cas NORMAL, mais `init()` le rapportait dans `errors[]` sous le meme message generique qu'un vrai echec de parsing -- c'est le "defaut voisin" identifie et deliberement NON corrige en section 18 (`hyp_7d7728d9`), traite ici.

### La chaine mesuree

`extractAstroFrontmatter` (`src/parser/tree-sitter.ts:145`) rend `null` par conception des qu'aucune fence n'est trouvee -- et rend le MEME `null` pour un fichier reellement casse (fence ouvrante presente, fermante absente). `extract()` propage ce `null` sans distinction. `indexFile()` (`src/commands/init.ts`) traitait tout `null` comme un echec, poussant `"Unsupported file type or parse error"` dans `errors[]`. MESURE via CLI le 2026-08-13 : un dossier avec un seul `.astro` sans fence produisait `Warnings: 1 file(s) reported errors during indexing` / `Files: 0`.

### Le correctif : classification, pas parsing

Deliberement PAS un changement de regle de fence -- la carte l'interdisait explicitement, la regle etant partagee avec de vrais echecs sur d'autres langages. Le correctif ajoute UNE COUCHE AU-DESSUS de `extractAstroFrontmatter` :

- `astroHasNoFrontmatterFence` (`src/parser/tree-sitter.ts`, exporte via `src/parser/index.ts`) : predicat pur qui reutilise EXACTEMENT la meme regle de premiere ligne que `extractAstroFrontmatter` (`trimEnd() !== '---'`), sans la dupliquer ni la modifier -- il repond a "pourquoi `null`", pas a "y a-t-il une fence".
- `indexFile()` (`src/commands/init.ts`) : sur `extraction === null`, si le fichier est `.astro` ET `astroHasNoFrontmatterFence` est vrai, rend `{success: true, empty: true, emptyReason: 'astro-no-frontmatter'}` au lieu de `{success: false, error: ...}`. Tout autre `null` (y compris `.astro` avec fence ouvrante sans fermante) garde le chemin d'erreur generique inchange.
- `run()` (`src/commands/init.ts`) : nouveau compteur `filesEmpty`, incremente a part de `filesIndexed` (aucune ligne `files` inseree pour ces fichiers) et a part de `errors[]` -- rendu dans `InitResult.filesEmpty`.
- **Visibilite CLI (exigence explicite du critere d'acceptation, pas une extension)** : un champ non imprime dans la structure de retour ne suffit pas -- l'operateur ne lit que le texte du terminal. `printEmptyFilesNote` (`src/utils/cli-warnings.ts`), silencieuse si `filesEmpty` est `0`/`undefined`, appelee depuis les DEUX branches CLI de `src/index.ts` (`init` et `rebuild-index`) juste apres `printIndexWarnings`, dans le meme bloc try/catch. Message volontairement `.astro` en EXEMPLE ("e.g.") et non en cause exclusive, `filesEmpty` etant destine a servir de futurs cas non-Astro.

### Ce qui n'a PAS ete touche

`InitSuccessCounts` (section 16, carte `a7039829`) et l'objet de comptage passe a `computeInitSuccess` sont restes intacts -- `filesEmpty` n'entre pas dans ce calcul, pour ne pas interferer avec l'heuristique zero-compte deja en place.

### Test de regression

`tests/astro-no-frontmatter.test.js` (7 tests, 4 blocs) : 2 tests unitaires confirmant que `extractAstroFrontmatter` rend `null` pour les deux cas (sans fence / fence non fermee), 2 tests confirmant que `extract()` propage ce `null`, 3 tests d'integration via `init()` (fichier sans fence -> `errors` vide ; fichier casse -> `errors` contient l'entree generique ; run mixte -> seul le fichier casse apparait). **MESURE rouge avant correctif** : 2 des 3 tests d'integration en echec (celui sur `errors` vide, et le run mixte). **MESURE vert apres correctif** : 7/7.

`tests/init-success-modes.test.js`, bloc `init CLI prints the third outcome (filesEmpty) separately from Warnings` (2 tests, harnais `spawnSync`/`CLI_ENTRY`/`NODE_BIN` deja en place dans ce fichier, PAS `tests/cli-warnings.test.js` qui ne fait que mocker `console.log`) : un projet TS normal ne doit JAMAIS imprimer la note (priorite haute -- prouve l'absence de bruit sur le chemin sain), un `.astro` sans fence doit imprimer `"1 file(s) had nothing to index (normal, not an error..."` et ne doit PAS imprimer `"Warnings:"`. **MESURE** : `C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe --experimental-vm-modules node_modules/jest/bin/jest.js tests/init-success-modes.test.js` -> `Tests: 36 passed, 36 total`.

**Prouve par mutation**, sur les DEUX nouvelles assertions specifiquement : `printEmptyFilesNote` court-circuitee (`if (true) return;`), rebuild, re-run cible sur le bloc -> **1 rouge (cas `.astro` sans fence) sur 2, le cas "projet TS normal" reste vert** -- directionnalite exacte demandee : le mutant ne fait rougir QUE le cas qu'il est cense casser, ce qui prouve que les deux assertions ne testent pas la meme chose. Restaure, rebuild, re-run -> 36/36 vert de nouveau.

**Verifie** : `agent-forge verify` (build + targeted-test sur `tests/astro-no-frontmatter.test.js` et `tests/init-success-modes.test.js`).

**Mutation dans l'autre sens (revue, bloquante)** : la mutation ci-dessus prouve que le correctif SERT, pas qu'il ne s'ELARGIT pas -- un test qui reste vert sous une desactivation du predicat mais qui restait DEJA vert avant le correctif ne prouve rien. `astroHasNoFrontmatterFence` sur-elargie (`return true;` inconditionnel, tout `.astro` declare sans fence), rebuild, re-run cible sur `tests/astro-no-frontmatter.test.js` seul -> **3 rouges sur 8** (le fichier casse, le run mixte, le cas BOM ci-dessous), les 4 tests unitaires + le cas fenceless restant verts a juste titre (ils pinnent le substrat inchange). Restaure, rebuild, re-run -> 8/8 vert.

**Quatrieme etat decouvert en revue (bloquant, corrige avant commit)** : un `.astro` avec un frontmatter VALIDE mais precede d'un BOM UTF-8 (`EF BB BF`) devenait silencieusement classe `filesEmpty` par le correctif ci-dessus -- ni template pur, ni fichier casse, un etat que la carte n'avait pas prevu. Cause : `trimEnd()` ne coupe que la fin de chaine, le BOM en tete de `lines[0]` survit et le predicat conclut a tort "aucune fence". Avant ce commit ce fichier apparaissait dans `errors[]` (regression de VISIBILITE introduite par ce correctif, pas une perte d'indexation preexistante puisqu'un `.astro` avec BOM n'a jamais ete indexable). Fix, une ligne (`src/parser/tree-sitter.ts:193`, dans `astroHasNoFrontmatterFence`) : `source.replace(/^﻿/, '')` avant le `split('\n')`, restauration de comportement, pas amelioration. Rendre le BOM INDEXABLE (strip aussi dans `extractAstroFrontmatter`) est deliberement hors carte, suivi par `029e11ac`.

Pin par `tests/astro-no-frontmatter.test.js` (fixture `ASTRO_BOM_WITH_VALID_FRONTMATTER`) : `errors.length === 1`, contient `'Bom.astro'` et le message generique, `filesEmpty` reste `0`. Prouve par mutation cible (retirer `.replace(/^﻿/, '')` seul, distinct de la mutation sur-elargie ci-dessus -- pour toute entree SANS BOM, `.replace(/^﻿/, '')` est l'identite octet pour octet, donc cette mutation ne peut changer le verdict que sur l'entree qui porte un BOM) : sur `tests/astro-no-frontmatter.test.js` seul, build refait et sa fraicheur verifiee AVANT lecture (`ls -l --time-style=full-iso`, build posterieur au source), **1 rouge/8, uniquement le cas BOM** -- une premiere version de cette section affirmait a tort "3 rouges/8, meme empreinte que la sur-elargie" en reappliquant le resultat de l'AUTRE mutation sans reexecuter celle-ci ; corrige apres qu'une revue a montre que l'empreinte attendue ne pouvait mathematiquement porter que sur l'entree BOM, et confirme par re-execution. Egalement pin, cote API (pas seulement texte CLI) : `result.filesEmpty === 1` sur le cas fenceless (renommage silencieux du champ rougirait desormais). Et cote CLI, le bloc `rebuild-index` (`src/index.ts:204`, precedemment non pinne) recoit son propre cas dans `tests/init-success-modes.test.js`.

**MESURE** : `node --experimental-vm-modules node_modules/jest/bin/jest.js tests/astro-no-frontmatter.test.js tests/init-success-modes.test.js` -> `Tests: 45 passed, 45 total`.
