---
name: project-aidex-literal-coverage-lot
description: Etat et dependances reelles du lot couverture litterale AiDex (cartes f08aeeb1, 10096483, b2d17b5d) au 2026-08-12
metadata:
  type: project
---

Le lot "couverture litterale" tient en trois cartes roadmap dont les dependances declarees etaient FAUSSES et ont ete corrigees par mesure le 2026-08-12.

- `f08aeeb1` -- lever la garde whitespace de `classifyPattern`. Perimetre elargi par arbitrage de l'operateur a la tolerance d'espacement, les deux ne pouvant pas se livrer separement. En cours.
- `10096483` -- ponderation IDF multi-termes. Le briefing d'origine posait qu'elle DEPENDAIT de f08aeeb1 ; la dependance est en realite croisee. Laissee ouverte, non planifiee.
- `b2d17b5d` -- acceleration du mode `contains`. FERMEE en `done` le 2026-08-12 sur le constat qu'il n'y a rien a optimiser.

**Why:** L'operateur a tranche deux points qui bloquaient f08aeeb1 depuis la session precedente. Le cout d'une reindexation integrale de la station est juge NON bloquant, la reindexation etant ponctuelle -- ne pas le reproposer comme obstacle. Et l'effet sur le hook de nudge est nul par mesure, le pre-filtre `CANDIDATE_RE` n'admettant pas l'espace, donc un pattern multi-mots n'atteint jamais l'oracle de couverture.

**How to apply:** Ne pas rouvrir b2d17b5d ni aucune variante d'optimisation du matching `contains` sans une plainte utilisateur reelle : le profilage montre que le matching pese 5 a 12 pour cent du cout d'un appel, le point chaud etant la jointure d'occurrences, proportionnelle au fanout. Ne pas presenter le cout de reindexation comme un obstacle a l'operateur. Si f08aeeb1 aboutit, la question suivante est l'usage reel avant de planifier 10096483, pas 10096483 par automatisme. Voir [[feedback-measure-before-prescribing]] et [[project-aidex-team-dispatch]].
