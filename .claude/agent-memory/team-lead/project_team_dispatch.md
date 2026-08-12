---
name: project-aidex-team-dispatch
description: Ce qui marche pour dispatcher l'equipe de peers AiDex -- roles, briefs autoportants, pieges d'environnement recurrents
metadata:
  type: project
---

L'equipe AiDex tourne comme onze sessions Claude Code peers dans le groupe `desktop-7b2civn-aidex`, une par role (developer x2, explorer, reviewer, debugger, test-engineer, architect, web-designer, security-auditor, release-engineer), pilotees par un team-lead.

**Why:** Les `peer_id` sont volatils, renouveles a chaque session et perdus au redemarrage de l'application hote -- un roster ecrit en memoire adresserait le mauvais agent. Seule la structure des roles est durable. Les resoudre par `whoami` + `list_peers` au demarrage.

**How to apply:**

Ce qui marche, valide sur trois dispatchs le 2026-08-12 (ACK sous 2 minutes, rapports complets, aucun relance necessaire) :
- Ne pas recopier le briefing d'une carte roadmap dans le message. Dire au worker de faire `roadmap_get <id>` lui-meme. Les cartes de ce projet portent des `context` de 10 000 caracteres et plus, enrichis par appends successifs, ecrits pour un agent demarrant a froid.
- Ecrire explicitement ce qui est HORS perimetre, et pourquoi. Sur f08aeeb1, dire que la requete par mots non contigus resterait a 0 resultat APRES le travail a evite qu'un developer prenne le comportement attendu pour un bug.
- Nommer les pieges d'environnement dans le brief plutot que de les laisser decouvrir.
- Exiger un ACK d'une ligne avant toute tache longue, et rappeler que le rapport ne compte que par `send_message`.

Trois pieges d'environnement a recopier dans CHAQUE brief impliquant une execution :
- `--runInBand` et `--maxWorkers=1` sont INTERDITS sur la suite de tests. L'addon natif tree-sitter est charge une fois par processus alors que jest cree un contexte vm par fichier : des le deuxieme fichier d'un meme processus, le parseur rend un arbre mort et toute suite qui indexe en direct tombe. Mesure : mono-processus 66 echecs sur 138, parallele par defaut 138/138. Le compte varie d'un run a l'autre parce que jest tire l'ordre des fichiers de son cache de timings, ce qui donne l'illusion d'un defaut non deterministe dans le code. Ce piege a coute trois rapports de diagnostic dont deux avec une cause racine fausse.
- Le `node` par defaut du PATH est en v24.18.0 et casse l'ABI de `better-sqlite3` : toute la suite de tests echoue en bloc, avec une cause qui n'a rien a voir. Le binaire a utiliser est `C:/Users/Olivier/AppData/Local/nvm/v22.11.0/node.exe`.
- `agent-forge` collisionne sur son repertoire de travail partage : un agent peut recevoir le `verify` d'un autre. Demander la verification que le stdout lu est bien le sien.

Voir [[project-aidex-literal-coverage-lot]].
