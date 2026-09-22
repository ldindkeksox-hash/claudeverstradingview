/**
 * Fibonacci and strategy-testing tools.
 *
 * These work on ANY symbol TradingView can display, not only Binance pairs:
 * bars come from the universal source in core/bars.js.
 */
import { z } from 'zod';
import * as fib from '../core/fibonacci.js';
import * as bt from '../core/backtest.js';

const jsonResult = (data, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  isError,
});

export function registerStrategyTools(server) {
  server.tool(
    'analysis_fibonacci',
    'Fibonacci retracements and extensions of the last completed impulse, with each level TESTED against history: how many times price reached it and how often it held. Works on any symbol (gold, forex, indices, crypto).',
    {
      symbol: z.string().describe('Symbol, e.g. "OANDA:XAUUSD", "BINANCE:BTCUSDT", "NASDAQ:AAPL"'),
      interval: z.string().optional().describe('Binance ("1h","15m","1d") or TradingView ("60","15","D") naming. Default 1h.'),
      periods: z.coerce.number().optional().describe('Bars to analyse (default 500, max 1000)'),
      swing_atr: z.coerce.number().optional().describe('ZigZag threshold in ATR units (default 3). Lower = more, smaller swings.'),
      lookahead: z.coerce.number().optional().describe('Bars used to measure the move after each touch (default 10)'),
    },
    async (args) => {
      try { return jsonResult(await fib.fibonacci(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'strategy_list',
    'List the backtestable strategies with their default parameters.',
    {},
    async () => {
      try { return jsonResult({ success: true, strategies: bt.listStrategies() }); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'strategy_backtest',
    'Backtest one strategy on a symbol. Entry fills at the NEXT bar open (no look-ahead), a bar touching both stop and target counts as a stop, and results carry a t-statistic plus a random-entry control so an edge can be told apart from luck.',
    {
      symbol: z.string().describe('Symbol, e.g. "OANDA:XAUUSD"'),
      strategie: z.string().optional().describe('repli_tendance | rsi_extreme | cassure | fib_retracement (default repli_tendance)'),
      interval: z.string().optional().describe('Default 1h'),
      periods: z.coerce.number().optional().describe('Bars of history (default 1000)'),
      stop_atr: z.coerce.number().optional().describe('Stop distance in ATR (default 2)'),
      objectif_atr: z.coerce.number().optional().describe('Target distance in ATR (default 4)'),
      max_bougies: z.coerce.number().optional().describe('Bars before giving up on a trade (default 50)'),
      sens: z.enum(['long', 'short', 'les_deux']).optional().describe('Trade direction (default les_deux)'),
      params: z.record(z.string(), z.any()).optional().describe('Strategy-specific overrides, see strategy_list'),
    },
    async (args) => {
      try { return jsonResult(await bt.backtest(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'strategy_find',
    'Run every strategy over a grid of stop/target pairs and keep only what clears four filters: >=30 trades, positive expectancy, |t|>=2, and beating random entries. Reports how many combinations were tried, because testing many and keeping the best invents edges out of noise.',
    {
      symbol: z.string().describe('Symbol, e.g. "OANDA:XAUUSD"'),
      interval: z.string().optional().describe('Default 1h'),
      periods: z.coerce.number().optional().describe('Bars of history (default 1000)'),
      sens: z.enum(['long', 'short', 'les_deux']).optional().describe('Default les_deux'),
    },
    async (args) => {
      try { return jsonResult(await bt.findStrategy(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
