# TradingView MCP — Claude Instructions

101 tools for reading and controlling a live TradingView chart via CDP (port 9222).

## Data source — read this before any analysis tool

Three sources sit behind the analysis tools, and they answer different questions.

| Source | Depth | Prices | Used for |
|--------|-------|--------|----------|
| **binance** | 1000 bars | exact | crypto pairs |
| **yahoo** | ~14 500 hourly bars (2 y) | exact, **except proxies** | depth: backtests, volatility, correlations |
| **chart** | **capped at 300 bars** | the traded instrument | price levels on non-crypto |

The 300-bar chart cap is hard: `setVisibleTimeRange` throws *Not implemented* and
`scrollChartByBar` does not grow the series. Never run a backtest off the chart source — it
produces single-digit trade counts, and three losses out of ten reach |t| = 3.

**Proxies.** Gold maps to `GC=F` (COMEX future), which sits ~1 % above spot; silver and oil are
futures too. Percentage moves, volatility and R-multiples transfer; **absolute price levels do
not**. Results carry `prix_equivalents: false` and an `equivalence_note` — quote a level from a
proxy and it will be ~1 % off the price being traded.

| Tool | Crypto | Gold, forex, indices, stocks |
|------|--------|------------------------------|
| `analysis_key_levels` | yes | yes — chart (exact prices, 300 bars) |
| `analysis_fibonacci` | yes | yes |
| `analysis_volatility_regime` | yes | yes — Yahoo depth |
| `strategy_backtest`, `strategy_find` | yes | yes — Yahoo depth |
| `analysis_drivers`, `analysis_sessions` | yes | yes — Yahoo depth |
| `analysis_relative_strength` | yes | **no** — Binance klines only |
| `market_positioning`, `market_orderbook` | yes | **no** — funding, OI and depth are Binance-specific |
| `market_technicals`, `market_breadth` | yes | **no** — crypto-scoped scanner |
| `data_get_ohlcv`, `data_get_study_values`, `quote_get`, `market_news`, `market_calendar` | yes | yes — read the chart |

The chart path **swaps the displayed symbol and resolution, then restores them** in a `finally`.
It is a side effect on the user's view, so prefer Yahoo whenever price exactness is not required.

`quote_get` reads the ACTIVE CHART's bars. Passing a symbol that is not the chart's returns
`success: false` naming both — call `chart_set_symbol` first.

## Argument trap

`periods` means **two different things** across this suite:

- `analysis_key_levels`, `analysis_fibonacci`, `strategy_*` → **number of bars**
- `analysis_volatility_regime` → **the ATR period** (bars are `limit`)

Passing `periods: 2000` to the regime tool now returns an error naming the confusion instead of
"ATR(2000) impossible".

## Analysis discipline

- A backtest result without its sample size is worthless. `strategy_backtest` returns `t_stat`
  and a random-entry control; under 30 trades or |t| < 2, report it as unproven, never as an edge.
- Check `historique_tronque` before reading any backtest. A 70 %-truncated window is an absence
  of data, not an absence of edge.
- `strategy_find` tries 16 combinations. Keeping the best of 16 invents edges out of noise — its
  `mise_en_garde` states the expected number of false positives. Pass it on to the user.
- A Fibonacci ratio has no power in itself. Quote `taux_respect` and `touches` from
  `analysis_fibonacci`, not the ratio.
- On gold, run `analysis_drivers` before arguing a direction from the chart. Gold moves −1.66 %
  per 1 % of DXY; a long argued from support while the dollar is bid is half an analysis.
- `analysis_sessions` before sizing an intraday stop: the most active hour carries 2.4x the
  quietest, so one ATR-derived stop is wrong in both directions.

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
