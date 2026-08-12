---
name: project-aidex-hooks-topology
description: Ou vivent les hooks de ce fork, qui les installe, et les deux faits d'environnement qui surprennent
metadata:
  type: project
---

Le fork versionne ses hooks dans le depot mais l'installation reste MANUELLE et appartient a l'operateur, qui l'a explicitement gardee pour la fin de session.

- Sources versionnees : `hooks/claude/` pour les hooks Claude Code, `hooks/git/` pour les hooks git. Un modele d'installation existe dans `hooks/claude/settings.json.template` et son markdown adjacent.
- L'operateur pose lui-meme le `settings.json` global et le contenu de son repertoire de hooks git global. Ne jamais ecrire dans son `~/.claude/` ni dans sa configuration git : le lire pour verifier une convention est admis, l'ecrire non.
- Sa configuration git est versionnee dans un depot separe, `~/.claude/claude-config/git-config`, dont plusieurs entrees du profil sont des symlinks. Editer la cible reelle, pas le lien.

**Why:** deux faits d'environnement rendent l'installation contre-intuitive. D'une part `core.hooksPath` est pose en GLOBAL, ce qui fait IGNORER le `.git/hooks` local de tous les depots de la machine : un hook pose la ne se declenche jamais, et un hook pose dans le repertoire global se declenche sur TOUS les depots, d'ou l'obligation d'auto-limitation. D'autre part la copie EXECUTEE des hooks Claude Code vit dans le profil utilisateur et non dans le depot, donc deplacer une source versionnee ne casse rien mais ne met rien a jour non plus, sans aucune synchronisation automatique entre les deux.

**How to apply:** quand un travail touche aux hooks, produire la source versionnee et le mode d'emploi, puis s'arreter et rendre la main. Verifier qu'aucune reference interne au depot ne porte le chemin d'un hook en dur avant de le deplacer. Voir [[project-aidex-multi-agent-traps]].
