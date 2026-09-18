import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/analysis.js';

export function registerAnalysisTools(server) {
  server.tool(
    'analysis_snapshot',
    'Multi-timeframe technical snapshot in one call: close, EMA20/50/200, RSI14, ATR, 20/50-bar swing highs and lows, and volume vs average, for each requested timeframe. Every timeframe is verified to have actually reloaded before it is read, and each average carries a reliability flag so a thin series is visible instead of silently wrong.',
    {
      symbol: z.string().optional().describe('Symbol to analyse. Defaults to the chart symbol.'),
      timeframes: z.array(z.string()).optional().describe('Resolutions to scan, e.g. ["D","240","60"]. Default ["D","240","60"].'),
    },
    async ({ symbol, timeframes }) => {
      try { return jsonResult(await core.snapshot({ symbol, timeframes })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
