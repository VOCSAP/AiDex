---
name: feedback-delegation-discipline
description: Lire le code du worker et pas seulement ses mesures, exiger le vrai binaire plutot qu'un simulacre, et faire contre-relire chaque correctif
metadata:
  type: feedback
---

Trois disciplines de supervision, chacune payee par un defaut reel le 2026-08-11.

1. **Lire le code livre, pas seulement les mesures rapportees.** Sur `b27f5663`, la carte prescrivait un index FTS5 persiste et le worker a livre une `Map` en memoire. L'ecart a survecu au rapport du worker et a ma lecture de ses mesures ; seule la revue l'a vu. Un rapport de mesures ne prouve pas que l'implementation est celle demandee.

2. **Exiger le vrai binaire, jamais un simulacre, pour toute preuve porteuse.** Un worker avait prouve la retention d'une file d'attente avec un faux CLI imitant le format de sortie attendu. Le vrai CLI se comportait autrement : `better-sqlite3` bloque et attend au lieu d'echouer sous verrou. La preuve refaite avec le vrai binaire a revele que le mecanisme reellement actif n'etait pas celui qu'on croyait.

3. **Contre-relire les correctifs, pas seulement le code initial.** Un correctif de BLOCKER a ete applique au bon endroit logique mais branche sur un chemin d'erreur jamais emprunte, donc du code mort. La contre-revue l'a mesure (16638 ms inchanges). Un correctif merite le meme scepticisme que le code qu'il repare.

**Why:** ces trois defauts avaient tous passe une premiere validation avec des chiffres a l'appui. Le mode de panne commun est un harnais qui mesure une forme que la production n'a jamais, ou un rapport credible qui ne decrit pas le code.

**How to apply:** apres chaque livraison non triviale, dispatcher une revue orientee vers ce que le worker n'a PAS teste, en lui interdisant de remesurer ce qui est deja chiffre. Demander a chaque worker de distinguer MESURE de DEDUIT et de SUPPOSE, ce qui a systematiquement fait remonter les vraies incertitudes. Voir [[feedback-measure-before-code]] et [[project-aidex-multi-agent-traps]].
