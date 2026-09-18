/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, returns structured data
 * for Claude to apply bias criteria and generate a session brief.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".kasper", "sessions");

function loadRules(rulesPath) {
  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".kasper", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

// A symbol change takes seconds to load; a fixed sleep reads the PREVIOUS
// symbol’s price. Wait until the chart actually reports the symbol asked for.
async function waitForSymbol(symbol, timeoutMs = 20000) {
  const wanted = String(symbol).split(":").pop().toUpperCase();
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      const st = await chart.getState();
      seen = st && st.symbol;
      // Exact match on the ticker segment: indexOf() would accept "BTCUSD"
      // while the chart still shows "BTCUSDT", i.e. the wrong instrument.
      if (seen && String(seen).split(":").pop().toUpperCase() === wanted) return { ok: true, symbol: seen };
    } catch (e) { /* chart still loading */ }
  }
  return { ok: false, symbol: seen };
}

export async function runBrief({ rules_path } = {}) {
  const { rules, path: loadedFrom } = loadRules(rules_path);
  const { watchlist = [], default_timeframe = "240" } = rules;

  if (!watchlist.length) {
    throw new Error(
      "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
    );
  }

  // Save current chart state so we can restore after scanning
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  const results = [];

  for (const symbol of watchlist) {
    try {
      await chart.setSymbol({ symbol });
      const loaded = await waitForSymbol(symbol);
      if (!loaded.ok) {
        results.push({ symbol, error: "Symbol never loaded (chart still shows " + loaded.symbol + "). Values skipped rather than reported wrong." });
        continue;
      }
      const tf = await chart.setTimeframe({ timeframe: default_timeframe });
      if (tf && tf.verified === false) {
        results.push({ symbol, error: "Timeframe " + default_timeframe + " could not be verified: " + (tf.error || "stale bars") });
        continue;
      }

      const [state, indicators, quote] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
      ]);

      results.push({
        symbol,
        resolved_symbol: loaded.symbol,
        timeframe: default_timeframe,
        state,
        indicators,
        quote,
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      "For each symbol in symbols_scanned, apply the bias_criteria from rules to the indicator readings.",
      "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price] | WATCH: [what to monitor]",
      "End with a one-sentence overall market read.",
      "Be direct. No preamble.",
    ].join(" "),
  };
}

export function saveSession({ brief, date } = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  // Fall back to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
