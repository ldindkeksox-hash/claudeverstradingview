import { evaluate, KNOWN_PATHS } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Bars loaded by the chart itself. The previous version counted
        // document.querySelectorAll('[class*="bar"]'), which matches toolbar,
        // sidebar and scrollbar — a number that never reflected the data and
        // left chart_ready stuck on false while the symbol had in fact loaded.
        var barCount = -1;
        try { barCount = ${KNOWN_PATHS.mainSeriesBars}.size(); } catch (e) {}

        // Symbol as the chart API reports it, not as the header renders it:
        // the header can still show the previous ticker mid-swap.
        var currentSymbol = '';
        try { currentSymbol = ${KNOWN_PATHS.chartApi}.symbol() || ''; } catch (e) {}
        if (!currentSymbol) {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        }

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Exact match on the ticker segment. includes() accepted "BTCUSD" while the
    // chart still showed "BTCUSDT" — declaring the wrong instrument ready.
    const ticker = (s) => String(s == null ? '' : s).split(':').pop().toUpperCase();
    if (expectedSymbol && state.currentSymbol && ticker(state.currentSymbol) !== ticker(expectedSymbol)) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timed out. false means "not confirmed ready within the timeout", never
  // "the symbol failed to load" — the caller must verify rather than assume
  // either way. (The old comment here said "return true anyway" while the code
  // returned false, so the two disagreed about what the value meant.)
  return false;
}
