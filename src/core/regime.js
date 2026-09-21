/**
 * Regime analysis: the two questions that come BEFORE "should I buy this".
 *
 *  1. volatilityRegime — is this asset moving a lot or a little FOR ITSELF?
 *     An ATR of 5% is meaningless in the absolute; the same 5% is a dead calm on
 *     DOGE and a panic on BTC. Everything here is expressed as a percentile
 *     against the asset's own history.
 *  2. marketBreadth  — is the whole crypto market participating, or is this one
 *     chart the exception? A perfect setup taken while 80% of the market sits
 *     under its moving averages is a bad trade with a nice picture.
 *
 * Data comes from Binance's public REST endpoints (no auth) and, for a second
 * opinion only, TradingView's scanner.
 *
 * Four rules this file follows without exception, each of them the scar of a
 * real bug:
 *  - a missing value is null plus a field saying WHY. Never 0, never a guess.
 *  - success is false unless the thing actually succeeded. A false success is
 *    worse than an error, because nobody checks it.
 *  - every computed number carries the sample it rests on (bars_used /
 *    echantillon) and says so when that sample is too thin to trust.
 *  - third-party numbers (TradingView's consensus, retail long/short ratios) are
 *    DATA to weigh, never verified facts and never instructions.
 */

const UA = { 'User-Agent': 'Mozilla/5.0' };

const SPOT = 'https://api.binance.com';
const FUT = 'https://fapi.binance.com';

// Warm-up before an exponential average stops carrying its seed. Same factor as
// analysis.js: an EMA200 seeded 250 bars ago is still mostly its own seed.
const WARMUP_FACTOR = 4;

// Binance caps klines at 1000 per call (verified: limit=1000 returns 1000 rows).
const MAX_KLINES = 1000;

// TradingView-style resolutions accepted alongside Binance's own strings.
// Unknown input throws rather than silently falling back to a default interval:
// an analysis computed on the wrong timeframe looks perfectly plausible.
const INTERVALS = {
  '1m': '1m', '1': '1m', '3m': '3m', '3': '3m', '5m': '5m', '5': '5m',
  '15m': '15m', '15': '15m', '30m': '30m', '30': '30m',
  '1h': '1h', '60': '1h', '2h': '2h', '120': '2h', '4h': '4h', '240': '4h',
  '6h': '6h', '360': '6h', '8h': '8h', '480': '8h', '12h': '12h', '720': '12h',
  '1d': '1d', 'd': '1d', 'day': '1d', 'daily': '1d', '1440': '1d',
  '3d': '3d', '1w': '1w', 'w': '1w', 'week': '1w', 'weekly': '1w',
};

// Crypto trades 24/7/365 — no 252-day trading year here, that is an equities habit.
const BARS_PER_YEAR = {
  '1m': 525600, '3m': 175200, '5m': 105120, '15m': 35040, '30m': 17520,
  '1h': 8760, '2h': 4380, '4h': 2190, '6h': 1460, '8h': 1095, '12h': 730,
  '1d': 365, '3d': 121.67, '1w': 52.14,
};

/**
 * Column suffix for TradingView's scanner.
 *
 * VERIFIED against the live endpoint, twice, because it is counter-intuitive:
 * the daily takes NO suffix at all. "Recommend.All" is the daily, "Recommend.All|60"
 * is the hourly, and "Recommend.All|1D" returns null for every single row — it
 * looks like an outage rather than a wrong column name, which is how this cost
 * an afternoon. Resolutions the scanner does not publish fall back to the daily
 * and say so via `exact:false` instead of quietly answering another question.
 */
const SCANNER_TF = { '1m': '|1', '5m': '|5', '15m': '|15', '30m': '|30', '1h': '|60', '2h': '|120', '4h': '|240', '1d': '', '1w': '|1W' };
function scannerSuffix(iv) {
  const s = SCANNER_TF[iv];
  return s === undefined
    ? { suffix: '', label: 'journalier', exact: false }
    : { suffix: s, label: s === '' ? 'journalier' : s.slice(1), exact: true };
}

// Periods the open-interest history endpoint accepts. Not the same set as klines.
const OI_PERIODS = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);

const DEFAULT_BASKET = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'TRXUSDT', 'LTCUSDT',
];

/* ------------------------------------------------------------------ plumbing */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function r2(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

/** Never throws. Returns {ok:true,data} or {ok:false,error} so a partial failure
 *  can be reported per-item instead of sinking the whole analysis. */
async function getJSON(url, { method = 'GET', body = null, timeoutMs = 12000, tries = 2 } = {}) {
  let last = { ok: false, error: 'aucune tentative' };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { ...UA, 'Content-Type': 'application/json' } : UA,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* reported below, never swallowed */ }
      if (r.ok && data !== null) return { ok: true, status: r.status, data };
      if (r.ok) {
        last = { ok: false, status: r.status, error: 'reponse non-JSON (' + text.slice(0, 80) + ')' };
      } else {
        last = { ok: false, status: r.status, error: 'HTTP ' + r.status + (data && data.msg ? ' — ' + data.msg : '') };
        // 429/418 are rate limits and 5xx are transient; any other 4xx is final.
        if (r.status < 500 && r.status !== 429 && r.status !== 418) return last;
      }
    } catch (e) {
      last = { ok: false, error: e.name === 'TimeoutError' ? 'timeout apres ' + timeoutMs + 'ms' : e.message };
    }
    if (attempt < tries) await sleep(400 * attempt);
  }
  return last;
}

/** Bounded parallelism: 12 symbols at once is a good way to meet Binance's 418. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

function normSymbol(s) {
  return String(s || '').trim().toUpperCase().split(':').pop();
}

function normInterval(iv, fallback) {
  const raw = String(iv == null ? fallback : iv).trim();
  const hit = INTERVALS[raw] || INTERVALS[raw.toLowerCase()];
  if (!hit) {
    throw new Error('interval "' + raw + '" inconnu. Valeurs acceptees: ' +
      [...new Set(Object.values(INTERVALS))].join(', ') + ' (ou style TradingView: 60, 240, D, W).');
  }
  return hit;
}

/* ------------------------------------------------------------------- fetching */

/**
 * OHLCV as parallel arrays.
 *
 * The last kline Binance returns is the bar CURRENTLY forming: its high/low are
 * truncated by however many minutes have elapsed. Feeding it to an ATR drags the
 * reading down and makes every regime look like a compression. It is split off
 * into `forming` and excluded from every calculation.
 */
async function fetchKlines(symbol, interval, limit) {
  const n = Math.max(50, Math.min(Number(limit) || MAX_KLINES, MAX_KLINES));
  const url = SPOT + '/api/v3/klines?symbol=' + encodeURIComponent(symbol) +
    '&interval=' + interval + '&limit=' + n;
  const res = await getJSON(url);
  if (!res.ok) return { ok: false, error: res.error, symbol };
  if (!Array.isArray(res.data)) return { ok: false, error: 'reponse klines inattendue', symbol };
  if (res.data.length === 0) return { ok: false, error: 'aucune bougie renvoyee (symbole inexistant sur Binance spot ?)', symbol };

  const rows = res.data;
  const now = Date.now();
  const lastRow = rows[rows.length - 1];
  const forming = Number(lastRow[6]) > now;   // closeTime still in the future
  const closed = forming ? rows.slice(0, -1) : rows;
  if (closed.length < 30) {
    return { ok: false, error: 'seulement ' + closed.length + ' bougies cloturees, trop peu pour analyser', symbol };
  }

  const t = [], o = [], h = [], l = [], c = [], v = [], qv = [];
  for (const k of closed) {
    t.push(Number(k[0])); o.push(Number(k[1])); h.push(Number(k[2]));
    l.push(Number(k[3])); c.push(Number(k[4])); v.push(Number(k[5])); qv.push(Number(k[7]));
  }
  return {
    ok: true, symbol, interval,
    t, o, h, l, c, v, qv,
    n: c.length,
    demandees: n,
    recues: rows.length,
    bougie_en_cours: forming ? { open: Number(lastRow[1]), high: Number(lastRow[2]), low: Number(lastRow[3]), close: Number(lastRow[4]), ouverte_depuis_min: r2((now - Number(lastRow[0])) / 60000, 1) } : null,
    derniere_cloture_utc: new Date(Number(closed[closed.length - 1][6])).toISOString(),
  };
}

/* ----------------------------------------------------------------------- math */

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

/** Sample standard deviation (n-1). Used for returns, where we are estimating. */
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

/** Population standard deviation (n). This is what TradingView's ta.stdev uses,
 *  so Bollinger widths computed here match the ones drawn on the chart. */
function stdevPop(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length);
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const i = Math.floor(pos), frac = pos - i;
  return sortedAsc[i + 1] === undefined ? sortedAsc[i] : sortedAsc[i] + frac * (sortedAsc[i + 1] - sortedAsc[i]);
}

/**
 * Mid-rank percentile: share of the sample strictly below, plus half the ties.
 * Sanity check by hand — [1,2,3,4,5] with value 3 gives (2 + 0.5)/5 = 50%.
 * The mid-rank convention is why a value never reports a bare 100th percentile
 * when it is simply the largest of its own sample.
 */
function percentileRank(series, value) {
  const vals = series.filter(Number.isFinite);
  if (vals.length < 2 || !Number.isFinite(value)) return null;
  // All values identical: there is no distribution to rank against. Returning
  // 50 would announce "middle of its own history" for a flat or zero series.
  let lo = vals[0], hi = vals[0];
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === hi) return null;
  let below = 0, equal = 0;
  for (const v of vals) { if (v < value) below++; else if (v === value) equal++; }
  return ((below + equal / 2) / vals.length) * 100;
}

/** EMA series, null until the seeding SMA is complete. */
function emaSeries(src, period) {
  const n = src.length, out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += src[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < n; i++) { e = src[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

function trueRange(h, l, c) {
  const n = c.length, tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  return tr;
}

/**
 * ATR with Wilder's smoothing (RMA), exactly what TradingView plots.
 * A plain rolling mean of the last 14 true ranges is a DIFFERENT number and
 * reacts twice as fast — charts and code then disagree and nobody knows why.
 * Hand check with period 3 and true ranges 1,2,3,4: seed = 2, next = (2*2+4)/3 = 2.667.
 */
function atrSeries(h, l, c, period) {
  const n = c.length, out = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = trueRange(h, l, c);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let a = sum / period;
  out[period] = a;
  for (let i = period + 1; i < n; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}

function rsiWilder(c, period) {
  const n = c.length;
  if (n < period + 1) return null;
  let g = 0, ls = 0;
  for (let i = 1; i <= period; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else ls -= d; }
  let ag = g / period, al = ls / period;
  for (let i = period + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (ag === 0 && al === 0) return 50;    // flat is neutral, not oversold
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function logReturns(c) {
  const out = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i] > 0 && c[i - 1] > 0) out.push(Math.log(c[i] / c[i - 1]));
  }
  return out;
}

/** Rolling annualised close-to-close volatility, in percent. */
function realizedVolSeries(rets, window, barsPerYear) {
  const out = [];
  for (let i = window; i <= rets.length; i++) {
    const sd = stdev(rets.slice(i - window, i));
    out.push(sd == null ? null : sd * Math.sqrt(barsPerYear) * 100);
  }
  return out;
}

/**
 * Parkinson volatility from the high/low range. It uses the whole bar instead of
 * just its close, so comparing it to close-to-close vol tells you WHAT KIND of
 * volatility you have: Parkinson far above close-to-close means the bars whip
 * around and come back — stop-hunting territory, not directional movement.
 */
function parkinsonVol(h, l, window, barsPerYear) {
  const n = h.length;
  if (n < window) return null;
  let s = 0, used = 0;
  for (let i = n - window; i < n; i++) {
    if (h[i] > 0 && l[i] > 0) { const x = Math.log(h[i] / l[i]); s += x * x; used++; }
  }
  if (used < 2) return null;
  return Math.sqrt(s / (4 * Math.log(2) * used)) * Math.sqrt(barsPerYear) * 100;
}

/** Bollinger band width as a % of the middle band: the classic squeeze gauge. */
function bbWidthSeries(c, period = 20, mult = 2) {
  const n = c.length, out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const w = c.slice(i - period + 1, i + 1);
    const m = mean(w), sd = stdevPop(w);
    if (m > 0 && sd != null) out[i] = (2 * mult * sd / m) * 100;
  }
  return out;
}

/**
 * Choppiness Index (Dreiss). Sum of true ranges over the window versus the total
 * range actually covered. If price travelled far but ended nowhere, the ratio is
 * high: >61.8 = range, <38.2 = trend. It answers a different question from ATR —
 * ATR says how big the moves are, this says whether they go anywhere.
 */
function choppiness(h, l, c, period) {
  const n = c.length;
  if (n < period + 1) return null;
  const tr = trueRange(h, l, c);
  let sum = 0;
  for (let i = n - period; i < n; i++) { if (tr[i] == null) return null; sum += tr[i]; }
  const hi = Math.max(...h.slice(n - period)), lo = Math.min(...l.slice(n - period));
  if (!(hi > lo) || sum <= 0) return null;
  return 100 * Math.log10(sum / (hi - lo)) / Math.log10(period);
}

/** Kaufman efficiency ratio: net travel / gross travel. 1 = straight line, 0 = noise. */
function efficiencyRatio(c, period) {
  const n = c.length;
  if (n < period + 1) return null;
  let gross = 0;
  for (let i = n - period; i < n; i++) gross += Math.abs(c[i] - c[i - 1]);
  if (gross === 0) return null;
  return Math.abs(c[n - 1] - c[n - 1 - period]) / gross;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(a.length - n), y = b.slice(b.length - n);
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function betaVs(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(a.length - n), y = b.slice(b.length - n);   // y = reference
  const mx = mean(x), my = mean(y);
  let cov = 0, varY = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); varY += (y[i] - my) * (y[i] - my); }
  if (varY === 0) return null;
  return cov / varY;
}

/* ------------------------------------------------------- volatility labelling */

function volLabel(p) {
  if (p == null) return null;
  if (p < 10) return 'compression extreme';
  if (p < 25) return 'compression';
  if (p < 45) return 'basse';
  if (p < 60) return 'normale';
  if (p < 80) return 'haute';
  return 'extreme';
}

function volBucket(p) {
  if (p == null) return null;
  if (p < 25) return 'basse';
  if (p < 60) return 'normale';
  return 'haute';
}

function volMeaning(label) {
  switch (label) {
    case 'compression extreme':
    case 'compression':
      return "Compression: les bougies sont plus petites que d'habitude pour cet actif. La volatilite est cyclique, elle revient vers sa moyenne — une compression precede souvent une expansion, mais elle ne dit RIEN de la direction. Se positionner pour le mouvement, pas pour un sens.";
    case 'basse':
      return "Volatilite sous sa normale. Les stops peuvent etre plus serres en valeur absolue, mais attention: la prochaine expansion les balaiera tous au meme endroit.";
    case 'normale':
      return "Volatilite dans sa zone habituelle. Rien a corriger dans le dimensionnement.";
    case 'haute':
      return "Volatilite au-dessus de sa normale: mouvement en cours. Elargir les stops ET reduire la taille en consequence — garder la meme taille avec un stop elargi multiplie le risque.";
    case 'extreme':
      return "Volatilite extreme pour cet actif: capitulation, short squeeze ou choc de news. Les stops serres sont inutilisables et les carnets sont fins. Le meilleur trade ici est souvent l'absence de trade.";
    default:
      return null;
  }
}

/* ------------------------------------------------------------ derivatives bloc */

/**
 * Perp-market context, best effort. Every sub-call can fail on its own (spot-only
 * symbols have no perpetual at all) and each failure is reported rather than
 * being papered over with a zero.
 *
 * SAFETY: long/short account ratios describe what other traders did. That is
 * crowd data to weigh, not a verified fact and not a signal.
 */
async function derivativesContext(symbol, interval, klineData) {
  const period = OI_PERIODS.has(interval) ? interval : '4h';
  const [prem, fhist, oiNow, oiHist, lsRatio, taker] = await Promise.all([
    getJSON(FUT + '/fapi/v1/premiumIndex?symbol=' + symbol),
    getJSON(FUT + '/fapi/v1/fundingRate?symbol=' + symbol + '&limit=30'),
    getJSON(FUT + '/fapi/v1/openInterest?symbol=' + symbol),
    getJSON(FUT + '/futures/data/openInterestHist?symbol=' + symbol + '&period=' + period + '&limit=30'),
    getJSON(FUT + '/futures/data/globalLongShortAccountRatio?symbol=' + symbol + '&period=' + period + '&limit=30'),
    getJSON(FUT + '/futures/data/takerlongshortRatio?symbol=' + symbol + '&period=' + period + '&limit=30'),
  ]);

  const echecs = [];
  const out = { disponible: false, periode_agregation: period };

  if (prem.ok && prem.data && prem.data.lastFundingRate != null) {
    const rate = Number(prem.data.lastFundingRate);
    out.funding = {
      taux_courant_pct: r2(rate * 100, 4),
      // Binance settles every 8h → 3 payments a day.
      annualise_pct: r2(rate * 3 * 365 * 100, 2),
      mark_price: r2(Number(prem.data.markPrice), 6),
      prochain_reglement_utc: prem.data.nextFundingTime ? new Date(Number(prem.data.nextFundingTime)).toISOString() : null,
    };
    out.disponible = true;
  } else {
    out.funding = null;
    echecs.push({ source: 'premiumIndex', raison: prem.error || 'champ lastFundingRate absent' });
  }

  if (fhist.ok && Array.isArray(fhist.data) && fhist.data.length) {
    const rates = fhist.data.map(x => Number(x.fundingRate)).filter(Number.isFinite);
    if (rates.length) {
      const m = mean(rates);
      out.funding_historique = {
        echantillon: rates.length,
        moyenne_pct: r2(m * 100, 4),
        moyenne_annualisee_pct: r2(m * 3 * 365 * 100, 2),
        part_positive_pct: r2(rates.filter(x => x > 0).length / rates.length * 100, 1),
        // A funding far from its own average is the crowded part, not the level itself.
        courant_vs_moyenne: out.funding ? r2(out.funding.taux_courant_pct - m * 100, 4) : null,
      };
    }
  } else {
    out.funding_historique = null;
    echecs.push({ source: 'fundingRate', raison: fhist.error || 'historique vide' });
  }

  if (oiNow.ok && oiNow.data && oiNow.data.openInterest != null) {
    out.open_interest = { contrats: r2(Number(oiNow.data.openInterest), 2) };
  } else {
    out.open_interest = null;
    echecs.push({ source: 'openInterest', raison: oiNow.error || 'champ absent' });
  }

  let oiChange = null;
  if (oiHist.ok && Array.isArray(oiHist.data) && oiHist.data.length >= 2) {
    const first = Number(oiHist.data[0].sumOpenInterest);
    const last = Number(oiHist.data[oiHist.data.length - 1].sumOpenInterest);
    if (first > 0 && Number.isFinite(last)) {
      oiChange = (last - first) / first * 100;
      out.open_interest = out.open_interest || {};
      out.open_interest.variation_pct = r2(oiChange, 2);
      out.open_interest.echantillon = oiHist.data.length;
      out.open_interest.fenetre = oiHist.data.length + ' x ' + period;
      out.open_interest.valeur_usd = r2(Number(oiHist.data[oiHist.data.length - 1].sumOpenInterestValue), 0);
    }
    // Price change over the SAME window, located by timestamp — comparing an OI
    // change to a price change measured over a different period says nothing.
    const startTs = Number(oiHist.data[0].timestamp);
    const idx = klineData.t.findIndex(ts => ts >= startTs);
    if (idx >= 0 && idx < klineData.n - 1) {
      const pStart = klineData.c[idx], pEnd = klineData.c[klineData.n - 1];
      const priceChange = (pEnd - pStart) / pStart * 100;
      out.oi_vs_prix = {
        variation_prix_pct: r2(priceChange, 2),
        variation_oi_pct: r2(oiChange, 2),
        bougies_couvertes: klineData.n - idx,
        lecture: oiChange == null ? null : readOiVsPrice(oiChange, priceChange),
      };
    } else {
      out.oi_vs_prix = { variation_oi_pct: r2(oiChange, 2), variation_prix_pct: null, lecture: null,
        raison: "l'historique de bougies chargé ne remonte pas jusqu'au debut de la fenetre d'open interest" };
    }
  } else {
    out.oi_vs_prix = null;
    echecs.push({ source: 'openInterestHist', raison: oiHist.error || 'historique trop court' });
  }

  if (lsRatio.ok && Array.isArray(lsRatio.data) && lsRatio.data.length) {
    const vals = lsRatio.data.map(x => Number(x.longShortRatio)).filter(Number.isFinite);
    const cur = vals[vals.length - 1];
    out.ratio_comptes_long_short = {
      courant: r2(cur, 3),
      moyenne: r2(mean(vals), 3),
      echantillon: vals.length,
      percentile: r2(percentileRank(vals, cur), 1),
      note: "Part des COMPTES retail positionnes long vs short sur Binance. Donnee de foule a peser, pas un fait ni un signal. Historiquement la foule est majoritairement longue, un ratio > 1 n'a donc rien d'anormal en soi.",
    };
  } else {
    out.ratio_comptes_long_short = null;
    echecs.push({ source: 'globalLongShortAccountRatio', raison: lsRatio.error || 'historique vide' });
  }

  if (taker.ok && Array.isArray(taker.data) && taker.data.length) {
    const vals = taker.data.map(x => Number(x.buySellRatio)).filter(Number.isFinite);
    out.taker_achat_vente = {
      courant: r2(vals[vals.length - 1], 3),
      moyenne: r2(mean(vals), 3),
      echantillon: vals.length,
      note: 'Ratio des volumes preneurs de liquidite. > 1 = agressivite acheteuse dominante sur la periode.',
    };
  } else {
    out.taker_achat_vente = null;
    echecs.push({ source: 'takerlongshortRatio', raison: taker.error || 'historique vide' });
  }

  out.disponible = !!(out.funding || out.open_interest || out.ratio_comptes_long_short);
  if (echecs.length) out.sources_indisponibles = echecs;
  if (!out.disponible) {
    out.raison = "Aucune donnee de derives: ce symbole n'a probablement pas de contrat perpetuel sur Binance Futures.";
  }
  return out;
}

function readOiVsPrice(oi, price) {
  const up = price > 0.5, down = price < -0.5;
  const oiUp = oi > 1, oiDown = oi < -1;
  if (up && oiUp) return "Prix en hausse avec open interest en hausse: de l'argent NEUF entre a l'achat. C'est la combinaison la plus saine pour une hausse, et aussi celle qui alimente un squeeze si le funding s'emballe.";
  if (up && oiDown) return 'Prix en hausse avec open interest en baisse: ce sont surtout des shorts qui se rachetent. Mouvement de couverture, moins durable qu une vraie accumulation.';
  if (down && oiUp) return "Prix en baisse avec open interest en hausse: ouverture de shorts agressive. Tendance baissiere alimentee, mais carburant a squeeze qui s'accumule.";
  if (down && oiDown) return 'Prix en baisse avec open interest en baisse: liquidation / desengagement. Souvent une fin de mouvement plutot qu un debut.';
  return 'Prix et open interest quasi stables sur la fenetre: pas de signal exploitable.';
}

function readFunding(f) {
  if (!f) return null;
  const ann = f.annualise_pct;
  if (ann == null) return null;
  if (ann > 30) return "Funding tres positif (" + ann + "%/an): les longs paient cher pour rester en place. Positionnement encombre cote long, terrain favorable a une purge a la baisse.";
  if (ann > 10) return 'Funding positif (' + ann + "%/an): biais long dominant, sans exces caracterise.";
  if (ann < -30) return 'Funding tres negatif (' + ann + "%/an): les shorts paient pour rester en place. Positionnement encombre cote short, carburant classique d'un squeeze haussier.";
  if (ann < -10) return 'Funding negatif (' + ann + '%/an): biais short dominant.';
  return 'Funding proche de zero: pas de desequilibre de positionnement notable.';
}

/* ============================================================ 1) VOLATILITY == */

/**
 * Is volatility high or low FOR THIS ASSET?
 *
 * Absolute levels are useless across assets and even across time on the same
 * asset: an ATR of 500 on BTC at 20k and at 80k are not the same thing at all.
 * Everything below is therefore percentile-ranked against the asset's own
 * history, and the ATR is normalised by price BEFORE ranking — ranking the raw
 * ATR would just rediscover that price went up.
 *
 * @param {object}   p
 * @param {string}   p.symbol        e.g. "LINKUSDT" or "BINANCE:LINKUSDT"
 * @param {string}   [p.interval]    "1d" default; TradingView style accepted ("240", "D")
 * @param {number}   [p.periods]     ATR period, default 14
 * @param {number}   [p.limit]       bars to pull, default 1000 (Binance max)
 * @param {number}   [p.horizon]     holding horizon in bars for the stop study, default 5
 * @param {number}   [p.survie_cible] target share of bars the stop must survive, default 90
 * @param {number}   [p.risque_pct]  capital risked per trade, default 1
 * @param {number}   [p.capital]     account size, optional — sizing is per 10 000 without it
 * @param {boolean}  [p.derives]     pull perp funding/OI context, default true
 */
export async function volatilityRegime({ symbol, interval, periods, limit, horizon, survie_cible, risque_pct, capital, derives } = {}) {
  if (!symbol) throw new Error('symbol est requis, ex: "LINKUSDT" ou "BINANCE:LINKUSDT"');
  const sym = normSymbol(symbol);
  const iv = normInterval(interval, '1d');
  const period = Number(periods) > 1 ? Math.floor(Number(periods)) : 14;
  const hz = Number(horizon) > 0 ? Math.floor(Number(horizon)) : 5;
  const targetSurvival = Number(survie_cible) > 0 && Number(survie_cible) < 100 ? Number(survie_cible) : 90;
  const riskPct = Number(risque_pct) > 0 ? Number(risque_pct) : 1;
  const barsPerYear = BARS_PER_YEAR[iv];

  const k = await fetchKlines(sym, iv, limit);
  if (!k.ok) {
    return { success: false, symbol: sym, interval: iv, error: k.error,
      note: 'Rien n a ete calcule. Aucune valeur par defaut n est renvoyee a la place des donnees manquantes.' };
  }

  const { h, l, c, o, n } = k;
  const warn = [];

  /* --- ATR and its own percentile ------------------------------------------ */
  const atrS = atrSeries(h, l, c, period);
  const atrPctS = atrS.map((a, i) => (a == null || !(c[i] > 0)) ? null : a / c[i] * 100);
  const atrPctValid = atrPctS.filter(Number.isFinite);
  const atrNow = atrS[n - 1];
  const atrPctNow = atrPctS[n - 1];

  if (!(atrNow > 0)) {
    return { success: false, symbol: sym, interval: iv,
      error: atrNow == null
        ? 'ATR(' + period + ') impossible: ' + n + ' bougies cloturees disponibles, il en faut au moins ' + (period + 1) + '.'
        : 'ATR(' + period + ') nul sur les ' + n + ' bougies cloturees: serie figee ou sans amplitude. Aucun regime, aucun percentile et aucune distance de stop ne sont calculables.',
      atr_mesure: atrNow,
      bougies_utilisees: n };
  }

  const pAtr = percentileRank(atrPctValid, atrPctNow);
  const label = volLabel(pAtr);

  // How long have we been in this regime? Walk back while the bucket holds.
  let persistance = 0;
  const bucketNow = volBucket(pAtr);
  for (let i = n - 1; i >= 0; i--) {
    if (atrPctS[i] == null) break;
    if (volBucket(percentileRank(atrPctValid, atrPctS[i])) !== bucketNow) break;
    persistance++;
  }

  // Direction of travel matters as much as the level: a 40th-percentile ATR on
  // the way up and on the way down are opposite situations.
  const atrAgo = atrPctS[n - 1 - Math.min(10, n - 1)];
  const atrTrendPct = (atrAgo != null && atrAgo > 0) ? (atrPctNow - atrAgo) / atrAgo * 100 : null;

  /* --- realized volatility -------------------------------------------------- */
  const rets = logReturns(c);
  const volWin = Math.min(20, Math.max(5, Math.floor(rets.length / 4)));
  const rvSeries = realizedVolSeries(rets, volWin, barsPerYear).filter(Number.isFinite);
  const sdNow = rets.length >= volWin ? stdev(rets.slice(-volWin)) : null;
  const rvNow = sdNow == null ? null : sdNow * Math.sqrt(barsPerYear) * 100;
  const pRv = rvNow == null ? null : percentileRank(rvSeries, rvNow);

  const shortWin = Math.min(7, volWin);
  const longWin = Math.min(30, rets.length);
  const sdShort = rets.length >= shortWin ? stdev(rets.slice(-shortWin)) : null;
  const sdLong = rets.length >= longWin ? stdev(rets.slice(-longWin)) : null;
  const termRatio = (sdShort != null && sdLong > 0) ? sdShort / sdLong : null;

  const park = parkinsonVol(h, l, volWin, barsPerYear);
  const parkRatio = (park != null && rvNow > 0) ? park / rvNow : null;

  const neg = rets.slice(-longWin).filter(x => x < 0);
  const pos = rets.slice(-longWin).filter(x => x > 0);
  const downVol = neg.length >= 3 ? Math.sqrt(mean(neg.map(x => x * x))) * Math.sqrt(barsPerYear) * 100 : null;
  const upVol = pos.length >= 3 ? Math.sqrt(mean(pos.map(x => x * x))) * Math.sqrt(barsPerYear) * 100 : null;

  /* --- Bollinger squeeze ---------------------------------------------------- */
  const bbw = bbWidthSeries(c, 20, 2);
  const bbwValid = bbw.filter(Number.isFinite);
  const bbwNow = bbw[n - 1];
  const pBbw = bbwNow == null ? null : percentileRank(bbwValid, bbwNow);

  /* --- trend vs noise ------------------------------------------------------- */
  const chopWin = Math.min(14, n - 1);
  const chop = choppiness(h, l, c, chopWin);
  const erWin = Math.min(20, n - 1);
  const er = efficiencyRatio(c, erWin);

  /* --- empirical stop study (this is the heart of the stop advice) ---------- */
  // For every historical bar, measure how far price went AGAINST an entry at the
  // open, expressed in ATR known BEFORE that bar. Using the current bar's ATR
  // would be look-ahead: at entry time you could not know it.
  const multiples = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  const maeLong1 = [], maeShort1 = [], maeLongH = [], maeShortH = [], barRangeAtr = [];
  for (let i = 1; i < n; i++) {
    const ref = atrS[i - 1];
    if (ref == null || !(ref > 0)) continue;
    maeLong1.push((o[i] - l[i]) / ref);
    maeShort1.push((h[i] - o[i]) / ref);
    barRangeAtr.push((h[i] - l[i]) / ref);
    if (i + hz - 1 < n) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i; j < i + hz; j++) { if (l[j] < lo) lo = l[j]; if (h[j] > hi) hi = h[j]; }
      maeLongH.push((o[i] - lo) / ref);
      maeShortH.push((hi - o[i]) / ref);
    }
  }

  const survival = (arr, m) => arr.length ? arr.filter(x => x < m).length / arr.length * 100 : null;
  const table = multiples.map(m => ({
    multiple_atr: m,
    survie_1_bougie_pct: r2(survival(maeLong1.concat(maeShort1), m), 1),
    survie_sur_horizon_pct: r2(survival(maeLongH.concat(maeShortH), m), 1),
  }));

  // Smallest multiple that survives the target share of historical excursions.
  let suggested = null;
  for (const row of table) {
    if (row.survie_sur_horizon_pct != null && row.survie_sur_horizon_pct >= targetSurvival) { suggested = row.multiple_atr; break; }
  }
  if (suggested == null) {
    suggested = multiples[multiples.length - 1];
    warn.push('Aucun multiple teste (max ' + suggested + ' ATR) ne survit a ' + targetSurvival +
      '% des excursions sur ' + hz + ' bougies. Soit l horizon est trop long pour cet actif, soit la volatilite actuelle impose de reduire la taille plutot que d elargir encore.');
  }
  // In an ongoing expansion the past understates what is coming; add a cushion.
  const multipleEmpirique = suggested;
  const majore = pAtr != null && pAtr >= 80 && suggested < 3;
  if (majore) suggested = r2(suggested * 1.2, 2);

  // Hard floor at 1 ATR. On a quiet sample the empirical table happily says 0.75
  // ATR would have survived — and it is right about the PAST. But a stop inside
  // the distance an ordinary bar covers is taken out by noise rather than by
  // information, and no historical sample contains the expansion that has not
  // happened yet. Caught by a synthetic test where the suggestion came out at 0.9.
  let floored = false;
  if (suggested < 1) { suggested = 1; floored = true; }

  const stopDist = atrNow * suggested;
  const lastClose = c[n - 1];
  const stopPct = stopDist / lastClose * 100;
  const overOneAtr = survival(barRangeAtr, 1);

  /* --- expected move + fat-tail reality check ------------------------------- */
  const rangeWin = Math.min(50, n);
  const rangePct = [];
  for (let i = n - rangeWin; i < n; i++) if (c[i] > 0) rangePct.push((h[i] - l[i]) / c[i] * 100);
  rangePct.sort((a, b) => a - b);

  const sigmaBar = sdNow;                 // short window: the move expected NOW
  const sigmaAll = rets.length >= 3 ? stdev(rets) : null;   // whole sample: the reference the 4.55% belongs to
  const tailObs = sigmaAll > 0
    ? rets.filter(x => Math.abs(x) > 2 * sigmaAll).length / rets.length * 100
    : null;

  /* --- position sizing ------------------------------------------------------ */
  const base = Number(capital) > 0 ? Number(capital) : 10000;
  const riskAmount = base * riskPct / 100;
  const units = stopDist > 0 ? riskAmount / stopDist : null;
  const notional = units == null ? null : units * lastClose;
  const leverage = notional == null ? null : notional / base;
  if (leverage != null && leverage > 5) {
    warn.push('Le stop suggere est si serre en pourcentage (' + r2(stopPct, 2) + '%) qu un risque de ' + riskPct +
      '% du capital implique un notionnel de ' + r2(leverage, 2) + 'x le capital. Risque de liquidation avant le stop: verifier la marge.');
  }

  /* --- reliability flags ---------------------------------------------------- */
  const thinPercentile = atrPctValid.length < 100;
  if (thinPercentile) {
    warn.push('Percentile ATR calcule sur seulement ' + atrPctValid.length +
      ' lectures. En dessous de ~100, un percentile est indicatif: augmenter limit ou passer sur une unite de temps plus haute.');
  }
  if (maeLongH.length < 50) {
    warn.push('Etude de stop basee sur ' + maeLongH.length + ' excursions seulement. A prendre comme ordre de grandeur.');
  }
  if (k.bougie_en_cours) {
    warn.push('La bougie en cours (ouverte depuis ' + k.bougie_en_cours.ouverte_depuis_min + ' min) est EXCLUE de tous les calculs: son amplitude est tronquee et ferait passer le regime pour une compression.');
  }

  /* --- derivatives ---------------------------------------------------------- */
  let deriv = null;
  if (derives !== false) {
    try { deriv = await derivativesContext(sym, iv, k); }
    catch (e) { deriv = { disponible: false, raison: 'erreur inattendue: ' + e.message }; }
    if (deriv && deriv.funding) deriv.lecture_funding = readFunding(deriv.funding);
  }

  /* --- squeeze synthesis ---------------------------------------------------- */
  let squeeze = null;
  if (pAtr != null && pBbw != null) {
    const compressed = pAtr < 25 && pBbw < 25;
    squeeze = {
      actif: compressed,
      percentile_atr: r2(pAtr, 1),
      percentile_largeur_bollinger: r2(pBbw, 1),
      lecture: compressed
        ? 'Compression confirmee par deux mesures independantes (ATR et largeur des bandes de Bollinger). Une expansion suit statistiquement, sans indication de direction. Se preparer aux deux sens plutot que de deviner.'
        : 'Pas de compression simultanee sur l ATR et les bandes de Bollinger.',
    };
  }

  return {
    success: true,
    symbol: sym,
    interval: iv,
    source: 'binance spot klines',

    bougies: {
      demandees: k.demandees,
      recues: k.recues,
      cloturees_utilisees: n,
      derniere_cloture_utc: k.derniere_cloture_utc,
      bougie_en_cours_exclue: !!k.bougie_en_cours,
      bougie_en_cours: k.bougie_en_cours,
    },

    prix: {
      dernier_close: r2(lastClose, 6),
      close_precedent: r2(c[n - 2], 6),
      variation_derniere_bougie_pct: r2((lastClose - c[n - 2]) / c[n - 2] * 100, 2),
    },

    atr: {
      periode: period,
      lissage: 'Wilder (RMA), identique a TradingView',
      valeur: r2(atrNow, 6),
      pct_du_prix: r2(atrPctNow, 3),
      percentile: r2(pAtr, 1),
      echantillon: atrPctValid.length,
      percentile_sur: 'ATR exprime en % du prix, compare a sa propre histoire sur ' + atrPctValid.length + ' bougies',
      variation_sur_10_bougies_pct: r2(atrTrendPct, 1),
      direction: atrTrendPct == null ? null : (atrTrendPct > 10 ? 'expansion' : atrTrendPct < -10 ? 'contraction' : 'stable'),
      regime: label,
      persistance_bougies: persistance,
      note_normalisation: "L'ATR est rapporte au prix AVANT d'etre classe. Classer l'ATR brut reviendrait a mesurer la hausse du prix, pas celle de la volatilite.",
    },

    volatilite_realisee: {
      fenetre_bougies: volWin,
      echantillon_rendements: rets.length,
      annualisee_pct: r2(rvNow, 2),
      percentile: r2(pRv, 1),
      echantillon_percentile: rvSeries.length,
      par_bougie_1sigma_pct: r2(sigmaBar == null ? null : sigmaBar * 100, 3),
      parkinson_annualisee_pct: r2(park, 2),
      ratio_parkinson_sur_close: r2(parkRatio, 2),
      lecture_parkinson: parkRatio == null ? null : (parkRatio > 1.4
        ? 'Amplitude intra-bougie nettement superieure a la volatilite de cloture: le prix va chercher des niveaux puis revient. Environnement a meches, defavorable aux stops serres et aux cassures.'
        : parkRatio < 0.9
          ? 'Les cloture bougent plus que les amplitudes internes: mouvement directionnel, propre, avec peu de retracement intra-bougie.'
          : 'Amplitude interne et volatilite de cloture coherentes.'),
      asymetrie: {
        vol_baissiere_pct: r2(downVol, 2),
        vol_haussiere_pct: r2(upVol, 2),
        echantillon_bas: neg.length,
        echantillon_haut: pos.length,
        lecture: (downVol == null || upVol == null) ? null : (downVol > upVol * 1.2
          ? 'La baisse est plus violente que la hausse sur cette fenetre: un stop symetrique cote long est structurellement plus expose.'
          : upVol > downVol * 1.2
            ? 'La hausse est plus violente que la baisse sur cette fenetre.'
            : 'Volatilite symetrique entre hausse et baisse.'),
      },
    },

    structure_de_volatilite: {
      court_terme_annualise_pct: r2(sdShort == null ? null : sdShort * Math.sqrt(barsPerYear) * 100, 2),
      fenetre_court_terme: shortWin,
      long_terme_annualise_pct: r2(sdLong == null ? null : sdLong * Math.sqrt(barsPerYear) * 100, 2),
      fenetre_long_terme: longWin,
      ratio: r2(termRatio, 2),
      lecture: termRatio == null ? null : (termRatio > 1.3
        ? 'Volatilite court terme bien au-dessus du long terme: expansion en cours, le regime est en train de changer.'
        : termRatio < 0.75
          ? 'Volatilite court terme bien en dessous du long terme: le marche se comprime. Configuration de pre-mouvement.'
          : 'Structure de volatilite plate, pas de bascule de regime en cours.'),
      largeur_bollinger_pct: r2(bbwNow, 2),
      percentile_largeur_bollinger: r2(pBbw, 1),
      echantillon_bollinger: bbwValid.length,
    },

    squeeze,

    tendance_vs_bruit: {
      choppiness: r2(chop, 1),
      fenetre_choppiness: chopWin,
      efficiency_ratio: r2(er, 3),
      fenetre_efficiency: erWin,
      lecture: (chop == null && er == null) ? null :
        (chop != null && chop > 61.8) ? 'Choppiness > 61.8: marche en range. Les cassures echouent, les extremes se vendent et s achetent. Les strategies de suivi de tendance saignent ici.'
          : (chop != null && chop < 38.2) ? 'Choppiness < 38.2: marche en tendance. Les replis se rachetent, les moyennes mobiles tiennent.'
            : 'Zone intermediaire: ni range franc ni tendance franche.',
      complement: er == null ? null : (er > 0.4
        ? 'Efficiency ratio eleve: le mouvement va quelque part, le deplacement net est une grande part du chemin parcouru.'
        : er < 0.2
          ? 'Efficiency ratio faible: beaucoup de chemin parcouru pour un deplacement net minime. La volatilite presente est du bruit, pas une tendance.'
          : 'Efficacite directionnelle moyenne.'),
    },

    mouvement_attendu: {
      base: 'ecart-type des rendements log sur ' + volWin + ' bougies',
      une_bougie_1sigma_pct: r2(sigmaBar == null ? null : sigmaBar * 100, 2),
      une_bougie_2sigma_pct: r2(sigmaBar == null ? null : sigmaBar * 200, 2),
      sur_horizon_1sigma_pct: r2(sigmaBar == null ? null : sigmaBar * Math.sqrt(hz) * 100, 2),
      horizon_bougies: hz,
      // Median, not mean: one capitulation bar should not redefine "typical".
      amplitude_mediane_bougie_pct: r2(quantile(rangePct, 0.5), 2),
      amplitude_9e_decile_pct: r2(quantile(rangePct, 0.9), 2),
      echantillon_amplitudes: rangePct.length,
      queues_epaisses: {
        depassements_2sigma_observes_pct: r2(tailObs, 2),
        attendu_loi_normale_pct: 4.55,
        sigma_de_reference_pct: sigmaAll == null ? null : r2(sigmaAll * 100, 3),
        base: sigmaAll == null ? null : 'ecart-type des ' + rets.length + ' rendements de l historique complet, le meme echantillon que celui compte. Comparer a un sigma de fenetre courte mesurerait le changement de regime, pas l epaisseur des queues.',
        lecture: tailObs == null ? null : (tailObs > 6
          ? 'Les depassements de 2 sigma sont ' + r2(tailObs / 4.55, 1) + 'x plus frequents que ne le predit une loi normale. Dimensionner sur un sigma gaussien sous-estime le risque reel de cet actif.'
          : 'Frequence des grands ecarts proche de ce qu une loi normale predit sur cette fenetre.'),
        echantillon: rets.length,
      },
    },

    stop: {
      multiple_atr_suggere: suggested,
      distance_prix: r2(stopDist, 6),
      distance_pct: r2(stopPct, 2),
      niveau_si_long: r2(lastClose - stopDist, 6),
      niveau_si_short: r2(lastClose + stopDist, 6),
      survie_cible_pct: targetSurvival,
      horizon_bougies: hz,
      base_empirique: {
        excursions_1_bougie: maeLong1.length + maeShort1.length,
        excursions_sur_horizon: maeLongH.length + maeShortH.length,
        methode: "Pour chaque bougie historique, excursion defavorable maximale depuis l'ouverture, divisee par l'ATR connu AVANT cette bougie (pas celui de la bougie elle-meme, qui serait du look-ahead).",
        table: table,
      },
      pourquoi_pas_moins_de_1_atr:
        "L'ATR est l'amplitude MOYENNE d'une seule bougie. Un stop pose a moins de 1 ATR est donc a l'interieur de la distance que le prix parcourt dans une bougie ordinaire, sans qu'aucune these ne soit invalidee: il est touche par le bruit, pas par une information. Mesure sur cet echantillon: " +
        (overOneAtr == null ? 'amplitude non mesurable' : r2(100 - overOneAtr, 1) + '% des bougies ont une amplitude superieure a 1 ATR') +
        ", et un stop a 1 ATR ne survit qu'a " + (table.find(x => x.multiple_atr === 1) || {}).survie_sur_horizon_pct +
        '% des excursions sur ' + hz + ' bougies. Serrer le stop ne reduit pas le risque, il augmente la frequence des sorties prematurees et degrade le taux de reussite.',
      plancher_1_atr_applique: floored,
      note_plancher: floored
        ? "La distribution empirique tolerait un stop plus serre, mais le plancher de 1 ATR a ete applique: un stop sous l'amplitude moyenne d'une bougie est touche par le bruit, et l'echantillon passe ne contient pas l'expansion a venir."
        : null,
      multiple_avant_ajustement: multipleEmpirique,
      majoration_appliquee: majore,
      ajustement_regime: label == null ? null : (majore
        ? 'Regime a volatilite extreme: le multiple a ete majore de 20% car les excursions passees sous-estiment une expansion en cours. Reduire la taille plutot que de compter sur le stop.'
        : (pAtr != null && pAtr >= 80)
          ? 'Regime a volatilite extreme, mais le multiple est deja au maximum teste (3 ATR): AUCUNE majoration n a pu etre appliquee. La distribution passee ne couvre pas ce regime, reduire la taille est la seule marge disponible.'
        : pAtr < 25
          ? 'Regime comprime: le stop en pourcentage parait confortable, mais une expansion peut doubler l ATR en quelques bougies. Le stop doit rester valide APRES expansion, pas seulement aujourd hui.'
          : 'Multiple issu directement de la distribution empirique, sans ajustement.'),
    },

    taille_position: {
      capital_de_reference: Number(capital) > 0 ? base : 10000,
      capital_fourni: Number(capital) > 0,
      risque_pct: riskPct,
      montant_risque: r2(riskAmount, 2),
      unites: r2(units, 6),
      notionnel: r2(notional, 2),
      levier_implicite: r2(leverage, 2),
      formule: 'unites = (capital x risque%) / (multiple ATR x ATR). Le stop determine la taille, jamais l inverse.',
      avertissement: leverage != null && leverage > 3
        ? 'Notionnel superieur a 3x le capital. Le risque de perte est bien plafonne a ' + riskPct + '% SI le stop passe, mais un gap ou une liquidation le contourne.'
        : null,
    },

    regime: {
      label,
      seuils_percentile: { 'compression extreme': '< 10', compression: '10-25', basse: '25-45', normale: '45-60', haute: '60-80', extreme: '>= 80' },
      percentile_atr: r2(pAtr, 1),
      percentile_volatilite_realisee: r2(pRv, 1),
      persistance_bougies: persistance,
      interpretation: volMeaning(label),
      // Two mesures, two questions: ATR sizes the bars, realized vol sizes the
      // closes. A 28-point gap called "same story" was hiding exactly the case
      // this field exists for, hence the intermediate tier.
      ecart_percentiles: (pAtr != null && pRv != null) ? r2(Math.abs(pAtr - pRv), 1) : null,
      coherence: (pAtr == null || pRv == null) ? null : (Math.abs(pAtr - pRv) > 30
        ? 'ATR et volatilite de cloture divergent fortement (' + r2(pAtr, 0) + 'e vs ' + r2(pRv, 0) +
          'e percentile): les bougies sont larges mais cloturent au meme endroit (ou l inverse). Lire tendance_vs_bruit avant de conclure quoi que ce soit.'
        : Math.abs(pAtr - pRv) > 15
          ? 'Divergence moderee entre ATR (' + r2(pAtr, 0) + 'e) et volatilite de cloture (' + r2(pRv, 0) +
            'e percentile): les amplitudes et les clotures ne racontent pas tout a fait la meme chose, souvent le signe de meches qui se resorbent.'
          : 'ATR et volatilite realisee racontent la meme histoire.'),
    },

    derives: deriv,

    avertissements: warn.length ? warn : undefined,

    note: "Toutes les mesures sont des percentiles face a l'historique PROPRE de l'actif: un ATR de 5% ne veut rien dire dans l'absolu. Aucune de ces valeurs n'est une prevision de direction — la volatilite dit l'amplitude, jamais le sens.",
  };
}

/* ============================================================ 2) BREADTH ===== */

/** One symbol's contribution to the breadth reading. Returns a failure object
 *  instead of throwing, so one dead ticker does not kill the basket. */
async function breadthOne(sym, iv, limit) {
  const k = await fetchKlines(sym, iv, limit);
  if (!k.ok) return { symbol: sym, ok: false, raison: k.error };

  const { c, h, l, n } = k;
  const e20 = emaSeries(c, 20)[n - 1];
  const e50 = emaSeries(c, 50)[n - 1];
  const e200 = emaSeries(c, 200)[n - 1];
  const atr = atrSeries(h, l, c, 14)[n - 1];
  const close = c[n - 1];

  // An EMA whose warm-up is too short is mostly its own seed. Reporting it as a
  // clean boolean would silently poison the percentage, so it is marked instead.
  const fiable = { ema20: n >= 20 * WARMUP_FACTOR, ema50: n >= 50 * WARMUP_FACTOR, ema200: n >= 200 * WARMUP_FACTOR };

  const look = Math.min(20, n);
  const hi20 = Math.max(...c.slice(-look));
  const lo20 = Math.min(...c.slice(-look));

  return {
    symbol: sym, ok: true,
    bars_used: n,
    close: r2(close, 6),
    ema20: r2(e20, 6), ema50: r2(e50, 6), ema200: r2(e200, 6),
    au_dessus: {
      ema20: e20 == null || !fiable.ema20 ? null : close > e20,
      ema50: e50 == null || !fiable.ema50 ? null : close > e50,
      ema200: e200 == null || !fiable.ema200 ? null : close > e200,
    },
    fiable,
    ecart_ema20_pct: e20 == null ? null : r2((close - e20) / e20 * 100, 2),
    // Distance in ATR units is the only way to compare "extended" across assets.
    extension_ema20_atr: (e20 == null || atr == null || atr <= 0) ? null : r2((close - e20) / atr, 2),
    rsi14: r2(rsiWilder(c, 14), 1),
    atr_pct: atr == null ? null : r2(atr / close * 100, 2),
    nouveau_haut_20: close >= hi20,
    nouveau_bas_20: close <= lo20,
    fenetre_extremes: look,
    _closes: c,
    _n: n,
  };
}

/**
 * How much of the market is participating?
 *
 * Breadth is the risk-on / risk-off gauge. Buying an isolated coin while 80% of
 * the market sits under its moving averages is a bad idea even with a beautiful
 * chart: in crypto almost everything is one trade with different tickers, and
 * that is measured here (average correlation to BTC).
 *
 * Every percentage states its own denominator. A symbol whose EMA200 has not
 * warmed up is EXCLUDED from that percentage and listed with a reason — counting
 * it as "below" would quietly bias the whole reading bearish.
 *
 * @param {object}    p
 * @param {string[]}  [p.symbols]   basket, default the 12 main Binance USDT pairs
 * @param {string}    [p.interval]  "1d" default
 * @param {number}    [p.limit]     bars per symbol, default 1000 (EMA200 warm-up)
 * @param {boolean}   [p.consensus] add TradingView's aggregated rating, default true
 */
export async function marketBreadth({ symbols, interval, limit, consensus } = {}) {
  const requested = (Array.isArray(symbols) && symbols.length ? symbols : DEFAULT_BASKET)
    .map(normSymbol).filter(Boolean);
  if (!requested.length) throw new Error('symbols doit etre un tableau non vide, ex: ["BTCUSDT","ETHUSDT"]');
  if (requested.length > 40) throw new Error('panier limite a 40 symboles (' + requested.length + ' demandes)');
  const iv = normInterval(interval, '1d');
  const barsPerYear = BARS_PER_YEAR[iv];

  // 4 at a time: enough to be quick, low enough to stay far from Binance's ban.
  const results = await mapLimit(requested, 4, s => breadthOne(s, iv, limit));
  const ok = results.filter(r => r && r.ok);
  const ko = results.filter(r => r && !r.ok).map(r => ({ symbol: r.symbol, raison: r.raison }));

  // Breadth on a fraction of the basket is not breadth. Refuse rather than
  // publish a percentage that looks authoritative and is not.
  const minimum = Math.max(2, Math.ceil(requested.length * 0.6));
  if (ok.length < minimum) {
    return {
      success: false,
      error: 'Seulement ' + ok.length + '/' + requested.length + ' symboles ont pu etre charges, il en faut au moins ' +
        minimum + ' pour que des pourcentages de participation aient un sens. Aucun pourcentage n est renvoye.',
      interval: iv,
      echecs: ko,
    };
  }

  /* --- 24h change, one call for the whole basket ---------------------------- */
  const tickRes = await getJSON(SPOT + '/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(ok.map(r => r.symbol))));
  const ticker = {};
  let tickerError = null;
  if (tickRes.ok && Array.isArray(tickRes.data)) {
    for (const t of tickRes.data) {
      ticker[t.symbol] = {
        variation_24h_pct: Number(t.priceChangePercent),
        dernier: Number(t.lastPrice),
        volume_quote_24h: Number(t.quoteVolume),
      };
    }
  } else {
    tickerError = tickRes.error || 'reponse ticker inattendue';
  }
  let flipping = 0;
  for (const r of ok) {
    const t = ticker[r.symbol];
    r.variation_24h_pct = t ? r2(t.variation_24h_pct, 2) : null;
    r.raison_24h_absente = t ? undefined : (tickerError || 'symbole absent de la reponse ticker');
    r.volume_quote_24h = t ? r2(t.volume_quote_24h, 0) : null;
    r.prix_actuel = t ? r2(t.dernier, 6) : null;
    // Participation is measured on CLOSED bars so it does not flicker intrabar.
    // The live price can already be on the other side of the average, which is
    // exactly when a breadth reading is about to change — so flag it per symbol
    // instead of letting the percentage look more settled than it is.
    r.ema20_bascule_en_cours = (r.prix_actuel != null && r.ema20 != null && r.au_dessus.ema20 !== null)
      ? (r.prix_actuel > r.ema20) !== r.au_dessus.ema20
      : null;
    if (r.ema20_bascule_en_cours) flipping++;
  }

  /* --- percentages, each with its own denominator --------------------------- */
  function share(key) {
    const evaluated = ok.filter(r => r.au_dessus[key] !== null);
    const excluded = ok.filter(r => r.au_dessus[key] === null)
      .map(r => ({ symbol: r.symbol, raison: r.bars_used < 20 ? 'historique insuffisant'
        : 'warm-up insuffisant: ' + r.bars_used + ' bougies pour une ' + key + ' (il en faut ' + (Number(key.replace('ema', '')) * WARMUP_FACTOR) + ')' }));
    if (!evaluated.length) {
      return { pct: null, au_dessus: null, evalues: 0, raison: 'aucun symbole du panier n a un historique suffisant pour cette moyenne', exclus: excluded };
    }
    const above = evaluated.filter(r => r.au_dessus[key]).length;
    return {
      pct: r2(above / evaluated.length * 100, 1),
      au_dessus: above,
      evalues: evaluated.length,
      sur_demandes: requested.length,
      exclus: excluded.length ? excluded : undefined,
    };
  }

  const p20 = share('ema20'), p50 = share('ema50'), p200 = share('ema200');

  const with24 = ok.filter(r => r.variation_24h_pct != null);
  const up24 = with24.filter(r => r.variation_24h_pct > 0).length;
  const hausse24 = with24.length
    ? { en_hausse: up24, evalues: with24.length, pct: r2(up24 / with24.length * 100, 1),
        non_evalues: ok.length - with24.length || undefined }
    : { en_hausse: null, evalues: 0, pct: null, raison: tickerError || 'aucune donnee 24h' };

  const withRsi = ok.filter(r => r.rsi14 != null);
  const rsiAbove = withRsi.filter(r => r.rsi14 > 50).length;

  /* --- advance / decline over the recent bars ------------------------------- */
  const adWin = Math.min(10, ...ok.map(r => r._n - 1));
  const adLine = [];
  if (adWin >= 2) {
    let cum = 0;
    for (let back = adWin; back >= 1; back--) {
      let adv = 0, dec = 0;
      for (const r of ok) {
        const i = r._n - back;
        if (i < 1) continue;
        if (r._closes[i] > r._closes[i - 1]) adv++; else if (r._closes[i] < r._closes[i - 1]) dec++;
      }
      cum += adv - dec;
      adLine.push({ bougies_avant: back - 1, hausse: adv, baisse: dec, cumul: cum });
    }
  }
  // Comparing the last cumulative point to the FIRST one silently throws away the
  // first bar's own contribution, which reported a degrading market on a window
  // whose recent half was clearly improving. Compare halves instead.
  const adNet = adLine.length ? adLine[adLine.length - 1].cumul : null;
  const adHalf = Math.floor(adLine.length / 2);
  const netOf = rows => rows.reduce((s, x) => s + x.hausse - x.baisse, 0);
  const adFirst = adHalf >= 1 ? netOf(adLine.slice(0, adHalf)) : null;
  const adSecond = adHalf >= 1 ? netOf(adLine.slice(adLine.length - adHalf)) : null;

  /* --- correlation and beta against BTC ------------------------------------- */
  const btc = ok.find(r => r.symbol === 'BTCUSDT');
  let correl = null;
  if (btc) {
    const btcRets = logReturns(btc._closes);
    const corrWin = Math.min(90, btcRets.length);
    const btcWin = btcRets.slice(-corrWin);
    const per = [];
    for (const r of ok) {
      if (r.symbol === 'BTCUSDT') continue;
      const rr = logReturns(r._closes).slice(-corrWin);
      const c1 = pearson(rr, btcWin), b1 = betaVs(rr, btcWin);
      r.correlation_btc = r2(c1, 2);
      r.beta_btc = r2(b1, 2);
      // Excess return once BTC beta is paid for: is it really outperforming?
      r.alpha_24h_pct = (r.variation_24h_pct != null && btc.variation_24h_pct != null && b1 != null)
        ? r2(r.variation_24h_pct - b1 * btc.variation_24h_pct, 2) : null;
      if (c1 != null) per.push(c1);
    }
    const avg = per.length ? mean(per) : null;
    correl = {
      reference: 'BTCUSDT',
      moyenne: r2(avg, 2),
      echantillon_symboles: per.length,
      echantillon_rendements: corrWin,
      lecture: avg == null ? null : (avg > 0.8
        ? 'Correlation moyenne tres elevee: le panier est un seul et meme trade. Detenir 5 altcoins n est pas une diversification, c est une position BTC a levier.'
        : avg > 0.6
          ? 'Correlation elevee: la direction du BTC domine, la selection de l actif compte moins que le timing du marche.'
          : 'Correlation moderee: la selection commence a payer, les actifs bougent avec une part propre.'),
    };
  } else {
    correl = { reference: null, moyenne: null, raison: 'BTCUSDT absent du panier, aucune reference de correlation calculable' };
  }

  /* --- dispersion ----------------------------------------------------------- */
  const changes = with24.map(r => r.variation_24h_pct);
  const disp = changes.length >= 3 ? stdev(changes) : null;
  const dispersion = {
    ecart_type_variations_24h_pct: r2(disp, 2),
    echantillon: changes.length,
    etendue_pct: changes.length ? r2(Math.max(...changes) - Math.min(...changes), 2) : null,
    lecture: disp == null ? null : (disp < 2
      ? 'Faible dispersion: tout le panier bouge ensemble, le marche est pilote par le macro. Choisir le bon altcoin ne rapporte presque rien face au fait d etre expose ou non.'
      : disp > 5
        ? 'Forte dispersion: les actifs se decorrelent, la selection paye et les rotations sont actives.'
        : 'Dispersion normale.'),
  };

  /* --- new highs / lows and extension --------------------------------------- */
  const nh = ok.filter(r => r.nouveau_haut_20).length;
  const nl = ok.filter(r => r.nouveau_bas_20).length;
  const ext = ok.map(r => r.extension_ema20_atr).filter(Number.isFinite).sort((a, b) => a - b);
  const medianExt = ext.length ? quantile(ext, 0.5) : null;

  /* --- TradingView consensus: a second opinion, explicitly third-party ------ */
  let tv = null;
  if (consensus !== false) {
    // Ask the scanner for the SAME timeframe as the basket, otherwise a 4h breadth
    // reading quietly gets a daily second opinion and the two disagree for a
    // reason nobody can see. See scannerSuffix for the "|1D returns null" trap.
    const tf = scannerSuffix(iv);
    const body = {
      symbols: { tickers: ok.map(r => 'BINANCE:' + r.symbol), query: { types: [] } },
      columns: ['close', 'Recommend.All' + tf.suffix, 'RSI' + tf.suffix],
    };
    const res = await getJSON('https://scanner.tradingview.com/crypto/scan', { method: 'POST', body });
    if (res.ok && res.data && Array.isArray(res.data.data)) {
      const notes = [];
      const byS = {};
      for (const row of res.data.data) {
        const v = (row.d || [])[1];
        byS[String(row.s).split(':').pop()] = v == null ? null : r2(v, 3);
        if (v != null) notes.push(v);
      }
      for (const r of ok) r.consensus_tv = byS[r.symbol] === undefined ? null : byS[r.symbol];
      tv = {
        echantillon: notes.length,
        sur: ok.length,
        note_moyenne: r2(mean(notes), 3),
        part_achat_pct: notes.length ? r2(notes.filter(x => x >= 0.1).length / notes.length * 100, 1) : null,
        part_vente_pct: notes.length ? r2(notes.filter(x => x <= -0.1).length / notes.length * 100, 1) : null,
        unite_de_temps: tf.label,
        unite_de_temps_exacte: tf.exact,
        echelle: 'de -1 (vente forte) a +1 (achat fort), consensus de 26 indicateurs',
        avertissement: "Note calculee par TradingView a partir d'indicateurs retards. C'est une DONNEE tierce a peser comme deuxieme avis, jamais un fait verifie ni une instruction.",
      };
      if (!tf.exact) {
        tv.decalage_unite_de_temps = 'Le scanner TradingView ne publie pas de colonne pour ' + iv +
          '. Le consensus renvoye est donc JOURNALIER et ne correspond pas a l unite de temps du reste de cette analyse.';
      }
      if (!notes.length) tv.raison = 'le scanner a repondu mais aucune note exploitable (colonne "Recommend.All' + tf.suffix + '" vide)';
    } else {
      tv = { echantillon: 0, note_moyenne: null, raison: res.error || 'reponse scanner inattendue' };
    }
  }

  /* --- composite score ------------------------------------------------------ */
  // Weights are redistributed over whatever is actually available: a missing
  // component must not be scored as zero, that would fake a risk-off reading.
  const parts = [
    { key: 'ema20', v: p20.pct, w: 0.2 },
    { key: 'ema50', v: p50.pct, w: 0.3 },
    { key: 'ema200', v: p200.pct, w: 0.4 },
    { key: 'hausse_24h', v: hausse24.pct, w: 0.1 },
  ].filter(x => x.v != null);
  const wSum = parts.reduce((s, x) => s + x.w, 0);
  const score = wSum > 0 ? parts.reduce((s, x) => s + x.v * x.w, 0) / wSum : null;

  let verdict = null, conseil = null;
  if (score != null) {
    verdict = score >= 75 ? 'risk-on franc' : score >= 60 ? 'risk-on' : score >= 40 ? 'mitige'
      : score >= 25 ? 'risk-off' : 'risk-off franc';
    conseil = score >= 60
      ? "Participation large: un long sur un actif isole a le marche avec lui. Les replis ont statistiquement plus de chances d'etre rachetes."
      : score >= 40
        ? "Marche partage: la selection compte plus que la direction. Reduire la taille par rapport a un contexte franc, dans les deux sens."
        : "Participation faible: la majorite du panier est sous ses moyennes. Acheter un actif isole ici, c'est parier contre le marche entier — le beau graphique ne compense pas. Exiger une raison specifique, reduire la taille, ou attendre.";
  }

  // Short-term breadth far above long-term breadth is the classic bear-market
  // rally signature. Worth calling out, because it looks like a recovery.
  let divergence = null;
  if (p20.pct != null && p200.pct != null) {
    const d = p20.pct - p200.pct;
    if (d > 30) divergence = 'Participation court terme (' + p20.pct + '% > EMA20) tres au-dessus du long terme (' + p200.pct +
      '% > EMA200): rebond a l interieur d une structure encore baissiere. Configuration classique de rally de marche baissier, a traiter comme un mouvement a contre-tendance.';
    else if (d < -30) divergence = 'Participation court terme (' + p20.pct + '%) tres en dessous du long terme (' + p200.pct +
      '%): repli a l interieur d une structure de fond haussiere. Historiquement un repli, pas un retournement — mais cela se confirme, cela ne se suppose pas.';
    else divergence = 'Participation court et long terme coherentes, pas de divergence notable.';
  }

  /* --- leaders and laggards ------------------------------------------------- */
  const ranked = [...with24].sort((a, b) => b.variation_24h_pct - a.variation_24h_pct);
  const slim = r => ({
    symbol: r.symbol,
    variation_24h_pct: r.variation_24h_pct,
    prix_actuel: r.prix_actuel,
    alpha_24h_pct: r.alpha_24h_pct === undefined ? null : r.alpha_24h_pct,
    ecart_ema20_pct: r.ecart_ema20_pct,
    extension_ema20_atr: r.extension_ema20_atr,
    rsi14: r.rsi14,
    au_dessus_ema200: r.au_dessus.ema200,
    correlation_btc: r.correlation_btc === undefined ? null : r.correlation_btc,
  });

  const detail = ok.map(r => {
    const d = { ...r };
    delete d._closes; delete d._n;
    return d;
  });

  const avert = [];
  if (ko.length) avert.push(ko.length + ' symbole(s) sur ' + requested.length + ' absents du calcul, voir echecs.');
  if (ok.length < 8) avert.push('Panier de ' + ok.length + ' symboles seulement: une mesure de participation sur si peu de valeurs est indicative, pas representative du marche.');
  if (tickerError) avert.push('Variations 24h indisponibles (' + tickerError + '): le compte des hausses sur 24h et le classement leaders/retardataires reposent sur un echantillon reduit ou nul.');
  if (p200.pct == null) avert.push("Aucune EMA200 fiable dans le panier: le volet long terme du score n'a pas pu etre calcule et son poids a ete redistribue.");

  return {
    success: true,
    interval: iv,
    panier: {
      demandes: requested.length,
      charges: ok.length,
      symboles: ok.map(r => r.symbol),
      par_defaut: !(Array.isArray(symbols) && symbols.length),
      bougies_par_symbole: { min: Math.min(...ok.map(r => r.bars_used)), max: Math.max(...ok.map(r => r.bars_used)) },
    },

    participation: {
      au_dessus_ema20: p20,
      au_dessus_ema50: p50,
      au_dessus_ema200: p200,
      en_hausse_24h: hausse24,
      rsi_superieur_50: { compte: rsiAbove, evalues: withRsi.length, pct: withRsi.length ? r2(rsiAbove / withRsi.length * 100, 1) : null },
      nouveaux_hauts_20: { compte: nh, sur: ok.length },
      nouveaux_bas_20: { compte: nl, sur: ok.length },
      bascule_ema20_en_cours: { compte: flipping, sur: ok.length,
        note: 'Symboles dont le prix actuel est deja passe de l autre cote de son EMA20 alors que la derniere bougie CLOTUREE dit le contraire. Ce compteur mesure la fragilite du pourcentage ci-dessus.' },
      note_denominateur: 'Chaque pourcentage est calcule uniquement sur les symboles dont la moyenne concernee a un warm-up suffisant (' +
        WARMUP_FACTOR + 'x la periode). Les exclus sont listes avec leur raison plutot que comptes comme "en dessous".',
      note_bougie: 'Les positions par rapport aux moyennes sont mesurees sur la derniere bougie CLOTUREE, pour ne pas clignoter au fil de la bougie en cours. La variation 24h, elle, est glissante et temps reel: les deux ne couvrent pas la meme fenetre.',
    },

    score: {
      valeur: r2(score, 1),
      verdict,
      composantes: parts.map(x => ({ composante: x.key, valeur: x.v, poids: r2(x.w / wSum, 3) })),
      poids_redistribues: parts.length < 4,
      conseil,
    },

    divergence_court_long: divergence,

    avance_declin: adLine.length ? {
      fenetre_bougies: adWin,
      symboles_par_bougie: ok.length,
      net_sur_fenetre: adNet,
      net_premiere_moitie: adFirst,
      net_seconde_moitie: adSecond,
      lecture: (adFirst == null || adSecond == null) ? null : (adSecond > adFirst
        ? 'Participation en amelioration: le solde avances moins declins de la seconde moitie de la fenetre (' + adSecond +
          ') depasse celui de la premiere (' + adFirst + ').'
        : adSecond < adFirst
          ? 'Participation en degradation: le solde avances moins declins passe de ' + adFirst + ' a ' + adSecond +
            '. Les gros caps peuvent tenir pendant que le reste du panier decroche.'
          : 'Solde avances/declins stable entre les deux moities de la fenetre.'),
      lecture_niveau: adNet == null ? null : (adNet > 0
        ? 'Solde net positif sur la fenetre: plus de bougies haussieres que baissieres, tous symboles confondus.'
        : adNet < 0
          ? 'Solde net negatif sur la fenetre: le panier a plus souvent baisse que monte, meme si le dernier jour est vert.'
          : 'Solde net nul.'),
      serie: adLine,
    } : { raison: 'historique commun insuffisant entre les symboles du panier pour une ligne avance/declin' },

    correlation: correl,
    dispersion,

    extension: {
      mediane_ema20_atr: r2(medianExt, 2),
      echantillon: ext.length,
      lecture: medianExt == null ? null : (medianExt > 2
        ? 'Panier median a plus de 2 ATR au-dessus de son EMA20: marche etire. Entrer ici, c est acheter apres le mouvement — attendre un retour vers la moyenne ameliore nettement le rapport risque/rendement.'
        : medianExt > 1
          ? 'Panier median a plus de 1 ATR au-dessus de son EMA20: debut d etirement. Le momentum est reel mais le point d entree est deja moins bon que celui d il y a quelques bougies.'
          : medianExt < -2
            ? 'Panier median a plus de 2 ATR sous son EMA20: marche survendu a court terme, rebond technique probable sans que cela dise quoi que ce soit de la tendance de fond.'
            : medianExt < -1
              ? 'Panier median a plus de 1 ATR sous son EMA20: repli marque sans exces caracterise.'
              : 'Panier proche de ses moyennes courtes, pas d etirement notable.'),
    },

    consensus_tradingview: tv,

    leaders: ranked.slice(0, 3).map(slim),
    retardataires: ranked.slice(-3).reverse().map(slim),

    detail,

    echecs: ko.length ? ko : undefined,
    avertissements: avert.length ? avert : undefined,

    note: "La participation se lit avant le graphique d'un actif isole. Acheter une crypto quand 80% du panier est sous ses moyennes revient a parier contre l'ensemble du marche, et la correlation moyenne indiquee ci-dessus dit a quel point ce pari est en realite un seul et meme trade.",
  };
}
