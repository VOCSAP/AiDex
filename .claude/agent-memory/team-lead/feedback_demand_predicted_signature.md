---
name: feedback-demand-the-predicted-signature
description: Rejeter un diagnostic dont la signature d'erreur predite est absente des donnees, plutot que de l'accepter sur une correlation numerique
metadata:
  type: feedback
---

Avant d'accepter une cause racine, demander quelle signature observable elle PREDIT, puis verifier que cette signature est reellement dans les donnees. Une correlation de chiffres n'est pas une preuve de mecanisme.

**Why:** Le 2026-08-12, trois diagnostics successifs de la meme panne se sont reveles faux avant le bon, et chacun est tombe sur ce test. (1) Le team-lead a soupconne un bump de version de regle : detruit par lecture du code, le refus etait garde par une condition jamais atteinte par defaut. (2) Le debugger a conclu a un repertoire courant casse en s'appuyant sur une coincidence numerique frappante, deux runs partageant le nombre 72 : detruit parce que les signatures que sa theorie predisait, `ENOENT` et `Cannot find module`, etaient ABSENTES de la sortie, et parce que les deux executions rapprochees n'avaient meme pas le meme total de tests. (3) Le team-lead a soupconne un etat partage sur disque : detruit par une mesure d'une ligne, relancer la suite victime SEULE apres une execution contaminee la rend verte, donc rien de persistant n'etait en cause. La vraie cause etait un addon natif charge une fois par processus face a un contexte vm par fichier de test. Chaque diagnostic faux a coute un cycle de dispatch complet.

**How to apply:** A la reception d'un rapport de cause racine, poser deux questions avant d'agir : quelle trace observable ce mecanisme produit-il, et cette trace est-elle dans la sortie que je detiens ? Si le rapport s'appuie sur une correspondance de nombres, exiger la signature. Quand c'est MA propre hypothese qui est en cause, la traiter avec la meme severite : deux des trois erreurs venaient de moi. Et renvoyer le diagnostic au worker qui tient le contexte plutot que de remesurer soi-meme, en NOMMANT le fait qui le contredit, ce qui produit un rapport corrige plutot qu'une defense. Voir [[feedback-measure-before-prescribing]].
