/**
 * Fibonacci and strategy-testing tools.
 *
 * These work on ANY symbol TradingView can display, not only Binance pairs:
 * bars come from the universal source in core/bars.js.
 */
import { z } from 'zod';
import * as fib from '../core/fibonacci.js';
import * as bt from '../core/backtest.js';
import * as macro from '../core/macro.js';
import * as gold from '../core/gold.js';

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

  server.tool(
    'analysis_drivers',
    'What actually moves this asset. For gold: the dollar, US 10-year yields, silver and equities — each with correlation on RETURNS, sample size, t-statistic, beta ("for 1% of DXY, gold moves X%"), and an alert when a usual link is breaking or weakening. Reading gold without its drivers is reading half the chart.',
    {
      symbol: z.string().describe('Symbol, e.g. "OANDA:XAUUSD"'),
      interval: z.string().optional().describe('Default 1d. Daily is the right scale for macro links.'),
      periods: z.coerce.number().optional().describe('Bars of history (default 400)'),
      fenetre_courte: z.coerce.number().optional().describe('Recent window used to detect a breaking link (default 30)'),
    },
    async (args) => {
      try { return jsonResult(await macro.drivers(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'analysis_sessions',
    'Hour-by-hour profile: which hours actually carry the range and which only look like they do. On gold the most active hour moves 2.4x the calmest, so one ATR-based stop is wrong in both directions depending on entry time. Directional bias is reported with a binomial test, never asserted.',
    {
      symbol: z.string().describe('Symbol, e.g. "OANDA:XAUUSD"'),
      periods: z.coerce.number().optional().describe('Hourly bars to profile (default 2000)'),
    },
    async (args) => {
      try { return jsonResult(await macro.sessionProfile(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'analysis_order_blocks',
    'Smart Money Concepts order blocks (the "OB sell zone" method), detected AND tested. Finds the last opposing candle before an impulsive move, then measures what a trader taking that zone would actually have made: fill at the PROXIMAL edge, stop beyond the far side, and the real reward:risk once the stop has to clear the zone. Returns expectancy in R, not just a flattering win rate.',
    {
      symbol: z.string().optional().describe('Default OANDA:XAUUSD'),
      interval: z.string().optional().describe('Default 5m. Try 1h too — it tests better on gold.'),
      periods: z.coerce.number().optional().describe('Bars of history (default 2000)'),
      impulsion_atr: z.coerce.number().optional().describe('How violent the move after the candle must be, in ATR (default 2)'),
      impulsion_bougies: z.coerce.number().optional().describe('Bars the impulse may take (default 5)'),
      zone: z.enum(['corps', 'meche']).optional().describe('Zone = candle body (default, tighter, better R) or full wick range'),
      reaction_atr: z.coerce.number().optional().describe('Target distance in ATR used to judge a reaction (default 1)'),
      max_blocs: z.coerce.number().optional().describe('Untouched zones to return (default 12)'),
    },
    async (args) => {
      try { return jsonResult(await gold.orderBlocks(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'plan_trade',
    'Plan a multi-target trade (several TPs, one SL). Gives each target its distance in points AND pips, its R, the partial gain, and — the part people skip — every partial outcome, including "TP1 hit then stopped on the rest", which is usually breakeven rather than a win. Also compares scaling out against a single exit.',
    {
      entree: z.coerce.number().describe('Entry price'),
      stop: z.coerce.number().describe('Stop loss price'),
      sens: z.enum(['long', 'short']).optional().describe('Default long'),
      objectifs: z.array(z.coerce.number()).optional().describe('Target prices. Omitted = 1R, 2R, 3R.'),
      parts: z.array(z.coerce.number()).optional().describe('Share of the position closed at each target, e.g. [0.5,0.3,0.2]. Normalised automatically.'),
      capital_risque_usd: z.coerce.number().optional().describe('USD risked if the stop is hit — turns every R into a dollar figure'),
      taux_reussite_estime: z.coerce.number().optional().describe('Win rate used for the scaling-out comparison (default 0.5)'),
      convention_pips: z.enum(['standard', 'point', 'dollar']).optional().describe('Gold pip convention (default standard: 1 pip = $0.10)'),
    },
    async (args) => {
      try { return jsonResult(gold.planTrade(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );

  server.tool(
    'gold_pips',
    'Convert between dollars and pips on gold under all three conventions in circulation. "300 pips" means $30, $3 or $300 depending on who is speaking — a factor of 100 — so check before copying anyone\'s stop.',
    {
      montant_usd: z.coerce.number().optional().describe('A dollar move to express in pips'),
      pips: z.coerce.number().optional().describe('A number of pips to express in dollars'),
      convention: z.enum(['standard', 'point', 'dollar']).optional().describe('Default standard (1 pip = $0.10)'),
    },
    async (args) => {
      try { return jsonResult(gold.pips(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    },
  );
}
