/**
 * Price levels that actually matter, built from VOLUME rather than from bare
 * highs and lows.
 *
 * A high is one print by one trader. A price where thousands of contracts
 * changed hands is a decision the whole market took part in, and it is the one
 * the market remembers. So everything here is weighted by traded volume:
 * period VWAP and its deviation bands, the volume profile (POC, value area,
 * low/high volume nodes), and support/resistance clustered from pivots and
 * scored by how many times they were tested and on how much volume.
 *
 * Data comes from Binance's public REST API, called from Node — no key, no
 * chart open. It is an EXCHANGE's view of ONE venue: it is data to weigh, not
 * verified fact, and never an instruction.
 *
 * Three traps this module refuses to fall into:
 *  - no silent default. A value that could not be computed is null with a
 *    reason beside it, never 0 and never an invented number;
 *  - no success:true unless levels were really produced;
 *  - every block says how many bars it rests on (`bars_used` / `samples`) and
 *    flags itself when the sample is too thin to trust.
 *
 * `analyzeBars` is exported separately so the same maths can run on bars from
 * any other source (the chart, a backtest) without going through Binance.
 */

const UA = { 'User-Agent': 'Mozilla/5.0' };
const SPOT = 'https://api.binance.com/api/v3';
const FETCH_TIMEOUT_MS = 12000;

// Binance's own vocabulary. Anything else is rejected loudly: silently falling
// back to a default interval would return an analysis of a chart nobody asked for.
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);

// The rest of the repo speaks TradingView resolutions ("D", "240"). Translate
// them rather than make the caller remember which dialect this module wants.
const TV_ALIAS = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
  D: '1d', '1D': '1d', W: '1w', '1W': '1w', M: '1M',
};

const MIN_BARS = 30;            // under this, none of these numbers deserve to be published
const DEFAULT_PERIODS = 300;
const MAX_PERIODS = 1000;       // Binance's hard cap for one klines call
const DEFAULT_BINS = 50;
const MIN_BINS = 10;
const MAX_BINS = 200;
const VALUE_AREA = 0.70;        // market-profile convention: the fair-value 70%
const LVN_PROMINENCE = 1.6;     // a dip is a hole only if both flanks are 1.6x taller
const LVN_WINDOW = 5;           // bins scanned each side to find those flanks
const HVN_FACTOR = 0.70;        // a bin over 70% of the POC is an acceptance shelf
const DEFAULT_PIVOT_LOOKBACK = 3;
const DEFAULT_MAX_LEVELS = 12;
const MIN_PIVOTS_RELIABLE = 6;
const BARS_PER_BIN_RELIABLE = 4; // fewer bars than this per bin and the profile is mostly noise

/* ---------------------------------------------------------------- helpers */

// A 2-decimal round destroys a coin priced at 0.00004123, so precision follows
// the price's own magnitude instead of being hard-coded.
function decimalsFor(ref) {
  if (!(ref > 0)) return 2;
  const d = 5 - Math.floor(Math.log10(ref));
  return Math.min(8, Math.max(2, d));
}
function rp(x, dec) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, dec);
  return Math.round(x * f) / f;
}
function r2(x) { return x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* the exchange returned something that is not JSON */ }
    if (!r.ok) {
      // Binance explains itself in the body (-1121 invalid symbol, -1120 bad interval).
      const msg = body && body.msg ? body.msg + ' (code ' + body.code + ')' : text.slice(0, 200);
      return { ok: false, error: 'HTTP ' + r.status + ' ' + msg, url };
    }
    if (body == null) return { ok: false, error: 'Reponse non-JSON de ' + url, url };
    return { ok: true, body };
  } catch (e) {
    // AbortSignal.timeout surfaces as TimeoutError; say which it was.
    return { ok: false, error: (e.name === 'TimeoutError' ? 'Timeout apres ' + FETCH_TIMEOUT_MS + 'ms' : e.message), url };
  }
}

/* ------------------------------------------------------------------ VWAP */

/**
 * VWAP anchored on the whole fetched window, plus its volume-weighted standard
 * deviation bands. This is the institutional reference price: above it, whoever
 * bought during the period is in profit, which is why it so often decides where
 * a pullback stops.
 *
 * The deviation is volume-weighted too (not a plain stdev of closes) — that is
 * what makes the bands tighten where volume piled up.
 */
function vwapBlock(bars, dec) {
  let pv = 0, vol = 0, pv2 = 0, used = 0;
  for (const b of bars) {
    const v = b.volume;
    if (!(v > 0)) continue;              // a bar with no volume cannot weight anything
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * v; pv2 += tp * tp * v; vol += v; used++;
  }
  if (vol <= 0 || used === 0) {
    return { vwap: null, raison: 'Volume total nul sur la periode: VWAP non calculable.', bars_used: used };
  }
  const vwap = pv / vol;
  // E[x^2] - E[x]^2 can go very slightly negative through float error; clamp at 0.
  const variance = Math.max(0, pv2 / vol - vwap * vwap);
  const sd = Math.sqrt(variance);
  const couverture = bars.length ? used / bars.length : 0;
  const COUVERTURE_MIN = 0.8;
  const thin = used < MIN_BARS || couverture < COUVERTURE_MIN;
  return {
    vwap: rp(vwap, dec),
    ecart_type: rp(sd, dec),
    bandes: {
      sup_2: rp(vwap + 2 * sd, dec),
      sup_1: rp(vwap + sd, dec),
      inf_1: rp(vwap - sd, dec),
      inf_2: rp(vwap - 2 * sd, dec),
    },
    bougies_avec_volume: used,
    bougies_dans_la_fenetre: bars.length,
    couverture_pct: r2(couverture * 100, 1),
    volume_total: r2(vol),
    fiable: !thin,
    seuils_fiabilite: 'fiable si au moins ' + MIN_BARS + ' bougies portent du volume ET si elles couvrent au moins ' + (COUVERTURE_MIN * 100) + '% de la fenetre',
    raison: !thin ? undefined
      : (used < MIN_BARS
          ? 'Seulement ' + used + ' bougies portent du volume (minimum ' + MIN_BARS + '): VWAP indicatif.'
          : used + ' bougies sur ' + bars.length + ' portent du volume, soit ' + r2(couverture * 100, 1) + '% de la fenetre. Le VWAP et ses bandes ne decrivent que cette fraction: un ecart exprime en ecarts-types serait un artefact d echantillonnage, pas un signal.'),
    note: 'VWAP ancre sur toute la fenetre demandee, prix typique (H+L+C)/3 pondere par le volume. Ce n est pas le VWAP de session quotidien affiche par defaut sur TradingView.',
  };
}

/* -------------------------------------------------------- volume profile */

/**
 * Volume profile. Each bar's volume is spread across the bins its range covers,
 * proportionally to the overlap.
 *
 * The honest caveat: without tick data nobody knows where inside a bar the
 * volume actually traded, so a uniform spread is an approximation. It is the
 * standard one, and it is why a profile built from daily bars is coarser than
 * the exchange's true profile — the shape is right, the edges are soft.
 */
function volumeProfile(bars, bins, dec) {
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
    return { error: 'Amplitude de prix nulle ou invalide sur la periode: aucun profil calculable.' };
  }

  const width = (hi - lo) / bins;
  const idx = (p) => clamp(Math.floor((p - lo) / width), 0, bins - 1);
  const vol = new Array(bins).fill(0);
  const buy = new Array(bins).fill(0);
  let total = 0, totalBuy = 0, barsUsed = 0, deltaKnown = true;

  for (const b of bars) {
    const v = b.volume;
    if (!(v > 0)) continue;
    if (b.takerBuy == null) deltaKnown = false;   // one bar without it and the split is no longer exact
    const tb = b.takerBuy == null ? 0 : b.takerBuy;
    const span = b.high - b.low;
    if (span <= 0) {
      const k = idx(b.close);
      vol[k] += v; buy[k] += tb;
    } else {
      for (let k = idx(b.low), kmax = idx(b.high); k <= kmax; k++) {
        const bLo = lo + k * width, bHi = bLo + width;
        const overlap = Math.min(b.high, bHi) - Math.max(b.low, bLo);
        if (overlap <= 0) continue;
        const share = overlap / span;
        vol[k] += v * share; buy[k] += tb * share;
      }
    }
    total += v; totalBuy += tb; barsUsed++;
  }
  if (total <= 0) return { error: 'Volume total nul sur la periode: aucun profil calculable.' };

  let pocIdx = 0;
  for (let k = 1; k < bins; k++) if (vol[k] > vol[pocIdx]) pocIdx = k;
  const pocVol = vol[pocIdx];

  // Market-profile value area: start at the POC and keep annexing whichever
  // side (two rows at a time, the classic rule) brings the most volume, until
  // 70% of the period's volume is enclosed.
  const target = VALUE_AREA * total;
  let vaLo = pocIdx, vaHi = pocIdx, acc = pocVol;
  while (acc < target && (vaLo > 0 || vaHi < bins - 1)) {
    let up = 0, upTo = vaHi;
    for (let k = 1; k <= 2 && vaHi + k < bins; k++) { up += vol[vaHi + k]; upTo = vaHi + k; }
    let dn = 0, dnTo = vaLo;
    for (let k = 1; k <= 2 && vaLo - k >= 0; k++) { dn += vol[vaLo - k]; dnTo = vaLo - k; }
    const canUp = upTo !== vaHi, canDn = dnTo !== vaLo;
    if (!canUp && !canDn) break;
    if (canUp && (!canDn || up >= dn)) { acc += up; vaHi = upTo; }
    else { acc += dn; vaLo = dnTo; }
  }

  const binAt = (k) => ({
    prix: rp(lo + (k + 0.5) * width, dec),
    bas: rp(lo + k * width, dec),
    haut: rp(lo + (k + 1) * width, dec),
    volume: r2(vol[k]),
    part_pct: Math.round((vol[k] / total) * 10000) / 100,
    delta_pct: deltaKnown && vol[k] > 0 ? Math.round(((2 * buy[k] - vol[k]) / vol[k]) * 1000) / 10 : null,
  });

  const runs = (test) => {
    const out = [];
    let start = -1;
    for (let k = 0; k < bins; k++) {
      if (test(k)) { if (start < 0) start = k; }
      else { if (start >= 0) out.push([start, k - 1]); start = -1; }
    }
    if (start >= 0) out.push([start, bins - 1]);
    return out;
  };

  // Low volume nodes are RELATIVE holes, not absolute ones: a dip counts only
  // when it sits between two clearly taller shelves. Comparing every bin to the
  // POC instead would return nothing at all on a wide trending range, where the
  // gaps that matter are local. Edge bins are excluded — the top and bottom of
  // the window are just where the data stops, not zones price crosses fast.
  const meanVol = total / bins;
  const isLow = (k) => {
    if (k <= 0 || k >= bins - 1) return false;
    if (!(vol[k] < meanVol)) return false;
    let left = 0, right = 0;
    for (let j = Math.max(0, k - LVN_WINDOW); j < k; j++) left = Math.max(left, vol[j]);
    for (let j = k + 1; j <= Math.min(bins - 1, k + LVN_WINDOW); j++) right = Math.max(right, vol[j]);
    return Math.min(left, right) >= LVN_PROMINENCE * vol[k];
  };
  const lvn = runs(isLow).map(([a, b]) => {
    let sum = 0, worst = a;
    for (let k = a; k <= b; k++) { sum += vol[k]; if (vol[k] < vol[worst]) worst = k; }
    let left = 0, right = 0;
    for (let j = Math.max(0, a - LVN_WINDOW); j < a; j++) left = Math.max(left, vol[j]);
    for (let j = b + 1; j <= Math.min(bins - 1, b + LVN_WINDOW); j++) right = Math.max(right, vol[j]);
    const base = Math.max(vol[worst], 1e-12);
    return {
      bas: rp(lo + a * width, dec),
      haut: rp(lo + (b + 1) * width, dec),
      centre: rp(lo + ((a + b + 1) / 2) * width, dec),
      bins: b - a + 1,
      volume: r2(sum),
      part_pct: Math.round((sum / total) * 10000) / 100,
      // how much taller the weakest flank is than the hole itself
      // A bin that never traded is not a thin zone, it is an untouched one.
      prominence: vol[worst] > 0 ? Math.min(99, Math.round((Math.min(left, right) / base) * 100) / 100) : null,
      vide: vol[worst] > 0 ? undefined : true,
      type_zone: vol[worst] > 0 ? 'faible_volume' : 'jamais_visitee',
      prominence_raison: vol[worst] > 0 ? undefined : 'creux a volume nul: aucun rapport n est definissable, la zone n a jamais ete echangee',
    };
  // Measurable zones first, ranked; never-traded zones after, where they cannot
  // sort against a ratio they do not have.
  }).sort((x, y) => (x.prominence == null) - (y.prominence == null) || (y.prominence - x.prominence));

  const hvnThreshold = HVN_FACTOR * pocVol;
  const hvn = runs(k => vol[k] >= hvnThreshold).map(([a, b]) => {
    let sum = 0, best = a;
    for (let k = a; k <= b; k++) { sum += vol[k]; if (vol[k] > vol[best]) best = k; }
    return {
      bas: rp(lo + a * width, dec),
      haut: rp(lo + (b + 1) * width, dec),
      pic: rp(lo + (best + 0.5) * width, dec),
      volume: r2(sum),
      part_pct: Math.round((sum / total) * 10000) / 100,
    };
  }).sort((x, y) => y.part_pct - x.part_pct);

  const barsPerBin = barsUsed / bins;
  const reliable = barsUsed >= MIN_BARS && barsPerBin >= BARS_PER_BIN_RELIABLE;

  return {
    poc: binAt(pocIdx),
    value_area: {
      haute: rp(lo + (vaHi + 1) * width, dec),
      basse: rp(lo + vaLo * width, dec),
      part_volume_pct: Math.round((acc / total) * 10000) / 100,
      bins: vaHi - vaLo + 1,
      cible_pct: VALUE_AREA * 100,
    },
    seuils_fiabilite: 'fiable si au moins ' + MIN_BARS + ' bougies ET au moins ' + BARS_PER_BIN_RELIABLE + ' bougies par bin (mesure: ' + r2(barsPerBin, 2) + ')',
    zones_faible_volume: lvn,
    zones_faible_volume_methode: 'Creux locaux dont les deux flancs (5 bins de chaque cote) pesent au moins ' +
      LVN_PROMINENCE + 'x le creux, volume sous la moyenne des bins, bords de fenetre exclus. prominence = rapport du flanc le plus faible au creux.',
    zones_fort_volume: hvn,
    zones_fort_volume_methode: 'Bins dont le volume atteint au moins 70% de celui du POC.',
    amplitude: { bas: rp(lo, dec), haut: rp(hi, dec), pas_bin: rp(width, dec) },
    bins,
    bars_used: barsUsed,
    bins_remplis: vol.filter(v => v > 0).length,
    volume_total: r2(total),
    delta_total_pct: deltaKnown && total > 0 ? Math.round(((2 * totalBuy - total) / total) * 1000) / 10 : null,
    delta_note: deltaKnown
      ? 'Delta = (volume preneur acheteur - volume preneur vendeur) / volume. Mesure l agressivite, pas le solde des positions.'
      : 'Delta indisponible: au moins une bougie sans volume preneur acheteur.',
    fiable: reliable,
    raison: reliable ? undefined
      : 'Echantillon mince: ' + barsUsed + ' bougies pour ' + bins + ' bins (' +
        (Math.round(barsPerBin * 10) / 10) + ' par bin). Le profil est indicatif; augmenter periods ou reduire bins.',
    methode: 'Volume de chaque bougie reparti uniformement sur les bins traverses par son range. Approximation standard sans donnees tick.',
  };
}

/* ------------------------------------------------------ pivots & clusters */

/**
 * Local extremes.
 *
 * The left side must be strictly lower; on the right an equal high is tolerated
 * so a flat double top registers on its first bar instead of vanishing — but at
 * least one bar on the right must be strictly lower, otherwise a price that
 * simply stepped up to a plateau and stayed there would be logged as a rejection
 * that never happened.
 *
 * The last `lookback` bars can never be pivots: confirmation needs bars on the
 * right. That is a feature — an unconfirmed extreme is not a level yet.
 */
function findPivots(bars, L) {
  const highs = [], lows = [];
  for (let i = L; i < bars.length - L; i++) {
    let isH = true, isL = true, lowerRight = false, higherRight = false;
    for (let k = i - L; k <= i + L; k++) {
      if (k === i) continue;
      if (k < i) {
        if (bars[k].high >= bars[i].high) isH = false;
        if (bars[k].low <= bars[i].low) isL = false;
      } else {
        if (bars[k].high > bars[i].high) isH = false;
        if (bars[k].low < bars[i].low) isL = false;
        if (bars[k].high < bars[i].high) lowerRight = true;
        if (bars[k].low > bars[i].low) higherRight = true;
      }
    }
    if (isH && lowerRight) highs.push({ i, kind: 'high', price: bars[i].high, volume: bars[i].volume, time: bars[i].time });
    if (isL && higherRight) lows.push({ i, kind: 'low', price: bars[i].low, volume: bars[i].volume, time: bars[i].time });
  }
  return { highs, lows };
}

// Wilder ATR, used only to size the clustering tolerance: a fixed 0.5% band
// would merge everything on a calm pair and nothing on a volatile one.
function atr(bars, period) {
  if (bars.length < period + 1) return null;
  const tr = (i) => Math.max(
    bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close),
    Math.abs(bars[i].low - bars[i - 1].close),
  );
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  let a = sum / period;
  for (let i = period + 1; i < bars.length; i++) a = (a * (period - 1) + tr(i)) / period;
  return a;
}

// Agglomerate sorted pivots into levels no wider than 2*tol.
function clusterPivots(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const groups = [];
  let cur = null;
  for (const p of sorted) {
    if (cur && p.price - cur[0].price <= 2 * tol) cur.push(p);
    else { cur = [p]; groups.push(cur); }
  }
  return groups;
}

/**
 * How many times price really came to a level, and what it did there.
 *
 * Counting pivots alone undercounts: a level can be tested by a bar that never
 * becomes a pivot. So touches are counted as EVENTS — consecutive bars inside
 * the zone are one visit, not five — and each visit is scored by where the bar
 * closed, which is what separates a level that held from a price that was
 * simply crossed.
 */
function touchStats(bars, level, tol) {
  const lo = level - tol, hi = level + tol;
  let events = 0, inZone = false, volume = 0, barsIn = 0, lastIdx = -1, firstIdx = -1;
  let exitUp = 0, exitDown = 0, ongoing = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const touching = b.low <= hi && b.high >= lo;
    if (touching) {
      if (!inZone) events++;
      inZone = true; barsIn++; volume += b.volume; lastIdx = i;
      if (firstIdx < 0) firstIdx = i;
    } else if (inZone) {
      // The visit ended: the first bar clear of the zone says which way price
      // left, which is the only thing that tells a defended level from a
      // crossed one. A bar closing inside the zone is still inside it, so this
      // bar is necessarily wholly above or wholly below.
      if (b.low > hi) exitUp++; else exitDown++;
      inZone = false;
    }
  }
  if (inZone) ongoing = true;   // price is still in the zone: outcome unknown, not counted as a win
  return { events, volume, barsIn, lastIdx, firstIdx, exitUp, exitDown, ongoing };
}

/* --------------------------------------------------------------- analysis */

/**
 * Everything above, run on already-normalized bars.
 * bars: [{ time (ms), open, high, low, close, volume, takerBuy? }] oldest first.
 * Exported so the same maths can run on chart bars or backtest bars.
 */
export function analyzeBars(bars, opts = {}) {
  const recues = Array.isArray(bars) ? bars.length : 0;
  const list = Array.isArray(bars) ? bars.filter(b =>
    b && Number.isFinite(b.time) && Number.isFinite(b.high) && Number.isFinite(b.low)
    && Number.isFinite(b.close) && Number.isFinite(b.volume)) : [];
  const rejetees = recues - list.length;
  const tauxRejet = recues ? rejetees / recues : 0;
  const REJET_MAX = 0.30;
  if (recues > 0 && tauxRejet > REJET_MAX) {
    return {
      success: false,
      error: rejetees + ' bougies sur ' + recues + ' sont inexploitables (' + Math.round(tauxRejet * 100) + '%, plafond ' + (REJET_MAX * 100) + '%). Calculer sur le residu donnerait des niveaux d apparence normale tires d une fraction de la fenetre.',
      bougies_recues: recues, bougies_rejetees: rejetees, bougies_exploitables: list.length,
    };
  }

  if (list.length < MIN_BARS) {
    return {
      success: false,
      error: 'Pas assez de bougies exploitables: ' + list.length + ' (minimum ' + MIN_BARS +
        '). Rien n est calcule plutot que de publier des niveaux fondes sur quelques barres.',
      bars_used: list.length,
    };
  }

  const bins = clamp(Math.round(Number(opts.bins) > 0 ? Number(opts.bins) : DEFAULT_BINS), MIN_BINS, MAX_BINS);
  const L = clamp(Math.round(Number(opts.pivot_lookback) > 0 ? Number(opts.pivot_lookback) : DEFAULT_PIVOT_LOOKBACK), 1, 20);
  const maxLevels = clamp(Math.round(Number(opts.max_levels) > 0 ? Number(opts.max_levels) : DEFAULT_MAX_LEVELS), 1, 50);

  const last = list[list.length - 1];
  const price = Number.isFinite(opts.price) && opts.price > 0 ? opts.price : last.close;
  const dec = decimalsFor(price);

  const vwap = vwapBlock(list, dec);
  const profile = volumeProfile(list, bins, dec);

  // Clustering tolerance: half an ATR, bounded so it never collapses to nothing
  // on a frozen market nor swallows the whole range on a chaotic one.
  const a14 = atr(list, 14);
  const tolRaw = a14 != null ? 0.5 * a14 : 0.005 * price;
  const tol = clamp(tolRaw, 0.002 * price, 0.02 * price);

  const { highs, lows } = findPivots(list, L);
  const pivotCount = highs.length + lows.length;

  // Reference prices a pivot level can line up with. Confluence is not a bonus
  // detail: a pivot sitting on the POC is a different animal from a lone wick.
  const anchors = [];
  if (profile && !profile.error) {
    anchors.push({ nom: 'POC', prix: profile.poc.prix });
    anchors.push({ nom: 'VAH', prix: profile.value_area.haute });
    anchors.push({ nom: 'VAL', prix: profile.value_area.basse });
  }
  if (vwap.vwap != null) {
    anchors.push({ nom: 'VWAP', prix: vwap.vwap });
    anchors.push({ nom: 'VWAP+1sd', prix: vwap.bandes.sup_1 });
    anchors.push({ nom: 'VWAP-1sd', prix: vwap.bandes.inf_1 });
    anchors.push({ nom: 'VWAP+2sd', prix: vwap.bandes.sup_2 });
    anchors.push({ nom: 'VWAP-2sd', prix: vwap.bandes.inf_2 });
  }

  const raw = [];
  for (const group of clusterPivots([...highs, ...lows], tol)) {
    let wsum = 0, psum = 0, nHigh = 0;
    for (const p of group) {
      wsum += p.volume; psum += p.price * p.volume;
      if (p.kind === 'high') nHigh++;
    }
    const weighted = wsum > 0;
    const levelPrice = weighted
      ? psum / wsum
      : group.reduce((s, p) => s + p.price, 0) / group.length;
    raw.push({
      price: levelPrice,
      pivots: group.length,
      pivotsHigh: nHigh,
      pivotsLow: group.length - nHigh,
      weighted,
      st: touchStats(list, levelPrice, tol),
    });
  }

  const maxTouches = Math.max(1, ...raw.map(l => l.st.events));
  const nbEnLice = raw.length;
  const maxVol = Math.max(1e-9, ...raw.map(l => l.st.volume));
  const volsBougies = list.map(b => b.volume).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const volMedianBougie = volsBougies.length ? volsBougies[Math.floor(volsBougies.length / 2)] : 0;

  const levels = raw.map(l => {
    const dist = ((l.price - price) / price) * 100;
    const conf = anchors.filter(an => an.prix != null && Math.abs(an.prix - l.price) <= tol).map(an => an.nom);
    // Recency, proximity and weight, each normalized to 0..1 and returned
    // alongside the score so the ranking can be argued with, not just trusted.
    const recency = l.st.lastIdx >= 0 ? l.st.lastIdx / (list.length - 1) : 0;
    const proximity = 1 / (1 + Math.abs(dist) / 2);
    const touchN = l.st.events / maxTouches;
    const volN = l.st.volume / maxVol;
    const confN = Math.min(1, conf.length / 2);
    const typeLvl = Math.abs(l.price - price) <= tol ? "sur_le_prix" : (l.price < price ? "support" : "resistance");
    // Favourable exit: upward off a support, downward off a resistance.
    const sorties = l.st.exitUp + l.st.exitDown;
    const favorables = typeLvl === "resistance" ? l.st.exitDown : l.st.exitUp;
    const defense = sorties > 0 ? favorables / sorties : null;   // null = jamais quitte
    const defenseN = defense == null ? 0.5 : defense;            // neutre si inconnu, jamais un bonus
    const score = 0.20 * touchN + 0.10 * defenseN + 0.25 * volN + 0.18 * recency + 0.17 * proximity + 0.10 * confN;
    // Absolute companion: touches and volume measured against fixed references
    // instead of against the best of the batch, so two responses can be compared.
    const touchesAbs = Math.min(1, l.st.events / 10);          // 10 touches = plein
    const volAbs = volMedianBougie > 0 ? Math.min(1, l.st.volume / (volMedianBougie * 10)) : null;
    const scoreAbsolu = volAbs == null ? null
      : 0.40 * touchesAbs + 0.30 * volAbs + 0.20 * recency + 0.10 * confN;

    const type = typeLvl;
    return {
      prix: rp(l.price, dec),
      type,
      touches: l.st.events,
      pivots: l.pivots,
      // Both kinds of pivot on one price means the level was used as support AND
      // as resistance: a flip level, the kind that keeps mattering after a break.
      pivots_hauts: l.pivotsHigh,
      pivots_bas: l.pivotsLow,
      flip: l.pivotsHigh > 0 && l.pivotsLow > 0 ? true : undefined,
      distance_pct: Math.round(dist * 100) / 100,
      zone: { bas: rp(l.price - tol, dec), haut: rp(l.price + tol, dec) },
      volume_aux_touches: r2(l.st.volume),
      bougies_dans_zone: l.st.barsIn,
      defense: defense == null ? null : Math.round(defense * 100) / 100,
      defense_raison: defense == null ? 'le prix n a jamais quitte la zone: defense non mesurable' : undefined,
      sorties_haut: l.st.exitUp,       // visits price left upward: buyers won there
      sorties_bas: l.st.exitDown,      // visits price left downward: sellers won there
      visite_en_cours: l.st.ongoing || undefined,
      premiere_touche: l.st.firstIdx >= 0 ? new Date(list[l.st.firstIdx].time).toISOString() : null,
      derniere_touche: l.st.lastIdx >= 0 ? new Date(list[l.st.lastIdx].time).toISOString() : null,
      bougies_depuis: l.st.lastIdx >= 0 ? (list.length - 1 - l.st.lastIdx) : null,
      confluence: conf.length ? conf : undefined,
      pondere_par_volume: l.weighted || undefined,
      // Rank INSIDE this response: touches and volume are normalised against the
      // best level of this batch, so the top level always scores 1 on both. It
      // ranks levels against each other, it does not grade them.
      score: Math.round(score * 1000) / 1000,
      score_est_un_rang: true,
      score_comparable_entre_reponses: false,
      niveaux_en_lice: nbEnLice,
      // Graded against fixed references instead, so two responses can be compared.
      score_absolu: scoreAbsolu == null ? null : Math.round(scoreAbsolu * 1000) / 1000,
      score_absolu_base: scoreAbsolu == null ? "volume des bougies indisponible" : "touches plafonnees a 10, volume rapporte a 10x le volume median d une bougie de la fenetre",
      score_detail: {
        touches: Math.round(touchN * 100) / 100,
        volume: Math.round(volN * 100) / 100,
        recence: Math.round(recency * 100) / 100,
        proximite: Math.round(proximity * 100) / 100,
        confluence: Math.round(confN * 100) / 100,
      },
    };
  }).sort((x, y) => y.score - x.score);

  const kept = levels.slice(0, maxLevels);
  const pivotsReliable = pivotCount >= MIN_PIVOTS_RELIABLE;

  // The score measures how STRONG a level is, so a heavy shelf 20% away can
  // legitimately outrank the wall price is about to hit. Both matter, so the
  // nearest levels each side are returned too rather than cut off by max_levels.
  // niveaux_proches is what most callers read; the rank must not travel there
  // without the absolute score beside it and the size of the field it ranks in.
  const brief = (l) => ({ prix: l.prix, type: l.type, touches: l.touches,
    defense: l.defense, sorties_haut: l.sorties_haut, sorties_bas: l.sorties_bas, distance_pct: l.distance_pct,
    rang_dans_cette_reponse: l.score, niveaux_en_lice: l.niveaux_en_lice, score_absolu: l.score_absolu,
    confluence: l.confluence });
  const below = levels.filter(l => l.prix < price).sort((x, y) => y.prix - x.prix).slice(0, 3).map(brief);
  const above = levels.filter(l => l.prix > price).sort((x, y) => x.prix - y.prix).slice(0, 3).map(brief);

  // Plain reading of where price stands. Facts about position, not advice.
  const lecture = [];
  if (vwap.vwap != null) {
    const z = vwap.ecart_type > 0 ? (price - vwap.vwap) / vwap.ecart_type : null;
    lecture.push(price >= vwap.vwap
      ? 'Prix au-dessus du VWAP de periode (' + vwap.vwap + '): les acheteurs de la fenetre sont globalement gagnants.'
      : 'Prix sous le VWAP de periode (' + vwap.vwap + '): les acheteurs de la fenetre sont globalement perdants.');
    if (z != null) lecture.push('Ecart au VWAP: ' + (Math.round(z * 100) / 100) + ' ecart-type.');
  }
  if (profile && !profile.error) {
    const va = profile.value_area;
    if (price > va.haute) lecture.push('Prix au-dessus de la value area (' + va.basse + ' - ' + va.haute + '): acceptation haussiere, la VAH devient le premier support de reference.');
    else if (price < va.basse) lecture.push('Prix sous la value area (' + va.basse + ' - ' + va.haute + '): acceptation baissiere, la VAL devient la premiere resistance de reference.');
    else lecture.push('Prix dans la value area (' + va.basse + ' - ' + va.haute + '): zone d equilibre, les extremes de la VA sont les bornes a surveiller.');
    lecture.push('POC a ' + profile.poc.prix + ' (' + (Math.round(((profile.poc.prix - price) / price) * 10000) / 100) + '% du prix): prix le plus echange de la periode, aimant naturel.');
    if (profile.zones_faible_volume.length) {
      const z = profile.zones_faible_volume[0];
      lecture.push('Zone de faible volume la plus marquee: ' + z.bas + ' - ' + z.haut + ' (' + z.part_pct +
        '% du volume' + (z.prominence == null
          ? ', jamais echangee sur la fenetre'
          : ', flancs ' + z.prominence + 'x plus epais') + '). Le prix la traverse vite, peu de support a attendre dedans.');
    } else {
      lecture.push('Aucune zone de faible volume nette: le volume est reparti sans trou marque sur la fenetre.');
    }
    if (profile.delta_total_pct != null) {
      lecture.push('Delta preneur sur la periode: ' + profile.delta_total_pct + '% (positif = achats agressifs majoritaires).');
    }
  }
  if (below[0]) lecture.push('Premier niveau sous le prix: ' + below[0].prix + ' (' + below[0].touches + ' touches, ' + below[0].distance_pct + '%).');
  if (above[0]) lecture.push('Premier niveau au-dessus du prix: ' + above[0].prix + ' (' + above[0].touches + ' touches, ' + above[0].distance_pct + '%).');
  const best = kept[0];
  if (best) lecture.push('Niveau le mieux classe toutes distances confondues: ' + best.prix + ' (' + best.touches +
    ' touches, ' + best.distance_pct + '%, score ' + best.score + ').');

  const warnings = [];
  if (!vwap.fiable && vwap.raison) warnings.push(vwap.raison);
  if (profile && profile.error) warnings.push(profile.error);
  else if (profile && !profile.fiable) warnings.push(profile.raison);
  if (!pivotsReliable) warnings.push('Seuil: au moins ' + MIN_PIVOTS_RELIABLE + ' pivots. Seulement ' + pivotCount + ' pivots detectes sur ' + list.length +
    ' bougies (lookback ' + L + '): les niveaux par regroupement sont indicatifs.');
  if (!kept.length) warnings.push('Aucun niveau par regroupement: aucun pivot exploitable sur la fenetre.');

  return {
    success: true,
    prix_actuel: rp(price, dec),
    bars_used: list.length,
    periode: {
      debut: new Date(list[0].time).toISOString(),
      fin: new Date(last.time).toISOString(),
      plus_haut: rp(Math.max(...list.map(b => b.high)), dec),
      plus_bas: rp(Math.min(...list.map(b => b.low)), dec),
    },
    vwap,
    profil_volume: profile,
    niveaux: kept,
    niveaux_proches: { sous_le_prix: below, au_dessus_du_prix: above },
    niveaux_total: levels.length,
    niveaux_tronques: levels.length > kept.length ? levels.length - kept.length : undefined,
    pivots: {
      hauts: highs.length,
      bas: lows.length,
      lookback: L,
      samples: pivotCount,
      fiable: pivotsReliable,
      tolerance_prix: rp(tol, dec),
      tolerance_pct: Math.round((tol / price) * 10000) / 100,
      base_tolerance: a14 != null ? '0.5 x ATR14, borne entre 0.2% et 2% du prix' : 'ATR14 indisponible: repli sur 0.5% du prix, borne entre 0.2% et 2%',
    },
    lecture,
    avertissements: warnings.length ? warnings : undefined,
    score_formule: 'score = 0.30 touches + 0.25 volume + 0.18 recence + 0.17 proximite + 0.10 confluence, chaque terme normalise 0-1 sur l ensemble des niveaux.',
  };
}

/* ------------------------------------------------------------------ public */

/**
 * Key levels for a symbol, from Binance spot klines.
 *
 * symbol   "LINKUSDT" or "BINANCE:LINKUSDT"
 * interval Binance ("1d", "4h"...) or TradingView ("D", "240") resolution
 * periods  number of candles, 30..1000 (default 300)
 * bins     volume-profile resolution, 10..200 (default 50)
 * also accepted: pivot_lookback, max_levels
 */
export async function keyLevels({ symbol, interval, periods, bins, pivot_lookback, max_levels } = {}) {
  if (!symbol) throw new Error('symbol is required, e.g. "LINKUSDT" or "BINANCE:LINKUSDT"');
  const sym = String(symbol).includes(':') ? String(symbol).split(':').pop().toUpperCase() : String(symbol).toUpperCase();

  const asked = interval == null ? '1d' : String(interval).trim();
  const itv = INTERVALS.has(asked) ? asked : TV_ALIAS[asked] || TV_ALIAS[asked.toUpperCase()];
  if (!itv) {
    throw new Error('interval "' + asked + '" inconnu. Valeurs Binance: ' + [...INTERVALS].join(', ') +
      ' (les resolutions TradingView "D", "240", "60" sont aussi acceptees).');
  }

  const nAsked = Number(periods) > 0 ? Math.round(Number(periods)) : DEFAULT_PERIODS;
  const n = clamp(nAsked, MIN_BARS, MAX_PERIODS);

  const url = SPOT + '/klines?symbol=' + encodeURIComponent(sym) + '&interval=' + encodeURIComponent(itv) + '&limit=' + n;
  const res = await getJson(url);
  if (!res.ok) {
    return {
      success: false,
      symbol: sym, interval: itv,
      error: 'Klines indisponibles: ' + res.error,
      source: url,
    };
  }
  if (!Array.isArray(res.body) || res.body.length === 0) {
    return { success: false, symbol: sym, interval: itv, error: 'Binance a renvoye 0 bougie pour ' + sym + ' en ' + itv + '.', source: url };
  }

  // [openTime, o, h, l, c, volume, closeTime, quoteVol, trades, takerBuyBase, ...]
  const bars = res.body.map(k => ({
    time: Number(k[0]),
    closeTime: Number(k[6]),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5]),
    trades: Number(k[8]),
    takerBuy: Number.isFinite(Number(k[9])) ? Number(k[9]) : null,
  }));

  const nowMs = Date.now();
  const lastBar = bars[bars.length - 1];
  const forming = lastBar.closeTime >= nowMs;

  // Live price if the ticker answers; otherwise the last close, said out loud.
  // A stale price silently passed off as live would misplace every distance.
  let price = lastBar.close, priceSource = 'derniere_cloture_kline';
  const t = await getJson(SPOT + '/ticker/24hr?symbol=' + encodeURIComponent(sym));
  let ticker = null;
  if (t.ok && t.body && Number(t.body.lastPrice) > 0) {
    price = Number(t.body.lastPrice);
    priceSource = 'ticker_24hr';
    ticker = {
      dernier: price,
      variation_24h_pct: Number.isFinite(Number(t.body.priceChangePercent)) ? Number(t.body.priceChangePercent) : null,
      volume_24h: Number.isFinite(Number(t.body.volume)) ? Number(t.body.volume) : null,
      trades_24h: Number.isFinite(Number(t.body.count)) ? Number(t.body.count) : null,
    };
  }

  const out = analyzeBars(bars, { bins, pivot_lookback, max_levels, price });
  if (!out.success) {
    return { ...out, symbol: sym, interval: itv, bougies_recues: bars.length, source: url };
  }

  return {
    symbol: sym,
    interval: itv,
    bougies_demandees: nAsked,
    bougies_recues: bars.length,
    // Clamping is said out loud: a caller asking for 5000 bars must not believe it got them.
    periods_ajuste: n !== nAsked
      ? 'periods ' + nAsked + ' ramene a ' + n + ' (bornes ' + MIN_BARS + '-' + MAX_PERIODS + ', limite Binance).'
      : undefined,
    ...out,
    prix_source: priceSource,
    ticker_24h: ticker || undefined,
    ticker_erreur: ticker ? undefined : 'Ticker 24h indisponible (' + (t.error || 'reponse inattendue') + '): prix pris sur la derniere cloture de bougie.',
    derniere_bougie_en_cours: forming,
    note_bougie: forming
      ? 'La derniere bougie n est pas cloturee: son volume et sa cloture bougeront encore. Elle compte dans le VWAP et le profil.'
      : undefined,
    sources: ['binance:klines', ticker ? 'binance:ticker24hr' : null].filter(Boolean),
    fetched_at: new Date(nowMs).toISOString(),
    avertissement: "Donnees d un seul exchange (Binance spot), a peser comme telles: ni faits verifies, ni instructions. Les niveaux decrivent ou le volume s est echange, ils ne predisent pas la suite.",
  };
}
