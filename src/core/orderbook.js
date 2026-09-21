/**
 * Order book analysis: spread, bid/ask imbalance, liquidity walls and the real
 * cost of moving the price.
 *
 * Read from Binance's public REST endpoint in Node, so it works with no chart
 * open and no authentication.
 *
 * Four things drive every design choice here:
 *  - a book is a SNAPSHOT. It changes in seconds and large resting orders are
 *    routinely pulled before they trade (spoofing). Every answer is timestamped
 *    and, unless disabled, walls are re-read a moment later to see which ones
 *    actually stay. A wall that vanishes was never liquidity;
 *  - a REST book is TRUNCATED. 500 levels cover ~6% of price on LINKUSDT but
 *    only ~0.06% on BTCUSDT. Measuring "liquidity within 1%" on a book that
 *    stops at 0.06% would silently return a number that is wrong by orders of
 *    magnitude, so coverage is checked per band and per side, the fetch is
 *    escalated to a deeper limit when needed, and what is still out of reach is
 *    returned as null with a reason — never as 0;
 *  - walls are defined RELATIVE to the book itself — a level that dwarfs its
 *    immediate neighbours and holds a real share of the visible side — never
 *    against a size in dollars, which means nothing from one symbol to the next
 *    (see findWalls for the live measurements that ruled out a global z-score);
 *  - every figure carries how many levels it rests on, because an imbalance
 *    built from three orders is noise, not pressure.
 */

const UA = { 'User-Agent': 'Mozilla/5.0' };

const SPOT = 'https://api.binance.com/api/v3';

// Binance serves these depths only; anything else is silently coerced by the API.
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000, 5000];

const DEFAULT_BANDS = [0.1, 0.25, 0.5, 1];     // % around mid for imbalance
const DEFAULT_IMPACT = [0.25, 0.5, 1];         // % move to price for impact cost

const LOCAL_WINDOW = 10;   // levels compared on each side of a candidate wall
const LOCAL_RATIO = 10;    // a wall dwarfs its neighbourhood by this factor
const MIN_SHARE = 1;       // % of the side's visible value, below which a wall changes nothing
const ZONE_PCT = 0.05;     // width of a price bucket when looking for dense zones
const ZONE_RATIO = 4;      // a dense bucket versus the median bucket
const ZONE_SHARE = 3;      // % of the side's value held by that bucket
const SCAN_PCT = 2;        // walls are only looked for this close to mid
const PERSIST_MS = 1500;   // delay before the second read used to spot spoofing

// Band edges land exactly on a tick (100 * 1.005 = 100.49999...), so a level
// sitting ON the edge would be dropped by a naive <=. That silently understates
// depth, which is the kind of quiet error this module exists to avoid.
const EPS = 1e-9;

function r(x, d) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

// Percentages: 4 decimals is fine above 1, but a 0.0000128% spread must not be
// rounded down to a flat 0 — a false zero reads as "no spread".
function pc(x) {
  if (x == null || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  return Math.abs(x) >= 1 ? r(x, 4) : Number(x.toPrecision(4));
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// Significant digits, so 0.000003685 and 78000 both print usefully.
function rp(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const a = Math.abs(x);
  if (a === 0) return 0;
  const d = Math.max(0, 8 - Math.ceil(Math.log10(a)));
  return r(x, Math.min(d, 10));
}

// Quote amounts: whole units are enough for a 300000 USDT wall, but a BTC-quoted
// pair puts real walls at 1.37 BTC, where rounding to units erases the figure.
function rq(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const a = Math.abs(x);
  if (a >= 1000) return r(x, 0);
  if (a >= 1) return r(x, 2);
  return rp(x);
}

// Every "valeur_quote" is in the quote asset, not in dollars. Naming it avoids
// a BTC-quoted pair being read as if the figures were USD.
const QUOTES = ['USDT', 'FDUSD', 'USDC', 'TUSD', 'BUSD', 'EUR', 'TRY', 'BRL', 'BTC', 'ETH', 'BNB'];
function quoteAsset(ticker) {
  const hit = QUOTES.filter(q => ticker.endsWith(q)).sort((a, b) => b.length - a.length)[0];
  return hit || null;
}

// Accepts "LINKUSDT" or "BINANCE:LINKUSDT". Anything else is refused rather
// than quietly analysed with Binance data under another exchange's name.
function parseSymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (!s) throw new Error('symbol is required, e.g. "LINKUSDT" or "BINANCE:LINKUSDT"');
  if (!s.includes(':')) return { ticker: s.replace(/[^A-Z0-9]/g, ''), warn: null };
  const [ex, tk] = s.split(':');
  if (ex !== 'BINANCE') {
    return { ticker: null, warn: 'Source unique: Binance spot. Symbole "' + symbol + '" non servi par ce module.' };
  }
  return { ticker: tk.replace(/[^A-Z0-9]/g, ''), warn: null };
}

async function fetchBook(ticker, limit) {
  let r0, txt;
  try {
    r0 = await fetch(SPOT + '/depth?symbol=' + encodeURIComponent(ticker) + '&limit=' + limit, { headers: UA });
    txt = await r0.text();
  } catch (e) {
    // A transient network failure must surface as a failed read, not as an
    // exception that a caller might turn into an empty-but-successful answer.
    return { ok: false, error: 'Lecture du carnet impossible: ' + e.message };
  }
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { /* non-JSON error page */ }
  if (!r0.ok) {
    const msg = j && j.msg ? j.msg : txt.slice(0, 160);
    return { ok: false, error: 'HTTP ' + r0.status + ' — ' + msg };
  }
  if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks)) {
    return { ok: false, error: 'Reponse inattendue de Binance (bids/asks absents).' };
  }
  const side = (rows, dir) => rows
    .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
    .filter(l => Number.isFinite(l.price) && Number.isFinite(l.qty) && l.price > 0 && l.qty > 0)
    .map(l => ({ ...l, notional: l.price * l.qty }))
    // Binance already sorts; re-sorting makes the walk below safe if it ever stops.
    .sort((a, b) => dir * (a.price - b.price));
  return {
    ok: true,
    lu_a: new Date().toISOString(),
    lastUpdateId: j.lastUpdateId,
    limit,
    bids: side(j.bids, -1),   // descending
    asks: side(j.asks, 1),    // ascending
  };
}

// Tick size inferred from the book itself: the smallest gap between adjacent
// levels. Avoids a second call to exchangeInfo and cannot go stale.
function inferTick(bids, asks) {
  let min = Infinity;
  const scan = (arr) => {
    for (let i = 1; i < arr.length; i++) {
      const d = Math.abs(arr[i].price - arr[i - 1].price);
      if (d > 0 && d < min) min = d;
    }
  };
  scan(bids.slice(0, 200)); scan(asks.slice(0, 200));
  if (!Number.isFinite(min)) return null;
  // Adjacent prices are exact multiples of the tick; float subtraction is not.
  return Number(min.toPrecision(8));
}

function medianGap(arr, n) {
  const gaps = [];
  for (let i = 1; i < Math.min(arr.length, n); i++) {
    const d = Math.abs(arr[i].price - arr[i - 1].price);
    if (d > 0) gaps.push(d);
  }
  return median(gaps.sort((a, b) => a - b));
}

/**
 * Cost of sweeping one side up to a target price.
 * Convention stated in the output: consume every level until the next one is
 * beyond mid*(1 +/- pct). If the book ends first the move is NOT reachable with
 * what we can see, which is a different statement from "it costs X".
 */
function sweep(levels, mid, pct, up) {
  const target = up ? mid * (1 + pct / 100) : mid * (1 - pct / 100);
  const hi = target * (1 + EPS), lo = target * (1 - EPS);
  let qty = 0, quote = 0, used = 0, last = null;
  for (const l of levels) {
    if (up ? l.price > hi : l.price < lo) break;
    qty += l.qty; quote += l.notional; used++; last = l.price;
  }
  const covered = levels.length
    ? (up ? levels[levels.length - 1].price > hi : levels[levels.length - 1].price < lo)
    : false;
  if (!covered) {
    return {
      atteignable: false,
      raison: 'Carnet tronque avant ' + pct + '% (' + (levels.length ? 'dernier niveau vu ' + rp(levels[levels.length - 1].price) : 'aucun niveau') + '). Valeur inconnue, pas nulle.',
      volume_base: null, valeur_quote: null, prix_moyen: null, glissement_pct: null, niveaux_consommes: null,
    };
  }
  if (!used) {
    return {
      atteignable: true,
      volume_base: 0, valeur_quote: 0, prix_moyen: null, glissement_pct: null, niveaux_consommes: 0,
      note: 'Aucun niveau dans la bande: le spread depasse deja ' + pct + '%.',
    };
  }
  const vwap = quote / qty;
  return {
    atteignable: true,
    volume_base: rp(qty),
    valeur_quote: rq(quote),
    prix_moyen: rp(vwap),
    glissement_pct: pc((up ? vwap / mid - 1 : 1 - vwap / mid) * 100),
    dernier_prix_touche: rp(last),
    niveaux_consommes: used,
  };
}

function bandStats(levels, mid, pct, up) {
  const edge = up ? mid * (1 + pct / 100) : mid * (1 - pct / 100);
  const hi = edge * (1 + EPS), lo = edge * (1 - EPS);
  let qty = 0, quote = 0, n = 0, top = 0;
  for (const l of levels) {
    if (up ? l.price > hi : l.price < lo) break;
    qty += l.qty; quote += l.notional; n++;
    if (l.notional > top) top = l.notional;
  }
  const covered = levels.length
    ? (up ? levels[levels.length - 1].price > hi : levels[levels.length - 1].price < lo)
    : false;
  return { qty, quote, n, top, covered };
}

/**
 * Walls = levels that dwarf their own neighbourhood AND carry a real share of
 * the visible side.
 *
 * Two thresholds, both relative, because measurements on live books show why a
 * single global test fails: a robust z-score over the whole side (median + MAD)
 * flagged 53 to 1145 "walls" per side on LINK/BTC/ETH, and the same test in log
 * space flagged 0 on LINK and 482 on BTC. Book sizes are not one population —
 * dust and real orders coexist, and density falls with distance from mid. A
 * level compared with its 20 immediate neighbours, plus a floor on how much of
 * the side it actually holds, gives 3 to 30 candidates on every symbol tested.
 */
function findWalls(levels, mid, side, tick) {
  const zone = levels.filter(l => Math.abs(l.price - mid) / mid * 100 <= SCAN_PCT);
  if (zone.length < 20) {
    return { walls: [], nearest: null, total_detectes: 0, zones: [], stats: null, raison: 'Trop peu de niveaux (' + zone.length + ') dans les ' + SCAN_PCT + '% autour du prix pour comparer quoi que ce soit.' };
  }
  const med = median(zone.map(l => l.notional).sort((a, b) => a - b));
  const total = zone.reduce((s, l) => s + l.notional, 0);
  const methode = 'taille >= ' + LOCAL_RATIO + 'x la mediane des ' + (LOCAL_WINDOW * 2)
    + ' niveaux voisins ET >= ' + MIN_SHARE + '% de la valeur affichee du cote dans la zone';

  const walls = [];
  for (let i = 0; i < zone.length; i++) {
    const l = zone[i];
    const share = total > 0 ? l.notional / total * 100 : 0;
    if (share < MIN_SHARE) continue;   // cheap test first
    const lo = Math.max(0, i - LOCAL_WINDOW), hi = Math.min(zone.length, i + LOCAL_WINDOW + 1);
    const nb = [];
    for (let k = lo; k < hi; k++) if (k !== i) nb.push(zone[k].notional);
    const locMed = median(nb.sort((a, b) => a - b));
    const locRatio = locMed > 0 ? l.notional / locMed : null;
    if (locRatio == null || locRatio < LOCAL_RATIO) continue;
    walls.push({
      prix: rp(l.price),
      prix_cle: l.price,
      taille_base: rp(l.qty),
      valeur_quote: rq(l.notional),
      distance_pct: pc((l.price - mid) / mid * 100),
      distance_ticks: tick ? Math.round(Math.abs(l.price - mid) / tick) : null,
      fois_les_voisins: r(locRatio, 1),
      fois_la_mediane_de_la_zone: med > 0 ? r(l.notional / med, 1) : null,
      part_de_la_zone_pct: r(share, 2),
      role: side === 'bid' ? 'support' : 'resistance',
    });
  }
  walls.sort((a, b) => b.valeur_quote - a.valeur_quote);
  const nearest = walls.length
    ? walls.reduce((a, b) => (Math.abs(b.distance_pct) < Math.abs(a.distance_pct) ? b : a))
    : null;

  // Liquidity is often split across neighbouring ticks; a dense bucket can
  // matter more than any single order in it.
  const width = mid * ZONE_PCT / 100;
  let zones = [];
  let zoneNote = null;
  if (tick && width <= tick * 2) {
    zoneNote = 'Bucket de ' + ZONE_PCT + '% plus etroit que 2 ticks: zones identiques aux niveaux, non calculees.';
  } else {
    const buckets = new Map();
    for (const l of zone) {
      const k = Math.floor(Math.abs(l.price - mid) / width);
      const b = buckets.get(k) || { quote: 0, qty: 0, n: 0, lo: l.price, hi: l.price };
      b.quote += l.notional; b.qty += l.qty; b.n++;
      b.lo = Math.min(b.lo, l.price); b.hi = Math.max(b.hi, l.price);
      buckets.set(k, b);
    }
    const bs = [...buckets.values()];
    if (bs.length >= 8) {
      const bmed = median(bs.map(b => b.quote).sort((a, b) => a - b));
      // Buckets already aggregate several levels, so the bar is on the share of
      // the side they hold rather than on a second outlier test.
      zones = bs
        .filter(b => bmed > 0 && b.quote / bmed >= ZONE_RATIO && total > 0 && b.quote / total * 100 >= ZONE_SHARE)
        .map(b => ({
          de: rp(Math.min(b.lo, b.hi)), a: rp(Math.max(b.lo, b.hi)),
          valeur_quote: rq(b.quote), volume_base: rp(b.qty), niveaux: b.n,
          distance_pct: pc(((b.lo + b.hi) / 2 - mid) / mid * 100),
          fois_le_bucket_median: r(b.quote / bmed, 1),
          part_de_la_zone_pct: r(b.quote / total * 100, 2),
          role: side === 'bid' ? 'support' : 'resistance',
        }))
        .sort((a, b) => b.valeur_quote - a.valeur_quote)
        .slice(0, 5);
    } else {
      zoneNote = 'Moins de 8 buckets exploitables dans la zone: agregation non significative.';
    }
  }

  const reach = zone.length ? Math.abs(zone[zone.length - 1].price - mid) / mid * 100 : 0;
  return {
    walls: walls.slice(0, 5),
    nearest,
    total_detectes: walls.length,
    zones,
    zone_note: zoneNote,
    stats: {
      niveaux_analyses: zone.length,
      valeur_zone_quote: rq(total),
      taille_mediane_quote: rq(med),
      methode,
      zone_pct_demandee: SCAN_PCT,
      // The book can stop before 2%; saying "2%" would overstate what was scanned.
      zone_pct_reellement_couverte: pc(reach),
    },
  };
}

function imbalanceVerdict(x) {
  if (x == null) return null;
  if (x >= 0.3) return 'pression acheteuse nette';
  if (x >= 0.1) return 'legere pression acheteuse';
  if (x > -0.1) return 'equilibre';
  if (x > -0.3) return 'legere pression vendeuse';
  return 'pression vendeuse nette';
}

/**
 * Full order book read for one symbol.
 *
 * @param {object}  o
 * @param {string}  o.symbol            "LINKUSDT" or "BINANCE:LINKUSDT"
 * @param {number} [o.depth_pct=0.5]    band around mid used for the headline imbalance
 * @param {number} [o.limit]            book depth to request (5..5000); escalated if too shallow
 * @param {boolean}[o.persistence_check=true]  re-read the book to see which walls survive
 * @param {number} [o.persistence_delay_ms=1500]
 */
export async function orderbook({ symbol, depth_pct, limit, persistence_check, persistence_delay_ms } = {}) {
  const { ticker, warn } = parseSymbol(symbol);
  if (!ticker) return { success: false, error: warn };

  const pct = depth_pct == null ? 0.5 : Number(depth_pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 10) {
    throw new Error('depth_pct doit etre un nombre entre 0 et 10 (en %), recu: ' + depth_pct);
  }

  // An explicit limit is the caller's decision and is left alone; only the
  // default depth is allowed to grow by itself.
  const autoDepth = !(Number(limit) > 0);
  const want = autoDepth ? 500 : (DEPTH_LIMITS.find(l => l >= Number(limit)) || 5000);
  const bands = [...new Set([...DEFAULT_BANDS, pct])].sort((a, b) => a - b);
  const impacts = [...new Set([...DEFAULT_IMPACT, pct])].sort((a, b) => a - b);
  const need = Math.max(...bands, ...impacts);

  const escalade = [];
  let book = await fetchBook(ticker, want);
  if (!book.ok) return { success: false, error: book.error, symbole: ticker };

  // Escalate depth while the book does not even reach the widest band asked.
  // Weight cost is real (limit 5000 = 250 of the 6000/min budget), so at most
  // two extra calls and only when the requested measure is otherwise unknowable.
  while (autoDepth && book.bids.length && book.asks.length && escalade.length < 2) {
    const mid0 = (book.bids[0].price + book.asks[0].price) / 2;
    const covB = (mid0 - book.bids[book.bids.length - 1].price) / mid0 * 100;
    const covA = (book.asks[book.asks.length - 1].price - mid0) / mid0 * 100;
    if (covB > need && covA > need) break;
    const next = DEPTH_LIMITS.find(l => l > book.limit);
    if (!next) break;
    escalade.push({ depuis: book.limit, vers: next, couverture_vue_pct: { bid: r(covB, 3), ask: r(covA, 3) } });
    const deeper = await fetchBook(ticker, next);
    if (!deeper.ok) { escalade[escalade.length - 1].echec = deeper.error; break; }
    book = deeper;
  }

  const { bids, asks } = book;
  if (bids.length < 5 || asks.length < 5) {
    return { success: false, error: 'Carnet quasi vide (' + bids.length + ' bids / ' + asks.length + ' asks): rien de fiable a calculer.', symbole: ticker, lu_a: book.lu_a };
  }

  const bestBid = bids[0].price, bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const tick = inferTick(bids, asks);
  const gapB = medianGap(bids, 50), gapA = medianGap(asks, 50);
  const gapRef = gapB != null && gapA != null ? (gapB + gapA) / 2 : (gapB || gapA);

  // "Wide" only means something relative to this book's own granularity.
  const ticks = tick ? Math.round(spread / tick) : null;
  const vsGap = gapRef ? spread / gapRef : null;
  const anormal = ticks != null && vsGap != null ? (ticks > 3 && vsGap >= 3) : null;

  const covB = (mid - bids[bids.length - 1].price) / mid * 100;
  const covA = (asks[asks.length - 1].price - mid) / mid * 100;

  // 24h context: a 3 bps spread is nothing on a 2% daily range and expensive on
  // a 0.2% one. Optional — its failure must not fake the rest of the answer.
  let ctx = { range_24h_pct: null, volume_24h_quote: null, raison: null };
  try {
    const t = await fetch(SPOT + '/ticker/24hr?symbol=' + encodeURIComponent(ticker), { headers: UA });
    if (!t.ok) ctx.raison = 'HTTP ' + t.status + ' sur ticker/24hr';
    else {
      const j = await t.json();
      const hi = Number(j.highPrice), lo = Number(j.lowPrice), qv = Number(j.quoteVolume);
      ctx.range_24h_pct = Number.isFinite(hi) && Number.isFinite(lo) && lo > 0 ? r((hi - lo) / lo * 100, 2) : null;
      ctx.volume_24h_quote = Number.isFinite(qv) ? rq(qv) : null;
      if (ctx.range_24h_pct == null) ctx.raison = 'high/low absents de la reponse';
    }
  } catch (e) { ctx.raison = e.message; }

  const spreadPct = spread / mid * 100;
  const spread_info = {
    meilleur_achat: rp(bestBid),
    meilleur_vente: rp(bestAsk),
    milieu: rp(mid),
    spread_absolu: rp(spread),
    spread_pct: pc(spreadPct),
    spread_bps: pc(spreadPct * 100),
    spread_en_ticks: ticks,
    pas_de_cotation: rp(tick),
    ecart_median_entre_niveaux: rp(gapRef),
    spread_sur_ecart_median: r(vsGap, 2),
    anormalement_large: anormal,
    critere: 'anormal si spread > 3 ticks ET >= 3x l ecart median entre niveaux voisins',
    cout_aller_retour_bps: pc(spreadPct * 100),
    cout_franchissement_bps: pc(spreadPct * 50),
    part_du_range_24h_pct: ctx.range_24h_pct ? pc(spreadPct / ctx.range_24h_pct * 100) : null,
    part_du_range_24h_raison: ctx.range_24h_pct ? undefined : (ctx.raison || 'range 24h indisponible'),
  };

  // Microprice: mid weighted by the OPPOSITE side's size. It leans toward the
  // side with less resting size, which is where price tends to go next.
  const qB = bids[0].qty, qA = asks[0].qty;
  const micro = (bestBid * qA + bestAsk * qB) / (qA + qB);
  const touche = {
    volume_meilleur_achat: rp(qB),
    volume_meilleur_vente: rp(qA),
    ratio_touche: r(qB / qA, 2),
    microprix: rp(micro),
    ecart_microprix_vs_milieu_bps: pc((micro / mid - 1) * 10000),
    lecture: 'Microprix au-dessus du milieu = plus de volume affiche a l achat qu a la vente au tout premier niveau, penchant haussier a tres court terme. Repose sur 2 niveaux seulement, c est la mesure la plus volatile du module.',
  };

  const desequilibre = {};
  for (const b of bands) {
    const B = bandStats(bids, mid, b, false);
    const A = bandStats(asks, mid, b, true);
    const key = String(b) + '%';
    if (!B.covered || !A.covered) {
      desequilibre[key] = {
        mesurable: false,
        raison: 'Carnet tronque: couverture bid ' + r(covB, 3) + '% / ask ' + r(covA, 3) + '% pour une bande de ' + b + '%. Un cote incomplet rendrait le ratio faux.',
        ratio: null, desequilibre: null, verdict: null,
        achat_quote: B.covered ? rq(B.quote) : null,
        vente_quote: A.covered ? rq(A.quote) : null,
        niveaux_vus: { achat: B.n, vente: A.n },
      };
      continue;
    }
    if (B.n === 0 && A.n === 0) {
      desequilibre[key] = {
        mesurable: false,
        raison: 'Bande de ' + b + '% plus etroite que le spread (' + r(spreadPct, 4) + '%): aucun niveau ne peut s y trouver, la grandeur n est pas definie.',
        ratio: null, desequilibre: null, verdict: null,
        achat_quote: null, vente_quote: null,
        niveaux: { achat: 0, vente: 0 },
      };
      continue;
    }
    const tot = B.quote + A.quote;
    const imb = tot > 0 ? (B.quote - A.quote) / tot : null;
    const thin = B.n + A.n < 10;
    const domB = B.quote > 0 ? B.top / B.quote : 0;
    const domA = A.quote > 0 ? A.top / A.quote : 0;
    // Counterfactual: what the verdict becomes once the largest order is gone.
    const totSans = (B.quote - B.top) + (A.quote - A.top);
    const imbSans = totSans > 0 ? ((B.quote - B.top) - (A.quote - A.top)) / totSans : null;
    desequilibre[key] = {
      mesurable: true,
      achat_base: rp(B.qty), vente_base: rp(A.qty),
      achat_quote: rq(B.quote), vente_quote: rq(A.quote),
      ratio: A.quote > 0 ? r(B.quote / A.quote, 3) : null,
      desequilibre: imb == null ? null : r(imb, 3),
      verdict: imbalanceVerdict(imb),
      niveaux: { achat: B.n, vente: A.n },
      criteres_verdict: 'desequilibre = (achat_quote - vente_quote) / (achat_quote + vente_quote). |x| < 0.1 equilibre, 0.1 <= |x| < 0.3 legere pression, |x| >= 0.3 pression nette.',
      echantillon_mince: thin || undefined,
      depend_d_un_seul_ordre: (domB >= 0.5 || domA >= 0.5) ? {
        achat_pct: r(domB * 100, 1),
        vente_pct: r(domA * 100, 1),
        cotes_concernes: [domB >= 0.5 ? 'achat' : null, domA >= 0.5 ? 'vente' : null].filter(Boolean),
        desequilibre_sans_plus_gros_ordre: imbSans == null ? null : r(imbSans, 3),
        verdict_sans_plus_gros_ordre: imbalanceVerdict(imbSans),
      } : undefined,
      avertissement: thin ? 'Moins de 10 niveaux au total dans cette bande: ratio peu significatif.' : undefined,
    };
  }

  const wB = findWalls(bids, mid, 'bid', tick);
  const wA = findWalls(asks, mid, 'ask', tick);

  const impact = {};
  for (const p of impacts) {
    impact[String(p) + '%'] = {
      achat_pour_monter: sweep(asks, mid, p, true),
      vente_pour_baisser: sweep(bids, mid, p, false),
    };
  }

  // Second read: the only cheap way to tell a real wall from a pulled one.
  let persistance = { effectuee: false, raison: 'desactivee par persistence_check=false' };
  if (persistence_check !== false) {
    const delay = Number(persistence_delay_ms) > 0 ? Math.min(Number(persistence_delay_ms), 10000) : PERSIST_MS;
    await new Promise(res => setTimeout(res, delay));
    const b2 = await fetchBook(ticker, book.limit);
    if (!b2.ok) {
      persistance = { effectuee: false, raison: 'Seconde lecture echouee: ' + b2.error };
    } else {
      const map = new Map();
      for (const l of b2.bids) map.set('b' + l.price, l.qty);
      for (const l of b2.asks) map.set('a' + l.price, l.qty);
      const top2 = { b: b2.bids.length ? b2.bids[0].price : null, a: b2.asks.length ? b2.asks[0].price : null };
      // Deepest price each side of the SECOND read reaches.
      const reach2 = {
        b: b2.bids.length ? b2.bids[b2.bids.length - 1].price : null,
        a: b2.asks.length ? b2.asks[b2.asks.length - 1].price : null,
      };
      const check = (walls, side) => walls.map(w => {
        const horsPortee = side === 'b'
          ? (reach2.b == null || w.prix_cle < reach2.b)
          : (reach2.a == null || w.prix_cle > reach2.a);
        if (horsPortee) {
          return {
            prix: w.prix, role: w.role, taille_avant: w.taille_base,
            taille_apres: null, reste_pct: null, statut: 'inconnu',
            cause: 'hors de la profondeur relue: non observe, ni maintenu ni retire.',
          };
        }
        const q2 = map.get(side + w.prix_cle);
        const kept = q2 == null ? 0 : q2 / (w.taille_base || 1);
        const statut = q2 == null || kept < 0.2 ? 'disparu' : (kept < 0.7 ? 'reduit' : 'maintenu');
        // A wall that shrank was either pulled or eaten, and the two mean
        // opposite things. Price never reaching it rules out a fill.
        let cause;
        if (statut !== 'maintenu') {
          const touche = side === 'a'
            ? (top2.a != null && top2.a >= w.prix_cle)
            : (top2.b != null && top2.b <= w.prix_cle);
          cause = touche
            ? 'le prix a atteint ce niveau: peut avoir ete consomme plutot que retire'
            : 'le prix n y est pas alle: ordre retire, pas execute';
        }
        return {
          prix: w.prix,
          role: w.role,
          taille_avant: w.taille_base,
          taille_apres: q2 == null ? 0 : rp(q2),
          reste_pct: r(kept * 100, 1),
          statut,
          cause,
        };
      });
      const mid2 = b2.bids.length && b2.asks.length ? (b2.bids[0].price + b2.asks[0].price) / 2 : null;
      const withNearest = (list, near) => {
        if (!near) return list;
        return list.some(x => x.prix_cle === near.prix_cle) ? list : list.concat([near]);
      };
      const suivi = [...check(withNearest(wB.walls, wB.nearest), 'b'),
                     ...check(withNearest(wA.walls, wA.nearest), 'a')];
      const disparus = suivi.filter(x => x.statut !== 'maintenu');
      const retires = disparus.filter(x => x.cause && x.cause.startsWith('le prix n y est pas alle')).length;
      persistance = {
        effectuee: true,
        delai_ms: delay,
        seconde_lecture: b2.lu_a,
        deplacement_du_milieu_bps: mid2 ? pc((mid2 / mid - 1) * 10000) : null,
        murs_suivis: suivi.length,
        murs_detectes_total: wB.total_detectes + wA.total_detectes,
        murs_non_maintenus: disparus.length,
        murs_retires_sans_etre_touches: retires,
        detail: suivi,
        lecture: suivi.length
          ? (disparus.length === 0
            ? 'Les ' + suivi.length + ' plus gros murs etaient encore la apres ' + delay + ' ms. Cela ne prouve pas qu ils tiendront, seulement qu ils n ont pas ete retires immediatement.'
            : disparus.length + ' mur(s) sur ' + suivi.length + ' ont fondu en ' + delay + ' ms. '
              + (retires > 0
                ? retires + ' l ont fait a un prix que le marche n a pas atteint: ceux-la ont ete retires, pas executes, et un affichage qui se retire ne soutient rien.'
                : 'Le prix a touche ces niveaux entre les deux lectures: ils ont pu etre consommes plutot que retires, impossible de trancher sans le flux des transactions.'))
          : 'Aucun mur a suivre.',
        limite: 'Seuls les plus gros murs de chaque cote sont re-lus, et deux instantanes ne font pas une preuve: un ordre peut etre replace aussitot.',
      };
    }
  }

  // Where the liquidity sits inside the band: a book holding most of its size
  // at the touch is easy to sweep once that first layer is eaten, while a book
  // loaded deeper absorbs a push progressively. Same totals, opposite behaviour.
  const smallKey = String(bands[0]) + '%';
  const wideKey = [...bands].reverse().map(b => String(b) + '%').find(k => desequilibre[k].mesurable);
  let concentration;
  if (!wideKey || wideKey === smallKey || !desequilibre[smallKey].mesurable) {
    concentration = { mesurable: false, raison: 'Bandes insuffisantes ou carnet tronque: pas de reference large exploitable.' };
  } else {
    const s = desequilibre[smallKey], w = desequilibre[wideKey];
    concentration = {
      mesurable: true,
      bande_courte: smallKey,
      bande_large: wideKey,
      achat_part_pct: w.achat_quote > 0 ? r(s.achat_quote / w.achat_quote * 100, 1) : null,
      vente_part_pct: w.vente_quote > 0 ? r(s.vente_quote / w.vente_quote * 100, 1) : null,
      lecture: 'Part de la liquidite de la bande ' + wideKey + ' deja presente dans les ' + smallKey + '. Elevee = carnet concentre au contact, donc plus facile a traverser une fois la premiere couche consommee.',
    };
  }

  // Human-readable summary, built only from values that were actually computed.
  const synthese = [];
  const Q = quoteAsset(ticker) ? ' ' + quoteAsset(ticker) : '';
  const mainBand = desequilibre[String(pct) + '%'];
  synthese.push('Spread ' + spread_info.spread_bps + ' bps (' + (ticks == null ? 'ticks inconnus' : ticks + ' tick(s)') + ')'
    + (anormal === true ? ', anormalement large pour ce carnet.' : anormal === false ? ', dans la norme du carnet.' : '.')
    + (spread_info.part_du_range_24h_pct != null ? ' Aller-retour = ' + spread_info.part_du_range_24h_pct + '% du range 24h.' : ''));
  if (mainBand && mainBand.mesurable) {
    synthese.push('Bande ' + String(pct) + '%: ' + mainBand.achat_quote + Q + ' a l achat contre ' + mainBand.vente_quote + Q + ' a la vente (ratio '
      + mainBand.ratio + ', ' + mainBand.niveaux.achat + '+' + mainBand.niveaux.vente + ' niveaux) -> ' + mainBand.verdict + '.'
      // depend_d_un_seul_ordre is an object; concatenating it printed
      // "Attention: [object Object]", hiding the single most important caveat
      // of the whole reading — that the verdict rests on one order.
      + (mainBand.depend_d_un_seul_ordre
        ? ' Attention: ' + mainBand.depend_d_un_seul_ordre.cotes_concernes.join(' et ')
          + ' — un seul ordre porte '
          + mainBand.depend_d_un_seul_ordre.cotes_concernes
            .map(function (c) { return c + ' ' + mainBand.depend_d_un_seul_ordre[c + '_pct'] + '%'; })
            .join(', ')
          + ' de la bande. Sans lui: desequilibre '
          + mainBand.depend_d_un_seul_ordre.desequilibre_sans_plus_gros_ordre
          + ' -> ' + mainBand.depend_d_un_seul_ordre.verdict_sans_plus_gros_ordre
          + '. Ce verdict tient a un ordre qui peut etre retire avant d etre touche.'
        : ''));
  } else if (mainBand) {
    synthese.push('Bande ' + String(pct) + '% non mesurable: ' + mainBand.raison);
  }
  const nb = wB.nearest, na = wA.nearest;
  synthese.push(nb || na
    ? 'Mur le plus proche: ' + [nb ? 'support ' + nb.prix + ' (' + nb.distance_pct + '%, ' + nb.valeur_quote + Q + ')' : null,
      na ? 'resistance ' + na.prix + ' (+' + na.distance_pct + '%, ' + na.valeur_quote + Q + ')' : null].filter(Boolean).join(' | ')
      + '. Total detecte: ' + (wB.total_detectes + wA.total_detectes) + ' mur(s).'
    : (wB.raison || wA.raison)
      ? 'Murs non evaluables' + (wB.raison ? ' (achat: ' + wB.raison + ')' : '')
        + (wA.raison ? ' (vente: ' + wA.raison + ')' : '')
        + '. Ni la presence ni l absence de mur n est etablie.'
      : 'Aucun mur: aucun niveau n ecrase son voisinage, la liquidite est repartie.');
  const oneUp = impact['1%'] && impact['1%'].achat_pour_monter;
  const oneDn = impact['1%'] && impact['1%'].vente_pour_baisser;
  if (oneUp && oneDn) {
    synthese.push('Pour deplacer le prix de 1%: ' + (oneUp.atteignable ? 'acheter ' + oneUp.valeur_quote + Q + ' (glissement ' + oneUp.glissement_pct + '%)' : 'inconnu a la hausse (' + oneUp.raison + ')')
      + ' / ' + (oneDn.atteignable ? 'vendre ' + oneDn.valeur_quote + Q + ' (glissement ' + oneDn.glissement_pct + '%)' : 'inconnu a la baisse (' + oneDn.raison + ')') + '.');
  }
  if (persistance.effectuee) synthese.push('Persistance: ' + persistance.lecture);
  else synthese.push('Persistance des murs non verifiee (' + persistance.raison + '): impossible de distinguer un vrai mur d un ordre retire.');

  const fiabilite = [];
  if (covB <= need || covA <= need) {
    fiabilite.push('Carnet tronque: visible sur -' + r(covB, 3) + '% / +' + r(covA, 3) + '% seulement (limit=' + book.limit + '). Les mesures au-dela sont renvoyees a null.'
      + (autoDepth ? '' : ' limit a ete impose par l appelant, aucune escalade automatique n a ete tentee.')
      + (book.limit < 5000 ? ' Un limit plus eleve (jusqu a 5000) irait plus loin.' : ' 5000 niveaux est le maximum servi par Binance.'));
  }
  if (wB.raison || wA.raison) {
    fiabilite.push('Detection de murs non effectuee'
      + (wB.raison ? ' cote achat: ' + wB.raison : '')
      + (wA.raison ? ' cote vente: ' + wA.raison : '')
      + ' Aucune conclusion sur la repartition de la liquidite ne peut en etre tiree.');
  } else if (!wB.walls.length && !wA.walls.length) {
    fiabilite.push('Aucun niveau ne se detache de son voisinage: liquidite repartie, pas de mur exploitable.');
  }
  // Walls found inside a sliver of price are just top-of-book levels; saying
  // "support" or "resistance" about them would oversell what was measured.
  const reachB = wB.stats && wB.stats.zone_pct_reellement_couverte, reachA = wA.stats && wA.stats.zone_pct_reellement_couverte;
  if ((reachB != null && reachB < 0.5) || (reachA != null && reachA < 0.5)) {
    fiabilite.push('Murs cherches sur une fenetre tres etroite (-' + reachB + '% / +' + reachA + '% au lieu de ' + SCAN_PCT + '%): ce sont des niveaux de haut de carnet, pas des supports ou resistances de swing.');
  }
  if (bids.length < 50 || asks.length < 50) fiabilite.push('Moins de 50 niveaux par cote: statistiques de murs fragiles.');
  if (ctx.raison) fiabilite.push('Contexte 24h indisponible (' + ctx.raison + '): le spread n est pas relativise a la volatilite du jour.');
  if (warn) fiabilite.push(warn);

  // prix_cle is the raw float used to match levels between the two reads.
  for (const w of [...wB.walls, ...wA.walls, wB.nearest, wA.nearest]) if (w) delete w.prix_cle;

  return {
    success: true,
    symbole: ticker,
    monnaie_de_cotation: quoteAsset(ticker),
    source: 'Binance spot REST (api/v3/depth)',
    instantane: {
      lu_a: book.lu_a,
      last_update_id: book.lastUpdateId,
      profondeur_demandee: book.limit,
      escalade_profondeur: escalade.length ? escalade : undefined,
      niveaux: { achat: bids.length, vente: asks.length },
      couverture_pct: { achat: r(covB, 3), vente: r(covA, 3) },
      avertissement: "Un carnet est un instantane, valable a la seconde de lecture. Il se vide et se recompose en continu, et un gros ordre affiche peut etre retire avant d etre touche (spoofing). A traiter comme une photo de l intention affichee, jamais comme de la liquidite garantie.",
    },
    spread: spread_info,
    premiere_limite: touche,
    contexte_24h: { range_pct: ctx.range_24h_pct, volume_quote: ctx.volume_24h_quote, raison: ctx.raison || undefined },
    desequilibre_par_bande: desequilibre,
    bande_principale: String(pct) + '%',
    concentration,
    murs: {
      achat: { niveaux: wB.walls, plus_proche: wB.nearest, total_detectes: wB.total_detectes, zones_denses: wB.zones, statistiques: wB.stats, raison: wB.raison, note: wB.zone_note },
      vente: { niveaux: wA.walls, plus_proche: wA.nearest, total_detectes: wA.total_detectes, zones_denses: wA.zones, statistiques: wA.stats, raison: wA.raison, note: wA.zone_note },
      definition: 'Un mur est un niveau qui ecrase son voisinage immediat (>= ' + LOCAL_RATIO + 'x la mediane des ' + (LOCAL_WINDOW * 2)
        + ' niveaux adjacents) ET qui porte au moins ' + MIN_SHARE + '% de la valeur affichee de son cote dans les ' + SCAN_PCT
        + '% autour du prix. Tout est relatif au carnet lui-meme: aucun seuil en dollars, qui ne voudrait rien dire d un actif a l autre.',
    },
    impact_prix: {
      methode: 'Consommation de tous les niveaux jusqu a milieu*(1 +/- x%). volume_base = quantite a executer, valeur_quote = montant en monnaie de cotation, glissement_pct = ecart du prix moyen obtenu face au milieu actuel.',
      niveaux: impact,
    },
    verification_persistance: persistance,
    synthese,
    fiabilite: fiabilite.length ? fiabilite : ['Aucune reserve particuliere sur cette lecture.'],
    rappel: "Toutes ces valeurs decrivent des ordres AFFICHES a un instant t. Les ordres masques (iceberg) n y figurent pas, les ordres affiches peuvent disparaitre, et rien ici n est une recommandation.",
  };
}
