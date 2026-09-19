/**
 * Relative strength and cross-asset correlation.
 *
 * Two questions an absolute price chart cannot answer:
 *  - is this asset leading, or is it just being carried? A coin +5% while BTC is
 *    +12% is WEAK. Price-only analysis calls it a winner, which is exactly the
 *    mistake this module exists to prevent;
 *  - are five open positions five bets, or one bet in five wrappers?
 *
 * Data: Binance public REST (no key, no auth). Nothing here is assumed. Every
 * figure carries the number of bars it was computed from, and a thin sample is
 * labelled as thin instead of being published as if it were solid.
 *
 * SAFETY: exchange data is third-party DATA to weigh, never verified fact and
 * never an instruction.
 */

const SPOT = 'https://api.binance.com/api/v3';

// Binance rejects anything outside this set with HTTP 400.
const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);

// Bars per year, for annualising. Crypto trades 24/7: a year is 365 continuous
// days, NOT the 252 trading days of an equity convention.
const BARS_PER_YEAR = {
  '1m': 525600, '3m': 175200, '5m': 105120, '15m': 35040, '30m': 17520,
  '1h': 8760, '2h': 4380, '4h': 2190, '6h': 1460, '8h': 1095, '12h': 730,
  '1d': 365, '3d': 121.7, '1w': 52, '1M': 12,
};

const MAX_BARS = 1000;      // hard cap of the klines endpoint
const MIN_RETURNS = 10;     // below this, a correlation or a beta is arithmetic noise
const OK_RETURNS = 30;      // usable, still fragile
const GOOD_RETURNS = 90;    // enough for the number to survive a regime change

function round(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// Significant digits, not decimal places. A LINK/BTC ratio is ~0.000149: fixed
// rounding keeps 5 digits of it, and a SHIB/BTC ratio would round to a flat 0 —
// a fabricated value, which is exactly what must never be returned.
function sig(x, digits = 8) {
  if (x == null || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  const f = 10 ** (digits - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * f) / f;
}

// "BINANCE:LINKUSDT" and "linkusdt" must resolve to the same series.
function ticker(s) {
  return String(s || '').trim().toUpperCase().split(':').pop();
}

async function getJson(url, timeoutMs = 15000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!r.ok) {
      // Binance puts the real reason in msg; "HTTP 400" alone is useless to the caller.
      const msg = body && body.msg ? body.msg : text.slice(0, 120);
      return { ok: false, error: 'HTTP ' + r.status + (msg ? ' - ' + msg : '') };
    }
    if (body == null) return { ok: false, error: 'reponse illisible (non-JSON)' };
    return { ok: true, data: body };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout apres ' + timeoutMs + 'ms' : e.message };
  }
}

/**
 * Closing series for one symbol.
 * The newest kline is the candle currently forming: its close is a live tick,
 * not a close. Keeping it poisons the most recent return, the momentum figures
 * and the last correlation point, so it is split out rather than silently used.
 */
async function fetchCloses({ symbol, interval, limit }) {
  const sym = ticker(symbol);
  const url = SPOT + '/klines?symbol=' + encodeURIComponent(sym)
    + '&interval=' + encodeURIComponent(interval)
    + '&limit=' + Math.min(Math.max(Number(limit) || 300, 2), MAX_BARS);

  const res = await getJson(url);
  if (!res.ok) return { ok: false, symbol: sym, error: res.error };
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) return { ok: false, symbol: sym, error: 'aucune bougie renvoyee' };

  const now = Date.now();
  const times = [], closes = [];
  let partial = null;
  for (const k of rows) {
    const t = Number(k[0]), c = Number(k[4]), closeTime = Number(k[6]);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue; // a zero price would break every log
    if (closeTime >= now) { partial = { time: t, close: c }; continue; }
    times.push(t);
    closes.push(c);
  }
  if (closes.length < 2) return { ok: false, symbol: sym, error: 'seulement ' + closes.length + ' bougie(s) cloturee(s) exploitable(s)' };
  return { ok: true, symbol: sym, times, closes, partial };
}

// Small pool: a dozen parallel calls is enough to draw a rate-limit ban.
async function fetchAll(symbols, interval, limit, poolSize = 4) {
  const out = [];
  for (let i = 0; i < symbols.length; i += poolSize) {
    const chunk = symbols.slice(i, i + poolSize);
    out.push(...await Promise.all(chunk.map(s => fetchCloses({ symbol: s, interval, limit }))));
  }
  return out;
}

/**
 * Keep only the timestamps every series shares.
 * Listing dates differ: zipping by index pairs one asset's Tuesday with
 * another's Friday and produces a correlation that measures nothing.
 */
function align(series) {
  let common = null;
  for (const s of series) {
    const set = new Set(s.times);
    common = common == null ? set : new Set([...common].filter(t => set.has(t)));
  }
  const times = [...(common || [])].sort((a, b) => a - b);
  const index = new Map(times.map((t, i) => [t, i]));
  const bySymbol = {};
  const dropped = {};
  for (const s of series) {
    const arr = new Array(times.length).fill(null);
    let kept = 0;
    s.times.forEach((t, i) => {
      const j = index.get(t);
      if (j != null) { arr[j] = s.closes[i]; kept++; }
    });
    bySymbol[s.symbol] = arr;
    dropped[s.symbol] = s.closes.length - kept;
  }
  return { times, bySymbol, dropped };
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0)) continue;
    out.push(Math.log(b / a));
  }
  return out;
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

// Sample standard deviation (n-1). With 30 points the population formula
// understates the spread by ~2%, and these samples are often that small.
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null; // a flat series has no correlation, not a correlation of 0
  return sxy / Math.sqrt(sxx * syy);
}

// Ordinary least squares of y on its own index, with the t-stat of the slope.
// A slope without its t-stat is a straight line drawn through noise.
function trendOf(y) {
  const n = y.length;
  if (n < 5) return null;
  const mx = (n - 1) / 2, my = mean(y);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (y[i] - my); sxx += (i - mx) ** 2; }
  if (sxx === 0) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) {
    sse += (y[i] - (intercept + slope * i)) ** 2;
    sst += (y[i] - my) ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : null;
  const se = n > 2 && sse > 0 ? Math.sqrt((sse / (n - 2)) / sxx) : null;

  // Drift test on the first differences (the log returns), which are ~i.i.d.
  const d = [];
  for (let i = 1; i < n; i++) d.push(y[i] - y[i - 1]);
  let tDrift = null;
  if (d.length >= 5) {
    const md = d.reduce((a, b) => a + b, 0) / d.length;
    const varD = d.reduce((a, b) => a + (b - md) ** 2, 0) / (d.length - 1);
    const sdD = Math.sqrt(varD);
    if (sdD > 0) tDrift = md / (sdD / Math.sqrt(d.length));
  }
  return { slope, r2, tstat_ols: se ? slope / se : null, tstat: tDrift, samples: n, returns_used: d.length };
}

function maxDrawdown(closes) {
  let peak = closes[0], worst = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = c / peak - 1;
    if (dd < worst) worst = dd;
  }
  return worst * 100;
}

function sma(arr, p, endIndex) {
  if (endIndex + 1 < p) return null;
  let s = 0;
  for (let i = endIndex - p + 1; i <= endIndex; i++) s += arr[i];
  return s / p;
}

function pctChange(arr, bars) {
  const last = arr.length - 1;
  if (last - bars < 0) return null;
  const a = arr[last - bars], b = arr[last];
  if (!(a > 0)) return null;
  return (b / a - 1) * 100;
}

function reliability(n) {
  if (n < MIN_RETURNS) return { fiable: false, niveau: 'inexploitable' };
  if (n < OK_RETURNS) return { fiable: false, niveau: 'tres faible' };
  if (n < GOOD_RETURNS) return { fiable: true, niveau: 'moyen' };
  return { fiable: true, niveau: 'bon' };
}

// Annualising a 12-day window into a yearly figure invents a number. Volatility
// scales by sqrt(t) and survives a short window; a return does not.
function coverage(bars, interval) {
  const perYear = BARS_PER_YEAR[interval];
  return perYear ? bars / perYear : null;
}

/**
 * Relative strength of an asset against a benchmark (BTC by default).
 *
 * Built on the RATIO series symbol/benchmark, which is the only series where
 * "rises less than the market" shows up as a fall. Everything else here exists
 * to say how much confidence that ratio deserves: how many bars, how linear the
 * trend, and what the benchmark itself was doing at the time.
 */
export async function relativeStrength({ symbol, benchmark, interval, periods, ma_period, trend_window }) {
  if (!symbol) throw new Error('symbol is required, e.g. "LINKUSDT" or "BINANCE:LINKUSDT"');
  const sym = ticker(symbol);
  const bench = ticker(benchmark || 'BTCUSDT');
  const tf = String(interval || '1d');
  if (!INTERVALS.has(tf)) throw new Error('interval invalide: ' + tf + '. Valeurs acceptees: ' + [...INTERVALS].join(', '));
  if (sym === bench) {
    return { success: false, error: 'symbol et benchmark sont identiques (' + sym + '): le ratio vaudrait 1 sur toute la serie, il n y a rien a mesurer.' };
  }

  const want = Math.min(Math.max(Number(periods) || 300, 30), MAX_BARS);
  const maP = Math.max(Number(ma_period) || 50, 3);

  const [a, b] = await fetchAll([sym, bench], tf, want, 2);
  const failed = [a, b].filter(x => !x.ok);
  if (failed.length) {
    return {
      success: false,
      error: 'donnees indisponibles pour ' + failed.map(f => f.symbol).join(', '),
      details: failed.map(f => ({ symbol: f.symbol, raison: f.error })),
      symbol: sym, benchmark: bench, interval: tf,
    };
  }

  const { times, bySymbol, dropped } = align([a, b]);
  const n = times.length;
  if (n < MIN_RETURNS + 1) {
    return {
      success: false,
      error: 'historique commun trop court: ' + n + ' bougies partagees entre ' + sym + ' et ' + bench + ' (minimum ' + (MIN_RETURNS + 1) + ')',
      bars_used: n, symbol: sym, benchmark: bench, interval: tf,
    };
  }

  const pSym = bySymbol[sym], pBench = bySymbol[bench];
  const ratio = pSym.map((v, i) => v / pBench[i]);
  const last = n - 1;
  const avertissements = [];

  // --- ratio vs its own moving average -------------------------------------
  const maNow = sma(ratio, maP, last);
  let maBlock;
  if (maNow == null) {
    maBlock = { periode: maP, valeur: null, raison: 'seulement ' + n + ' bougies communes, il en faut ' + maP + ' pour cette moyenne' };
    avertissements.push('Moyenne mobile du ratio non calculable sur ' + maP + ' periodes avec ' + n + ' bougies.');
  } else {
    // How long the ratio has held its side of the MA: one close above after
    // twenty below is a blip, not a rotation.
    let streak = 0;
    const above = ratio[last] > maNow;
    for (let i = last; i >= maP - 1; i--) {
      const m = sma(ratio, maP, i);
      if (m == null) break;
      if ((ratio[i] > m) !== above) break;
      streak++;
    }
    maBlock = {
      periode: maP,
      valeur: sig(maNow),
      ecart_pct: round((ratio[last] / maNow - 1) * 100, 2),
      position: above ? 'au-dessus' : 'en-dessous',
      periodes_consecutives: streak,
      // Mansfield RS: the ratio's distance to its own MA, in percent. Positive =
      // outperforming its own recent norm, not just the benchmark's level.
      mansfield_rs: round((ratio[last] / maNow - 1) * 100, 2),
    };
  }

  // --- ratio momentum -------------------------------------------------------
  const horizons = [7, 30, 90].filter(h => h < n);
  const variation = {};
  for (const h of horizons) variation[h] = round(pctChange(ratio, h), 2);
  for (const h of [7, 30, 90]) {
    if (!(h in variation)) variation[h] = null;
  }

  // --- trend of log(ratio) --------------------------------------------------
  const tw = Math.min(Math.max(Number(trend_window) || 30, 5), n);
  const logRatio = ratio.slice(n - tw).map(Math.log);
  const tr = trendOf(logRatio);
  let tendance;
  if (!tr) {
    tendance = { valeur: null, raison: 'fenetre de tendance trop courte (' + tw + ' bougies)' };
  } else {
    const perPeriodPct = (Math.exp(tr.slope) - 1) * 100;
    const significatif = tr.tstat != null && Math.abs(tr.tstat) >= 2;   // drift t-stat on returns
    tendance = {
      fenetre: tw,
      pente_pct_par_periode: round(perPeriodPct, 3),
      // tw bars span tw-1 intervals; compounding over tw extrapolated one period
      // beyond the data that produced the slope.
      pente_pct_sur_fenetre: round((Math.exp(tr.slope * (tw - 1)) - 1) * 100, 2),
      r2: round(tr.r2, 3),
      t_stat: round(tr.tstat, 2),
      t_stat_methode: "t de la derive moyenne des rendements du ratio sur " + (tr.returns_used || 0) + " points. La pente OLS du niveau logarithmique n est PAS testable ainsi: log(ratio) est une marche aleatoire, ses residus sont autocorreles et son t explose (78 % de faux positifs mesures).",
      t_stat_ols_niveau: round(tr.tstat_ols, 2),
      significatif,
      verdict: !significatif ? 'pas de tendance nette (pente non significative)'
        : perPeriodPct > 0 ? 'ratio en hausse: surperformance en cours'
          : 'ratio en baisse: sous-performance en cours',
      samples: tr.samples,
    };
    if (!significatif) avertissements.push('La pente du ratio n est pas statistiquement distinguable de zero (|t| < 2): la tendance de force relative est du bruit sur cette fenetre.');
  }

  // --- performance side by side --------------------------------------------
  const perf = [];
  for (const h of [1, 7, 30, 90, n - 1]) {
    if (h < 1) continue;
    if (perf.some(p => p.horizon_bougies === h)) continue;
    const ps = pctChange(pSym, h), pb = pctChange(pBench, h);
    if (ps == null || pb == null) {
      perf.push({ horizon_bougies: h, symbol_pct: null, benchmark_pct: null, raison: 'pas assez de bougies communes (' + n + ')' });
      continue;
    }
    perf.push({
      horizon_bougies: h,
      symbol_pct: round(ps, 2),
      benchmark_pct: round(pb, 2),
      ecart_points: round(ps - pb, 2),
      verdict: ps > pb ? 'surperformance' : ps < pb ? 'sous-performance' : 'egalite',
    });
  }

  // --- regression, capture, volatility -------------------------------------
  const rs = logReturns(pSym), rb = logReturns(pBench);
  const m = Math.min(rs.length, rb.length);
  const rel = reliability(m);
  // Beta by OLS of the asset's returns on the benchmark's: cov / var.
  const mb = mean(rb.slice(0, m));
  const ms = mean(rs.slice(0, m));
  let sxy = 0, sxx = 0;
  for (let i = 0; i < m; i++) { sxy += (rb[i] - mb) * (rs[i] - ms); sxx += (rb[i] - mb) ** 2; }
  const beta = sxx > 0 ? sxy / sxx : null;
  const corr = pearson(rs.slice(0, m), rb.slice(0, m));
  const alphaLog = beta == null ? null : ms - beta * mb;

  const cov = coverage(m, tf);
  const canAnnualise = cov != null && cov >= 0.2;
  const perYear = BARS_PER_YEAR[tf] || null;

  const regression = {
    beta: round(beta, 3),
    correlation: round(corr, 3),
    r2: corr == null ? null : round(corr * corr, 3),
    alpha_pct_par_periode: alphaLog == null ? null : round((Math.exp(alphaLog) - 1) * 100, 4),
    alpha_annualise_pct: (alphaLog != null && canAnnualise && perYear)
      ? round((Math.exp(alphaLog * perYear) - 1) * 100, 1)
      : null,
    alpha_annualise_raison: (alphaLog != null && !canAnnualise)
      ? 'fenetre trop courte pour annualiser (' + round(cov * 100, 1) + '% d une annee); extrapoler donnerait un chiffre invente'
      : undefined,
    samples: m,
    fiable: rel.fiable,
    note: 'Beta = sensibilite aux mouvements de la reference. Il ne vaut que ce que vaut le r2: un beta avec r2 < 0.3 decrit mal l actif.',
  };
  if (corr != null && corr * corr < 0.3) {
    avertissements.push('r2 de ' + round(corr * corr, 2) + ' entre ' + sym + ' et ' + bench + ': la reference explique mal les mouvements, le beta et l alpha sont peu informatifs.');
  }

  // Up/down capture: what fraction of the benchmark's move the asset catches on
  // each side. Down-capture below 1 is what "defensive" actually means.
  let upS = 0, upB = 0, upN = 0, dnS = 0, dnB = 0, dnN = 0;
  for (let i = 0; i < m; i++) {
    if (rb[i] > 0) { upS += rs[i]; upB += rb[i]; upN++; }
    else if (rb[i] < 0) { dnS += rs[i]; dnB += rb[i]; dnN++; }
  }
  const capture = {
    hausse: upN >= 5 && upB > 0
      ? { ratio: round(upS / upB, 2), samples: upN, lecture: upS / upB > 1 ? 'capte plus que la reference quand elle monte' : 'capte moins que la reference quand elle monte' }
      : { ratio: null, samples: upN, raison: 'moins de 5 periodes de hausse de la reference dans l echantillon' },
    baisse: dnN >= 5 && dnB < 0
      ? { ratio: round(dnS / dnB, 2), samples: dnN, lecture: dnS / dnB > 1 ? 'baisse plus que la reference quand elle baisse' : 'baisse moins que la reference quand elle baisse' }
      : { ratio: null, samples: dnN, raison: 'moins de 5 periodes de baisse de la reference dans l echantillon' },
    note: 'Ratio > 1 = amplifie le mouvement de la reference. Le profil ideal est hausse > 1 et baisse < 1.',
  };

  const volS = stdev(rs.slice(0, m)), volB = stdev(rb.slice(0, m));
  const volatilite = {
    symbol_pct_par_periode: round(volS * 100, 3),
    benchmark_pct_par_periode: round(volB * 100, 3),
    symbol_annualisee_pct: perYear && volS != null ? round(volS * Math.sqrt(perYear) * 100, 1) : null,
    benchmark_annualisee_pct: perYear && volB != null ? round(volB * Math.sqrt(perYear) * 100, 1) : null,
    ratio_vol: volS != null && volB > 0 ? round(volS / volB, 2) : null,
    samples: m,
    note: cov != null && cov < 0.1 ? 'Fenetre courte (' + round(cov * 100, 1) + '% d une annee): l annualisation en sqrt(t) reste indicative.' : undefined,
  };

  const drawdown = {
    symbol_pct: round(maxDrawdown(pSym), 2),
    benchmark_pct: round(maxDrawdown(pBench), 2),
    ratio_pct: round(maxDrawdown(ratio), 2),
    note: 'Baisse maximale pic-a-creux sur la fenetre commune. Celui du ratio mesure la pire phase de sous-performance.',
  };

  // --- context: strength against a falling benchmark is not the same trade ---
  const perfSymWindow = pctChange(pSym, n - 1);
  const perfBenchWindow = pctChange(pBench, n - 1);
  const regime = perfBenchWindow == null ? null
    : perfBenchWindow > 5 ? 'reference en hausse'
      : perfBenchWindow < -5 ? 'reference en baisse' : 'reference plate';
  // Same window as perfSymWindow: the ratio end-to-end, not its last 30 bars.
  const rsUp = ratio.length >= 2 && ratio[0] > 0 ? ratio[ratio.length - 1] > ratio[0] : null;
  const rsRecent = variation[30] != null ? variation[30] > 0 : (variation[7] != null ? variation[7] > 0 : null);
  const rsDivergence = rsUp != null && rsRecent != null && rsUp !== rsRecent;
  let lecture = null;
  // Both quantities below span the full window, stated so the reader can check.
  if (perfSymWindow != null && rsUp != null) {
    if (perfSymWindow > 0 && rsUp) lecture = 'monte ET surperforme la reference: leadership, c est le cas le plus solide.';
    else if (perfSymWindow > 0 && !rsUp) lecture = 'monte mais moins vite que la reference: force apparente en prix, faiblesse relative. Detenir la reference aurait mieux paye.';
    else if (perfSymWindow <= 0 && rsUp) lecture = 'baisse moins que la reference: resistance relative, souvent le premier signe d une rotation.';
    else lecture = 'baisse ET sous-performe: faiblesse confirmee sur les deux plans.';
  }
  // A verdict over the window and a move over 30 bars can point opposite ways;
  // saying so is the difference between a reading and a contradiction.
  if (lecture && rsDivergence) {
    lecture += ' ATTENTION: sur les 30 dernieres periodes le ratio va dans l AUTRE sens (' +
      (rsRecent ? 'redressement recent' : 'essoufflement recent') + '). La phrase ci-dessus porte sur toute la fenetre.';
  }

  // --- scored verdict, each component visible -------------------------------
  const composantes = [];
  if (maBlock.valeur != null) composantes.push({ critere: 'ratio vs moyenne mobile ' + maP, points: maBlock.position === 'au-dessus' ? 1 : -1, detail: maBlock.position + ' de ' + maBlock.ecart_pct + '% depuis ' + maBlock.periodes_consecutives + ' periodes' });
  // Below this the ratio has not really moved: it must not vote either way.
  const ZONE_MORTE_PCT = 0.5;
  const pointsVariation = (v) => Math.abs(v) < ZONE_MORTE_PCT ? 0 : (v > 0 ? 1 : -1);
  const detailVariation = (v) => v + "%" + (Math.abs(v) < ZONE_MORTE_PCT ? " (sous la zone morte de " + ZONE_MORTE_PCT + "%, ne compte pas)" : "");
  if (variation[7] != null) composantes.push({ critere: 'ratio 7 periodes', points: pointsVariation(variation[7]), detail: detailVariation(variation[7]) });
  if (variation[30] != null) composantes.push({ critere: 'ratio 30 periodes', points: pointsVariation(variation[30]), detail: detailVariation(variation[30]) });
  if (tendance.significatif) composantes.push({ critere: 'pente du ratio (significative)', points: tendance.pente_pct_par_periode > 0 ? 1 : -1, detail: 't=' + tendance.t_stat + ', r2=' + tendance.r2 });
  if (capture.hausse.ratio != null) composantes.push({ critere: 'capture hausse', points: capture.hausse.ratio > 1 ? 0.5 : -0.5, detail: String(capture.hausse.ratio) });
  if (capture.baisse.ratio != null) composantes.push({ critere: 'capture baisse', points: capture.baisse.ratio < 1 ? 0.5 : -0.5, detail: String(capture.baisse.ratio) });

  const gained = composantes.reduce((s, c) => s + c.points, 0);
  const possible = composantes.reduce((s, c) => s + Math.abs(c.points), 0);
  const abstentions = composantes.filter(c => c.points === 0).length;
  const score = possible > 0 ? gained / possible : null; // -1 .. +1
  const force = score == null ? null
    : score >= 0.5 ? 'FORT'
      : score >= 0.15 ? 'PLUTOT FORT'
        : score > -0.15 ? 'NEUTRE'
          : score > -0.5 ? 'PLUTOT FAIBLE' : 'FAIBLE';

  if (!rel.fiable) avertissements.push('Echantillon de ' + m + ' rendements (' + rel.niveau + '): beta, correlation et captures sont a lire comme des indications, pas comme des mesures.');
  if (dropped[sym] || dropped[bench]) avertissements.push('Bougies ecartees faute d horodatage commun: ' + sym + ' ' + dropped[sym] + ', ' + bench + ' ' + dropped[bench] + '.');
  if (a.partial || b.partial) avertissements.push('La bougie en cours est exclue des calculs (son cours n est pas un cours de cloture). Le prix live est fourni separement.');

  return {
    success: true,
    symbol: sym,
    benchmark: bench,
    interval: tf,
    bars_used: n,
    returns_used: m,
    fiabilite: { niveau: rel.niveau, fiable: rel.fiable, seuils: 'inexploitable < ' + MIN_RETURNS + ' <= tres faible < ' + OK_RETURNS + ' <= moyen < ' + GOOD_RETURNS + ' <= bon' },
    periode: { du: new Date(times[0]).toISOString(), au: new Date(times[last]).toISOString(), derniere_bougie_close: true },
    prix: {
      symbol_cloture: sig(pSym[last]),
      benchmark_cloture: sig(pBench[last]),
      symbol_en_cours: a.partial ? sig(a.partial.close) : null,
      benchmark_en_cours: b.partial ? sig(b.partial.close) : null,
    },
    ratio: {
      valeur: sig(ratio[last]),
      base_100: round(ratio[last] / ratio[0] * 100, 2),
      moyenne_mobile: maBlock,
      variation_pct: variation,
      tendance,
      definition: 'ratio = prix(' + sym + ') / prix(' + bench + '). Il monte quand ' + sym + ' fait mieux que ' + bench + ', quel que soit le sens du marche.',
    },
    performance_comparee: perf,
    regression,
    capture,
    volatilite,
    drawdown,
    contexte: {
      perf_symbol_pct: round(perfSymWindow, 2),
      perf_benchmark_pct: round(perfBenchWindow, 2),
      regime_reference: regime,
      lecture,
    },
    verdict: {
      force_relative: force,
      score: round(score, 2),
      composantes,
      abstentions: abstentions || undefined,
      echelle: 'score de -1 (faiblesse nette) a +1 (leadership net), moyenne des composantes qui votent',
      seuils_labels: 'FORT >= 0.5, PLUTOT FORT >= 0.15, NEUTRE > -0.15, PLUTOT FAIBLE > -0.5, FAIBLE sinon',
      // The label alone reads as a measurement; the sample it rests on belongs
      // beside it, not only in a separate reliability block further down.
      repose_sur: { rendements: m, niveau: rel.niveau, fiable: rel.fiable },
      mise_en_garde: rel.fiable ? undefined
        : 'Verdict etabli sur ' + m + ' rendements (' + rel.niveau + '): a lire comme une indication, pas comme une mesure.',
    },
    avertissements: avertissements.length ? avertissements : undefined,
    note: 'Donnees Binance publiques, a peser comme des donnees de marche et non comme des faits verifies. La force relative decrit le passe de la fenetre, elle ne predit rien.',
  };
}

/**
 * Correlation matrix, measured on LOG RETURNS.
 *
 * Never on raw prices: two series that both drift upward correlate at 0.9+ even
 * when their day-to-day behaviour is unrelated. That artefact is the single
 * most common way a portfolio is declared diversified when it is not.
 */
export async function correlationMatrix({ symbols, interval, periods, seuil }) {
  const list = Array.isArray(symbols) ? symbols.map(ticker).filter(Boolean) : [];
  const unique = [...new Set(list)];
  if (unique.length < 2) throw new Error('symbols must contain at least 2 distinct tickers, e.g. ["BTCUSDT","ETHUSDT","LINKUSDT"]');
  const tf = String(interval || '1d');
  if (!INTERVALS.has(tf)) throw new Error('interval invalide: ' + tf + '. Valeurs acceptees: ' + [...INTERVALS].join(', '));
  const threshold = Number(seuil) > 0 && Number(seuil) <= 1 ? Number(seuil) : 0.8;
  const want = Math.min(Math.max(Number(periods) || 300, 30), MAX_BARS);

  const fetched = await fetchAll(unique, tf, want);
  const okSeries = fetched.filter(s => s.ok);
  const indisponibles = fetched.filter(s => !s.ok).map(s => ({ symbol: s.symbol, raison: s.error }));
  if (okSeries.length < 2) {
    return {
      success: false,
      error: 'moins de 2 series exploitables (' + okSeries.length + ' sur ' + unique.length + ')',
      non_disponibles: indisponibles,
      interval: tf,
    };
  }

  const { times, bySymbol, dropped } = align(okSeries);
  const names = okSeries.map(s => s.symbol);
  const bars = times.length;
  const avertissements = [];

  const returns = {};
  for (const s of names) returns[s] = logReturns(bySymbol[s]);
  const points = Math.min(...names.map(s => returns[s].length));
  if (points < 3) {
    return {
      success: false,
      error: 'historique commun insuffisant: ' + points + ' rendements partages entre ' + names.join(', '),
      points_utilises: points, bars_used: bars,
      non_disponibles: indisponibles.length ? indisponibles : undefined,
      interval: tf,
    };
  }

  const rel = reliability(points);
  // Below this |r|, a correlation is indistinguishable from chance at 95%
  // (normal approximation of the t-test; loose under ~30 points, which is
  // precisely when the warning matters most).
  const rCrit = 1.96 / Math.sqrt(Math.max(points - 2, 1) + 1.96 ** 2);

  const matrice = {};
  const pairs = [];
  for (const x of names) {
    matrice[x] = {};
    for (const y of names) {
      if (x === y) { matrice[x][y] = 1; continue; }
      const r = pearson(returns[x].slice(0, points), returns[y].slice(0, points));
      matrice[x][y] = round(r, 3);
      if (names.indexOf(x) < names.indexOf(y) && r != null) pairs.push({ a: x, b: y, r });
    }
  }

  // Stability: a correlation averaged over the window can hide two regimes.
  // Split in half and look at the gap before trusting the single number.
  const SEUIL_INSTABLE = 0.2;
  const half = Math.floor(points / 2);
  const stabilite = [];
  if (half >= MIN_RETURNS) {
    for (const p of pairs) {
      const r1 = pearson(returns[p.a].slice(0, half), returns[p.b].slice(0, half));
      const r2 = pearson(returns[p.a].slice(points - half, points), returns[p.b].slice(points - half, points));
      if (r1 == null || r2 == null) continue;
      stabilite.push({
        paire: p.a + '/' + p.b,
        premiere_moitie: round(r1, 3),
        seconde_moitie: round(r2, 3),
        ecart: round(Math.abs(r2 - r1), 3),
        instable: Math.abs(r2 - r1) >= SEUIL_INSTABLE,
        points_par_moitie: half,
      });
    }
    stabilite.sort((u, v) => v.ecart - u.ecart);
    const bougees = stabilite.filter(x => x.instable);
    if (bougees.length) {
      avertissements.push('Correlation instable entre les deux moities de la fenetre pour ' + bougees.map(x => x.paire + ' (' + x.premiere_moitie + ' -> ' + x.seconde_moitie + ')').join(', ') + '. Le chiffre moyen de la matrice masque ces deux regimes.');
    }
  } else {
    avertissements.push('Stabilite non calculee: ' + points + ' points ne permettent pas deux sous-fenetres d au moins ' + MIN_RETURNS + ' points.');
  }

  const moyennes = names.map(s => {
    const vals = names.filter(o => o !== s).map(o => matrice[s][o]).filter(v => v != null);
    return {
      symbol: s,
      correlation_moyenne: vals.length ? round(mean(vals), 3) : null,
      paires_mesurees: vals.length,
      vol_pct_par_periode: round(stdev(returns[s].slice(0, points)) * 100, 3),
    };
  }).sort((u, v) => (v.correlation_moyenne ?? -2) - (u.correlation_moyenne ?? -2));

  const paires_elevees = pairs
    .filter(p => p.r >= threshold)
    .sort((u, v) => v.r - u.r)
    .map(p => ({
      paire: p.a + '/' + p.b,
      r: round(p.r, 3),
      r2: round(p.r * p.r, 3),
      variance_partagee_pct: round(p.r * p.r * 100, 1),
      commentaire: 'Deux positions sur ces actifs n en forment qu une seule: ' + round(p.r * p.r * 100, 0) + '% de leurs variations sont communes.',
    }));

  const paires_negatives = pairs
    .filter(p => p.r <= -0.3)
    .sort((u, v) => u.r - v.r)
    .map(p => ({ paire: p.a + '/' + p.b, r: round(p.r, 3), commentaire: 'Evoluent en sens inverse sur la fenetre: seul cas ou une seconde position reduit vraiment le risque.' }));

  // Clusters: assets linked, directly or through a chain, above the threshold.
  const parent = Object.fromEntries(names.map(s => [s, s]));
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const p of pairs) if (p.r >= threshold) parent[find(p.a)] = find(p.b);
  const groups = {};
  for (const s of names) (groups[find(s)] = groups[find(s)] || []).push(s);
  const clusters = Object.values(groups).filter(g => g.length > 1).map(g => {
    const inner = [];
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (matrice[g[i]][g[j]] != null) inner.push(matrice[g[i]][g[j]]);
    return { membres: g, correlation_interne_moyenne: inner.length ? round(mean(inner), 3) : null, commentaire: 'Bloc a traiter comme une seule ligne de risque.' };
  });

  const allR = pairs.map(p => p.r);
  const rhoAvg = allR.length ? mean(allR) : null;
  const N = names.length;
  // Effective number of independent bets for an equally weighted basket.
  const denom = rhoAvg == null ? null : 1 + (N - 1) * rhoAvg;
  const nEffRaw = denom != null && denom > 0 ? N / denom : null;
  const nEff = nEffRaw == null ? null : Math.min(N, Math.max(1, nEffRaw));
  const nEffSature = nEffRaw != null && (nEffRaw > N || nEffRaw < 1);

  if (!rel.fiable) {
    avertissements.push('Correlations calculees sur ' + points + ' points (' + rel.niveau + '). En dessous de ' + OK_RETURNS + ' points, une correlation ne vaut pratiquement rien: elle bouge de 0.2 en changeant quelques bougies.');
  }
  const dropTotal = Object.values(dropped).reduce((s, x) => s + x, 0);
  if (dropTotal > 0) {
    avertissements.push('Bougies ecartees faute d horodatage commun a toutes les series: ' + Object.entries(dropped).filter(([, v]) => v > 0).map(([k, v]) => k + ' ' + v).join(', ') + '. La fenetre retenue est celle du plus jeune actif.');
  }
  if (okSeries.some(s => s.partial)) {
    avertissements.push('Bougie en cours exclue: son cours n est pas un cours de cloture et fausserait le dernier rendement.');
  }

  return {
    success: true,
    interval: tf,
    symbols: names,
    non_disponibles: indisponibles.length ? indisponibles : undefined,
    points_utilises: points,
    bars_used: bars,
    periode: { du: new Date(times[0]).toISOString(), au: new Date(times[times.length - 1]).toISOString(), derniere_bougie_close: true },
    fiabilite: {
      points: points,
      niveau: rel.niveau,
      fiable: rel.fiable,
      minimum_exploitable: OK_RETURNS,
      seuil_bruit_95: round(rCrit, 3),
      note: 'Toute correlation dont la valeur absolue est inferieure a ' + round(rCrit, 2) + ' est indistinguable du hasard avec ' + points + ' points.',
    },
    methode: 'Pearson sur rendements logarithmiques ln(Pt/Pt-1), horodatages strictement alignes. Jamais sur les prix bruts: deux series haussieres correlent artificiellement.',
    matrice,
    moyennes,
    seuil_utilise: threshold,
    paires_elevees: paires_elevees.length ? paires_elevees : [],
    paires_negatives: paires_negatives.length ? paires_negatives : undefined,
    clusters: clusters.length ? clusters : [],
    stabilite: stabilite.length ? { seuil_ecart: SEUIL_INSTABLE, methode: 'correlation de la premiere moitie de la fenetre contre celle de la seconde, ' + half + ' points chacune', paires: stabilite.slice(0, 10) } : undefined,
    diversification: {
      correlation_moyenne_globale: round(rhoAvg, 3),
      actifs_independants_effectifs: round(nEff, 2),
      actifs_reels: N,
      valeur_brute_non_bornee: nEffSature ? round(nEffRaw, 2) : undefined,
      borne: nEffSature
        ? "Formule saturee: N/(1+(N-1)*rho) diverge quand rho approche -1/(N-1). Valeur ramenee entre 1 et le nombre d actifs. A cette taille d echantillon le chiffre n est pas exploitable."
        : undefined,
      lecture: nEff == null ? null
        : 'Un panier equipondere de ces ' + N + ' actifs se comporte comme ' + round(nEff, 1) + ' pari(s) reellement independant(s).',
    },
    avertissements: avertissements.length ? avertissements : undefined,
    note: 'Donnees Binance publiques, a peser comme des donnees de marche. Une correlation est une mesure passee sur cette fenetre: elle monte vers 1 precisement pendant les krachs, quand la diversification compte le plus.',
  };
}
