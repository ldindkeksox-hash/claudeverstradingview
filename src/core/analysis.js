/**
 * Multi-timeframe technical snapshot.
 *
 * Indicators are computed inside the page from the series the chart already
 * holds, so one call returns a whole timeframe without shipping hundreds of
 * bars back over CDP.
 *
 * Three correctness notes that matter more than the numbers themselves:
 *  - every timeframe is validated through setTimeframe(), and the symbol is
 *    confirmed on the chart before anything is read — a resolution property or
 *    a toolbar label is not proof that the series reloaded;
 *  - RSI and ATR use Wilder's smoothing, the same as TradingView. A plain mean
 *    over the last 14 bars gives a different number from the one on screen;
 *  - an EMA needs far more warm-up than its period, so `bars_used` and
 *    `reliable` are returned per average instead of quietly publishing a value
 *    computed from too little history.
 */
import { evaluate } from '../connection.js';
import { setTimeframe, setSymbol, getState } from './chart.js';

const WARMUP_FACTOR = 4;   // bars needed per EMA period before it is trustworthy

// A symbol change takes seconds. Reading before it lands returns the PREVIOUS
// symbol's bars, which look perfectly plausible.
async function waitForSymbol(symbol, timeoutMs = 20000) {
  const wanted = String(symbol).split(':').pop().toUpperCase();
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    try {
      const st = await getState();
      seen = st && st.symbol;
      // exact match on the ticker segment: "BTCUSD" must not satisfy "BTCUSDT"
      if (seen && String(seen).split(':').pop().toUpperCase() === wanted) {
        return { ok: true, symbol: seen };
      }
    } catch (e) { /* chart still loading */ }
  }
  return { ok: false, symbol: seen };
}

async function computeOnCurrentChart() {
  return evaluate(`
    (function() {
      var w = window.TradingViewApi._activeChartWidgetWV.value();
      var b = w._chartWidget.model().mainSeries().bars();
      var end = b.lastIndex(), start = b.firstIndex();
      var t = [], c = [], h = [], l = [], v = [];
      for (var i = start; i <= end; i++) {
        var x = b.valueAt(i);
        if (x) { t.push(x[0]); c.push(x[4]); h.push(x[2]); l.push(x[3]); v.push(x[5] || 0); }
      }
      var n = c.length;
      if (n < 30) return { error: 'Only ' + n + ' bars loaded; not enough to analyse.' };

      function ema(arr, p) {
        if (arr.length < p) return null;
        var k = 2 / (p + 1), e = 0;
        for (var i = 0; i < p; i++) e += arr[i];
        e /= p;
        for (var i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
        return e;
      }
      function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }

      // RSI with Wilder smoothing (RMA), matching TradingView.
      function rsi(period) {
        if (n < period + 1) return null;
        var g = 0, ls = 0, i;
        for (i = 1; i <= period; i++) {
          var d0 = c[i] - c[i - 1];
          if (d0 > 0) g += d0; else ls -= d0;
        }
        var ag = g / period, al = ls / period;
        for (i = period + 1; i < n; i++) {
          var d = c[i] - c[i - 1];
          var up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
          ag = (ag * (period - 1) + up) / period;
          al = (al * (period - 1) + dn) / period;
        }
        if (al === 0 && ag === 0) return 50;   // perfectly flat is neutral, not overbought
        if (al === 0) return 100;
        return 100 - 100 / (1 + ag / al);
      }

      // ATR with Wilder smoothing, matching TradingView.
      function atr(period) {
        if (n < period + 1) return null;
        function tr(i) {
          return Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
        }
        var sum = 0, i;
        for (i = 1; i <= period; i++) sum += tr(i);
        var a = sum / period;
        for (i = period + 1; i < n; i++) a = (a * (period - 1) + tr(i)) / period;
        return a;
      }

      // Extremes only when the window is actually available.
      function hi(p) { return n >= p ? Math.max.apply(null, h.slice(-p)) : null; }
      function lo(p) { return n >= p ? Math.min.apply(null, l.slice(-p)) : null; }

      // The last bar is still forming, so it is excluded from the volume
      // average it would otherwise be compared against.
      var volAvg = null;
      if (n >= 21) {
        var s = 0;
        for (var j = n - 21; j < n - 1; j++) s += v[j];
        volAvg = s / 20;
      }

      var close = c[n - 1];
      return {
        symbol: w.symbol(),
        bars_used: n,
        bar_spacing_s: t[n - 1] - t[n - 2],
        last_bar_utc: new Date(t[n - 1] * 1000).toISOString(),
        close: r2(close),
        ema20: r2(ema(c, 20)), ema50: r2(ema(c, 50)), ema200: r2(ema(c, 200)),
        rsi14: (function(x) { return x == null ? null : Math.round(x * 10) / 10; })(rsi(14)),
        atr14: r2(atr(14)),
        atr_pct: (function(x) { return x == null ? null : Math.round((x / close) * 10000) / 100; })(atr(14)),
        high20: r2(hi(20)), low20: r2(lo(20)),
        high50: r2(hi(50)), low50: r2(lo(50)),
        volume_vs_avg20: volAvg ? Math.round((v[n - 1] / volAvg) * 100) / 100 : null,
        bar_in_progress: true
      };
    })()
  `);
}

function annotate(tf) {
  if (!tf || tf.error) return tf;
  const n = tf.bars_used;
  tf.reliable = {
    ema20: n >= 20 * WARMUP_FACTOR,
    ema50: n >= 50 * WARMUP_FACTOR,
    ema200: n >= 200 * WARMUP_FACTOR,
  };
  const thin = Object.keys(tf.reliable).filter(k => tf.reliable[k] === false && tf[k] != null);
  if (thin.length) {
    tf.warning = 'Thin warm-up: ' + thin.join(', ') + ' computed from only ' + n +
      ' bars. Treat as indicative; scroll the chart back to load more history for a firm reading.';
  }

  const c = tf.close;
  tf.structure = {
    above_ema20: tf.ema20 == null ? null : c > tf.ema20,
    above_ema50: tf.ema50 == null ? null : c > tf.ema50,
    above_ema200: tf.ema200 == null ? null : c > tf.ema200,
    pct_to_high20: tf.high20 ? Math.round(((tf.high20 - c) / c) * 10000) / 100 : null,
    pct_to_low20: tf.low20 ? Math.round(((c - tf.low20) / c) * 10000) / 100 : null,
  };
  return tf;
}

export async function snapshot({ symbol, timeframes }) {
  const list = (Array.isArray(timeframes) && timeframes.length ? timeframes : ['D', '240', '60'])
    .map(String);

  if (symbol) {
    await setSymbol({ symbol });
    const loaded = await waitForSymbol(symbol);
    if (!loaded.ok) {
      return {
        success: false,
        symbol,
        error: 'Symbol never loaded on the chart (it still shows ' + loaded.symbol +
          '). Nothing was read, rather than reading the previous symbol by mistake.',
      };
    }
  }

  const out = {};
  const failed = [];

  for (const tf of list) {
    const set = await setTimeframe({ timeframe: tf });
    if (!set.success) {
      failed.push({ timeframe: tf, reason: set.error || 'resolution could not be set' });
      continue;
    }
    const data = await computeOnCurrentChart();
    if (!data || data.error) {
      failed.push({ timeframe: tf, reason: (data && data.error) || 'no data' });
      continue;
    }
    if (set.verified === false) {
      // Readable, but the resolution could not be proven — say so on the data itself.
      data.resolution_unverified = set.note || 'Resolution could not be confirmed by bar spacing.';
    }
    if (set.method === 'page_reload') data.note = set.warning;
    out[tf] = annotate(data);
  }

  const first = Object.values(out)[0];
  return {
    success: Object.keys(out).length > 0,
    symbol: (first && first.symbol) || symbol || null,
    timeframes: out,
    failed: failed.length ? failed : undefined,
    note: 'The most recent bar of each timeframe is still forming; its close and volume are not final.',
  };
}
