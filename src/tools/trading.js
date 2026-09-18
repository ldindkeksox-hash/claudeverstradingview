import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

export function registerTradingTools(server) {
  server.tool(
    'trading_get_account',
    'Read the paper-trading account: balance, equity, margin, and every open position with its entry, take profit, stop loss and live PnL. Also reports the risk actually on the table if every stop were hit, and names any position with no stop loss.',
    {},
    async () => {
      try { return jsonResult(await core.getAccount()); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'trading_close_position',
    'Close an open paper-trading position at market. Not reversible: requires confirm: true, and verifies the position is actually gone afterwards.',
    {
      symbol: z.string().describe('Symbol of the position, e.g. "BINANCE:BTCUSDT" or "BTCUSDT"'),
      confirm: z.coerce.boolean().optional().describe('Must be true to actually close'),
    },
    async ({ symbol, confirm }) => {
      try { return jsonResult(await core.closePosition({ symbol, confirm })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'trading_check_risk',
    'Read-only session audit: flags positions with no stop loss, positions risking more than the allowed share of capital, correlated positions that are really one bet, and symbols with no active alert. Changes nothing - safe to run at any time.',
    {
      max_risk_pct_per_trade: z.coerce.number().optional().describe('Allowed risk per trade in % of equity. Default 1.'),
      max_total_risk_pct: z.coerce.number().optional().describe('Allowed total simultaneous risk in % of equity. Default 3.'),
    },
    async ({ max_risk_pct_per_trade, max_total_risk_pct }) => {
      try { return jsonResult(await core.checkRisk({ max_risk_pct_per_trade, max_total_risk_pct })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
