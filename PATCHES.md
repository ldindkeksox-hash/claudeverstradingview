# Correctifs et ajouts locaux

Modifications apportées au dépôt d'origine le 17–18/09/2026.
Chaque fichier modifié a une sauvegarde `.orig` à côté de lui.

---

## Bugs corrigés

### 1. `chart_set_timeframe` ne rechargeait pas les données

**Symptôme :** l'outil renvoyait `success: true`, la barre d'outils affichait bien « 1h »,
`chart_get_state` renvoyait `resolution: "60"` — mais `data_get_ohlcv` continuait à renvoyer
les bougies de la résolution précédente. Vérifié : écart de 86 400 s entre bougies alors que
l'outil annonçait du 60.

**Conséquence :** toute analyse intraday pouvait être faite sur des données journalières,
sans le moindre signe d'erreur. `morning_brief`, qui appelle `setTimeframe` pour chaque
symbole, était touché aussi.

**Cause :** `chart.setResolution()` met à jour la propriété de résolution et l'interface,
mais la série de données ne se recharge pas toujours.

**Correctif** (`src/core/chart.js`) : la fonction mesure désormais **l'écart réel entre les
deux dernières bougies** et ne confirme que s'il correspond à la résolution demandée. Si
`setResolution` échoue, elle recharge la page via l'URL (`?symbol=…&interval=…`), puis
re-vérifie. Elle renvoie `verified: true/false` et `method: setResolution | page_reload`.
Un rechargement de page est signalé par un `warning` (la mise en page revient au défaut).

### 2. `data_get_ohlcv` pouvait renvoyer des données périmées en silence

**Correctif** (`src/core/data.js`) : chaque réponse contient maintenant un
`resolution_check` avec l'écart réel entre bougies, la résolution annoncée par le graphique,
et un `warning` explicite en cas de désaccord.

### 3. `alert_create` ne créait rien

**Symptôme :** `price_set: false`, `source: "dom_fallback"`, aucune alerte créée.

**Cause :** la fonction faisait de l'automatisation DOM à l'aveugle avec des sélecteurs
obsolètes (`[aria-label="Create Alert"]`, `[class*="alert"] input`). Et surtout, **le
paramètre `condition` n'était jamais lu** — il était seulement recopié dans la réponse,
rendant `crossing_down` impossible.

**Correctif** (`src/core/alerts.js`) : réécrit sur l'API REST que `list()` utilisait déjà.

```
POST https://pricealerts.tradingview.com/create_alert
```

Les cinq types de condition ont été vérifiés en réel contre l'API :
`crossing → cross`, `crossing_up → cross_up`, `crossing_down → cross_down`,
`greater_than → greater`, `less_than → less`.

Ajouts : paramètres `symbol`, `resolution`, `expiration_days` ; erreur explicite sur une
condition inconnue ; et un **garde-fou** qui relit l'alerte après création et signale
`fired_immediately: true` si la condition était déjà vraie (l'alerte se déclenche alors
aussitôt et s'éteint, donnant l'illusion d'une protection en place).

### 4. `alert_delete` renvoyait un faux succès

**Symptôme :** renvoyait `success: true` après avoir seulement ouvert un menu contextuel.
Rien n'était supprimé. La suppression unitaire n'existait pas.

**Correctif** (`src/core/alerts.js`) : réécrit sur
`POST https://pricealerts.tradingview.com/delete_alerts` avec
`{"payload":{"alert_ids":[…]}}`. Gère `alert_id`, `alert_ids` ou `delete_all`, et renvoie
le nombre réellement supprimé.

### 5. `tv_launch` ne trouvait pas TradingView (Windows/MSIX)

**Contexte :** la version Windows de TradingView Desktop est un paquet **MSIX**. Son bac à
sable refuse le lancement direct de l'exe (« Accès refusé ») et
`Invoke-CommandInDesktopPackage` plante en `AccessViolationException` sur PowerShell 5.1 —
impossible de lui passer `--remote-debugging-port`.

**Correctif** (`src/core/health.js`) : quand aucun binaire TradingView Desktop exploitable
n'est trouvé, `tv_launch` bascule sur **Chrome** (ou Edge) avec
`--remote-debugging-port` et un profil dédié `~/.tv-debug-profile`, sur
`tradingview.com/chart`. Ça fonctionne parce que `findChartTarget()` dans `connection.js`
sélectionne sa cible **uniquement par l'URL** : un onglet navigateur est équivalent à
l'application desktop.

### 6. `morning_brief` attribuait le prix du symbole precedent

**Symptome :** le premier symbole du brief affichait le prix du symbole affiche avant le
scan. Exemple mesure : `BINANCE:BTCUSDT | last 2439.8` alors que BTC valait 76 400 —
2 439,8 etait le prix d'ETH, qui etait sur le graphique juste avant.

**Consequence :** un brief matinal peut attribuer a un actif le prix, les indicateurs et
donc le biais d'un autre actif. C'est le type d'erreur qui ne se voit pas : le chiffre est
plausible, seulement il concerne le mauvais marche.

**Cause :** `setSymbol()` suivi d’une **attente fixe de 900 ms**, puis lecture. Un
changement de symbole prend 4 a 5 secondes.

**Correctif** (`src/core/morning.js`) : attente **active** jusqu’a ce que le graphique
confirme le symbole demande (20 s max), et verification que le timeframe a bien ete valide.
En cas d'echec, le symbole est marque en erreur et **exclu** du brief plutot que rapporte
avec de fausses valeurs. Chaque ligne porte desormais `resolved_symbol`, le symbole
reellement charge.

**Verifie apres correctif :** `BINANCE:BTCUSDT -> charge: BINANCE:BTCUSDT | last 76396.01`.
Duree du brief sur 6 symboles : environ 90 secondes.

---

## Outils ajoutés (81 → 85)

| Outil | Rôle |
|---|---|
| `trading_get_account` | Compte, equity, marge et chaque position (entrée, TP, SL, PnL) en données structurées. Calcule le **risque réel si tous les stops sautaient** et liste les positions **sans stop**. |
| `trading_check_risk` | Audit **en lecture seule** : positions non protégées, risque par trade au-dessus de la limite, **positions corrélées qui ne forment qu'un seul pari**, symboles sans alerte active. |
| `trading_close_position` | Fermeture au marché. Exige `confirm: true` et **vérifie ensuite que la position a bien disparu**. |
| `analysis_snapshot` | Snapshot multi-timeframe : close, EMA20/50/200, RSI14, ATR, plus hauts/bas 20 et 50 périodes, volume relatif. Chaque timeframe est vérifié avant lecture, et chaque moyenne porte un **drapeau de fiabilité**. |

### Pourquoi le drapeau de fiabilité

Une EMA a besoin de bien plus d'historique que sa période. Calculée sur 300 bougies,
une EMA200 est fausse : lors de cette session, la même EMA50 a donné **2 428 avec 60
bougies et 2 441 avec 220** — un écart suffisant pour inverser une décision.
`analysis_snapshot` renvoie `bars_used` et `reliable: {ema20, ema50, ema200}` pour que le
problème soit visible au lieu d'être silencieux.

---

## Ce qui n'a délibérément PAS été ajouté

**Un outil de passage d'ordre.** Le ticket d'ordre de TradingView n'expose aucun sélecteur
stable : ses champs n'ont ni `data-name` ni `id`. Le seul moyen serait de cliquer à des
coordonnées fixes en pixels. Un outil qui se tromperait de champ et validerait un ordre de
mauvaise taille est plus dangereux que pas d'outil du tout.

Pour passer un ordre : clic droit sur le graphique → *Add order* → onglet **Market** →
quantité → activer *Take profit* et *Stop loss* → vérifier le **Risk/Reward** affiché par
TradingView → *Buy* / *Sell*. Puis contrôler avec `trading_get_account`.

---

## `rules.json`

Le fichier livré avec le dépôt décrivait un « 10-Second Momentum Scalper » : 6 trades en
60 secondes, **aucun stop loss**. Mesuré sur BTC le 18/09/2026 : mouvement net moyen sur
3 minutes = 29 points, frais aller-retour à 0,2 % = 153 points. Cette stratégie perd de
l'argent **par construction**, avant même de parler de direction.

Elle a été remplacée par des règles de swing multi-timeframe, explicitement marquées comme
des défauts à relire et ajuster.

⚠️ `scalper-run.js` à la racine du dépôt passe de **vrais ordres sur Bitget**
(`POST /api/v2/spot/trade/place-order`, aucun stop loss). Il n'est branché à aucun outil MCP
et ne se lance jamais seul, mais ne pas l'exécuter avec de vraies clés API.

---

## Tests

`pass 8, fail 5` sur les tests CLI **avant et après** ces modifications — les 5 échecs
préexistent dans le dépôt (vérifié en remettant le code d'origine avec `git stash`).
Les 24 tests Pine passent.

---

## Seconde passe : defauts trouves en relisant les correctifs eux-memes

Les correctifs ci-dessus ont ete soumis a une relecture adversariale. Elle a ete
interrompue avant la fin, mais ce qui a abouti a revele six defauts dans le code
de correction lui-meme. Tous verifies en lisant le code, tous corriges.

### A. RSI et ATR ne correspondaient pas a TradingView

`analysis.js` calculait RSI et ATR par **moyenne simple sur 14 barres**, alors que
TradingView applique le **lissage de Wilder (RMA)**. Les valeurs rendues ne
correspondaient donc pas a celles affichees a l ecran.

Mesure sur BTCUSDT 1H, contre l indicateur natif de TradingView :

```
TradingView        RSI 76.68   ATR 361.98
apres correctif    RSI 76.16   ATR 361.98   <- ATR identique
avant correctif    RSI 85.04   ATR 322.21   <- RSI faux de 8,4 points
```

Sur le daily le meme jour : RSI correct 56.9 contre 43.9 par l ancienne methode,
soit **13 points d ecart** - de quoi lire un marche comme survendu alors qu il est
neutre. Les 0,5 point residuels viennent du prechauffage : TradingView dispose de
plus d historique que les 300 barres chargees.

Corrige aussi : un RSI de 100 (surachat maximal) etait renvoye quand les 14
dernieres cloturs etaient identiques ; un marche parfaitement plat vaut 50.

### B. Faux avertissement STALE DATA a chaque week-end

`resolutionCheck` (data.js) et `barSpacing` (chart.js) mesuraient l ecart sur les
**deux dernieres barres uniquement** - or c est precisement l ecart qui traverse un
week-end, une coupure de seance ou un jour ferie.

Consequence sur data.js : avertissement STALE DATA sur des donnees parfaitement
fraiches, chaque lundi. Un avertissement qui crie au loup sera ignore, et le vrai
cas de barres perimees passerait alors inapercu.

Consequence sur chart.js, plus grave : `setTimeframe` n aurait jamais valide un
lundi, aurait declenche un **rechargement destructeur** de la page (perte des
indicateurs et de la mise en page), puis renvoye `success: false` sur des donnees
pourtant correctes.

Les deux utilisent desormais la **mediane et le plus petit ecart** sur toute la
serie. Une coupure de seance ne peut qu agrandir un ecart, jamais le reduire :
mediane et minimum y survivent. Une mauvaise resolution, elle, decale tous les
ecarts a la fois et reste donc detectee.

### C. resolutionSeconds ne reconnaissait ni les secondes ni les multi-jours

`30S`, `2D`, `3W` renvoyaient `null`, ce qui les faisait basculer dans la branche
« mensuel, non verifiable » : `success: true` sans aucun controle. La chaine vide
renvoyait meme 60 (une minute). Desormais toutes ces formes sont reconnues, et
« impossible a verifier » est distingue de « verifie faux » par un champ `reason`.

### D. Un risque negatif reduisait le risque total du portefeuille

`trading.js` deduisait le sens de la position du libelle `Short`. Avec un libelle
`Sell`, le calcul s inversait et renvoyait un risque **negatif** - qui venait alors
**diminuer** le risque total, faisant paraitre le compte plus sur qu il ne l est.

Le sens est desormais detecte sur `long|buy` et `short|sell`, un libelle inconnu
retombe sur la distance absolue, et un stop place au-dela de l entree du bon cote
est rapporte comme un risque nul avec une note, jamais comme un risque negatif.

### E. num() transformait une cellule vide en 0

Une cellule vide ou un tiret donnait `0` au lieu de `null` : un stop loss absent
se lisait comme un stop au prix zero. La virgule decimale francaise provoquait en
plus une erreur de facteur 100 (`1 234,56` devenait `123456`). Corrige : `null`
sans chiffre, et le separateur decimal est deduit de sa position.

### F. Correspondances de symbole trop laxistes

`closePosition` cherchait le symbole par **sous-chaine sur toutes les tables de la
page** : demander `BTCUSD` pouvait cliquer la ligne `BINANCE:BTCUSDT`, donc fermer
un autre instrument. Il compare desormais le symbole **resolu** exactement, et ne
considere que les lignes portant reellement un bouton de fermeture.

Meme defaut dans la garde de `morning.js` et dans `snapshot()` : `indexOf` acceptait
`BTCUSD` alors que le graphique affichait encore `BTCUSDT`. Les deux comparent
maintenant le segment du ticker a l identique. `snapshot()` ne lisait meme pas le
resultat de `setSymbol` : il renvoie desormais une erreur plutot que les indicateurs
du symbole precedent.

### Limite de cette relecture

La relecture adversariale a ete coupee par une limite d usage : 92 agents lances,
10 aboutis, 82 en echec. Un seul defaut a ete confirme par le vote des trois
sceptiques (le faux STALE DATA) ; les autres ont ete verifies a la main, en lisant
le code et en reproduisant chaque cas. **Les modules `alerts.js`, `health.js` et le
cablage des schemas n ont pas ete relus en entier.**

---

## Troisieme passe : relecture des 5 modules professionnels

Les 5 modules ont ete soumis a 15 relecteurs (3 angles chacun : exactitude des
formules, donnees absentes, honnetete de l interpretation). **22 defauts graves
reproduits par execution.** La contre-expertise a ete tuee par une limite d usage,
mais un defaut reproduit avec sa commande et sa sortie reelle n a pas besoin de vote.

### positioning : trois verdicts inverses

- **Ratio OI/volume** : encours du PERPETUEL divise par le volume du SPOT. Mesure :
  BTC traite 17,4 Md sur le perpetuel contre 1,87 Md sur le spot, soit 9,3x. Le ratio
  etait gonfle d autant et les contrats les plus liquides du marche ressortaient en
  « livre encombre, une purge se propage vite ». Corrige : perpetuel contre perpetuel ;
  si l appel echoue, ratio null avec sa raison plutot qu un repli sur le spot.
- **Taux de repos du funding** : 0,01 % par intervalle de 8 h EST 10,95 %/an. La constante
  etait remise a l echelle de l intervalle du contrat, posant un zero pratique a 21,90 %/an
  sur un contrat 4 h — soit 417 des 528 paires USDT. Tout contrat 4 h au repos etait note
  baissier. Verifie apres correctif : KAVA (4 h, 0,005 %) et LINK (8 h, 0,01 %) donnent
  tous deux 10,95 % annualise, axe funding a 0.
- **Fenetres desalignees** : la variation de prix courait jusqu a maintenant pendant que
  l open interest s arretait au dernier bucket clos, le tout publie comme 24 h. Le quadrant
  qui distingue argent frais et rachat de shorts pouvait s inverser. Les deux jambes
  finissent desormais au meme instant ; la sortie porte fenetre_utc et retard_h.

### strength : une regression fallacieuse

Le test de significativite de tendance testait la pente OLS de log(ratio) avec une
erreur-type i.i.d. Or log(ratio) est lui-meme une marche aleatoire : ses residus sont
quasi racine unitaire et l erreur-type s effondre. C est le cas d ecole de Granger-Newbold.

```
3 000 marches aleatoires sans derive, fenetre 30
ANCIEN  (t OLS du niveau log)        77,3 % de faux positifs
NOUVEAU (t de derive des rendements)  4,8 % de faux positifs
cible theorique d un test a 5 %        ~5 %
```

Les differences premieres du niveau SONT les rendements logarithmiques, proches de i.i.d. :
la derive est desormais testee sur elles. L ancienne statistique reste publiee sous
t_stat_ols_niveau pour que le changement soit visible.

Corriges aussi : une phrase d interpretation qui comparait une performance sur 298 bougies
a un mouvement sur 30 en les soudant sans citer d horizon (un retardataire qui rebondit
30 bougies etait annonce « leadership » alors que son ratio avait perdu 36 %), et
actifs_independants_effectifs qui divergeait a 4,5e15 paris independants pour 2 actifs.

### orderbook : des absences affirmees sans mesure

findWalls renvoie stats:null et une raison quand la zone contient trop peu de niveaux.
Rien en aval ne la lisait : la synthese ET la section fiabilite imprimaient « Aucun mur :
la liquidite est repartie » la ou rien n avait ete compare. Sur QUICKUSDT (18 niveaux
a l achat, 15 a la vente) la sortie dit maintenant « Murs non evaluables », avec la raison.

Six autres corriges : un mur absent de la SECONDE lecture etait compte comme retire avec
accusation de spoofing alors que la seconde lecture a sa propre profondeur ; le mur mis en
avant par la synthese n etait jamais celui verifie en persistance ; une bande plus etroite
que le spread renvoyait mesurable:true avec 0/0 ; depend_d_un_seul_ordre prenait le max des
deux cotes sans nommer lequel ; les seuils du verdict n etaient publies nulle part ;
fois_la_mediane_du_cote etait calcule sur la mediane de la zone.

### regime et levels : non relus par un tiers, testes directement

Les relecteurs sont morts avant de les examiner. Tests menes a la main : symbole inexistant
et intervalle invalide renvoient success:false avec leur raison ; un panier partiel declare
`evalues: 2 / sur_demandes: 3` et nomme l echec ; les percentiles sont bornes et les seuils
publies. volatilityRegime exclut la bougie en cours en disant pourquoi (« son amplitude est
tronquee et ferait passer le regime pour une compression ») ; keyLevels refuse 3 bougies,
en prend 30 et le declare.

Verifications de formules independantes : VWAP recalcule a la main sur 200 bougies 4h =
11.4982 contre 11.4982 pour le module ; ATR Wilder sur 999 bougies closes = 0.677645 contre
0.677645, ecart 1.8e-7.

**Ce n est pas un quitus.** Ces deux modules n ont recu ni relecture adverse ni verification
exhaustive de leurs formules. Zero defaut connu n est pas zero defaut.
