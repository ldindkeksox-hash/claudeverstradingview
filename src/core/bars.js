/**
 * Universal bar source.
 *
 * Every analysis module here was written against Binance's klines endpoint, so
 * asking for gold, an index or a currency pair returned "Invalid symbol" and the
 * whole professional toolkit was unusable outside crypto. This module puts one
 * interface in front of two sources:
 *
 *   binance  — the REST endpoint, when the symbol actually trades there
 *   chart    — the TradingView chart itself, for everything else
 *
 * The chart path is a side effect: it swaps the displayed symbol and resolution,
 * reads the series, and puts the view back. That is the price of reading an
 * instrument Binance does not carry, and it is stated in the returned `source`
 * so a caller always knows where its numbers came from.
 */
import { evaluate } from '../connection.js';
import { getState, setSymbol, setTimeframe } from './chart.js';

const SPOT = 'https://api.binance.com/api/v3';
const BARS = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()';

// Binance interval <-> TradingView resolution. The two name the same periods
// differently, and a caller should not have to know which module wants which.
const TO_TV = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '8h': '480', '12h': '720',
  '1d': 'D', '3d': '3D', '1w': 'W', '1M': 'M',
};
const TO_BINANCE = {};
for (const [k, v] of Object.entries(TO_TV)) TO_BINANCE[v] = k;

/** Accepts either naming and returns both. */
export function normalizeInterval(interval) {
  const raw = String(interval == null ? '1h' : interval).trim();
  if (TO_TV[raw]) return { binance: raw, tv: TO_TV[raw] };
  const up = raw.toUpperCase();
  if (TO_BINANCE[up]) return { binance: TO_BINANCE[up], tv: up };
  // Bare numbers are TradingView minutes ("60"), which Binance writes "1h".
  if (/^\d+$/.test(raw) && TO_BINANCE[raw]) return { binance: TO_BINANCE[raw], tv: raw };
  return { binance: null, tv: null, raw };
}

/** Ticker without its exchange prefix, upper-cased. */
export function ticker(symbol) {
  return String(symbol == null ? '' : symbol).split(':').pop().toUpperCase();
}

/** Exchange prefix, or null when the symbol carries none. */
export function exchangeOf(symbol) {
  const s = String(symbol == null ? '' : symbol);
  return s.includes(':') ? s.split(':')[0].toUpperCase() : null;
}

/**
 * Which source can serve this symbol. A non-Binance prefix is decisive; without
 * a prefix we let Binance try and fall back, because a bare "BTCUSDT" is crypto
 * while a bare "XAUUSD" is not, and only the endpoint knows for sure.
 */
export function preferredSource(symbol) {
  const ex = exchangeOf(symbol);
  if (ex === null) return 'binance-then-chart';
  return ex === 'BINANCE' ? 'binance-then-chart' : 'chart';
}

async function getJSON(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160) };
    return { ok: true, data: await res.json() };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function fromBinance(symbol, interval, limit) {
  const iv = normalizeInterval(interval);
  if (!iv.binance) return { ok: false, error: 'intervalle "' + interval + '" inconnu' };
  const sym = ticker(symbol);
  const n = Math.max(50, Math.min(Number(limit) || 500, 1000));
  const res = await getJSON(SPOT + '/klines?symbol=' + encodeURIComponent(sym)
    + '&interval=' + iv.binance + '&limit=' + n);
  if (!res.ok) return { ok: false, error: res.error };
  if (!Array.isArray(res.data) || res.data.length === 0) {
    return { ok: false, error: 'aucune bougie (symbole absent de Binance spot)' };
  }
  const rows = res.data;
  const now = Date.now();
  const forming = Number(rows[rows.length - 1][6]) > now;
  const closed = forming ? rows.slice(0, -1) : rows;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (const k of closed) {
    t.push(Number(k[0]) / 1000); o.push(Number(k[1])); h.push(Number(k[2]));
    l.push(Number(k[3])); c.push(Number(k[4])); v.push(Number(k[5]));
  }
  return { ok: true, source: 'binance', symbol: sym, interval: iv.binance, t, o, h, l, c, v, n: c.length, bougie_en_cours_exclue: forming };
}

/**
 * Read the chart's own series. The chart holds whatever TradingView has loaded
 * for the displayed symbol and resolution, so the symbol must be swapped in,
 * confirmed, read, and swapped back out.
 */
async function fromChart(symbol, interval, limit) {
  const iv = normalizeInterval(interval);
  if (!iv.tv) return { ok: false, error: 'intervalle "' + interval + '" inconnu' };

  let before = null;
  try { before = await getState(); } catch (e) { /* chart unreachable, reported below */ }
  if (!before || !before.symbol) return { ok: false, error: 'graphique injoignable: impossible de lire une serie' };

  const needSymbol = ticker(before.symbol) !== ticker(symbol);
  const needTf = String(before.resolution) !== String(iv.tv);

  try {
    if (needSymbol) {
      const sw = await setSymbol({ symbol });
      if (!sw.symbole_confirme) {
        return { ok: false, error: 'le graphique n a pas charge ' + symbol + ' (affiche: ' + sw.symbole_charge + '). Symbole inconnu de TradingView ?' };
      }
    }
    if (needTf) {
      const tf = await setTimeframe({ timeframe: iv.tv });
      if (tf && tf.verified === false) {
        return { ok: false, error: 'resolution ' + iv.tv + ' non confirmee sur le graphique' };
      }
    }

    const n = Math.max(50, Math.min(Number(limit) || 500, 1000));
    const data = await evaluate(`
      (function () {
        var b = ${BARS};
        if (!b || typeof b.lastIndex !== 'function') return { ok: false, error: 'serie indisponible' };
        var last = b.lastIndex(), first = Math.max(0, last - ${n} + 1), out = [];
        for (var i = first; i <= last; i++) {
          var r = b.valueAt(i);
          if (r && isFinite(r[1]) && isFinite(r[2]) && isFinite(r[3]) && isFinite(r[4])) {
            out.push([r[0], r[1], r[2], r[3], r[4], isFinite(r[5]) ? r[5] : 0]);
          }
        }
        return { ok: true, rows: out };
      })()
    `);
    if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'lecture de la serie impossible' };
    if (!data.rows.length) return { ok: false, error: 'la serie du graphique est vide' };

    // TradingView keeps the forming bar at the end of the series. Every module
    // here assumes closed bars, so it is dropped rather than silently averaged in.
    const rows = data.rows;
    const t = [], o = [], h = [], l = [], c = [], v = [];
    const closed = rows.slice(0, -1);
    for (const r of closed) { t.push(Number(r[0])); o.push(Number(r[1])); h.push(Number(r[2])); l.push(Number(r[3])); c.push(Number(r[4])); v.push(Number(r[5])); }
    if (c.length < 30) return { ok: false, error: 'seulement ' + c.length + ' bougies cloturees chargees sur le graphique' };

    // Volume is optional on many non-crypto feeds; say so instead of letting a
    // volume-weighted number quietly rest on zeros.
    const withVol = v.filter(x => x > 0).length;
    return {
      ok: true, source: 'chart', symbol, interval: iv.tv, t, o, h, l, c, v, n: c.length,
      bougie_en_cours_exclue: true,
      volume_disponible: withVol > 0,
      volume_couverture_pct: c.length ? Math.round(withVol / c.length * 1000) / 10 : 0,
    };
  } finally {
    // Always put the user's view back, including when a read above failed.
    try { if (needTf) await setTimeframe({ timeframe: before.resolution }); } catch (e) { /* best effort */ }
    try { if (needSymbol) await setSymbol({ symbol: before.symbol }); } catch (e) { /* best effort */ }
  }
}

/**
 * Bars for any symbol TradingView can display.
 * `source` in the result says which path answered, so a caller can report it.
 */
export async function fetchBars({ symbol, interval = '1h', limit = 500, source } = {}) {
  if (!symbol) return { ok: false, error: 'symbole requis' };
  const plan = source || preferredSource(symbol);

  if (plan === 'chart') return fromChart(symbol, interval, limit);
  if (plan === 'binance') return fromBinance(symbol, interval, limit);

  const b = await fromBinance(symbol, interval, limit);
  if (b.ok) return b;
  const ch = await fromChart(symbol, interval, limit);
  if (ch.ok) return { ...ch, binance_indisponible: b.error };
  return {
    ok: false,
    error: 'aucune source n a pu fournir de bougies pour ' + symbol,
    binance: b.error,
    graphique: ch.error,
  };
}

/** Bars as an array of objects, the shape the levels/fib modules work with. */
export function toCandles(bars) {
  if (!bars || !bars.ok) return [];
  const out = [];
  for (let i = 0; i < bars.n; i++) {
    out.push({ time: bars.t[i], open: bars.o[i], high: bars.h[i], low: bars.l[i], close: bars.c[i], volume: bars.v[i] });
  }
  return out;
}
