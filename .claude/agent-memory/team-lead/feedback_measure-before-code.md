---
name: feedback-measure-before-code
description: L'operateur exige qu'une mesure precede le code, et accepte explicitement qu'une mesure tue une carte de la roadmap
metadata:
  type: feedback
---

Sur ce projet, une carte dont la premisse est chiffrable doit commencer par la mesure, et l'abandon reste une issue acceptable de cette mesure.

**Why:** le 2026-08-11, deux cartes ont vu leur premisse REFUTEE avant tout developpement. La carte `10096483` supposait que les litteraux multi-mots etaient bloques a la requete ; ils sont rejetes a l'indexation (`classifyPattern` rejette tout pattern contenant un blanc). La carte `b27f5663` prescrivait un index FTS5 pour accelerer une recherche dont personne n'avait mesure la lenteur ; elle a ete implementee, mesuree 12 a 19 fois plus lente que le scan qu'elle remplacait, puis revertee. L'operateur a valide les deux arrets et a demande une carte de tracage cadree autour de la mesure prealable. Sa formule directrice : la carte prescrivait une solution avant d'avoir localise le probleme.

**How to apply:** quand une carte annonce un gain, faire produire le chiffre AVANT d'ouvrir un editeur, et dire explicitement au worker qu'un resultat qui condamne la carte est un resultat acceptable, sinon il cherchera a faire dire a la mesure que le travail vaut le coup. Consigner la mesure dans le contexte de la carte, pas seulement dans le rapport. Voir [[feedback-delegation-discipline]].
