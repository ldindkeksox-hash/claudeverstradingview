/**
 * Gold specifics: order blocks, multi-target planning, and the pip conversion
 * that makes half the discussion around this metal unintelligible.
 *
 * The method people describe as "sell zone OB M5" comes from Smart Money
 * Concepts. Its claim is testable: price is said to return to the last opposing
 * candle before an impulsive move, and to react there. This module finds those
 * zones and then MEASURES the claim on history, because the concept is asserted
 * far more often than it is checked. If order blocks do not hold on gold, that
 * is the useful answer.
 *
 * On multi-target exits the arithmetic is settled and worth stating plainly:
 * scaling out of a winner LOWERS expectancy in any positive-expectancy system —
 * the best trades are the ones cut short. What it buys is lower variance and an
 * earlier risk-free position. That is a real trade-off, not a free lunch, and
 * planTrade prints both sides of it instead of selling the idea.
 */
import { fetchBars, toCandles } from './bars.js';

const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * Gold pip conventions, which genuinely disagree with each other.
 * XAUUSD is quoted to two decimals; brokers and traders then divide it up
 * differently, so "50 pips" can mean $5 or $0.50 depending on who is speaking.
 */
export const PIP_OR = {
  standard: 0.10,   // most MT4/MT5 brokers: 4330.00 -> 4331.00 = 10 pips
  point: 0.01,      // the smallest quoted increment; same move = 100 "points"
  dollar: 1.00,     // common in speech: "gold moved 30 pips" meaning $30
};

export function pips({ montant_usd, pips: nbPips, convention = 'standard' }) {
  const taille = PIP_OR[convention] || PIP_OR.standard;
  const out = { convention, un_pip_vaut_usd: taille };
  if (montant_usd != null) {
    out.montant_usd = montant_usd;
    out.en_pips = { standard: r(montant_usd / PIP_OR.standard, 1), point: r(montant_usd / PIP_OR.point, 1), dollar: r(montant_usd / PIP_OR.dollar, 1) };
  }
  if (nbPips != null) {
    out.pips = nbPips;
    out.en_usd = { standard: r(nbPips * PIP_OR.standard), point: r(nbPips * PIP_OR.point), dollar: r(nbPips * PIP_OR.dollar) };
  }
  out.avertissement = 'Les trois conventions circulent en meme temps sur l or. Avant de recopier le "SL 300 pips" de quelqu un, '
    + 'verifier laquelle il emploie: 300 pips valent 30 $, 3 $ ou 300 $ selon le cas, soit un rapport de 1 a 100.';
  return out;
}

function atrSeries(c, period = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length < period + 1) return out;
  const tr = [0];
  for (let i = 1; i < c.length; i++) {
    const p = c[i - 1].close;
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - p), Math.abs(c[i].low - p)));
  }
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < c.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

/**
 * Order blocks, detected then tested.
 *
 * Bearish (a "sell zone"): the last UP candle before price falls by at least
 * `impulsion_atr` ATR within `impulsion_bougies` bars. Bullish is the mirror.
 * The zone is the candle body by default — the wick version is wider and
 * therefore easier to "hit", which flatters the statistics.
 */
export async function orderBlocks({
  symbol = 'OANDA:XAUUSD', interval = '5m', periods = 2000,
  impulsion_atr = 2, impulsion_bougies = 5, zone = 'corps', reaction_atr = 1, max_blocs = 12,
  spread = 0.25,
} = {}) {
  const bars = await fetchBars({ symbol, interval, limit: periods, prefer: 'profondeur' });
  if (!bars.ok) return { success: false, symbol, interval, error: bars.error, yahoo: bars.yahoo, graphique: bars.graphique };
  const c = toCandles(bars);
  if (c.length < 100) return { success: false, symbol, error: 'seulement ' + c.length + ' bougies.' };

  // When the depth source is a proxy, its PRICES are not the traded
  // instrument's: gold futures sit ~35 points above spot, which is seven M5
  // ATRs. Warning about it is not enough — a zone is a price you put an order
  // on, so it has to be converted or it is actively dangerous. Read the real
  // instrument's last price and carry a conversion factor.
  let facteurSpot = null, prixReel = null;
  if (bars.prix_equivalents === false) {
    const reel = await fetchBars({ symbol, interval: '1h', limit: 60, source: 'chart' });
    if (reel.ok && reel.n > 0) {
      prixReel = reel.c[reel.n - 1];
      const proxy = c[c.length - 1].close;
      if (proxy > 0 && prixReel > 0) facteurSpot = prixReel / proxy;
    }
  }
  const versReel = (p) => (facteurSpot == null || p == null ? null : Math.round(p * facteurSpot * 100) / 100);

  const atr = atrSeries(c);
  const px = c[c.length - 1].close;
  const blocs = [];

  for (let i = 15; i < c.length - impulsion_bougies - 1; i++) {
    const a = atr[i];
    if (!(a > 0)) continue;
    const haussiere = c[i].close > c[i].open;
    const baissiere = c[i].close < c[i].open;
    if (!haussiere && !baissiere) continue;

    // Impulse measured from the candle's close over the following bars.
    let bas = Infinity, haut = -Infinity;
    for (let k = i + 1; k <= i + impulsion_bougies; k++) { if (c[k].low < bas) bas = c[k].low; if (c[k].high > haut) haut = c[k].high; }
    const chute = (c[i].close - bas) / a;
    const hausse = (haut - c[i].close) / a;

    let sens = null;
    if (haussiere && chute >= impulsion_atr) sens = 'vente';   // last up candle before a drop
    else if (baissiere && hausse >= impulsion_atr) sens = 'achat';
    if (!sens) continue;

    const hi = zone === 'meche' ? c[i].high : Math.max(c[i].open, c[i].close);
    const lo = zone === 'meche' ? c[i].low : Math.min(c[i].open, c[i].close);
    if (!(hi > lo)) continue;

    // Mitigation: the first return into the zone, then the only test that
    // matters — would a trader taking this zone have been paid?
    //
    // An earlier version asked whether price "moved away without ever closing
    // beyond the zone within 20 bars". That is unfair: a zone can produce a
    // clean run to target and break two hours later, and a trader who took it
    // was paid regardless. So the check is now an actual trade: enter at the
    // zone edge, stop beyond the far side, target `reaction_atr` ATR, and ask
    // which came first. Ties inside one bar go to the stop, as everywhere else
    // in this codebase.
    let visiteIdx = null, reaction = null, excursion = null;
    for (let k = i + impulsion_bougies + 1; k < c.length; k++) {
      if (c[k].low <= hi && c[k].high >= lo) {
        visiteIdx = k;
        const vente = sens === 'vente';
        // Fill at the PROXIMAL edge — the side price actually reaches first.
        // A sell zone sits above price and is entered from below, so the first
        // price touched is `lo`, not `hi`. Filling at `hi` handed the test a
        // free head start worth the whole thickness of the zone and produced
        // 70% win rates where a random walk gives 33%.
        const entree = vente ? lo : hi;
        const stopPx = vente ? hi + a * 0.5 : lo - a * 0.5;   // beyond the far side, half an ATR of room
        const cible = vente ? entree - a * reaction_atr : entree + a * reaction_atr;
        const fin = Math.min(c.length - 1, k + 40);
        let best = 0;
        reaction = false;
        var sortieIdx = fin;
        for (let j = k; j <= fin; j++) {
          const mv = vente ? entree - c[j].low : c[j].high - entree;
          if (mv > best) best = mv;
          const touchStop = vente ? c[j].high >= stopPx : c[j].low <= stopPx;
          const touchCible = vente ? c[j].low <= cible : c[j].high >= cible;
          if (touchStop) { reaction = false; sortieIdx = j; break; }
          if (touchCible) { reaction = true; sortieIdx = j; break; }
        }
        excursion = best;
        var dureeBougies = sortieIdx - k;
        // The stop must clear the whole zone plus the buffer, so the real
        // reward:risk of this setup is NOT reaction_atr — it is that divided by
        // the zone thickness. A win rate without its R says nothing about money.
        var risqueTest = Math.abs(stopPx - entree) / a;
        var risquePrix = Math.abs(stopPx - entree);
        var Rtest = risqueTest > 0 ? reaction_atr / risqueTest : null;
        break;
      }
    }

    blocs.push({
      sens, type_zone: sens === 'vente' ? 'zone de vente (OB baissier)' : 'zone d achat (OB haussier)',
      haut: r(hi), bas: r(lo), milieu: r((hi + lo) / 2),
      // The only prices an order may be placed at when the source is a proxy.
      haut_reel: versReel(hi), bas_reel: versReel(lo), milieu_reel: versReel((hi + lo) / 2),
      // Proximal edge: the side price reaches first, hence where a limit fills.
      entree_reelle: versReel(sens === 'vente' ? lo : hi),
      epaisseur: r(hi - lo), epaisseur_atr: r((hi - lo) / a, 2),
      impulsion_atr: r(sens === 'vente' ? chute : hausse, 1),
      bougies_avant: c.length - 1 - i,
      distance_pct: r(((hi + lo) / 2 - px) / px * 100),
      teste: visiteIdx != null,
      bougies_avant_test: visiteIdx == null ? null : c.length - 1 - visiteIdx,
      a_reagi: visiteIdx == null ? null : reaction,
      risque_atr: visiteIdx == null ? null : r(risqueTest, 2),
      risque_prix: visiteIdx == null ? null : r(risquePrix, 3),
      R_du_test: visiteIdx == null ? null : r(Rtest, 2),
      duree_bougies: visiteIdx == null ? null : dureeBougies,
      _entree_idx: visiteIdx, _sortie_idx: visiteIdx == null ? null : sortieIdx,
      excursion_apres_test: visiteIdx == null ? null : r(excursion),
      excursion_atr: visiteIdx == null ? null : r(excursion / a, 2),
      intact: visiteIdx == null,
    });
  }

  const testes = blocs.filter(b => b.teste);
  const reussis = testes.filter(b => b.a_reagi);
  const n = testes.length;
  const taux = n ? reussis.length / n : null;
  // Binomial z against a coin: an order block that "works" 55% of the time on
  // 20 samples has not been shown to work at all.
  const z = n >= 20 ? (reussis.length - n / 2) / Math.sqrt(n / 4) : null;

  // A win rate is not a verdict. The stop has to clear the zone, so the real
  // reward:risk is often well under 1 — and at R = 0.7 a 55% win rate loses
  // money. Breakeven is 1/(1+R).
  const Rs = testes.map(b => b.R_du_test).filter(x => x != null && x > 0);
  const Rmoy = Rs.length ? Rs.reduce((s, x) => s + x, 0) / Rs.length : null;
  const seuil = Rmoy != null ? 1 / (1 + Rmoy) : null;
  const esperance = Rmoy != null && taux != null ? taux * Rmoy - (1 - taux) : null;

  // Expectancy PER TRADE is only half the answer. A setup earning less per trade
  // but firing four times as often can return more per week, which is exactly
  // why scalpers work on M5 rather than the hourly. So: how long is a trade
  // held, how often does it appear, and what does that add up to over a week.
  const secParBougie = c.length > 1 ? (c[c.length - 1].time - c[0].time) / (c.length - 1) : null;
  const durees = testes.map(b => b.duree_bougies).filter(x => x != null);
  const dureeMoy = durees.length ? durees.reduce((s, x) => s + x, 0) / durees.length : null;
  const dureeGagnants = reussis.map(b => b.duree_bougies).filter(x => x != null);
  const dureePerdants = testes.filter(b => !b.a_reagi).map(b => b.duree_bougies).filter(x => x != null);
  const moyOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const spanJours = secParBougie ? (c[c.length - 1].time - c[0].time) / 86400 : null;
  const tradesParSemaine = spanJours > 0 ? n / spanJours * 7 : null;

  // Costs decide everything at this frequency, and leaving them out is how a
  // scalping backtest produces 36 R a week. The stop distance IS the risk unit,
  // so one round-trip spread costs spread/risk in R — on a 5-minute setup whose
  // stop is a couple of points wide, that is a fifth of the edge or more.
  const risquesPrix = testes.map(b => b.risque_prix).filter(x => x != null && x > 0);
  const risqueMoyPrix = risquesPrix.length ? risquesPrix.reduce((s, x) => s + x, 0) / risquesPrix.length : null;
  const coutR = risqueMoyPrix > 0 ? spread / risqueMoyPrix : null;
  const espNette = esperance != null && coutR != null ? esperance - coutR : esperance;
  const espBruteParSemaine = esperance != null && tradesParSemaine != null ? esperance * tradesParSemaine : null;

  // Overlap. Several zones forming inside one impulse are all hit by the same
  // pullback: that is ONE trade for a person holding one position, not five.
  // Counting them separately inflates the sample (so z-scores look significant
  // on data that is not independent) and multiplies a weekly return nobody
  // could take. The sequential subset is what one position at a time gives.
  const chrono = testes.filter(b => b._entree_idx != null).sort((a, b) => a._entree_idx - b._entree_idx);
  const sequentiels = [];
  let libreA = -1;
  for (const b of chrono) {
    if (b._entree_idx > libreA) { sequentiels.push(b); libreA = b._sortie_idx; }
  }
  const nSeq = sequentiels.length;
  const gagnesSeq = sequentiels.filter(b => b.a_reagi).length;
  const tauxSeq = nSeq ? gagnesSeq / nSeq : null;
  const RsSeq = sequentiels.map(b => b.R_du_test).filter(x => x != null && x > 0);
  const RmoySeq = RsSeq.length ? RsSeq.reduce((s, x) => s + x, 0) / RsSeq.length : null;
  const espSeqBrute = RmoySeq != null && tauxSeq != null ? tauxSeq * RmoySeq - (1 - tauxSeq) : null;
  const espSeqNette = espSeqBrute != null && coutR != null ? espSeqBrute - coutR : espSeqBrute;
  const tradesSeqParSemaine = spanJours > 0 ? nSeq / spanJours * 7 : null;
  const espParSemaine = espSeqNette != null && tradesSeqParSemaine != null ? espSeqNette * tradesSeqParSemaine : null;
  const zSeq = nSeq >= 20 ? (gagnesSeq - nSeq / 2) / Math.sqrt(nSeq / 4) : null;

  const intacts = blocs.filter(b => b.intact).sort((a, b) => Math.abs(a.distance_pct) - Math.abs(b.distance_pct));

  return {
    success: true,
    symbol, interval: bars.interval, source: bars.source + (bars.symbole_source ? ' (' + bars.symbole_source + ')' : ''),
    prix_equivalents: bars.prix_equivalents,
    equivalence_note: bars.equivalence_note,
    bougies: c.length,
    prix_actuel: r(px),
    conversion_prix: facteurSpot == null
      ? (bars.prix_equivalents === false
        ? { disponible: false, danger: 'La source est un proxy et le prix reel n a PAS pu etre lu: les zones ci-dessous sont en prix ' + (bars.symbole_source || 'proxy') + '. NE PAS y placer d ordre sans les convertir soi-meme.' }
        : undefined)
      : {
        prix_proxy: r(px), prix_reel: r(prixReel), symbole_proxy: bars.symbole_source,
        facteur: Math.round(facteurSpot * 1e6) / 1e6,
        ecart_points: r(prixReel - px), ecart_pct: r((prixReel - px) / px * 100, 3),
        note: 'Les champs *_reel et entree_reelle sont deja convertis: ce sont les SEULS a utiliser pour passer un ordre. '
          + 'Les champs haut/bas/milieu restent en prix ' + bars.symbole_source + ', soit ' + r(prixReel - px) + ' points d ecart.',
      },
    parametres: { impulsion_atr, impulsion_bougies, zone, reaction_atr,
      definition: 'Zone de vente = derniere bougie HAUSSIERE avant une chute d au moins ' + impulsion_atr + ' ATR en ' + impulsion_bougies + ' bougies. '
        + 'Reaction comptee si le prix s eloigne d au moins ' + reaction_atr + ' ATR SANS traverser la zone.' },
    blocs_detectes: blocs.length,
    validation: {
      blocs_testes: n,
      ont_reagi: reussis.length,
      taux_reaction_pct: taux == null ? null : r(taux * 100, 1),
      z: r(z, 2),
      significatif: z != null && Math.abs(z) >= 2,
      R_moyen_du_setup: r(Rmoy, 2),
      seuil_rentabilite_pct: seuil == null ? null : r(seuil * 100, 1),
      esperance_R_par_trade: r(esperance, 3),
      rentable: esperance != null ? esperance > 0 : null,
      frais: {
        spread_utilise: spread,
        risque_moyen_en_points: r(risqueMoyPrix, 2),
        cout_aller_retour_R: r(coutR, 3),
        esperance_brute_R: r(esperance, 3),
        esperance_nette_R: r(espNette, 3),
        survit_aux_frais: espNette != null ? espNette > 0 : null,
        note: 'Le spread est paye a chaque aller-retour et se compare au RISQUE du trade, pas au prix. '
          + 'Sur un stop de ' + r(risqueMoyPrix, 2) + ' points, un spread de ' + spread + ' coute ' + r(coutR * 100, 1) + '% du risque, '
          + 'a chaque trade. C est ce qui tue la plupart des strategies a haute frequence, et c est invisible tant qu on ne le chiffre pas.',
      },
      sequentiel: {
        trades_si_une_position_a_la_fois: nSeq,
        sur_signaux_bruts: n,
        part_retenue_pct: n ? r(nSeq / n * 100, 1) : null,
        taux_reussite_pct: tauxSeq == null ? null : r(tauxSeq * 100, 1),
        R_moyen: r(RmoySeq, 2),
        z: r(zSeq, 2),
        significatif: zSeq != null && Math.abs(zSeq) >= 2,
        esperance_R_par_trade: r(espSeqNette, 3),
        trades_par_semaine: r(tradesSeqParSemaine, 1),
        note: 'Seuls ces trades-la sont prenables par quelqu un qui detient UNE position a la fois. '
          + 'Les ' + (n - nSeq) + ' autres chevauchent un trade deja ouvert: les compter separement gonfle '
          + 'l echantillon (donc le z) et promet un rendement hebdomadaire que personne ne peut prendre.',
      },
      cadence: {
        fenetre_jours: r(spanJours, 1),
        trades_par_semaine_bruts: r(tradesParSemaine, 1),
        esperance_R_par_semaine_brute_signaux: r(espBruteParSemaine, 2),
        esperance_R_par_semaine: r(espParSemaine, 2),
        base: 'esperance_R_par_semaine est calculee sur les trades SEQUENTIELS nets de frais — le seul chiffre reellement atteignable.',
        duree_moyenne_bougies: r(dureeMoy, 1),
        duree_moyenne_minutes: secParBougie && dureeMoy != null ? r(dureeMoy * secParBougie / 60, 1) : null,
        duree_gagnants_minutes: secParBougie && moyOf(dureeGagnants) != null ? r(moyOf(dureeGagnants) * secParBougie / 60, 1) : null,
        duree_perdants_minutes: secParBougie && moyOf(dureePerdants) != null ? r(moyOf(dureePerdants) * secParBougie / 60, 1) : null,
        note: 'L esperance par SEMAINE est le chiffre qui compte pour comparer deux unites de temps. '
          + 'Une unite courte qui gagne moins par trade peut rapporter davantage si elle se declenche bien plus souvent — '
          + 'c est la raison d etre du scalping, et c est invisible quand on ne regarde que l esperance par trade.',
      },
      verdict: n < 20
        ? 'Seulement ' + n + ' blocs testes: pas assez pour juger. Allonger la fenetre avant de conclure.'
        : [
          'Taux de reaction ' + r(taux * 100, 1) + '% sur ' + n + ' zones (z = ' + r(z, 2) + ', '
            + (Math.abs(z) >= 2 ? 'distinguable du hasard' : 'NON distinguable du hasard') + ').',
          'Mais le stop doit couvrir toute la zone: rapport gain/risque reel ' + r(Rmoy, 2)
            + ', il faut donc ' + r(seuil * 100, 1) + '% de reussite pour etre a l equilibre.',
          esperance > 0
            ? 'RENTABLE sur cette fenetre: esperance ' + r(esperance, 3) + ' R par trade.'
            : 'PERDANT sur cette fenetre: esperance ' + r(esperance, 3) + ' R par trade. Le taux de reussite est flatteur, le rapport gain/risque le mange.',
        ].join(' '),
    },
    realisme: {
      avertissement: 'Le SENS de ce resultat est plus solide que son AMPLITUDE. Un R par semaine a deux chiffres ne se reproduira pas en reel.',
      ce_qui_reste_optimiste: [
        'Execution parfaite: fill a la limite au bord de zone a chaque fois, sans fill partiel ni zone sautee.',
        'Aucun glissement sur les stops. L or decroche sur les chiffres macro, et un stop de ' + r(risqueMoyPrix, 1) + ' points s y franchit sans s arreter.',
        'Seul le spread est facture. Une commission au lot (souvent 5 a 7 $ l aller-retour) s ajouterait a chaque trade.',
        'Presence humaine totale: ' + r((tradesSeqParSemaine || 0) / 5, 0) + ' trades par jour ouvre a saisir sans en manquer un.',
        'Une seule fenetre de ' + r(spanJours, 0) + ' jours, donc un seul regime de marche.',
        'Les parametres de zone ont ete choisis apres avoir vu les donnees. Le biais de selection gonfle toujours le resultat retenu.',
      ],
      a_faire_avant_d_y_croire: 'Reverifier sur une autre periode et un autre actif, puis en demo avec les frais reels du courtier.',
    },
    zones_intactes: intacts.slice(0, max_blocs),
    zone_la_plus_proche: intacts[0] || null,
    avertissement: 'Un order block est une hypothese sur le comportement du prix, pas un fait. Le taux de reaction ci-dessus est ce qui a ete '
      + 'observe sur cette fenetre et cet actif; il ne se transporte ni a une autre periode ni a un autre instrument sans etre reverifie.',
  };
}

/**
 * Multi-target trade plan: what several take-profits actually do to a trade.
 */
export function planTrade({
  entree, stop, sens = 'long', objectifs, parts, capital_risque_usd,
  taux_reussite_estime = 0.5, prix_du_point = 1, convention_pips = 'standard',
} = {}) {
  if (!(entree > 0) || !(stop > 0)) return { success: false, error: 'entree et stop sont requis et doivent etre positifs.' };
  const long = sens === 'long';
  const risqueUnit = long ? entree - stop : stop - entree;
  if (!(risqueUnit > 0)) {
    return { success: false, error: long ? 'un stop de long doit etre SOUS l entree.' : 'un stop de short doit etre AU-DESSUS de l entree.' };
  }

  let cibles = Array.isArray(objectifs) && objectifs.length ? objectifs.slice() : null;
  if (!cibles) cibles = long ? [entree + risqueUnit, entree + risqueUnit * 2, entree + risqueUnit * 3]
    : [entree - risqueUnit, entree - risqueUnit * 2, entree - risqueUnit * 3];
  const mauvais = cibles.filter(t => long ? t <= entree : t >= entree);
  if (mauvais.length) return { success: false, error: 'objectif(s) du mauvais cote de l entree: ' + mauvais.join(', ') };

  let f = Array.isArray(parts) && parts.length === cibles.length ? parts.slice() : new Array(cibles.length).fill(1 / cibles.length);
  const somme = f.reduce((s, x) => s + x, 0);
  if (!(somme > 0)) return { success: false, error: 'les parts doivent totaliser plus de zero.' };
  f = f.map(x => x / somme);

  const pipTaille = PIP_OR[convention_pips] || PIP_OR.standard;
  const lignes = cibles.map((t, i) => {
    const dist = Math.abs(t - entree);
    return {
      n: i + 1, prix: r(t, 2), part_pct: r(f[i] * 100, 1),
      distance_points: r(dist, 2),
      distance_pips: r(dist / pipTaille, 1),
      R: r(dist / risqueUnit, 2),
      gain_usd: capital_risque_usd != null ? r(capital_risque_usd * (dist / risqueUnit) * f[i]) : null,
    };
  });

  // Blended R if every target is reached.
  const Rplein = lignes.reduce((s, l, i) => s + l.R * f[i], 0);
  // Partial outcomes: TP1 hit then stopped on the rest, etc. This is the case
  // people forget, and it is the most frequent one.
  const scenarios = [];
  for (let k = 0; k <= cibles.length; k++) {
    let R = 0;
    for (let i = 0; i < k; i++) R += lignes[i].R * f[i];
    for (let i = k; i < cibles.length; i++) R -= 1 * f[i];             // remainder stopped out
    scenarios.push({
      atteint: k === 0 ? 'aucun objectif (stop direct)' : 'TP1' + (k > 1 ? '..TP' + k : '') + ' puis stop sur le reste',
      R: r(R, 3),
      gain_usd: capital_risque_usd != null ? r(capital_risque_usd * R) : null,
    });
  }
  scenarios[scenarios.length - 1].atteint = 'tous les objectifs';

  // Where the position becomes risk-free: after TP1, moving the stop to entry.
  const apresTP1 = lignes[0].R * f[0];
  const seuilSansRisque = apresTP1 >= (1 - f[0]) ? 'des TP1' : 'pas avant TP' + (lignes.findIndex((l, i) => {
    let acc = 0; for (let j = 0; j <= i; j++) acc += lignes[j].R * f[j];
    return acc >= 1 - f.slice(0, i + 1).reduce((s, x) => s + x, 0);
  }) + 1);

  // The honest comparison: same risk, everything on the furthest target.
  const Rtout = lignes[lignes.length - 1].R;
  const p = Math.max(0, Math.min(1, taux_reussite_estime));
  const espEchelonne = p * Rplein - (1 - p) * 1;
  const espUnique = p * Rtout - (1 - p) * 1;

  return {
    success: true,
    sens, entree: r(entree, 2), stop: r(stop, 2),
    risque_points: r(risqueUnit, 2),
    risque_pips: r(risqueUnit / pipTaille, 1),
    convention_pips, un_pip_vaut_usd: pipTaille,
    capital_risque_usd: capital_risque_usd != null ? r(capital_risque_usd) : null,
    objectifs: lignes,
    R_si_tout_atteint: r(Rplein, 3),
    scenarios,
    position_sans_risque: seuilSansRisque,
    comparaison_sortie_unique: {
      R_si_tout_sur_le_dernier_objectif: r(Rtout, 2),
      taux_reussite_utilise: p,
      esperance_echelonnee_R: r(espEchelonne, 3),
      esperance_sortie_unique_R: r(espUnique, 3),
      ecart_R: r(espEchelonne - espUnique, 3),
      lecture: espEchelonne < espUnique
        ? 'Echelonner REDUIT l esperance de ' + r(espUnique - espEchelonne, 3) + ' R par trade a taux de reussite egal. '
          + 'C est le cout normal de la methode: on coupe les gagnants tot. Ce qu on achete en echange, c est une variance plus faible '
          + 'et une position sans risque ' + seuilSansRisque + ', donc une serie de pertes plus supportable.'
        : 'Dans cette configuration l echelonnement ne degrade pas l esperance (objectifs rapproches).',
      mise_en_garde: 'Le taux de reussite est le meme dans les deux colonnes, ce qui est FAUX en pratique: un objectif proche est atteint '
        + 'plus souvent qu un objectif lointain. Un TP1 a 1R se touche bien plus que 50% du temps, un TP3 a 3R bien moins. '
        + 'Ces deux esperances ne sont donc comparables qu a titre indicatif.',
    },
    methode: 'R = distance a l objectif / distance au stop. Les scenarios partiels supposent le reste de la position sortie au stop initial '
      + '(pas remonte a l entree), ce qui est le cas le plus defavorable et le plus honnete.',
  };
}
