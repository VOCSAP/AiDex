---
name: project-aidex-multi-agent-traps
description: Pieges de coordination rencontres en faisant travailler cinq workers en parallele sur ce depot, avec leurs contournements
metadata:
  type: project
---

Quatre pieges mesures le 2026-08-11 en pilotant cinq workers simultanes sur ce depot.

- **Les peer_ids sont volatils.** Ils sont renouveles a chaque session et tout le roster disparait quand l'application hote redemarre, ce qui est arrive en pleine session. Resoudre `whoami` et `list_peers` au DEBUT de chaque session, et ne jamais ecrire un roster en memoire. Quand les peers disparaissent, basculer sur des sous-agents.
- **agent-forge collisionne sur son repertoire de travail partage.** Deux agents lancant `verify` en parallele peuvent recevoir le resultat de l'autre. Panne silencieuse : un correctif valide par la preuve d'un tiers. Imposer un scratch dedie par worker.
- **Le node par defaut du PATH est en v24 et casse l'ABI de better-sqlite3.** Toute la suite de tests echoue en bloc pour une raison sans rapport avec le code teste. Donner le chemin du binaire epingle a CHAQUE worker des son briefing, pas apres son premier echec.
- **Le partage par sous-repertoire fonctionne bien.** Deux workers dans `hooks/git/` et `hooks/claude/`, un troisieme dans `src/`, un quatrieme dans `tests/`, sans conflit. Le seul incident a ete un build transitoirement casse par un worker, resolu de lui-meme.

**Why:** ces pieges produisent tous des faux verts plutot que des erreurs franches, donc ils ne se signalent pas.

**How to apply:** decouper les lots par sous-repertoire disjoint et l'annoncer a chaque worker (qui travaille ou), donner les pieges d'environnement dans le briefing initial, et traiter le silence d'un worker comme un etat qu'on interroge plutot qu'un evenement qui arrivera. Voir [[feedback-delegation-discipline]].
