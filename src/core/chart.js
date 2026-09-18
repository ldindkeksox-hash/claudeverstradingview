/**
 * Core chart control logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';
import { waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function getState() {
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export async function setSymbol({ symbol }) {
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol('${symbol.replace(/'/g, "\\'")}', {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  return { success: true, symbol, chart_ready: ready };
}

// Seconds per bar for each resolution TradingView accepts.
// Seconds per bar for each resolution TradingView accepts:
// "30S" seconds, "15" minutes (bare number), "2D" days, "3W" weeks.
// Calendar months vary in length, so "M" has no fixed answer.
export function resolutionSeconds(tf) {
  const s = String(tf == null ? '' : tf).trim().toUpperCase();
  const m = s.match(/^(\d*)([SDWM]?)$/);
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;   // empty / whitespace is not a resolution
  const n = m[1] === '' ? 1 : Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === 'S') return n;
  if (m[2] === 'D') return n * 86400;
  if (m[2] === 'W') return n * 604800;
  if (m[2] === 'M') return null;          // calendar month — not a fixed span
  if (m[2] === '') return n * 60;         // bare number means minutes
  return null;
}

// Whether a resolution can be checked by bar spacing at all. Distinguishes
// "verification impossible" (monthly, unparseable) from "verified false".
export function isVerifiableResolution(tf) {
  return resolutionSeconds(tf) != null;
}

/**
 * Typical spacing across a run of bars.
 *
 * Never use the last pair alone: that gap is the one most likely to straddle a
 * weekend, a session break or a holiday, which would flag perfectly fresh data
 * as stale. A session break can only ENLARGE a gap, never shrink it — so the
 * median and the smallest gap both survive it. A wrong resolution, by contrast,
 * shifts every gap at once, so it still gets caught.
 */
export function spacingStats(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return { median: gaps[Math.floor(gaps.length / 2)], min: gaps[0], samples: gaps.length };
}

export function spacingMatches(stats, expected) {
  if (stats == null || expected == null) return null;
  return Math.abs(stats.median - expected) < 2 || Math.abs(stats.min - expected) < 2;
}

// Spacing statistics over the bars currently loaded on the chart.
async function barSpacing() {
  const times = await evaluate(`
    (function() {
      try {
        var b = window.TradingViewApi._activeChartWidgetWV.value()
          ._chartWidget.model().mainSeries().bars();
        var e = b.lastIndex(), s = Math.max(b.firstIndex(), e - 60);
        var out = [];
        for (var i = s; i <= e; i++) { var v = b.valueAt(i); if (v) out.push(v[0]); }
        return out;
      } catch (err) { return null; }
    })()
  `);
  return Array.isArray(times) && times.length >= 2 ? spacingStats(times) : null;
}

/**
 * Set the chart resolution and PROVE the data actually reloaded.
 *
 * chart.setResolution() updates the resolution property and the toolbar while
 * leaving the previous resolution's bars in place, so data_get_ohlcv silently
 * returns bars of the wrong timeframe. Every read here is therefore validated
 * against real bar spacing, and a reload through the URL is used as a fallback.
 */
export async function setTimeframe({ timeframe, timeout_ms }) {
  const expected = resolutionSeconds(timeframe);
  const budget = Number(timeout_ms) > 0 ? Number(timeout_ms) : 25000;
  let measured = null;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${JSON.stringify(String(timeframe))}, {});
    })()
  `);

  // null = cannot be checked by spacing (monthly, or an unparseable resolution)
  const matches = async () => {
    if (expected == null) return null;
    measured = await barSpacing();
    return spacingMatches(measured, expected);
  };

  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const ok = await matches();
    if (ok === null) break;
    if (ok) {
      return {
        success: true, timeframe, verified: true, method: 'setResolution',
        expected_spacing_s: expected,
        bar_spacing_s: measured ? measured.median : null,   // measured, not assumed
        min_spacing_s: measured ? measured.min : null,
      };
    }
  }

  if (expected == null) {
    return {
      success: true, timeframe, verified: false, method: 'setResolution',
      note: String(timeframe).toUpperCase().indexOf('M') >= 0
        ? 'Monthly bars have no fixed length, so the resolution cannot be confirmed by bar spacing. Values may still be correct.'
        : 'Resolution "' + timeframe + '" could not be parsed, so it cannot be confirmed by bar spacing. Values may still be correct.',
    };
  }

  // Fallback: a real page load at the requested interval.
  const symbol = await evaluate(`
    (function() { try { return ${CHART_API}.symbol(); } catch (e) { return null; } })()
  `);
  if (!symbol) {
    return { success: false, timeframe, verified: false,
      error: 'Resolution did not reload and the symbol could not be read for a fallback reload.' };
  }

  await evaluate(`
    (function() {
      location.href = 'https://www.tradingview.com/chart/?symbol='
        + encodeURIComponent(${JSON.stringify(symbol)}) + '&interval='
        + encodeURIComponent(${JSON.stringify(String(timeframe))});
      return true;
    })()
  `);

  const reloadDeadline = Date.now() + 45000;
  while (Date.now() < reloadDeadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      if (await matches()) {
        return {
          success: true, timeframe, verified: true, method: 'page_reload', symbol,
          expected_spacing_s: expected,
          bar_spacing_s: measured ? measured.median : null,
          min_spacing_s: measured ? measured.min : null,
          warning: 'setResolution did not reload the series, so the page was reloaded. Indicators, drawings and the saved layout are gone from the chart.',
        };
      }
    } catch (e) { /* page is navigating */ }
  }

  return {
    success: false, timeframe, verified: false,
    expected_spacing_s: expected,
    bar_spacing_s: measured ? measured.median : null,
    error: 'Timeframe did not load after both setResolution and a page reload. Data currently on the chart is NOT at the requested resolution. A page reload was attempted, so the chart may also have lost its layout.',
  };
}

export async function setType({ chart_type }) {
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy('${indicator.replace(/'/g, "\\'")}', false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity('${entity_id.replace(/'/g, "\\'")}');
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function setVisibleRange({ from, to }) {
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = chart.symbolExt();
      return {
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType()
      };
    })()
  `);
  return { success: true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
