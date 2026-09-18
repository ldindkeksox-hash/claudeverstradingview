import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as positioning from '../core/positioning.js';
import * as orderbook from '../core/orderbook.js';
import * as strength from '../core/strength.js';
import * as regime from '../core/regime.js';
import * as levels from '../core/levels.js';

export function registerProAnalysisTools(server) {
  server.tool(
    'market_positioning',
    'Leveraged positioning on a crypto pair: funding rate (with annualised equivalent), open interest and its 24h change, long/short account ratio, and taker buy/sell aggression. The core reading is price vs open interest — price up with OI up is new money entering, price up with OI down is short covering and far more fragile. Binance data, no chart needed.',
    {
      symbol: z.string().describe('e.g. "LINKUSDT" or "BINANCE:LINKUSDT"'),
      period: z.string().optional().describe('Bucket size: 1h, 4h, 12h, 1d. Default 4h. Note: taker flow lags a full bucket, so 1d is not usable for it.'),
    },
    async (a) => { try { return jsonResult(await positioning.positioning(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'market_orderbook',
    'Order book state: spread, bid/ask imbalance in a band around price, liquidity walls detected statistically, and how much buying or selling it takes to move price 0.5% and 1%. A book is a snapshot that changes in seconds and large orders can be pulled — the response timestamps itself and says so.',
    {
      symbol: z.string().describe('e.g. "LINKUSDT"'),
      depth_pct: z.coerce.number().optional().describe('Band around mid price to measure, in %. Default 0.5.'),
    },
    async (a) => { try { return jsonResult(await orderbook.orderbook(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'analysis_relative_strength',
    'Strength of an asset against a benchmark (default BTCUSDT), measured on the ratio series rather than on absolute price. An asset rising slower than BTC during a rally is WEAK even though its price is up — absolute-price analysis misses this entirely.',
    {
      symbol: z.string().describe('e.g. "LINKUSDT"'),
      benchmark: z.string().optional().describe('Default "BTCUSDT"'),
      interval: z.string().optional().describe('1h, 4h, 1d, 1w. Default 1d.'),
      periods: z.coerce.number().optional().describe('Number of bars. Default 90.'),
    },
    async (a) => { try { return jsonResult(await strength.relativeStrength(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'analysis_correlation',
    'Correlation actually MEASURED between assets — Pearson on log returns, not on raw prices (two series that both rise correlate artificially). Reports how many points it rests on and the noise threshold below which a correlation is indistinguishable from chance. Pairs above 0.8 are one position wearing two names.',
    {
      symbols: z.array(z.string()).describe('e.g. ["LINKUSDT","BTCUSDT","ETHUSDT"]'),
      interval: z.string().optional().describe('Default 1d.'),
      periods: z.coerce.number().optional().describe('Default 90.'),
    },
    async (a) => { try { return jsonResult(await strength.correlationMatrix(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'analysis_volatility_regime',
    'Is volatility high or low FOR THIS ASSET? An ATR of 5% means nothing in absolute terms, so it is ranked as a percentile against its own history, alongside realised volatility. Low percentile means compression, often before a move; high means a move under way and stops that need room. Suggests stop distance in ATR multiples.',
    {
      symbol: z.string().describe('e.g. "LINKUSDT"'),
      interval: z.string().optional().describe('Default 1d.'),
      periods: z.coerce.number().optional().describe('Default 300.'),
    },
    async (a) => { try { return jsonResult(await regime.volatilityRegime(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'market_breadth',
    'Risk-on / risk-off gauge across the crypto market: what share of a basket of major pairs trades above its EMA20, EMA50 and EMA200, and how many are up on the day. Buying one coin on a pretty chart while 80% of the market sits below its averages is a bad trade regardless of the chart.',
    {
      symbols: z.array(z.string()).optional().describe('Basket. Defaults to the major Binance USDT pairs.'),
      interval: z.string().optional().describe('Default 1d.'),
    },
    async (a) => { try { return jsonResult(await regime.marketBreadth(a || {})); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );

  server.tool(
    'analysis_key_levels',
    'Price levels that matter, built from VOLUME rather than from bare highs and lows: VWAP with its standard-deviation bands, a volume profile giving the point of control and the 70% value area, low-volume gaps the price crosses quickly, and support/resistance clustered from pivots and weighted by how many times each was touched.',
    {
      symbol: z.string().describe('e.g. "LINKUSDT"'),
      interval: z.string().optional().describe('Default 4h.'),
      periods: z.coerce.number().optional().describe('Number of bars. Default 200.'),
      bins: z.coerce.number().optional().describe('Volume profile resolution. Default 50.'),
    },
    async (a) => { try { return jsonResult(await levels.keyLevels(a)); }
      catch (e) { return jsonResult({ success: false, error: e.message }, true); } }
  );
}
