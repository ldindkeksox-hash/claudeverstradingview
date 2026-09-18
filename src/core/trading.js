/**
 * Paper-trading account access.
 *
 * TradingView's broker REST server (window.TRADING_REST_SERVER_URL) is not
 * reachable from the page origin, so the account is read from the trading
 * panel's own table instead. The table is parsed by its column headers rather
 * than by fixed offsets, so a column added or moved upstream does not silently
 * shift every value.
 */
import { evaluate } from '../connection.js';
import * as alertsCore from './alerts.js';

const PANEL_FIELDS = [
  'Account balance', 'Equity', 'Realized PnL', 'Unrealized PnL',
  'Account margin', 'Available funds', 'Orders margin', 'Margin buffer',
];

// Parses a cell from the trading panel.
// Returns null — never 0 — for an empty or non-numeric cell: a missing stop loss
// read as 0 would look like a stop at price zero instead of no stop at all.
// Handles both "1,234.56" and "1 234,56" by deciding which separator came last.
function num(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/−/g, '-').replace(/[^0-9.,+-]/g, '');
  if (!/[0-9]/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  s = lastComma > lastDot
    ? s.split('.').join('').replace(',', '.')   // comma is the decimal separator
    : s.split(',').join('');                    // comma groups thousands
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// TradingView labels the side "Long"/"Short" in English, but other builds and
// locales use "Buy"/"Sell". Getting this wrong flips the sign of the risk.
function sideOf(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase();
  if (s.indexOf('short') >= 0 || s.indexOf('sell') >= 0) return 'short';
  if (s.indexOf('long') >= 0 || s.indexOf('buy') >= 0) return 'long';
  return null;
}

export async function getAccount() {
  const raw = await evaluate(`
    (function() {
      var NL = String.fromCharCode(10);
      var lines = (document.body.innerText || '').split(NL)
        .map(function(s) { return s.trim(); }).filter(Boolean);

      var fields = {};
      ${JSON.stringify(PANEL_FIELDS)}.forEach(function(k) {
        var i = lines.indexOf(k);
        if (i >= 0 && lines[i + 1]) fields[k] = lines[i + 1];
      });

      // Header row of the positions table drives the mapping.
      var headers = [];
      var headRow = null;
      var allRows = Array.prototype.slice.call(document.querySelectorAll('tr'));
      for (var r = 0; r < allRows.length; r++) {
        var ths = allRows[r].querySelectorAll('th');
        if (ths.length > 5) {
          headRow = allRows[r];
          for (var j = 0; j < ths.length; j++) headers.push((ths[j].innerText || '').trim());
          break;
        }
      }

      var positions = [];
      allRows.forEach(function(tr) {
        if (tr === headRow) return;
        var tds = tr.querySelectorAll('td');
        if (!tds.length) return;
        var first = (tds[0].innerText || '').trim();
        if (first.indexOf(':') < 0) return;      // not a symbol row
        var row = {};
        for (var k = 0; k < tds.length; k++) {
          var key = headers[k] || ('col' + k);
          row[key] = (tds[k].innerText || '').trim().split(NL).join(' ');
        }
        row._has_close = !!tr.querySelector('[data-name="close-settings-cell-button"]');
        positions.push(row);
      });

      return { fields: fields, headers: headers, positions: positions };
    })()
  `);

  // evaluate() always returns an object here, so the old !raw check could never
  // fire: a closed panel silently produced success:true with zero positions.
  if (!raw) throw new Error('Trading panel not found. Open it with the Trade button.');
  if (!raw.fields || Object.keys(raw.fields).length === 0) {
    throw new Error('Trading panel is not open (no account fields on the page), so positions cannot be read. Open it with the Trade button before reading the account.');
  }

  const account = {};
  for (const k of PANEL_FIELDS) {
    if (raw.fields[k] != null) account[k.toLowerCase().split(' ').join('_')] = num(raw.fields[k]);
  }

  const positions = (raw.positions || []).map(p => {
    const pick = (name) => {
      const key = Object.keys(p).find(k => k.toLowerCase() === name.toLowerCase());
      return key ? p[key] : null;
    };
    const sym = (pick('Symbol') || '').split(' ')[0];
    return {
      symbol: sym,
      side: pick('Side'),
      quantity: num(pick('Quantity')),
      entry: num(pick('Avg fill price')),
      take_profit: num(pick('Take profit')),
      stop_loss: num(pick('Stop loss')),
      last: num(pick('Last price')),
      pnl: num(pick('Unrealized PnL')),
      pnl_pct: num(pick('Unrealized PnL %')),
      trade_value: num(pick('Trade value')),
      leverage: pick('Leverage'),
      margin: num(pick('Margin')),
      closable: p._has_close === true,
    };
  }).filter(p => p.symbol);

  // Risk actually on the table: distance to stop x size, per position.
  // The sign is derived from the detected side; when the label is unrecognised
  // the absolute distance is used, because a NEGATIVE risk would subtract from
  // the portfolio total and make the account look safer than it is.
  for (const p of positions) {
    const side = sideOf(p.side);
    p.side_detected = side;
    if (p.stop_loss == null || p.entry == null || !p.quantity) {
      p.risk_if_stopped = null;
      p.unprotected = true;
      continue;
    }
    let perUnit;
    if (side === 'short') perUnit = p.stop_loss - p.entry;
    else if (side === 'long') perUnit = p.entry - p.stop_loss;
    else perUnit = Math.abs(p.entry - p.stop_loss);
    if (perUnit < 0) {
      p.risk_if_stopped = 0;
      p.note = 'Stop is past entry on the favourable side: the position is locked at break-even or better.';
    } else {
      p.risk_if_stopped = Math.round(perUnit * p.quantity * 100) / 100;
    }
    if (side === null) {
      p.warning = 'Side label "' + p.side + '" not recognised; risk computed from the absolute distance to the stop.';
    }
  }

  const totalRisk = positions.reduce((a, p) => a + (p.risk_if_stopped || 0), 0);
  const equity = account.equity;

  return {
    success: true,
    account,
    positions,
    position_count: positions.length,
    total_risk_if_all_stopped: Math.round(totalRisk * 100) / 100,
    total_risk_pct_of_equity: equity ? Math.round((totalRisk / equity) * 10000) / 100 : null,
    unprotected_positions: positions.filter(p => p.unprotected).map(p => p.symbol),
  };
}

export async function closePosition({ symbol, confirm }) {
  if (!symbol) throw new Error('symbol is required');
  if (confirm !== true) {
    return {
      success: false,
      error: 'Closing a position is not reversible. Call again with confirm: true.',
      symbol,
    };
  }

  const before = await getAccount();
  const match = before.positions.find(p => p.symbol === symbol || p.symbol.endsWith(':' + symbol));
  if (!match) {
    return { success: false, error: 'No open position for ' + symbol, open: before.positions.map(p => p.symbol) };
  }

  // Match the RESOLVED symbol exactly, not the caller's string as a substring:
  // "BTCUSD" is a substring of "BINANCE:BTCUSDT", so a loose match could close a
  // different instrument than the one asked for. Only rows that actually carry a
  // close button are considered, which keeps other tables on the page out of it.
  const clicked = await evaluate(`
    (function() {
      var target = ${JSON.stringify(match.symbol)};
      var rows = Array.prototype.slice.call(document.querySelectorAll('tr'));
      for (var i = 0; i < rows.length; i++) {
        var btn = rows[i].querySelector('[data-name="close-settings-cell-button"]');
        if (!btn) continue;
        var tds = rows[i].querySelectorAll('td');
        if (!tds.length) continue;
        var cell = (tds[0].innerText || '').trim().split(/\\s+/)[0];
        if (cell !== target) continue;
        btn.click();
        return true;
      }
      return false;
    })()
  `);

  if (!clicked) return { success: false, error: 'Close button not found for ' + symbol };

  await new Promise(r => setTimeout(r, 4000));
  const after = await getAccount();
  const still = after.positions.find(p => p.symbol === match.symbol);

  return {
    success: !still,
    symbol: match.symbol,
    closed: !still,
    note: still ? 'Close was clicked but the position is still open; a confirmation dialog may be waiting.' : undefined,
    pnl_at_close: match.pnl,
    equity_after: after.account.equity,
  };
}

// --- Session audit -----------------------------------------------------------

const CORRELATION_GROUPS = [
  { name: 'crypto', match: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA'] },
  { name: 'metaux', match: ['GOLD', 'XAU', 'SILVER', 'XAG'] },
  { name: 'petrole', match: ['USOIL', 'UKOIL', 'BRENT', 'WTI', 'CL1'] },
  { name: 'indices_us', match: ['SPX', 'NDX', 'DJI', 'ES1', 'NQ1'] },
];

function groupOf(symbol) {
  const s = String(symbol).toUpperCase();
  for (const g of CORRELATION_GROUPS) {
    if (g.match.some(m => s.indexOf(m) >= 0)) return g.name;
  }
  return null;
}

/**
 * Read-only session audit: what is open, what is protected, what is actually at
 * risk, and whether the alerts in place cover the positions held.
 * Changes nothing — safe to run at any time.
 */
export async function checkRisk({ max_risk_pct_per_trade, max_total_risk_pct } = {}) {
  const perTradeCap = Number(max_risk_pct_per_trade) > 0 ? Number(max_risk_pct_per_trade) : 1;
  const totalCap = Number(max_total_risk_pct) > 0 ? Number(max_total_risk_pct) : 3;

  const acct = await getAccount();
  let alerts = [];
  try {
    const listed = await alertsCore.list();
    alerts = listed.alerts || [];
  } catch (e) { /* alerts are optional context */ }

  const equity = acct.account.equity;
  const problems = [];
  const observations = [];

  for (const p of acct.positions) {
    if (p.unprotected) {
      problems.push({
        severity: 'critique',
        symbol: p.symbol,
        issue: 'Position sans stop loss. La perte est illimitee.',
      });
      continue;
    }
    const pct = equity ? (p.risk_if_stopped / equity) * 100 : null;
    if (pct != null && pct > perTradeCap) {
      problems.push({
        severity: 'eleve',
        symbol: p.symbol,
        issue: 'Risque ' + Math.round(pct * 100) / 100 + '% du capital, au-dessus de la limite de ' + perTradeCap + '%.',
      });
    }
    const covered = alerts.some(a => String(a.symbol).indexOf(p.symbol.split(':').pop()) >= 0 && a.active);
    if (!covered) {
      observations.push({
        symbol: p.symbol,
        note: 'Aucune alerte active sur ce symbole : tu ne seras prevenu de rien avant le stop.',
      });
    }
  }

  // Correlated exposure: several positions in the same family are one bet.
  const byGroup = {};
  for (const p of acct.positions) {
    const g = groupOf(p.symbol);
    if (!g) continue;
    byGroup[g] = byGroup[g] || { symbols: [], risk: 0, sides: new Set() };
    byGroup[g].symbols.push(p.symbol);
    byGroup[g].risk += p.risk_if_stopped || 0;
    byGroup[g].sides.add(String(p.side || '').toLowerCase());
  }
  const correlated = [];
  for (const [g, v] of Object.entries(byGroup)) {
    if (v.symbols.length < 2) continue;
    const sameSide = v.sides.size === 1;
    correlated.push({
      groupe: g,
      symbols: v.symbols,
      risque_cumule: Math.round(v.risk * 100) / 100,
      meme_direction: sameSide,
      note: sameSide
        ? 'Ces positions bougent ensemble et vont dans le meme sens : compte-les comme UN seul pari, pas ' + v.symbols.length + '.'
        : 'Positions correlees en sens opposes : elles se neutralisent en partie.',
    });
  }

  const totalPct = acct.total_risk_pct_of_equity;
  if (totalPct != null && totalPct > totalCap) {
    problems.push({
      severity: 'eleve',
      symbol: '(portefeuille)',
      issue: 'Risque total ' + totalPct + '% au-dessus de la limite de ' + totalCap + '%.',
    });
  }

  return {
    success: true,
    verdict: problems.length === 0 ? 'OK' : 'A CORRIGER',
    equity,
    positions_ouvertes: acct.position_count,
    risque_total_usd: acct.total_risk_if_all_stopped,
    risque_total_pct: totalPct,
    limites: { par_trade_pct: perTradeCap, total_pct: totalCap },
    problemes: problems,
    exposition_correlee: correlated,
    observations,
    alertes_actives: alerts.filter(a => a.active).length,
    positions: acct.positions.map(p => ({
      symbol: p.symbol, side: p.side, quantity: p.quantity,
      entry: p.entry, stop_loss: p.stop_loss, take_profit: p.take_profit,
      pnl: p.pnl, risque_si_stop: p.risk_if_stopped,
      risque_pct: equity && p.risk_if_stopped ? Math.round((p.risk_if_stopped / equity) * 10000) / 100 : null,
    })),
  };
}
