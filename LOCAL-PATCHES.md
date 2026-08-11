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

Regle retenue (`ruleId: strict+typepos`, version 1) : **forme identifiant** ET (separateur `: - . _ /` OU casse mixte), OU mot minuscule seul en position `literal_type` / `jsx_attribute` / valeur de `pair`.

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
