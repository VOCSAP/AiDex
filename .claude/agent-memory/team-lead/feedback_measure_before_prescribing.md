---
name: feedback-measure-before-prescribing
description: Sur AiDex, une recommandation de team-lead doit etre mesuree avant d'etre dispatchee ; invalider sa propre reco est attendu et bien recu
metadata:
  type: feedback
---

Verifier par une mesure toute recommandation avant de la transformer en dispatch, y compris et surtout quand elle vient d'un rapport de worker que l'on relaie. Annoncer l'invalidation de sa propre reco plutot que de la laisser passer.

**Why:** Ce projet a deja paye un revert complet (implementation e7a0c8d, revert 7ca37e2) pour une carte qui prescrivait une technique -- un index trigramme FTS5 -- avant d'avoir localise le probleme. La prescription avait traverse toute la chaine, spec puis implementation puis revue, sans que personne ne verifie qu'il existait un probleme mesurable. Le 2026-08-12, la meme erreur a failli se reproduire : j'ai recommande une carte "normalisation d'espace d'abord" en reprenant sans la mesurer une claim de l'explorer selon laquelle elle beneficierait a l'index existant. L'operateur avait deja dit "Go pour 2, on suit ta reco". Une requete SQL a montre 0 item contenant un blanc sur 6397, donc un no-op complet. L'operateur a accepte la correction sans friction ("Go pour A") : invalider sa propre reco ne coute rien, dispatcher une carte vide coute un developer.

**How to apply:** Avant tout dispatch d'implementation, isoler la claim porteuse de la reco et se demander si elle est MESUREE ou DEDUITE. Si elle est deduite et load-bearing, la mesurer soi-meme quand c'est une requete ou une lecture de source (cout : une minute), la renvoyer au worker qui a le contexte quand c'est plus lourd. Piege specifique rencontre : confondre le texte source indexe et les termes stockes en base. Voir [[project-aidex-literal-coverage-lot]].
