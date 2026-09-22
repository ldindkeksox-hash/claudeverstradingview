/**
 * Strategy backtesting.
 *
 * The point of this module is to answer one question honestly: does this setup
 * have an edge, or does it just look like it did? Three rules make the
 * difference between a backtest and a fantasy, and all three are enforced here:
 *
 *  1. No look-ahead. A signal computed on bar i is filled at the OPEN of bar
 *     i+1. Filling at bar i's close uses a price that was not knowable when the
 *     condition became true, and it is the single most common way a losing
 *     system is made to look profitable.
 *  2. Ambiguity resolves against the trade. When a bar's range covers both the
 *     stop and the target, intrabar order is unknown, so it is counted as the
 *     stop. Assuming the target instead inflates the win rate on exactly the
 *     volatile bars where it matters most.
 *  3. A result is reported with the sample that produced it. Twelve trades at
 *     60% is noise; the t-statistic on the mean R is printed beside every
 *     verdict, and a strategy that cannot clear it is labelled as unproven
 *     rather than quietly recommended.
 */
import { fetchBars, toCandles, normalizeInterval } from './bars.js';
import { swings } from './fibonacci.js';

const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

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

function emaSeries(c, period) {
  const out = new Array(c.length).fill(null);
  if (c.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += c[i].close;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < c.length; i++) { e = c[i].close * k + e * (1 - k); out[i] = e; }
  return out;
}

/** Wilder RSI, matching TradingView. A simple mean here reads several points off. */
function rsiSeries(c, period = 14) {
  const out = new Array(c.length).fill(null);
  if (c.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i].close - c[i - 1].close;
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < c.length; i++) {
    const d = c[i].close - c[i - 1].close;
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signal generators. Each returns +1 (long), -1 (short) or 0 for bar i, using
// ONLY data available up to and including bar i.
// ---------------------------------------------------------------------------
const STRATEGIES = {
  repli_tendance: {
    description: 'Achat d un repli sur l EMA20 tant que l EMA20 est au-dessus de l EMA50 (tendance intacte). Vend le miroir.',
    params: { ema_rapide: 20, ema_lente: 50, tolerance_atr: 0.5 },
    prepare(c, p) { return { fast: emaSeries(c, p.ema_rapide), slow: emaSeries(c, p.ema_lente), atr: atrSeries(c) }; },
    signal(c, i, s, p) {
      const f = s.fast[i], sl = s.slow[i], a = s.atr[i];
      if (f == null || sl == null || a == null || i < 1) return 0;
      const tol = a * p.tolerance_atr;
      const touchedNow = c[i].low <= f + tol && c[i].close > f;
      const touchedPrev = c[i - 1].low <= s.fast[i - 1] + tol;
      if (f > sl && touchedNow && !touchedPrev) return 1;
      const touchedNowS = c[i].high >= f - tol && c[i].close < f;
      const touchedPrevS = c[i - 1].high >= s.fast[i - 1] - tol;
      if (f < sl && touchedNowS && !touchedPrevS) return -1;
      return 0;
    },
  },

  rsi_extreme: {
    description: 'Achat quand le RSI repasse au-dessus du seuil bas apres l avoir franchi (retour de survente). Vend le miroir.',
    params: { periode: 14, seuil_bas: 30, seuil_haut: 70 },
    prepare(c, p) { return { rsi: rsiSeries(c, p.periode), atr: atrSeries(c) }; },
    signal(c, i, s, p) {
      const a = s.rsi[i], b = s.rsi[i - 1];
      if (a == null || b == null || s.atr[i] == null) return 0;
      if (b <= p.seuil_bas && a > p.seuil_bas) return 1;
      if (b >= p.seuil_haut && a < p.seuil_haut) return -1;
      return 0;
    },
  },

  cassure: {
    description: 'Achat a la cassure du plus haut des N dernieres bougies. Vend a la cassure du plus bas.',
    params: { fenetre: 20 },
    prepare(c) { return { atr: atrSeries(c) }; },
    signal(c, i, s, p) {
      const n = p.fenetre;
      if (i < n || s.atr[i] == null) return 0;
      let hi = -Infinity, lo = Infinity;
      for (let k = i - n; k < i; k++) { if (c[k].high > hi) hi = c[k].high; if (c[k].low < lo) lo = c[k].low; }
      if (c[i].close > hi) return 1;
      if (c[i].close < lo) return -1;
      return 0;
    },
  },

  fib_retracement: {
    description: 'Achat quand le prix retrace dans la zone de Fibonacci choisie de la derniere impulsion haussiere. Vend le miroir.',
    params: { ratio: 0.618, swing_atr: 3, tolerance_atr: 0.5 },
    prepare(c) { return { atr: atrSeries(c) }; },
    signal(c, i, s, p) {
      const a = s.atr[i];
      if (a == null || i < 60) return 0;
      // Swings recomputed on the visible history only — never on the full set.
      const hist = c.slice(0, i + 1);
      const sw = swings(hist, a, p.swing_atr);
      if (sw.length < 2) return 0;
      const b = sw[sw.length - 2], e = sw[sw.length - 1];
      const amp = Math.abs(e.price - b.price);
      if (!(amp > 0)) return 0;
      const up = e.price > b.price;
      const lvl = up ? e.price - amp * p.ratio : e.price + amp * p.ratio;
      const tol = a * p.tolerance_atr;
      const inZone = c[i].low <= lvl + tol && c[i].high >= lvl - tol;
      if (!inZone) return 0;
      return up ? 1 : -1;
    },
  },
};

export function listStrategies() {
  return Object.entries(STRATEGIES).map(([nom, s]) => ({ nom, description: s.description, params_par_defaut: s.params }));
}

/**
 * Simulate one signal series. Entry at the next bar's open; stop and target
 * checked on every subsequent bar; stop wins any ambiguous bar.
 */
function simulate(c, signals, atr, opts) {
  const { stop_atr, objectif_atr, max_bougies, sens } = opts;
  const trades = [];
  let openUntil = -1;                    // no pyramiding: one position at a time

  for (let i = 0; i < c.length - 1; i++) {
    if (i <= openUntil) continue;
    const sig = signals[i];
    if (!sig) continue;
    if (sens === 'long' && sig !== 1) continue;
    if (sens === 'short' && sig !== -1) continue;
    const a = atr[i];
    if (a == null || !(a > 0)) continue;

    const entry = c[i + 1].open;         // fill on the NEXT bar's open
    const long = sig === 1;
    const stop = long ? entry - a * stop_atr : entry + a * stop_atr;
    const target = long ? entry + a * objectif_atr : entry - a * objectif_atr;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;

    let exit = null, exitIdx = null, raison = null;
    const last = Math.min(c.length - 1, i + 1 + max_bougies);
    for (let k = i + 1; k <= last; k++) {
      const hitStop = long ? c[k].low <= stop : c[k].high >= stop;
      const hitTgt = long ? c[k].high >= target : c[k].low <= target;
      if (hitStop) { exit = stop; exitIdx = k; raison = 'stop'; break; }   // stop wins ties
      if (hitTgt) { exit = target; exitIdx = k; raison = 'objectif'; break; }
    }
    if (exit == null) { exit = c[last].close; exitIdx = last; raison = 'temps_ecoule'; }

    const pnl = long ? exit - entry : entry - exit;
    trades.push({
      i_signal: i, i_entree: i + 1, i_sortie: exitIdx,
      sens: long ? 'long' : 'short',
      entree: r(entry, 5), stop: r(stop, 5), objectif: r(target, 5), sortie: r(exit, 5),
      raison, R: r(pnl / risk, 3), bougies_tenues: exitIdx - (i + 1),
    });
    openUntil = exitIdx;
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (n === 0) return { trades: 0 };
  const Rs = trades.map(t => t.R);
  const wins = Rs.filter(x => x > 0), losses = Rs.filter(x => x <= 0);
  const mean = Rs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(Rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  const gross = wins.reduce((s, x) => s + x, 0);
  const grossLoss = -losses.reduce((s, x) => s + x, 0);

  // Equity path in R, for the drawdown a headline win rate never shows.
  let eq = 0, peak = 0, dd = 0, run = 0, maxRun = 0;
  for (const x of Rs) {
    eq += x; if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
    if (x <= 0) { run++; if (run > maxRun) maxRun = run; } else run = 0;
  }

  return {
    trades: n,
    gagnants: wins.length,
    perdants: losses.length,
    taux_reussite_pct: r(wins.length / n * 100, 1),
    R_moyen: r(mean, 3),
    R_total: r(eq, 2),
    R_median: r([...Rs].sort((a, b) => a - b)[Math.floor(n / 2)], 3),
    gain_moyen_R: wins.length ? r(gross / wins.length, 2) : null,
    perte_moyenne_R: losses.length ? r(grossLoss / losses.length, 2) : null,
    facteur_profit: grossLoss > 0 ? r(gross / grossLoss, 2) : null,
    drawdown_max_R: r(dd, 2),
    pertes_consecutives_max: maxRun,
    ecart_type_R: r(sd, 3),
    t_stat: r(t, 2),
    significatif: t != null && Math.abs(t) >= 2,
    lecture_stat: n < 30
      ? 'Echantillon de ' + n + ' trades: trop petit pour distinguer une competence du hasard, quel que soit le taux de reussite affiche.'
      : (t != null && Math.abs(t) >= 2
        ? 'R moyen distinguable de zero (|t| = ' + r(Math.abs(t), 2) + ' >= 2) sur ' + n + ' trades.'
        : 'R moyen NON distinguable de zero (|t| = ' + r(t == null ? 0 : Math.abs(t), 2) + ' < 2): ce resultat est compatible avec l absence d edge.'),
  };
}

/**
 * Backtest a named strategy on a symbol.
 */
export async function backtest({
  symbol, interval = '1h', periods = 1000, strategie = 'repli_tendance',
  params = {}, stop_atr = 2, objectif_atr = 4, max_bougies = 50, sens = 'les_deux',
  _bars,
} = {}) {
  const def = STRATEGIES[strategie];
  if (!def) {
    return { success: false, error: 'strategie inconnue: ' + strategie, disponibles: Object.keys(STRATEGIES) };
  }
  const iv = normalizeInterval(interval);
  // _bars lets a caller running many tests fetch once. Without it, findStrategy's
  // grid would swap the chart symbol back and forth 16 times for one answer.
  const bars = _bars || await fetchBars({ symbol, interval, limit: periods });
  if (!bars.ok) return { success: false, symbol, interval: iv.tv || interval, error: bars.error, binance: bars.binance, graphique: bars.graphique };

  const c = toCandles(bars);
  if (c.length < 100) return { success: false, symbol, error: 'seulement ' + c.length + ' bougies: trop peu pour un backtest.' };

  const p = { ...def.params, ...params };
  const prepared = def.prepare(c, p);
  const atr = prepared.atr || atrSeries(c);
  const signals = new Array(c.length).fill(0);
  for (let i = 1; i < c.length - 1; i++) signals[i] = def.signal(c, i, prepared, p);

  const trades = simulate(c, signals, atr, { stop_atr, objectif_atr, max_bougies, sens });
  const st = stats(trades);

  // A random-entry control on the same bars, same stop and target. If the setup
  // cannot beat coin flips with identical exits, the entry rule adds nothing.
  const rnd = new Array(c.length).fill(0);
  let seed = 1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rate = trades.length / Math.max(1, c.length);
  for (let i = 1; i < c.length - 1; i++) if (next() < rate) rnd[i] = next() < 0.5 ? 1 : -1;
  const ctrl = stats(simulate(c, rnd, atr, { stop_atr, objectif_atr, max_bougies, sens }));

  const attendu = objectif_atr / stop_atr;
  const seuilRentable = 1 / (1 + attendu) * 100;

  return {
    success: true,
    symbol: bars.symbol, interval: bars.interval, source: bars.source,
    strategie, description: def.description, params: p,
    bougies: c.length,
    periode: { du: new Date(c[0].time * 1000).toISOString(), au: new Date(c[c.length - 1].time * 1000).toISOString() },
    sortie: { stop_atr, objectif_atr, max_bougies, sens, R_par_gain: r(attendu, 2) },
    signaux_generes: signals.filter(Boolean).length,
    resultats: st,
    controle_aleatoire: { ...ctrl, note: 'Entrees tirees au hasard a la meme frequence, avec les memes stop et objectif. La strategie doit battre ceci pour que la regle d entree serve a quelque chose.' },
    verdict: verdict(st, ctrl, seuilRentable),
    seuil_rentabilite_pct: r(seuilRentable, 1),
    trades: trades.slice(-15),
    trades_total: trades.length,
    regles_du_test: [
      'Entree a l OUVERTURE de la bougie suivant le signal, jamais a la cloture du signal (ce serait lire le futur).',
      'Bougie touchant stop ET objectif: comptee comme stop. L ordre intra-bougie est inconnu, le doute joue contre le trade.',
      'Une position a la fois, pas de renforcement.',
      'Derniere bougie exclue des donnees: elle n est pas cloturee.',
    ],
    avertissement: 'Un backtest decrit le passe de cette fenetre. Il ne promet rien, et une strategie testee sur un seul actif et une seule periode reste une hypothese.',
  };
}

function verdict(st, ctrl, seuil) {
  if (!st.trades) return 'Aucun trade declenche: la regle ne trouve pas sa configuration sur cette fenetre.';
  const lines = [];
  if (st.trades < 30) lines.push('ECHANTILLON INSUFFISANT (' + st.trades + ' trades). Tout ce qui suit est indicatif.');
  lines.push('Taux de reussite ' + st.taux_reussite_pct + '% contre ' + r(seuil, 1) + '% necessaires pour etre a l equilibre avec ce rapport objectif/stop.');
  if (st.R_moyen > 0 && st.significatif) lines.push('Esperance positive et statistiquement distinguable du hasard.');
  else if (st.R_moyen > 0) lines.push('Esperance positive mais NON significative: peut n etre que de la chance sur cet echantillon.');
  else lines.push('Esperance negative sur cette fenetre: la regle a perdu de l argent.');
  if (ctrl.trades && ctrl.R_moyen != null) {
    lines.push(st.R_moyen > ctrl.R_moyen
      ? 'Bat les entrees aleatoires (' + st.R_moyen + ' R contre ' + ctrl.R_moyen + ' R).'
      : 'NE BAT PAS les entrees aleatoires (' + st.R_moyen + ' R contre ' + ctrl.R_moyen + ' R): la regle d entree n apporte rien de mesurable.');
  }
  lines.push('Pire serie: ' + st.pertes_consecutives_max + ' pertes d affilee, creux maximal ' + st.drawdown_max_R + ' R.');
  return lines;
}

/**
 * Run every strategy over a grid of stop/target pairs and rank what survives.
 * Reports how many combinations were tried, because testing many and keeping the
 * best is how an edge gets invented out of noise.
 */
export async function findStrategy({ symbol, interval = '1h', periods = 1000, sens = 'les_deux' } = {}) {
  const grid = [
    { stop_atr: 1.5, objectif_atr: 3 },
    { stop_atr: 2, objectif_atr: 4 },
    { stop_atr: 2, objectif_atr: 3 },
    { stop_atr: 3, objectif_atr: 4.5 },
  ];
  // One fetch for the whole grid: on a non-Binance symbol every fetch swaps the
  // displayed chart, and 16 swaps to answer one question is not acceptable.
  const bars = await fetchBars({ symbol, interval, limit: periods });
  if (!bars.ok) {
    return { success: false, symbol, interval, error: bars.error, binance: bars.binance, graphique: bars.graphique };
  }

  const noms = Object.keys(STRATEGIES);
  const out = [];
  for (const nom of noms) {
    for (const g of grid) {
      const res = await backtest({ symbol, interval, periods, strategie: nom, sens, ...g, _bars: bars });
      if (!res.success) { out.push({ strategie: nom, ...g, erreur: res.error }); continue; }
      out.push({
        strategie: nom, ...g,
        trades: res.resultats.trades,
        taux_reussite_pct: res.resultats.taux_reussite_pct,
        R_moyen: res.resultats.R_moyen,
        R_total: res.resultats.R_total,
        facteur_profit: res.resultats.facteur_profit,
        t_stat: res.resultats.t_stat,
        significatif: res.resultats.significatif,
        drawdown_max_R: res.resultats.drawdown_max_R,
        bat_aleatoire: res.controle_aleatoire.R_moyen != null && res.resultats.R_moyen > res.controle_aleatoire.R_moyen,
      });
    }
  }
  const valides = out.filter(x => !x.erreur && x.trades >= 30 && x.R_moyen > 0 && x.significatif && x.bat_aleatoire)
    .sort((a, b) => b.R_moyen - a.R_moyen);
  const essais = out.filter(x => !x.erreur).length;

  return {
    success: true, symbol, interval, sens,
    combinaisons_testees: essais,
    tous_les_resultats: out.sort((a, b) => (b.R_moyen || -99) - (a.R_moyen || -99)),
    retenues: valides,
    verdict: valides.length
      ? valides.length + ' combinaison(s) sur ' + essais + ' passent les quatre filtres: >= 30 trades, esperance positive, |t| >= 2, et battent les entrees aleatoires.'
      : 'AUCUNE des ' + essais + ' combinaisons ne passe les quatre filtres (>= 30 trades, esperance positive, |t| >= 2, bat l aleatoire). '
        + 'Sur cet actif et cette fenetre, aucune de ces regles n a d edge demontrable. C est un resultat, pas un echec du test.',
    mise_en_garde: 'ATTENTION: ' + essais + ' combinaisons ont ete essayees. Tester beaucoup et garder la meilleure fabrique des resultats flatteurs a partir de bruit '
      + '(avec ' + essais + ' essais, on attend environ ' + r(essais * 0.05, 1) + ' faux positifs au seuil de 5%). '
      + 'Une regle retenue ici doit etre reverifiee sur une autre periode ou un autre actif AVANT d etre jouee.',
  };
}
