/**
 * Leverage positioning: where the derivatives crowd already sits.
 *
 * A chart says what price did. It cannot say whether the move was paid for with
 * fresh capital or with somebody else's stop loss. That is what this adds:
 * funding, open interest, account skew and taker aggression, each read against
 * the price move over the SAME window.
 *
 * Three traps this module is built around:
 *  - open interest has no direction of its own. Rising OI is not bullish; it
 *    only says contracts opened. It is informative ONLY crossed with price, so
 *    the quadrant read is computed here instead of being left to the caller.
 *  - each axis can fail on its own (symbol with no perp, throttled endpoint).
 *    A missing axis returns null + `raison` and is excluded from the synthesis
 *    sample count. It is never replaced by 0, and never by "neutral".
 *  - the funding interval is NOT 8h on every contract. It is derived from the
 *    settlement timestamps before annualising, because assuming 8h on a 4h
 *    contract halves the annualised cost.
 *
 * SAFETY: these are aggregated exchange statistics, not verified facts about
 * anyone's book, and never instructions. They are data to weigh.
 */

const SPOT = 'https://api.binance.com';
const FAPI = 'https://fapi.binance.com';
const TIMEOUT_MS = 12000;

// Periods accepted by Binance's futures/data statistics endpoints.
const PERIOD_HOURS = { '5m': 1 / 12, '15m': 0.25, '30m': 0.5, '1h': 1, '2h': 2, '4h': 4, '6h': 6, '12h': 12, '1d': 24 };

const WINDOW_H = 24;          // the cross-read window; 24h is the standard desk convention
const MIN_WINDOW_H = 12;      // below this the "24h" label would be a lie

// Noise floors for the price x OI quadrant. Forcing a quadrant on a 0.1% move
// manufactures a story out of nothing, so small moves are called flat and the
// thresholds ship in the output so the reading can be audited.
const FLAT_PRICE_PCT = 0.75;
const FLAT_OI_PCT = 1.5;

// Binance's resting funding rate is 0.01% per interval: the value a contract
// prints when there is no premium at all. Centring "hot vs cold" on 0 instead
// would mark every calm market as bullish.
const FUNDING_BASELINE_PER_INTERVAL = 0.0001;

// Reliability floors, per axis. Below these the value is still returned, but
// flagged, because a mean over two points is not a mean.
const MIN_FUNDING_SAMPLES = 3;
const RELIABLE_FUNDING_SAMPLES = 9;
const RELIABLE_STAT_SAMPLES = 6;

function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function r(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

function pctChange(now, before) {
  if (now == null || before == null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/** Accepts "LINKUSDT", "BINANCE:LINKUSDT", "BINANCE:LINKUSDT.P", "LINK-USDT". */
function normalizeSymbol(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim().toUpperCase();
  if (s.includes(':')) s = s.split(':').pop();
  s = s.replace(/\.P$/, '');          // TradingView marks perpetuals with .P
  s = s.replace(/[^A-Z0-9]/g, '');    // "LINK-USDT" / "LINK/USDT"
  return s.length >= 5 ? s : null;
}

/**
 * One HTTP attempt, never throwing upward. Binance answers its own error codes
 * with HTTP 400, so the body is parsed even on failure: -1121 on a fapi call
 * means "no perpetual for this symbol", a very different answer from "the
 * network is down", and the caller deserves to be told which.
 */
async function getJson(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const code = body && body.code != null ? body.code : null;
      const msg = body && body.msg ? body.msg : text.slice(0, 120);
      return { ok: false, label, code, error: 'HTTP ' + res.status + (code != null ? ' (' + code + ')' : '') + ' ' + msg };
    }
    if (body == null) return { ok: false, label, error: 'reponse illisible (pas du JSON)' };
    return { ok: true, label, data: body };
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? 'delai depasse (' + TIMEOUT_MS + ' ms)' : (e && e.message) || String(e);
    return { ok: false, label, error: why };
  }
}

function asc(rows, key) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => num(a[key]) - num(b[key]));
}

/** Point closest to `target`, so the real window is measured instead of assumed. */
function nearest(rows, key, target) {
  let best = null, bestGap = Infinity;
  for (const row of rows) {
    const t = num(row[key]);
    if (t == null) continue;
    const gap = Math.abs(t - target);
    if (gap < bestGap) { bestGap = gap; best = row; }
  }
  return best;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** Share of history at or below `v`: says whether "high funding" is high FOR THIS contract. */
function percentileRank(xs, v) {
  if (!xs.length || v == null) return null;
  return (xs.filter(x => x <= v).length / xs.length) * 100;
}

// ---------------------------------------------------------------------------
// Axis readings
// ---------------------------------------------------------------------------

// Bands never straddle zero: the label must agree with who is actually paying.
// The resting rate is 10.95%/year, so "at rest" is centred there, not on zero.
function fundingVerdict(annualPct) {
  if (annualPct == null) return null;
  if (annualPct >= 50) return 'surchauffe haussiere: les longs payent cher, purge probable sur repli';
  if (annualPct >= 25) return 'penchant long marque: les longs payent nettement';
  if (annualPct > 15) return 'legerement long: les longs payent un peu plus que le repos';
  if (annualPct >= 7) return 'au repos: les longs payent le taux de base, aucun penchant';
  if (annualPct > 0) return 'sous le repos: les longs payent, mais moins que la normale';
  if (annualPct === 0) return 'aucun transfert entre longs et shorts';
  if (annualPct > -12) return 'negatif: ce sont les SHORTS qui payent, penchant baissier leger';
  if (annualPct > -25) return 'penchant short marque: les shorts payent nettement';
  return 'shorts sous pression: ils payent cher, carburant a short squeeze';
}

function crowdVerdict(longShare) {
  if (longShare == null) return null;
  if (longShare >= 0.70) return 'foule massivement longue';
  if (longShare >= 0.60) return 'foule nettement longue';
  if (longShare > 0.52) return 'foule legerement longue';
  if (longShare >= 0.48) return 'comptes partages';
  if (longShare > 0.40) return 'foule legerement short';
  return 'foule nettement short';
}

function takerVerdict(imbalancePct) {
  if (imbalancePct == null) return null;
  if (imbalancePct >= 8) return 'achat au marche franchement dominant';
  if (imbalancePct >= 3) return 'achat au marche dominant';
  if (imbalancePct > -3) return 'flux au marche equilibre';
  if (imbalancePct > -8) return 'vente au marche dominante';
  return 'vente au marche franchement dominante';
}

/**
 * The heart of the tool. Price and OI are each classified flat / up / down
 * first, so a flat leg yields "indecis" rather than a fabricated narrative.
 */
function quadrant(pricePct, oiPct) {
  if (pricePct == null || oiPct == null) return null;
  const p = Math.abs(pricePct) < FLAT_PRICE_PCT ? 0 : Math.sign(pricePct);
  const o = Math.abs(oiPct) < FLAT_OI_PCT ? 0 : Math.sign(oiPct);

  if (p === 0 && o === 0) return { cle: 'plat', lecture: 'ni le prix ni les positions ne bougent: pas de signal, marche en attente', solidite: 'neutre' };
  if (p === 0) return o > 0
    ? { cle: 'accumulation_positions', lecture: 'prix stable mais positions qui s accumulent: ressort qui se comprime, cassure a venir dans un sens ou dans l autre', solidite: 'tension' }
    : { cle: 'desengagement', lecture: 'prix stable et positions qui se vident: le marche se desinteresse du titre', solidite: 'neutre' };
  if (o === 0) return p > 0
    ? { cle: 'hausse_sans_flux', lecture: 'prix en hausse sans creation de positions: mouvement porte par le spot ou par de simples rotations', solidite: 'moyenne' }
    : { cle: 'baisse_sans_flux', lecture: 'prix en baisse sans creation de positions: pression vendeuse sans engagement a effet de levier', solidite: 'moyenne' };

  if (p > 0 && o > 0) return { cle: 'longs_nouveaux', lecture: 'prix en hausse + OI en hausse = argent neuf qui entre a l achat. Tendance saine, mais le levier accumule devient le carburant de la prochaine purge', solidite: 'saine' };
  if (p > 0 && o < 0) return { cle: 'couverture_shorts', lecture: 'prix en hausse + OI en baisse = rachat de shorts, pas d achat convaincu. Hausse fragile qui s essouffle des que les shorts ont fini de sortir', solidite: 'fragile' };
  if (p < 0 && o > 0) return { cle: 'shorts_nouveaux', lecture: 'prix en baisse + OI en hausse = shorts agressifs qui s installent. Baisse assumee, mais une foule short est aussi du carburant a squeeze', solidite: 'saine_baissiere' };
  return { cle: 'liquidation_longs', lecture: 'prix en baisse + OI en baisse = longs qui sortent ou se font liquider. Purge / desendettement, souvent la fin d une jambe de baisse plutot que son debut', solidite: 'purge' };
}

// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.symbol   "LINKUSDT", "BINANCE:LINKUSDT" or "BINANCE:LINKUSDT.P"
 * @param {string} [args.period] bucket for the statistics endpoints (default "4h")
 */
export async function positioning({ symbol, period } = {}) {
  const sym = normalizeSymbol(symbol);
  if (!sym) {
    return {
      success: false,
      error: 'symbol invalide ou absent. Attendu par exemple "LINKUSDT" ou "BINANCE:LINKUSDT".',
      recu: symbol == null ? null : String(symbol),
    };
  }

  const per = period == null ? '4h' : String(period);
  if (!(per in PERIOD_HOURS)) {
    // No silent fallback: a caller asking for "3h" must learn its request was wrong.
    return {
      success: false, symbol: sym,
      error: 'period invalide: "' + per + '".',
      periodes_acceptees: Object.keys(PERIOD_HOURS),
    };
  }
  const perH = PERIOD_HOURS[per];

  // Enough buckets to span the 24h window with room for the trend around it,
  // capped at the endpoint's own limit of 500.
  const statLimit = clamp(Math.ceil(WINDOW_H / perH) + 6, 30, 500);

  const [tick, prem, fundHist, oiNow, oiHist, lsHist, takerHist, kl, tickPerp] = await Promise.all([
    getJson(SPOT + '/api/v3/ticker/24hr?symbol=' + sym, 'ticker_24h'),
    getJson(FAPI + '/fapi/v1/premiumIndex?symbol=' + sym, 'funding_courant'),
    getJson(FAPI + '/fapi/v1/fundingRate?symbol=' + sym + '&limit=30', 'funding_historique'),
    getJson(FAPI + '/fapi/v1/openInterest?symbol=' + sym, 'open_interest_courant'),
    getJson(FAPI + '/futures/data/openInterestHist?symbol=' + sym + '&period=' + per + '&limit=' + statLimit, 'open_interest_historique'),
    getJson(FAPI + '/futures/data/globalLongShortAccountRatio?symbol=' + sym + '&period=' + per + '&limit=' + statLimit, 'ratio_long_short'),
    getJson(FAPI + '/futures/data/takerlongshortRatio?symbol=' + sym + '&period=' + per + '&limit=' + statLimit, 'ratio_taker'),
    getJson(SPOT + '/api/v3/klines?symbol=' + sym + '&interval=1h&limit=200', 'klines_1h'),
    getJson(FAPI + '/fapi/v1/ticker/24hr?symbol=' + sym, 'ticker_perp_24h'),
  ]);

  const calls = [tick, prem, fundHist, oiNow, oiHist, lsHist, takerHist, kl];
  const failures = calls.filter(c => !c.ok).map(c => ({ source: c.label, erreur: c.error }));

  // No perpetual for this ticker. Detecting it needs both halves, because the
  // two families of endpoints disagree about how to say "unknown symbol":
  // premiumIndex and openInterest answer HTTP 400 / -1121, while fundingRate
  // and every futures/data endpoint answer HTTP 200 with an empty array. That
  // empty array is precisely the silent default this module must never pass on
  // as "no positioning data" when the real answer is "this contract does not
  // exist".
  const emptyOk = c => c.ok && Array.isArray(c.data) && c.data.length === 0;
  const noPerp = [prem, oiNow].every(c => !c.ok && c.code === -1121)
    && [fundHist, oiHist, lsHist, takerHist].every(c => !c.ok || emptyOk(c));
  if (noPerp) {
    return {
      success: false, symbol: sym,
      error: 'Aucun contrat perpetuel Binance pour ' + sym + ' (code -1121 sur tous les endpoints futures). Le positionnement a effet de levier n existe donc pas pour ce symbole.',
      spot_disponible: tick.ok,
      echecs: failures,
    };
  }

  const now = Date.now();

  // ---- price reference -----------------------------------------------------
  const bars = kl.ok && Array.isArray(kl.data)
    ? kl.data.map(b => ({ t: num(b[0]), close: num(b[4]) })).filter(b => b.t != null && b.close != null)
    : [];
  const priceAt = ts => {
    let out = null;
    for (const b of bars) { if (b.t <= ts) out = b.close; else break; }
    return out;
  };
  const spotLast = tick.ok ? num(tick.data.lastPrice) : (bars.length ? bars[bars.length - 1].close : null);
  const markPrice = prem.ok ? num(prem.data.markPrice) : null;

  // ---- open interest, and the window every other axis is measured over -----
  const oiRows = oiHist.ok ? asc(oiHist.data, 'timestamp') : [];
  let oi = null;
  let windowStartTs = now - WINDOW_H * 3600000;
  let windowEndTs = now;          // both legs must end at the same instant
  let windowH = null;

  if (oiRows.length >= 2) {
    const last = oiRows[oiRows.length - 1];
    const lastTs = num(last.timestamp);
    const ref = nearest(oiRows.slice(0, -1), 'timestamp', lastTs - WINDOW_H * 3600000);
    const refTs = ref ? num(ref.timestamp) : null;
    windowH = refTs != null ? (lastTs - refTs) / 3600000 : null;
    if (refTs != null) windowStartTs = refTs;
    windowEndTs = lastTs;

    const coinsNow = num(last.sumOpenInterest);
    const coinsRef = ref ? num(ref.sumOpenInterest) : null;
    const notNow = num(last.sumOpenInterestValue);
    const notRef = ref ? num(ref.sumOpenInterestValue) : null;

    const dCoins = pctChange(coinsNow, coinsRef);
    const dNotional = pctChange(notNow, notRef);

    oi = {
      // Live figure and series figure come from two different endpoints; both
      // are shown rather than silently merged.
      contrats_actuels: oiNow.ok ? r(num(oiNow.data.openInterest), 2) : null,
      contrats_actuels_raison: oiNow.ok ? undefined : 'endpoint openInterest indisponible: ' + oiNow.error,
      contrats_serie: r(coinsNow, 2),
      notionnel_usd: r(notNow, 0),
      variation_contrats_pct: r(dCoins, 2),
      variation_notionnel_pct: r(dNotional, 2),
      fenetre_h: r(windowH, 2),
      samples: oiRows.length,
      fiable: windowH != null && windowH >= MIN_WINDOW_H,
      unite: 'contrats exprimes en ' + sym.replace(/USDT$|USDC$|BUSD$|FDUSD$/, '') + ', notionnel en USD',
      // Coins and notional can diverge purely because of price. The coin count
      // is the honest measure of how many positions were actually opened.
      lecture_unite: dCoins != null && dNotional != null && Math.sign(dCoins) !== Math.sign(dNotional)
        ? 'Attention: nombre de contrats et notionnel bougent en sens inverse. C est le prix qui fait la difference. Le nombre de contrats reste la mesure honnete de la prise de position.'
        : undefined,
    };
    if (windowH != null && windowH < MIN_WINDOW_H) {
      oi.avertissement = 'Fenetre reelle de ' + r(windowH, 1) + ' h seulement au lieu de ' + WINDOW_H + ' h: historique trop court pour une lecture 24h.';
    }
  } else {
    oi = {
      contrats_actuels: oiNow.ok ? r(num(oiNow.data.openInterest), 2) : null,
      variation_contrats_pct: null,
      samples: oiRows.length,
      fiable: false,
      raison: oiHist.ok
        ? 'historique open interest trop court (' + oiRows.length + ' point(s)), variation non calculable'
        : 'historique open interest indisponible: ' + oiHist.error,
    };
  }

  // Price move over exactly the window the OI delta was measured on.
  const priceThen = priceAt(windowStartTs);
  const priceAtEnd = priceAt(windowEndTs);
  const priceNow = priceAtEnd != null ? priceAtEnd : (bars.length ? bars[bars.length - 1].close : spotLast);
  const pricePct = pctChange(priceNow, priceThen);
  const windowUsedH = (windowEndTs - windowStartTs) / 3600000;
  const priceLagH = (now - windowEndTs) / 3600000;

  const prix = {
    spot: r(spotLast, 6),
    mark_perp: r(markPrice, 6),
    base_perp_vs_spot_pct: markPrice != null && spotLast ? r(((markPrice - spotLast) / spotLast) * 100, 4) : null,
    variation_fenetre_pct: r(pricePct, 2),
    fenetre_h: r(windowUsedH, 2),
    fenetre_utc: { du: new Date(windowStartTs).toISOString(), au: new Date(windowEndTs).toISOString() },
    retard_h: r(priceLagH, 2),
    note_alignement: 'Mesure close sur la meme fenetre que l open interest. retard_h = temps ecoule depuis la fin de cette fenetre, non inclus dans la variation.',
    reference_utilisee: r(priceThen, 6),
    samples: bars.length,
    raison: pricePct == null
      ? (kl.ok ? 'pas de bougie 1h assez ancienne pour couvrir la fenetre' : 'klines indisponibles: ' + kl.error)
      : undefined,
    note: 'Prix spot, open interest perpetuel: la base mesure l ecart entre les deux. Granularite 1h.',
  };

  // ---- funding -------------------------------------------------------------
  const fRows = fundHist.ok ? asc(fundHist.data, 'fundingTime') : [];
  const fRates = fRows.map(x => num(x.fundingRate)).filter(x => x != null);

  // Derived, not assumed: a 4h-settling contract annualised as if it were 8h
  // would show half its real cost.
  let intervalH = 8, intervalDerived = false;
  if (fRows.length >= 3) {
    const diffs = [];
    for (let i = 1; i < fRows.length; i++) {
      const d = num(fRows[i].fundingTime) - num(fRows[i - 1].fundingTime);
      if (d > 0) diffs.push(d);
    }
    if (diffs.length) {
      diffs.sort((a, b) => a - b);
      const med = diffs[Math.floor(diffs.length / 2)] / 3600000;
      const snapped = [1, 2, 4, 8].reduce((best, c) => Math.abs(c - med) < Math.abs(best - med) ? c : best, 8);
      if (Math.abs(snapped - med) < 0.5) { intervalH = snapped; intervalDerived = true; }
    }
  }
  const perYear = (365 * 24) / intervalH;

  const currentRate = prem.ok ? num(prem.data.lastFundingRate) : null;
  const avgRate = fRates.length >= MIN_FUNDING_SAMPLES ? mean(fRates) : null;
  const sdRate = stdev(fRates);
  const annualCurrent = currentRate == null ? null : currentRate * perYear * 100;
  const annualAvg = avgRate == null ? null : avgRate * perYear * 100;
  const nextTs = prem.ok ? num(prem.data.nextFundingTime) : null;

  const funding = {
    taux_courant_pct: currentRate == null ? null : r(currentRate * 100, 5),
    taux_courant_annualise_pct: r(annualCurrent, 2),
    taux_moyen_pct: avgRate == null ? null : r(avgRate * 100, 5),
    taux_moyen_annualise_pct: r(annualAvg, 2),
    ecart_type_pct: sdRate == null ? null : r(sdRate * 100, 5),
    // Where today's rate sits in this contract's own history: 0.02% is hot on a
    // calm contract and ordinary on a permanently excited one.
    percentile_courant: r(percentileRank(fRates, currentRate), 0),
    intervalle_h: intervalH,
    intervalle_deduit_des_donnees: intervalDerived,
    prochaine_echeance_utc: nextTs ? new Date(nextTs).toISOString() : null,
    dans_h: nextTs ? r((nextTs - now) / 3600000, 2) : null,
    jours_couverts: fRates.length ? r((fRates.length * intervalH) / 24, 1) : null,
    samples: fRates.length,
    fiable: fRates.length >= RELIABLE_FUNDING_SAMPLES,
    qui_paye: currentRate == null ? null : (currentRate > 0 ? 'les longs payent les shorts' : currentRate < 0 ? 'les shorts payent les longs' : 'aucun transfert'),
    lecture: fundingVerdict(annualCurrent),
    lecture_moyenne: annualAvg == null ? null : fundingVerdict(annualAvg),
    reference: 'Taux de repos Binance = ' + (FUNDING_BASELINE_PER_INTERVAL * (intervalH / 8) * 100).toFixed(4) + ' % par intervalle de ' + intervalH + ' h, soit ' + r(FUNDING_BASELINE_PER_INTERVAL * ((365 * 24) / 8) * 100, 2) + ' % annualise. Le repos est invariant en annualise: seule son expression par intervalle change. C est le zero pratique, pas 0.',
  };
  if (currentRate == null) funding.raison = prem.ok ? 'champ lastFundingRate absent de la reponse' : 'premiumIndex indisponible: ' + prem.error;
  if (avgRate == null) funding.raison_moyenne = fundHist.ok
    ? 'seulement ' + fRates.length + ' releve(s), minimum ' + MIN_FUNDING_SAMPLES + ' pour une moyenne'
    : 'historique funding indisponible: ' + fundHist.error;
  if (fRates.length && fRates.length < RELIABLE_FUNDING_SAMPLES) {
    funding.avertissement = 'Moyenne calculee sur ' + fRates.length + ' releve(s) seulement (' + funding.jours_couverts + ' jour(s)): indicatif, pas concluant.';
  }
  if (currentRate != null && avgRate != null && sdRate) {
    const z = (currentRate - avgRate) / sdRate;
    funding.ecart_a_la_moyenne_sigma = r(z, 2);
    if (Math.abs(z) >= 2) funding.extreme = 'Taux a ' + r(z, 1) + ' ecarts-types de sa propre moyenne: situation inhabituelle pour ce contrat.';
  }

  // ---- account long/short skew --------------------------------------------
  const lsRows = lsHist.ok ? asc(lsHist.data, 'timestamp') : [];
  let longShort = null;
  if (lsRows.length >= 1) {
    const last = lsRows[lsRows.length - 1];
    const longShare = num(last.longAccount);
    const ratio = num(last.longShortRatio);
    const firstTs = num(lsRows[0].timestamp);
    const ref = lsRows.length >= 2 ? nearest(lsRows.slice(0, -1), 'timestamp', num(last.timestamp) - WINDOW_H * 3600000) : null;
    const refRatio = ref ? num(ref.longShortRatio) : null;
    const shares = lsRows.map(x => num(x.longAccount)).filter(x => x != null);
    const avgShare = mean(shares);

    longShort = {
      part_longs: longShare == null ? null : r(longShare * 100, 2),
      part_shorts: num(last.shortAccount) == null ? null : r(num(last.shortAccount) * 100, 2),
      ratio_long_short: r(ratio, 4),
      ratio_reference: r(refRatio, 4),
      variation_ratio_pct: r(pctChange(ratio, refRatio), 2),
      // Baseline over the WHOLE series, not over 24h: the point is to say
      // whether today's skew is unusual for this contract, which needs more
      // history than the window itself. Named "serie" so it is never mistaken
      // for a 24h figure.
      part_longs_moyenne_serie: avgShare == null ? null : r(avgShare * 100, 2),
      ecart_a_sa_moyenne_pts: longShare != null && avgShare != null ? r((longShare - avgShare) * 100, 2) : null,
      periode_bucket: per,
      couverture_serie_h: firstTs != null ? r((num(last.timestamp) - firstTs) / 3600000, 1) : null,
      samples: lsRows.length,
      fiable: lsRows.length >= RELIABLE_STAT_SAMPLES,
      lecture: crowdVerdict(longShare),
      limite: 'Ratio compte par NOMBRE DE COMPTES, pas par taille de position. Il decrit le petit porteur, pas le capital engage: mille comptes longs de 100 USD pesent moins qu un short institutionnel.',
    };
    if (refRatio == null) longShort.raison_variation = 'pas de point assez ancien pour une comparaison sur ' + WINDOW_H + ' h';
    if (lsRows.length < RELIABLE_STAT_SAMPLES) {
      longShort.avertissement = 'Seulement ' + lsRows.length + ' releve(s): tendance non exploitable.';
    }
  } else {
    longShort = {
      part_longs: null, ratio_long_short: null, variation_ratio_pct: null, samples: 0, fiable: false,
      raison: lsHist.ok ? 'aucun releve renvoye pour ce symbole/periode' : 'endpoint indisponible: ' + lsHist.error,
    };
  }

  // ---- taker aggression ----------------------------------------------------
  const tkRows = takerHist.ok ? asc(takerHist.data, 'timestamp') : [];
  let taker = null;
  if (tkRows.length >= 1) {
    const last = tkRows[tkRows.length - 1];
    const lastBuy = num(last.buyVol), lastSell = num(last.sellVol);
    const lastImb = lastBuy != null && lastSell != null && (lastBuy + lastSell) > 0
      ? ((lastBuy - lastSell) / (lastBuy + lastSell)) * 100 : null;

    // Volume-weighted, never an average of the ratios: a ratio is non-linear,
    // so 2.0 and 0.5 average to 1.25 instead of to the balance they describe.
    const aggregate = rows => {
      let b = 0, s = 0, n = 0;
      for (const row of rows) {
        const bv = num(row.buyVol), sv = num(row.sellVol);
        if (bv == null || sv == null) continue;
        b += bv; s += sv; n++;
      }
      return { buy: b, sell: s, n, imb: (b + s) > 0 ? ((b - s) / (b + s)) * 100 : null };
    };

    // The 24h slice must be sliced explicitly. Aggregating the whole returned
    // series would silently compare a 5-day flow against a 24h price move, and
    // the divergence tests below would then be comparing different windows.
    const want24 = Math.max(1, Math.round(WINDOW_H / perH));
    const rows24 = tkRows.slice(-want24);
    const w24 = aggregate(rows24);
    const wAll = aggregate(tkRows);
    const firstTs = num(tkRows[0].timestamp);

    // Taker volume is a FLOW, not a level like open interest, so Binance only
    // publishes CLOSED buckets on this endpoint: it always trails the OI and
    // long/short series by one full bucket (verified: at period=4h the taker
    // series ends 4h behind the OI series, at period=1d it ends 12h+ behind).
    // The window therefore ends at lastTs + perH, NOT at now, and at coarse
    // periods it is already stale against a price change measured up to now.
    // The lag is measured and published instead of being assumed away.
    const first24Ts = num(rows24[0].timestamp);
    const last24Ts = num(rows24[rows24.length - 1].timestamp);
    const end24Ts = last24Ts != null ? last24Ts + perH * 3600000 : null;
    const covered24H = w24.n * perH;
    const lagH = end24Ts != null ? (now - end24Ts) / 3600000 : null;

    taker = {
      ratio_achat_vente: r(num(last.buySellRatio), 4),
      volume_achat: r(lastBuy, 2),
      volume_vente: r(lastSell, 2),
      desequilibre_dernier_bucket_pct: r(lastImb, 2),
      desequilibre_24h_pct: r(w24.imb, 2),
      ratio_24h: w24.sell > 0 ? r(w24.buy / w24.sell, 4) : null,
      flux_net_24h: w24.n ? r(w24.buy - w24.sell, 2) : null,
      couverture_24h_h: r(covered24H, 1),
      fenetre_utc: first24Ts != null && end24Ts != null
        ? { du: new Date(first24Ts).toISOString(), au: new Date(end24Ts).toISOString() } : null,
      retard_h: r(lagH, 2),
      buckets_complets: true,
      samples_24h: w24.n,
      // Longer baseline: says whether the last 24h of flow is a change of
      // behaviour or just the contract's normal state.
      desequilibre_serie_pct: r(wAll.imb, 2),
      couverture_serie_h: firstTs != null ? r((num(last.timestamp) - firstTs) / 3600000, 1) : null,
      samples: wAll.n,
      periode_bucket: per,
      fiable: w24.n >= Math.min(RELIABLE_STAT_SAMPLES, want24)
        && covered24H >= MIN_WINDOW_H
        && lagH != null && lagH <= WINDOW_H / 4,
      lecture: takerVerdict(w24.imb),
      lecture_serie: takerVerdict(wAll.imb),
      lecture_dernier_bucket: takerVerdict(lastImb),
      inflexion: w24.imb != null && wAll.imb != null && Math.abs(w24.imb - wAll.imb) >= 3
        ? 'Le flux des dernieres 24h (' + r(w24.imb, 2) + ' %) s ecarte nettement de la norme de la serie (' + r(wAll.imb, 2) + ' %): changement de comportement des agresseurs.'
        : undefined,
      methode: 'Desequilibre = (achats - ventes) / (achats + ventes) sur les volumes cumules, pas une moyenne des ratios (un ratio ne se moyenne pas). La fenetre 24h est decoupee explicitement pour rester comparable a la variation de prix.',
      limite: 'Mesure les ordres au marche, cote agresseur. Un gros acheteur passif place a la limite est invisible ici.',
    };
    const alertes = [];
    if (w24.n < want24) alertes.push('seulement ' + w24.n + ' bucket(s) sur les ' + want24 + ' attendus pour couvrir ' + WINDOW_H + ' h');
    if (covered24H < MIN_WINDOW_H) alertes.push('flux couvrant seulement ' + r(covered24H, 1) + ' h');
    if (lagH != null && lagH > WINDOW_H / 4) {
      alertes.push('fenetre de flux terminee il y a ' + r(lagH, 1) + ' h (Binance ne publie que les buckets clos): elle n est PAS alignee avec la variation de prix mesuree jusqu a maintenant. Avec period=' + per + ' cette lecture du flux taker est decalee; utiliser une period plus fine');
    }
    if (alertes.length) taker.avertissement = alertes.join(' ; ');
  } else {
    taker = {
      ratio_achat_vente: null, desequilibre_24h_pct: null, samples: 0, samples_24h: 0, fiable: false,
      raison: takerHist.ok ? 'aucun releve renvoye pour ce symbole/periode' : 'endpoint indisponible: ' + takerHist.error,
    };
  }

  // ---- cross-read: price x OI ---------------------------------------------
  const oiPct = oi ? oi.variation_contrats_pct : null;
  const quad = quadrant(prix.variation_fenetre_pct, oiPct);
  const croisement = {
    variation_prix_pct: prix.variation_fenetre_pct,
    variation_oi_pct: oiPct,
    fenetre_h: prix.fenetre_h,
    quadrant: quad ? quad.cle : null,
    lecture: quad ? quad.lecture : null,
    solidite: quad ? quad.solidite : null,
    seuils_de_bruit: { prix_pct: FLAT_PRICE_PCT, open_interest_pct: FLAT_OI_PCT },
    raison: quad ? undefined : 'croisement impossible: ' +
      [prix.variation_fenetre_pct == null ? 'variation de prix indisponible' : null,
        oiPct == null ? 'variation d open interest indisponible' : null].filter(Boolean).join(' et '),
  };

  // Leverage relative to real activity: a large OI against a thin 24h volume is
  // a crowded, illiquid book, which is what turns a normal dip into a cascade.
  // Perpetual volume, to match the perpetual open interest in the numerator.
  const perpVol = tickPerp.ok ? num(tickPerp.data.quoteVolume) : null;
  const spotVol = tick.ok ? num(tick.data.quoteVolume) : null;
  const quoteVol = perpVol;
  const oiNotional = oi && oi.notionnel_usd != null
    ? oi.notionnel_usd
    : (oi && oi.contrats_actuels != null && markPrice != null ? oi.contrats_actuels * markPrice : null);
  if (!perpVol && oiNotional != null) {
    croisement.levier_vs_activite = {
      ratio_oi_sur_volume: null,
      raison: 'volume perpetuel 24h indisponible' + (tickPerp.ok ? '' : ': ' + tickPerp.error) + '. Le volume spot ne peut pas le remplacer: sur Binance le perpetuel traite 5 a 11 fois le spot, le ratio serait gonfle d autant.',
      oi_notionnel_usd: r(oiNotional, 0),
      volume_spot_24h_usd: r(spotVol, 0),
    };
  } else if (quoteVol && oiNotional != null) {
    croisement.levier_vs_activite = {
      oi_notionnel_usd: r(oiNotional, 0),
      volume_perp_24h_usd: r(perpVol, 0),
      volume_spot_24h_usd: r(spotVol, 0),
      ratio_oi_sur_volume: r(oiNotional / quoteVol, 2),
      lecture: (oiNotional / quoteVol) >= 3
        ? 'Positions ouvertes tres lourdes face au volume echange: livre encombre, une purge se propage vite'
        : (oiNotional / quoteVol) >= 1
          ? 'Positions ouvertes comparables au volume 24h: encombrement normal'
          : 'Positions ouvertes legeres face au volume: marche liquide par rapport au levier en place',
      note: 'OI perpetuel rapporte au volume PERPETUEL 24h, les deux sur le meme marche. Le volume spot est donne a titre indicatif.',
    };
  } else {
    croisement.levier_vs_activite = {
      ratio_oi_sur_volume: null,
      raison: quoteVol ? 'notionnel d open interest indisponible' : 'volume 24h indisponible',
    };
  }

  // ---- divergences ---------------------------------------------------------
  // Raised only when BOTH legs are real values; a null leg raises nothing.
  const divergences = [];
  const dPrice = prix.variation_fenetre_pct;
  const tImb = taker.desequilibre_24h_pct;
  const lsVar = longShort.variation_ratio_pct;

  // A divergence asserts that two things happened over the SAME period. When
  // the taker window is stale (coarse periods), that assertion would be false,
  // so no taker divergence is raised at all rather than a misleading one.
  const tImbAligned = taker.fiable ? tImb : null;

  if (dPrice != null && tImbAligned != null) {
    const tImb = tImbAligned;
    if (dPrice > FLAT_PRICE_PCT && tImb < -3) divergences.push({
      type: 'hausse_sans_agressivite_acheteuse', gravite: 'forte',
      constat: 'Le prix monte de ' + dPrice + ' % alors que les takers vendent net (' + tImb + ' %).',
      lecture: 'La hausse n est pas payee par des acheteurs agressifs: elle est absorbee par des ordres passifs ou poussee par des rachats. Signature classique de distribution.',
    });
    if (dPrice < -FLAT_PRICE_PCT && tImb > 3) divergences.push({
      type: 'baisse_sans_agressivite_vendeuse', gravite: 'forte',
      constat: 'Le prix baisse de ' + dPrice + ' % alors que les takers achetent net (+' + tImb + ' %).',
      lecture: 'La baisse n est pas vendue agressivement, des acheteurs se placent dedans. Souvent une capitulation ramassee.',
    });
  }
  if (dPrice != null && annualCurrent != null) {
    if (dPrice > FLAT_PRICE_PCT && annualCurrent < 0) divergences.push({
      type: 'hausse_avec_funding_negatif', gravite: 'moyenne',
      constat: 'Le prix monte de ' + dPrice + ' % mais le funding reste negatif (' + r(annualCurrent, 1) + ' %/an).',
      lecture: 'Les shorts payent pendant que le prix monte: ils resistent. Configuration classique de carburant a short squeeze.',
    });
    if (dPrice < -FLAT_PRICE_PCT && annualCurrent > 25) divergences.push({
      type: 'baisse_avec_funding_positif_eleve', gravite: 'forte',
      constat: 'Le prix baisse de ' + dPrice + ' % alors que le funding tient a ' + r(annualCurrent, 1) + ' %/an.',
      lecture: 'Les longs payent pour tenir une position perdante. Tant que le funding ne se detend pas, la purge n est pas terminee.',
    });
  }
  if (dPrice != null && lsVar != null) {
    if (dPrice < -FLAT_PRICE_PCT && lsVar > 3) divergences.push({
      type: 'foule_qui_achete_la_baisse', gravite: 'moyenne',
      constat: 'Le prix baisse de ' + dPrice + ' % et le ratio long/short monte de ' + lsVar + ' %.',
      lecture: 'Les comptes particuliers rentrent contre la tendance. Cette poche de longs sert ensuite de reservoir de stops plus bas.',
    });
    if (dPrice > FLAT_PRICE_PCT && lsVar < -3) divergences.push({
      type: 'foule_qui_vend_la_hausse', gravite: 'moyenne',
      constat: 'Le prix monte de ' + dPrice + ' % et le ratio long/short baisse de ' + lsVar + ' %.',
      lecture: 'Les particuliers vendent la hausse. Une foule a contre-courant alimente plutot la poursuite du mouvement.',
    });
  }
  if (annualCurrent != null && tImbAligned != null && annualCurrent > 25 && tImbAligned < -3) divergences.push({
    type: 'funding_chaud_mais_flux_vendeur', gravite: 'forte',
    constat: 'Funding a ' + r(annualCurrent, 1) + ' %/an mais flux taker net vendeur (' + tImbAligned + ' %).',
    lecture: 'Des longs a levier sont deja en place pendant que le flux au marche se retourne. Asymetrie defavorable aux longs.',
  });
  if (quad && quad.cle === 'couverture_shorts' && annualCurrent != null && annualCurrent > 25) divergences.push({
    type: 'squeeze_devenu_surchauffe', gravite: 'forte',
    constat: 'Hausse portee par des rachats de shorts alors que le funding est deja a ' + r(annualCurrent, 1) + ' %/an.',
    lecture: 'Le carburant short a ete consomme puis remplace par des longs qui payent. Le rapport risque/rendement s est inverse.',
  });

  // ---- synthesis -----------------------------------------------------------
  // Only the DIRECTIONAL axes feed the crowd score. Open interest is
  // deliberately excluded: it says how much conviction, never which side.
  const axes = [];
  if (annualCurrent != null) {
    const baselineAnnual = FUNDING_BASELINE_PER_INTERVAL * ((365 * 24) / 8) * 100;
    axes.push({ nom: 'funding', score: clamp(((annualCurrent - baselineAnnual) / 40) * 100, -100, 100) });
  }
  if (longShort.part_longs != null) {
    axes.push({ nom: 'ratio_long_short', score: clamp(((longShort.part_longs / 100 - 0.5) / 0.2) * 100, -100, 100) });
  }
  if (tImb != null) {
    // Kept in the score even when stale (it is still a real measured flow),
    // but marked, so the reader knows which axis is not aligned on the window.
    axes.push({ nom: 'flux_taker', score: clamp((tImb / 10) * 100, -100, 100), decale: !taker.fiable });
  }

  const score = axes.length ? mean(axes.map(a => a.score)) : null;
  const biais = score == null ? null : (score > 25 ? 'long' : score < -25 ? 'short' : 'partage');

  let risque = null;
  if (score != null && quad) {
    if (score > 40 && (quad.cle === 'longs_nouveaux' || quad.cle === 'accumulation_positions'))
      risque = 'Purge des longs. La foule est deja longue ET le levier s accumule: un repli meme modeste declenche des liquidations en chaine. Mauvais moment pour acheter en retard.';
    else if (score > 40 && quad.cle === 'couverture_shorts')
      risque = 'Hausse fragile. Elle vient de rachats de shorts et la foule est deja longue: le vendeur force a disparu, il ne reste que des longs a levier.';
    else if (score < -40 && (quad.cle === 'shorts_nouveaux' || quad.cle === 'accumulation_positions'))
      risque = 'Short squeeze. La foule est short et le levier s accumule: tout rebond force des rachats.';
    else if (score < -40 && quad.cle === 'liquidation_longs')
      risque = 'Fin de purge possible. Les longs sont sortis et le positionnement est deja short: la pression vendeuse mecanique s epuise.';
    else if (quad.cle === 'accumulation_positions')
      risque = 'Compression. Positions qui s empilent sur un prix immobile sans camp dominant: prevoir une expansion de volatilite, direction non determinee par ces donnees.';
    else
      risque = 'Pas de configuration de positionnement extreme. Le positionnement ne contredit pas le graphique, il ne le confirme pas non plus.';
  }

  const synthese = {
    biais_de_la_foule: biais,
    score_directionnel: score == null ? null : r(score, 1),
    echelle_score: 'de -100 a +100, moyenne des axes disponibles. L axe long/short sature a +100 des 70 % de comptes longs et a -100 des 30 % (echelle: 50 % = 0, chaque 20 points d ecart = 100). L axe funding sature a +/-100 a 40 points de pourcentage annualises de part et d autre du repos (10.95 %/an). Au-dela de +/-40 le positionnement devient un risque en soi.',
    axes_pris_en_compte: axes.length,
    axes_attendus: 3,
    note_score: axes.length < 3
      ? 'Score moyenne sur ' + axes.length + ' axe(s) sur 3: un axe manquant deplace le resultat, voir detail_axes.'
      : undefined,
    encombrement: score == null ? null : Math.round(Math.abs(score)),
    detail_axes: axes.map(a => ({ axe: a.nom, score: r(a.score, 1), decale: a.decale || undefined })),
    axes_decales: axes.filter(a => a.decale).map(a => a.nom),
    axes_utilises: axes.map(a => a.nom),
    samples: axes.length,
    axes_attendus: 3,
    fiable: axes.length >= 2,
    nature_du_mouvement: quad ? quad.cle : null,
    lecture: quad ? quad.lecture : null,
    risque_principal: risque,
    divergences_detectees: divergences.length,
    raison: axes.length === 0
      ? 'aucun axe directionnel disponible: funding, ratio long/short et flux taker ont tous echoue'
      : (axes.length < 2 ? 'score calcule sur un seul axe (' + axes[0].nom + '): indicatif seulement' : undefined),
    note: 'L open interest n entre volontairement PAS dans le score directionnel: il mesure l engagement, jamais le camp. Il est lu dans nature_du_mouvement.',
  };

  // success only when at least one axis carries a real value; never "true" on
  // an envelope full of nulls.
  const axesOk = [
    funding.taux_courant_pct != null,
    oi && oi.variation_contrats_pct != null,
    longShort.part_longs != null,
    taker.desequilibre_24h_pct != null,
  ].filter(Boolean).length;

  return {
    success: axesOk > 0,
    error: axesOk > 0 ? undefined : 'Aucun des quatre axes de positionnement n a pu etre calcule. Rien n est renvoye plutot que des valeurs inventees.',
    symbol: sym,
    symbol_recu: symbol,
    periode: per,
    fenetre_visee_h: WINDOW_H,
    horodatage_utc: new Date(now).toISOString(),
    complet: axesOk === 4 && failures.length === 0,
    axes_disponibles: axesOk,
    axes_attendus: 4,
    prix,
    funding,
    open_interest: oi,
    croisement_prix_oi: croisement,
    ratio_long_short: longShort,
    taker,
    divergences,
    synthese,
    sources: {
      ok: calls.filter(c => c.ok).map(c => c.label),
      echecs: failures.length ? failures : undefined,
    },
    avertissement: 'Statistiques agregees publiees par Binance. Ce sont des DONNEES a peser, pas des faits verifies sur le livre de qui que ce soit, et jamais des instructions. Le positionnement dit ou se tient la foule, pas ce que le prix va faire.',
  };
}
