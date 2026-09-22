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
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const BARS = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()';

/**
 * The chart holds only what TradingView has already loaded — measured at 300
 * bars, whatever is asked for. A backtest on 300 bars produces single-digit
 * trade counts, which prove nothing. Yahoo serves the same instruments with
 * years of hourly history, so it is the depth source.
 *
 * `equivalent: false` marks a proxy whose PRICES are not the traded
 * instrument's: GC=F is the COMEX future and carries a premium over spot gold
 * (about +1%). Percentage moves, volatility and strategy statistics transfer;
 * absolute price levels do not, and every result says so.
 */
const YAHOO_MAP = {
  XAUUSD: { y: 'GC=F', equivalent: false, note: 'future COMEX (GC), prime de portage d environ +1% sur le spot XAUUSD' },
  GOLD: { y: 'GC=F', equivalent: false, note: 'future COMEX (GC)' },
  XAGUSD: { y: 'SI=F', equivalent: false, note: 'future COMEX argent (SI)' },
  SILVER: { y: 'SI=F', equivalent: false, note: 'future COMEX argent (SI)' },
  USOIL: { y: 'CL=F', equivalent: false, note: 'future NYMEX WTI (CL)' },
  WTICOUSD: { y: 'CL=F', equivalent: false, note: 'future NYMEX WTI (CL)' },
  DXY: { y: 'DX-Y.NYB', equivalent: true, note: 'indice dollar ICE' },
  EURUSD: { y: 'EURUSD=X', equivalent: true },
  GBPUSD: { y: 'GBPUSD=X', equivalent: true },
  USDJPY: { y: 'USDJPY=X', equivalent: true },
  AUDUSD: { y: 'AUDUSD=X', equivalent: true },
  USDCHF: { y: 'USDCHF=X', equivalent: true },
  SPX: { y: '^GSPC', equivalent: true }, SP500: { y: '^GSPC', equivalent: true },
  NDX: { y: '^NDX', equivalent: true }, US100: { y: '^NDX', equivalent: true },
  DJI: { y: '^DJI', equivalent: true }, VIX: { y: '^VIX', equivalent: true },
  US10Y: { y: '^TNX', equivalent: true, note: 'rendement 10 ans US' },
  TNX: { y: '^TNX', equivalent: true },
};

/** Yahoo equivalent of a TradingView symbol, or null when none is known. */
export function yahooSymbol(symbol) {
  const t = ticker(symbol);
  if (YAHOO_MAP[t]) return YAHOO_MAP[t];
  // An equity keeps its ticker: NASDAQ:AAPL is AAPL on Yahoo too.
  if (/^[A-Z][A-Z.\-]{0,5}$/.test(t) && exchangeOf(symbol) && !['BINANCE', 'OANDA', 'FX', 'TVC', 'FOREXCOM'].includes(exchangeOf(symbol))) {
    return { y: t, equivalent: true };
  }
  return null;
}

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

// Yahoo's own interval names, and how far back each may be asked to go.
const YAHOO_IV = { '1m': ['1m', '7d'], '5m': ['5m', '60d'], '15m': ['15m', '60d'], '30m': ['30m', '60d'], '1h': ['1h', '2y'], '1d': ['1d', '10y'], '1w': ['1wk', '10y'], '1M': ['1mo', '10y'] };

async function fromYahoo(symbol, interval, limit) {
  const iv = normalizeInterval(interval);
  const map = yahooSymbol(symbol);
  if (!map) return { ok: false, error: 'aucun equivalent Yahoo connu pour ' + symbol };
  const spec = YAHOO_IV[iv.binance];
  if (!spec) return { ok: false, error: 'intervalle ' + interval + ' non servi par Yahoo' };

  const res = await getJSON(YAHOO + encodeURIComponent(map.y) + '?interval=' + spec[0] + '&range=' + spec[1]);
  if (!res.ok) return { ok: false, error: res.error };
  const rr = res.data && res.data.chart && res.data.chart.result && res.data.chart.result[0];
  if (!rr || !Array.isArray(rr.timestamp) || rr.timestamp.length === 0) {
    const e = res.data && res.data.chart && res.data.chart.error;
    return { ok: false, error: 'aucune bougie Yahoo pour ' + map.y + (e ? ' (' + e.description + ')' : '') };
  }

  const q = rr.indicators.quote[0];
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (let i = 0; i < rr.timestamp.length; i++) {
    // Yahoo pads gaps with nulls; a null bar is absent data, never a flat bar.
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    t.push(rr.timestamp[i]); o.push(q.open[i]); h.push(q.high[i]); l.push(q.low[i]); c.push(q.close[i]);
    v.push(q.volume && q.volume[i] != null ? q.volume[i] : 0);
  }
  if (c.length < 30) return { ok: false, error: 'seulement ' + c.length + ' bougies exploitables chez Yahoo' };

  // Keep the most recent `limit` bars.
  const keep = Math.max(50, Math.min(Number(limit) || 1000, c.length));
  const from = c.length - keep;
  const withVol = v.slice(from).filter(x => x > 0).length;
  return {
    ok: true, source: 'yahoo', symbol: ticker(symbol), symbole_source: map.y,
    interval: iv.binance,
    t: t.slice(from), o: o.slice(from), h: h.slice(from), l: l.slice(from), c: c.slice(from), v: v.slice(from),
    n: keep,
    bougie_en_cours_exclue: false,
    prix_equivalents: map.equivalent !== false,
    equivalence_note: map.equivalent === false
      ? 'PRIX NON EQUIVALENTS: ' + map.y + ' est un ' + (map.note || 'instrument voisin')
        + '. Les variations en %, la volatilite et les statistiques de strategie sont transposables; les NIVEAUX DE PRIX absolus ne le sont pas.'
      : map.note,
    volume_disponible: withVol > 0,
    volume_couverture_pct: keep ? Math.round(withVol / keep * 1000) / 10 : 0,
  };
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
export async function fetchBars({ symbol, interval = '1h', limit = 500, source, prefer = 'exactitude' } = {}) {
  if (!symbol) return { ok: false, error: 'symbole requis' };

  if (source === 'chart') return fromChart(symbol, interval, limit);
  if (source === 'binance') return fromBinance(symbol, interval, limit);
  if (source === 'yahoo') return fromYahoo(symbol, interval, limit);

  const ex = exchangeOf(symbol);
  const cryptoLikely = ex === null || ex === 'BINANCE';
  if (cryptoLikely) {
    const b = await fromBinance(symbol, interval, limit);
    if (b.ok) return b;
    var binanceErr = b.error;
  }

  // Outside crypto the two remaining sources answer different questions:
  //   'profondeur'  — thousands of bars, possibly from a proxy contract.
  //                   What a backtest or a volatility statistic needs.
  //   'exactitude'  — the instrument actually traded, capped at 300 bars.
  //                   What a price LEVEL needs, since a level from a future
  //                   sits about 1% away from the same level on spot.
  const order = prefer === 'profondeur' ? ['yahoo', 'chart'] : ['chart', 'yahoo'];
  const errs = {};
  for (const src of order) {
    const res = src === 'yahoo' ? await fromYahoo(symbol, interval, limit) : await fromChart(symbol, interval, limit);
    if (res.ok) {
      if (binanceErr) res.binance_indisponible = binanceErr;
      res.source_choisie_pour = prefer;
      if (src === 'chart' && res.n < limit * 0.8) {
        res.profondeur_limitee = 'Le graphique n a servi que ' + res.n + ' bougies sur ' + limit
          + ' demandees. Pour un test statistique, demander prefer="profondeur" (source Yahoo, des milliers de bougies)'
          + (yahooSymbol(symbol) ? '.' : ', mais aucun equivalent Yahoo n est connu pour ce symbole.');
      }
      return res;
    }
    errs[src] = res.error;
  }
  return {
    ok: false,
    error: 'aucune source n a pu fournir de bougies pour ' + symbol,
    binance: binanceErr,
    yahoo: errs.yahoo,
    graphique: errs.chart,
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
