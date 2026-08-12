---
name: project-aidex-literal-coverage-lot
description: Etat du lot couverture litterale AiDex apres livraison (f08aeeb1 livree, b2d17b5d et 39e02f07 et a7039829 fermees, 10096483 ouverte)
metadata:
  type: project
---

Le lot "couverture litterale" est LIVRE. Etat au 2026-08-12, apres sept commits sur local-patches, suite a 161 verts.

- `f08aeeb1` -- litteraux multi-mots plus tolerance d'espacement. DONE.
- `b2d17b5d` -- acceleration du mode `contains`. DONE, ferme sur le constat qu'il n'y a rien a optimiser.
- `39e02f07` -- infrastructure de test. DONE.
- `a7039829` -- contrat de `init()`, trois modes via `AIDEX_INIT_SUCCESS_MODE`. DONE.
- `bfb7bf8f` -- meme trou de visibilite dans `rebuild-index`. CREEE, non traitee.
- `10096483` -- ponderation IDF multi-termes. Ouverte, non planifiee.

**Why:** Ce qui reste utile n'est pas l'etat des cartes, que la roadmap porte deja, mais les trois premisses que la mesure a REFUTEES en chemin. Le cout de reindexation de la station : juge non bloquant par l'operateur, ne pas le representer comme un obstacle. L'effet sur le hook de nudge : nul, `CANDIDATE_RE` n'admet pas l'espace donc un pattern multi-mots n'atteint jamais l'oracle. Le volume : mesure a +5,5 pourcent apres reindexation reelle, contre +29,9 pourcent annonces par une prevision obtenue en dupliquant les gardes dans un script jetable, soit un facteur 5,5 d'erreur.

**How to apply:** Ne pas rouvrir `b2d17b5d` ni aucune variante d'optimisation du matching `contains` sans plainte utilisateur reelle : le matching pese 5 a 12 pourcent du cout d'un appel et le point chaud est la jointure d'occurrences, proportionnelle au fanout. Avant de planifier `10096483`, observer l'usage reel : `f08aeeb1` sert la phrase exacte et la sous-chaine contigue, ce qui couvre deja le geste de coller un message d'erreur. La seule piste vraiment nouvelle est l'elargissement de `LITERAL_SHAPE` a la ponctuation courante (virgule, parenthese, apostrophe), et elle demande une mesure avant toute decision. Voir [[feedback-measure-before-prescribing]], [[feedback-demand-the-predicted-signature]] et [[project-aidex-team-dispatch]].
