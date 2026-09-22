/**
 * Fibonacci retracements and extensions, with the part that is usually missing:
 * a measurement of whether each level ever did anything.
 *
 * Drawing 0.618 on a chart is free, and it is also worthless on its own — the
 * ratio holds no predictive power by itself. What can be measured is whether
 * price, on this instrument, in this window, actually stopped and turned at that
 * price. So every level here carries its own test record: how many times it was
 * reached, how often price left it in the direction the level implies, and how
 * far it travelled afterwards. A level that was never touched is reported as
 * untested rather than dressed up as support.
 */
import { fetchBars, toCandles, normalizeInterval } from './bars.js';

const RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786];
const EXTENSIONS = [1.272, 1.618, 2.0, 2.618];
const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Wilder ATR, the same smoothing TradingView uses. */
function atr(c, period = 14) {
  if (c.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) {
    const p = c[i - 1].close;
    tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - p), Math.abs(c[i].low - p)));
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += tr[i];
  a /= period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/**
 * ZigZag on an ATR threshold rather than a fixed percentage: a 2% swing means
 * something very different on gold than on a small-cap token, and a fixed
 * percentage would flood one with noise and find nothing in the other.
 */
export function swings(candles, atrValue, mult = 3) {
  const min = atrValue * mult;
  if (!(min > 0) || candles.length < 10) return [];
  const pts = [];
  let dir = 0;                       // +1 = seeking a high, -1 = seeking a low
  let extIdx = 0, extPrice = candles[0].close;

  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    if (dir >= 0 && hi > extPrice) { extPrice = hi; extIdx = i; }
    if (dir <= 0 && lo < extPrice) { extPrice = lo; extIdx = i; }

    if (dir >= 0 && extPrice - lo >= min) {
      pts.push({ i: extIdx, price: extPrice, type: 'haut', time: candles[extIdx].time });
      dir = -1; extPrice = lo; extIdx = i;
    } else if (dir <= 0 && hi - extPrice >= min) {
      pts.push({ i: extIdx, price: extPrice, type: 'bas', time: candles[extIdx].time });
      dir = 1; extPrice = hi; extIdx = i;
    }
  }
  pts.push({ i: extIdx, price: extPrice, type: dir >= 0 ? 'haut' : 'bas', time: candles[extIdx].time, en_cours: true });
  return pts;
}

/**
 * What price did at a level, measured rather than assumed.
 * `sens_attendu` is 'haut' for a level meant to hold as support, 'bas' for
 * resistance. A touch that leaves the other way is counted as a failure.
 */
function reaction(candles, price, tol, sensAttendu, lookAhead = 10) {
  let inZone = false, touches = 0, respecte = 0, perce = 0;
  let firstIdx = -1, lastIdx = -1;
  const moves = [];

  for (let i = 0; i < candles.length; i++) {
    const within = candles[i].low <= price + tol && candles[i].high >= price - tol;
    if (within) {
      if (!inZone) {
        touches++; inZone = true;
        if (firstIdx < 0) firstIdx = i;
        // Excursion over the next few bars, measured from the level itself.
        const end = Math.min(candles.length - 1, i + lookAhead);
        let best = 0;
        for (let k = i + 1; k <= end; k++) {
          const mv = sensAttendu === 'haut' ? candles[k].high - price : price - candles[k].low;
          if (mv > best) best = mv;
        }
        moves.push(best);
      }
      lastIdx = i;
    } else if (inZone) {
      inZone = false;
      const away = sensAttendu === 'haut' ? candles[i].close > price : candles[i].close < price;
      if (away) respecte++; else perce++;
    }
  }

  const sorties = respecte + perce;
  const moyenne = moves.length ? moves.reduce((s, x) => s + x, 0) / moves.length : null;
  return {
    touches,
    sorties_favorables: respecte,
    sorties_defavorables: perce,
    // null, not 0.5: never having left the zone is an absence of evidence, not
    // a fifty-fifty record.
    taux_respect: sorties > 0 ? r(respecte / sorties, 2) : null,
    excursion_moyenne_apres_touche: r(moyenne),
    bougies_depuis_derniere_touche: lastIdx >= 0 ? candles.length - 1 - lastIdx : null,
    teste: touches > 0,
  };
}

/**
 * Fibonacci levels for a symbol, each one tested against the history that
 * produced it.
 */
export async function fibonacci({ symbol, interval = '1h', periods = 500, swing_atr = 3, lookahead = 10 } = {}) {
  const iv = normalizeInterval(interval);
  const bars = await fetchBars({ symbol, interval, limit: periods });
  if (!bars.ok) {
    return { success: false, symbol, interval: iv.tv || interval, error: bars.error, binance: bars.binance, graphique: bars.graphique };
  }
  const c = toCandles(bars);
  const a = atr(c);
  if (!(a > 0)) {
    return { success: false, symbol, error: 'ATR nul ou incalculable sur ' + c.length + ' bougies: aucune amplitude a mesurer.' };
  }

  const sw = swings(c, a, swing_atr);
  if (sw.length < 2) {
    return {
      success: false, symbol, source: bars.source,
      error: 'aucune oscillation d au moins ' + swing_atr + ' ATR (' + r(a * swing_atr) + ') sur ' + c.length + ' bougies. '
        + 'Baisser swing_atr, ou allonger la fenetre: sans oscillation nette il n y a pas d impulsion a retracer.',
      bougies: c.length, atr: r(a),
    };
  }

  // The impulse to retrace is the last completed leg: from the second-to-last
  // pivot to the last one.
  const b = sw[sw.length - 2], e = sw[sw.length - 1];
  const hausse = e.price > b.price;
  const amplitude = Math.abs(e.price - b.price);
  const px = c[c.length - 1].close;
  const tol = Math.max(a * 0.5, px * 0.0008);

  const niveaux = [];
  for (const ratio of RETRACEMENTS) {
    // Retracement walks back from the end of the leg toward its start.
    const prix = hausse ? e.price - amplitude * ratio : e.price + amplitude * ratio;
    const sens = hausse ? 'haut' : 'bas';      // in an up-leg a retracement should hold as support
    niveaux.push({
      ratio, role: 'retracement', prix: r(prix),
      type: prix < px ? 'support' : (prix > px ? 'resistance' : 'sur_le_prix'),
      distance_pct: r((prix - px) / px * 100),
      ...reaction(c, prix, tol, sens, lookahead),
    });
  }
  for (const ratio of EXTENSIONS) {
    const prix = hausse ? b.price + amplitude * ratio : b.price - amplitude * ratio;
    const sens = hausse ? 'bas' : 'haut';      // an extension is a target: price should stall there
    niveaux.push({
      ratio, role: 'extension', prix: r(prix),
      type: prix < px ? 'support' : (prix > px ? 'resistance' : 'sur_le_prix'),
      distance_pct: r((prix - px) / px * 100),
      ...reaction(c, prix, tol, sens, lookahead),
    });
  }

  const testes = niveaux.filter(n => n.teste && n.taux_respect != null);
  const fiables = testes.filter(n => n.touches >= 3 && n.taux_respect >= 0.6)
    .sort((x, y) => y.taux_respect - x.taux_respect || y.touches - x.touches);
  const proches = niveaux.filter(n => Math.abs(n.distance_pct) <= 3)
    .sort((x, y) => Math.abs(x.distance_pct) - Math.abs(y.distance_pct));

  return {
    success: true,
    symbol, interval: bars.interval, source: bars.source,
    bougies: c.length,
    prix_actuel: r(px),
    atr: r(a), atr_pct: r(a / px * 100, 2),
    tolerance_zone: r(tol),
    impulsion: {
      sens: hausse ? 'haussiere' : 'baissiere',
      depart: { prix: r(b.price), type: b.type, bougies_avant: c.length - 1 - b.i },
      arrivee: { prix: r(e.price), type: e.type, bougies_avant: c.length - 1 - e.i, en_cours: e.en_cours || undefined },
      amplitude: r(amplitude),
      amplitude_pct: r(amplitude / b.price * 100),
      amplitude_atr: r(amplitude / a, 1),
      retracement_actuel_pct: r(hausse ? (e.price - px) / amplitude * 100 : (px - e.price) / amplitude * 100, 1),
      seuil_oscillation: r(a * swing_atr),
      oscillations_detectees: sw.length,
    },
    niveaux,
    niveaux_proches: proches.slice(0, 4),
    niveaux_eprouves: fiables.slice(0, 4),
    lecture: [
      'Impulsion ' + (hausse ? 'haussiere' : 'baissiere') + ' de ' + r(amplitude) + ' (' + r(amplitude / a, 1) + ' ATR), retracee a '
        + r(hausse ? (e.price - px) / amplitude * 100 : (px - e.price) / amplitude * 100, 1) + '% a l instant.',
      testes.length === 0
        ? 'AUCUN niveau de cette grille n a ete teste sur la fenetre: ils sont geometriques, pas empiriques. Les tracer ne leur donne aucun pouvoir.'
        : testes.length + ' niveaux sur ' + niveaux.length + ' ont ete touches au moins une fois; ' + fiables.length
          + ' tiennent avec au moins 3 touches et 60% de sorties dans le sens attendu.',
      fiables.length
        ? 'Le mieux eprouve: ' + fiables[0].ratio + ' a ' + fiables[0].prix + ' (' + fiables[0].touches + ' touches, '
          + Math.round(fiables[0].taux_respect * 100) + '% de respect).'
        : 'Aucun niveau ne reunit 3 touches et 60% de respect: sur cette fenetre la grille de Fibonacci n a pas de valeur demontree pour cet actif.',
    ],
    methode: 'Impulsion = derniere jambe complete du ZigZag (seuil ' + swing_atr + ' x ATR). taux_respect = sorties dans le sens attendu / sorties totales, '
      + 'mesure sur une zone de +/- ' + r(tol) + ' autour du niveau. Un ratio de Fibonacci n a aucun pouvoir en soi: seule la trace historique compte.',
    avertissement: bars.volume_disponible === false
      ? 'Le flux ne porte pas de volume: seuls les niveaux de prix sont exploitables ici.' : undefined,
  };
}
