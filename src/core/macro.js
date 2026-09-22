/**
 * Cross-asset drivers.
 *
 * Gold is not an isolated chart. Its price is, first and foremost, a function of
 * the dollar and of real yields: when the dollar rises, the same ounce costs
 * more in every other currency, and when yields rise, holding a metal that pays
 * no coupon costs more. Reading a gold chart without its drivers is reading half
 * the information — which is exactly what happened here today, where a long was
 * argued from support levels while the whole news flow said "higher-for-longer".
 *
 * So this module measures, rather than asserts, the relationship:
 *  - correlation of daily returns against each driver, with the sample size;
 *  - beta: how much the asset moves for a 1% move in the driver;
 *  - whether that link is currently BREAKING, by comparing a short window to a
 *    long one. A decoupling is the interesting event, and it is invisible to
 *    anyone who only quotes the long-run number.
 *
 * Correlations are computed on RETURNS, never on price levels: two rising series
 * correlate at 0.9 whatever they are, which measures the fact they both rose and
 * nothing else.
 */
import { fetchBars, toCandles } from './bars.js';

const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Drivers that actually move each family, rather than a generic basket. */
const MOTEURS = {
  or: [
    { symbole: 'DXY', role: 'dollar', attendu: 'negatif', pourquoi: 'un dollar plus cher rencherit l once dans toutes les autres devises' },
    { symbole: 'US10Y', role: 'taux 10 ans US', attendu: 'negatif', pourquoi: 'un metal ne verse aucun coupon: quand les taux montent, le detenir coute plus cher' },
    { symbole: 'XAGUSD', role: 'argent', attendu: 'positif', pourquoi: 'meme famille; le ratio or/argent dit lequel des deux mene' },
    { symbole: 'SPX', role: 'actions US', attendu: 'variable', pourquoi: 'refuge quand les actions chutent, actif de portefeuille quand elles montent' },
  ],
  defaut: [
    { symbole: 'DXY', role: 'dollar', attendu: 'negatif', pourquoi: 'actif cote en dollars' },
    { symbole: 'SPX', role: 'actions US', attendu: 'positif', pourquoi: 'appetit pour le risque' },
  ],
};

function famille(symbol) {
  const t = String(symbol || '').split(':').pop().toUpperCase();
  if (/XAU|GOLD/.test(t)) return 'or';
  return 'defaut';
}

function returns(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1].close, b = candles[i].close;
    if (a > 0 && b > 0) out.push({ t: candles[i].time, v: Math.log(b / a) });
  }
  return out;
}

/**
 * Pair returns by PERIOD, not by exact timestamp.
 *
 * Gold futures close at 17:00 New York, the S&P at 16:00, and a yield index at
 * a third time entirely. Matching raw timestamps therefore paired almost
 * nothing: the 10-year gave 0 points and the S&P 3, so two of gold's four
 * drivers were silently reported as unavailable. Bucketing to the day (or the
 * hour, intraday) pairs the periods that actually correspond.
 */
function bucket(t, interval) {
  const iv = String(interval || '1d');
  if (/d|w|M/i.test(iv) && !/m$|h$/i.test(iv)) return Math.floor(t / 86400);      // calendar day
  if (/h$/i.test(iv)) return Math.floor(t / 3600);                                 // hour
  return t;                                                                        // minutes: keep exact
}

function align(a, b, interval) {
  const m = new Map();
  for (const x of b) m.set(bucket(x.t, interval), x.v);   // last write wins within a bucket
  const x = [], y = [];
  const seen = new Set();
  for (const p of a) {
    const k = bucket(p.t, interval);
    if (seen.has(k)) continue;                             // one pair per period
    const q = m.get(k);
    if (q != null) { x.push(p.v); y.push(q); seen.add(k); }
  }
  return { x, y };
}

function pearson(x, y) {
  const n = x.length;
  if (n < 20) return { rho: null, n, raison: 'moins de 20 points apparies' };
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (!(sxx > 0) || !(syy > 0)) return { rho: null, n, raison: 'une des deux series est plate' };
  const rho = sxy / Math.sqrt(sxx * syy);
  // t = r*sqrt(n-2)/sqrt(1-r^2): a correlation on few points is not a fact.
  const t = Math.abs(rho) < 1 ? rho * Math.sqrt((n - 2) / (1 - rho * rho)) : null;
  return { rho, n, t, significatif: t != null && Math.abs(t) >= 2, beta: sxy / syy };
}

function lire(rho) {
  if (rho == null) return null;
  const a = Math.abs(rho);
  const force = a >= 0.7 ? 'tres forte' : a >= 0.4 ? 'forte' : a >= 0.2 ? 'moderee' : a >= 0.1 ? 'faible' : 'quasi nulle';
  return force + ' et ' + (rho < 0 ? 'inverse' : 'de meme sens');
}

/**
 * Which hours of the day actually move, and which only look like they do.
 *
 * Gold does not trade evenly around the clock: the London fix and the New York
 * open carry most of the range, while the Asian afternoon is often a drift.
 * Placing an intraday stop sized on the 24-hour average ATR means a stop far too
 * tight for the open and far too wide for the lull — the same number being wrong
 * in both directions.
 *
 * Direction is reported with a binomial test, because "this hour is bullish" on
 * 40 samples at 57% is indistinguishable from a coin.
 */
export async function sessionProfile({ symbol, periods = 2000, fuseau = 'UTC' } = {}) {
  if (!symbol) return { success: false, error: 'symbole requis' };
  const bars = await fetchBars({ symbol, interval: '1h', limit: periods, prefer: 'profondeur' });
  if (!bars.ok) return { success: false, symbol, error: bars.error, yahoo: bars.yahoo, graphique: bars.graphique };
  const c = toCandles(bars);
  if (c.length < 200) return { success: false, symbol, error: 'seulement ' + c.length + ' bougies horaires: trop peu pour un profil de session.' };

  const heures = Array.from({ length: 24 }, () => ({ amplitudes: [], hausses: 0, baisses: 0, volumes: [] }));
  for (const b of c) {
    const h = new Date(b.time * 1000).getUTCHours();
    if (b.close > 0) heures[h].amplitudes.push((b.high - b.low) / b.close * 100);
    if (b.close > b.open) heures[h].hausses++; else if (b.close < b.open) heures[h].baisses++;
    if (b.volume > 0) heures[h].volumes.push(b.volume);
  }

  const moy = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const toutes = heures.flatMap(h => h.amplitudes);
  const ampMoyenne = moy(toutes);

  const lignes = heures.map((h, i) => {
    const n = h.hausses + h.baisses;
    const amp = moy(h.amplitudes);
    const part = h.hausses / (n || 1);
    // Binomial z against a fair coin: |z| >= 2 before calling an hour directional.
    const z = n >= 20 ? (h.hausses - n / 2) / Math.sqrt(n / 4) : null;
    return {
      heure_utc: i,
      amplitude_moyenne_pct: r(amp, 3),
      vs_moyenne: ampMoyenne > 0 && amp != null ? r(amp / ampMoyenne, 2) : null,
      echantillon: h.amplitudes.length,
      hausses: h.hausses, baisses: h.baisses,
      part_haussiere_pct: n ? r(part * 100, 1) : null,
      z_directionnel: r(z, 2),
      biais_significatif: z != null && Math.abs(z) >= 2,
      volume_moyen: r(moy(h.volumes), 0),
    };
  });

  const classe = lignes.filter(l => l.amplitude_moyenne_pct != null).sort((a, b) => b.amplitude_moyenne_pct - a.amplitude_moyenne_pct);
  const biais = lignes.filter(l => l.biais_significatif);

  return {
    success: true,
    symbol, source: bars.source + (bars.symbole_source ? ' (' + bars.symbole_source + ')' : ''),
    prix_equivalents: bars.prix_equivalents,
    bougies: c.length,
    fuseau: 'UTC (heures brutes, non converties)',
    amplitude_moyenne_toutes_heures_pct: r(ampMoyenne, 3),
    profil_horaire: lignes,
    heures_les_plus_actives: classe.slice(0, 4).map(l => ({ heure_utc: l.heure_utc, amplitude_pct: l.amplitude_moyenne_pct, vs_moyenne: l.vs_moyenne, echantillon: l.echantillon })),
    heures_les_plus_calmes: classe.slice(-4).reverse().map(l => ({ heure_utc: l.heure_utc, amplitude_pct: l.amplitude_moyenne_pct, vs_moyenne: l.vs_moyenne, echantillon: l.echantillon })),
    biais_directionnels: biais.map(l => ({ heure_utc: l.heure_utc, part_haussiere_pct: l.part_haussiere_pct, z: l.z_directionnel, echantillon: l.hausses + l.baisses })),
    lecture: [
      classe.length
        ? 'Heure la plus active: ' + classe[0].heure_utc + 'h UTC, amplitude ' + classe[0].amplitude_moyenne_pct
          + '% soit ' + classe[0].vs_moyenne + 'x la moyenne. La plus calme: ' + classe[classe.length - 1].heure_utc
          + 'h UTC (' + classe[classe.length - 1].vs_moyenne + 'x).'
        : 'Profil horaire non calculable.',
      'Un stop dimensionne sur l ATR 24h est trop serre aux heures actives et trop large aux heures creuses: le rapport entre les deux extremes est de '
        + (classe.length ? r(classe[0].amplitude_moyenne_pct / classe[classe.length - 1].amplitude_moyenne_pct, 1) : '?') + 'x.',
      biais.length
        ? biais.length + ' heure(s) avec un biais directionnel distinguable du hasard (|z| >= 2): ' + biais.map(b => b.heure_utc + 'h (' + b.part_haussiere_pct + '% haussier)').join(', ')
          + '. A reverifier sur une autre periode avant d en faire une regle.'
        : 'AUCUNE heure ne montre de biais directionnel distinguable du hasard. Les heures disent QUAND ca bouge, pas dans quel sens.',
    ],
    methode: 'Amplitude = (haut - bas) / cloture, moyennee par heure UTC. Biais = test binomial des cloture>ouverture contre 50%, '
      + 'z = (hausses - n/2) / sqrt(n/4); |z| < 2 = non distinguable d une piece.',
  };
}

/**
 * Correlations of a symbol against the drivers that actually move it.
 */
export async function drivers({ symbol, interval = '1d', periods = 400, fenetre_courte = 30 } = {}) {
  if (!symbol) return { success: false, error: 'symbole requis' };
  const fam = famille(symbol);
  const liste = MOTEURS[fam];

  const base = await fetchBars({ symbol, interval, limit: periods, prefer: 'profondeur' });
  if (!base.ok) return { success: false, symbol, error: base.error, yahoo: base.yahoo, graphique: base.graphique };
  const rBase = returns(toCandles(base));
  if (rBase.length < 40) {
    return { success: false, symbol, error: 'seulement ' + rBase.length + ' rendements: trop peu pour une correlation.' };
  }

  const out = [];
  for (const m of liste) {
    const d = await fetchBars({ symbol: m.symbole, interval, limit: periods, prefer: 'profondeur' });
    if (!d.ok) { out.push({ ...m, disponible: false, raison: d.error }); continue; }
    const rD = returns(toCandles(d));
    const { x, y } = align(rBase, rD, interval);
    const plein = pearson(x, y);
    // Same computation on the tail only: a link that has just broken is the
    // signal, and the long-run number hides it by construction.
    const k = Math.min(fenetre_courte, x.length);
    const court = pearson(x.slice(-k), y.slice(-k));

    const rupture = plein.rho != null && court.rho != null
      && Math.sign(plein.rho) !== Math.sign(court.rho) && Math.abs(plein.rho) >= 0.2;
    const affaibli = plein.rho != null && court.rho != null
      && Math.sign(plein.rho) === Math.sign(court.rho) && Math.abs(court.rho) < Math.abs(plein.rho) / 2;

    out.push({
      ...m,
      disponible: true,
      source: d.source, symbole_source: d.symbole_source,
      correlation: r(plein.rho, 3),
      echantillon: plein.n,
      t_stat: r(plein.t, 2),
      significatif: plein.significatif || false,
      lecture: lire(plein.rho),
      beta: r(plein.beta, 3),
      beta_lecture: plein.beta == null ? null
        : 'pour 1% de variation de ' + m.symbole + ', ' + String(symbol).split(':').pop() + ' bouge de '
          + r(plein.beta, 2) + '% en moyenne',
      correlation_recente: r(court.rho, 3),
      fenetre_recente: k,
      conforme_a_l_attendu: m.attendu === 'variable' ? null
        : plein.rho == null ? null
          : (m.attendu === 'negatif' ? plein.rho < 0 : plein.rho > 0),
      alerte: rupture ? 'RUPTURE: le lien s est inverse sur les ' + k + ' dernieres periodes (' + r(plein.rho, 2) + ' -> ' + r(court.rho, 2) + ').'
        : affaibli ? 'AFFAIBLISSEMENT: le lien a perdu plus de la moitie de sa force recemment (' + r(plein.rho, 2) + ' -> ' + r(court.rho, 2) + ').'
          : undefined,
    });
  }

  const dispo = out.filter(o => o.disponible && o.correlation != null);
  const dominant = dispo.slice().sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0] || null;
  const alertes = dispo.filter(o => o.alerte);
  const contraires = dispo.filter(o => o.conforme_a_l_attendu === false);

  return {
    success: true,
    symbol, interval,
    famille: fam,
    source_base: base.source + (base.symbole_source ? ' (' + base.symbole_source + ')' : ''),
    prix_equivalents: base.prix_equivalents,
    equivalence_note: base.equivalence_note,
    rendements_utilises: rBase.length,
    moteurs: out,
    moteur_dominant: dominant ? { symbole: dominant.symbole, role: dominant.role, correlation: dominant.correlation, significatif: dominant.significatif } : null,
    lecture: [
      dominant
        ? 'Moteur dominant: ' + dominant.role + ' (' + dominant.symbole + '), correlation ' + dominant.correlation
          + ' sur ' + dominant.echantillon + ' points' + (dominant.significatif ? '' : ' — NON significative, a ne pas exploiter comme un fait') + '.'
        : 'Aucune correlation exploitable n a pu etre calculee.',
      alertes.length
        ? alertes.length + ' lien(s) en rupture ou affaiblissement: ' + alertes.map(a => a.symbole).join(', ') + '. Un moteur qui lache est plus informatif qu un moteur stable.'
        : 'Aucune rupture de correlation detectee: les moteurs habituels tiennent.',
      contraires.length
        ? 'ATTENTION: ' + contraires.map(c => c.symbole + ' (' + c.correlation + ', attendu ' + c.attendu + ')').join(', ')
          + ' se comporte a l inverse de la theorie sur cette fenetre. Soit le regime a change, soit la relation n est pas a l oeuvre ici.'
        : undefined,
    ].filter(Boolean),
    methode: 'Correlation de Pearson sur les RENDEMENTS logarithmiques apparies par horodatage, jamais sur les niveaux de prix '
      + '(deux series qui montent correlent a 0.9 quoi qu elles soient). t = r*sqrt(n-2)/sqrt(1-r2); |t| < 2 = non distinguable de zero. '
      + 'beta = covariance / variance du moteur.',
    avertissement: 'Une correlation decrit le passe de la fenetre et ne dit rien de la causalite ni de la suite.',
  };
}
