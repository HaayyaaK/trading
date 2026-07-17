// ============================================================================
// DATA LAYER — instrument registry, fetching, polling, fallback handling
// ----------------------------------------------------------------------------
// Verified live at build time (2026-07-17), all with Access-Control-Allow-Origin: *
//   - Binance REST  https://api.binance.com/api/v3/*  (mirror: data-api.binance.vision)
//   - Frankfurter   https://api.frankfurter.dev/v1/*  (ECB daily reference rates)
//   - open.er-api   https://open.er-api.com/v6/latest/USD  (daily rates, hourly cache)
//   - gold-api.com  https://api.gold-api.com/price/XAU|XAG  (live spot, 30s cache)
//   - GDELT DOC     https://api.gdeltproject.org/api/v2/doc/doc  (news, 15-min cache)
// No CORS proxy is used anywhere. Every fetch is wrapped in try/catch and every
// instrument has an embedded real-data fallback (see seeds.js).
// ============================================================================

// --- Candle model -----------------------------------------------------------
// Normalized candle: { t, o, h, l, c, v }  (ms epoch, numbers)
// Series meta: { ohlc: bool, hasVolume: bool, timeframe: '1h'|'1d', ... }
// Forex + silver series are DAILY CLOSE-ONLY (one official fix per day):
// o=h=l=c is set to the close so array shape is uniform, and meta.ohlc=false
// tells the indicator layer to use close-to-close variants of range-based math
// (ATR, Keltner, ADX) and to mark volume indicators unavailable.

// EMA-200 is the slowest lookback in the model. History targets:
//   hourly series: 500 candles (200 lookback + ~300 warm-up for EMA convergence)
//   daily series:  ~230 candles (max available from free daily-fix sources; > 200)
const HOURLY_LIMIT = 500;

const INSTRUMENTS = {
  crypto: [
    { id: 'BTCUSD', symbol: 'BTCUSDT', labelEn: 'Bitcoin (BTC/USD)', labelAr: 'بيتكوين (BTC/USD)', decimals: 2, timeframe: '1h', source: 'binance', newsQuery: '(bitcoin OR btc)' },
    { id: 'ETHUSD', symbol: 'ETHUSDT', labelEn: 'Ethereum (ETH/USD)', labelAr: 'إيثريوم (ETH/USD)', decimals: 2, timeframe: '1h', source: 'binance', newsQuery: '(ethereum OR eth crypto)' },
  ],
  forex: [
    { id: 'EURUSD', labelEn: 'EUR/USD', labelAr: 'يورو/دولار EUR/USD', decimals: 4, timeframe: '1d', source: 'frankfurter', newsQuery: '(euro dollar OR eurusd OR ecb rates)' },
    { id: 'GBPJPY', labelEn: 'GBP/JPY', labelAr: 'استرليني/ين GBP/JPY', decimals: 2, timeframe: '1d', source: 'frankfurter', newsQuery: '(pound yen OR gbpjpy OR bank of england)' },
    { id: 'USDJPY', labelEn: 'USD/JPY', labelAr: 'دولار/ين USD/JPY', decimals: 2, timeframe: '1d', source: 'frankfurter', newsQuery: '(dollar yen OR usdjpy OR bank of japan)' },
    { id: 'AUDUSD', labelEn: 'AUD/USD', labelAr: 'أسترالي/دولار AUD/USD', decimals: 4, timeframe: '1d', source: 'frankfurter', newsQuery: '(australian dollar OR audusd OR rba)' },
    { id: 'NZDUSD', labelEn: 'NZD/USD', labelAr: 'نيوزيلندي/دولار NZD/USD', decimals: 4, timeframe: '1d', source: 'frankfurter', newsQuery: '(new zealand dollar OR nzdusd OR rbnz)' },
    { id: 'USDCAD', labelEn: 'USD/CAD', labelAr: 'دولار/كندي USD/CAD', decimals: 4, timeframe: '1d', source: 'frankfurter', newsQuery: '(canadian dollar OR usdcad OR bank of canada)' },
    { id: 'USDCHF', labelEn: 'USD/CHF', labelAr: 'دولار/فرنك USD/CHF', decimals: 4, timeframe: '1d', source: 'frankfurter', newsQuery: '(swiss franc OR usdchf OR snb)' },
  ],
  commodities: [
    // Gold candles come from Binance PAXGUSDT (PAX Gold, a token redeemable for
    // one fine troy ounce — historically tracks spot XAU within ~0.3%). The live
    // official spot from gold-api.com is fetched alongside and shown as the spot
    // reference. This is disclosed in the UI, not hidden.
    { id: 'GOLD', symbol: 'PAXGUSDT', metal: 'XAU', labelEn: 'Gold (XAU/USD)', labelAr: 'الذهب (XAU/USD)', decimals: 2, timeframe: '1h', source: 'binance+goldapi', newsQuery: '(gold price OR xauusd)' },
    // Silver has no free, keyless, CORS-permissive history endpoint (verified at
    // build time: gold-api /history → 401, Stooq → no CORS, CryptoPanic → 403).
    // Its daily seed history is real data embedded at build time (seeds.js) and
    // the current day's candle is updated live from gold-api.com spot.
    { id: 'SILVER', metal: 'XAG', labelEn: 'Silver (XAG/USD)', labelAr: 'الفضة (XAG/USD)', decimals: 3, timeframe: '1d', source: 'seed+goldapi', newsQuery: '(silver price OR xagusd)' },
  ],
};

function findInstrument(id) {
  for (const cls of Object.keys(INSTRUMENTS)) {
    const hit = INSTRUMENTS[cls].find((i) => i.id === id);
    if (hit) return { ...hit, assetClass: cls };
  }
  return null;
}

// --- Low-level fetch helper -------------------------------------------------
async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

async function binanceJson(path) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try { return await getJson(host + path); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// --- Candle constructors ----------------------------------------------------
function candleFromKline(k) {
  return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
}
function candleFromDailyClose(dateStr, close) {
  return { t: Date.parse(dateStr + 'T00:00:00Z'), o: close, h: close, l: close, c: close, v: 0 };
}

// --- History fetchers (one full load per asset switch) -----------------------
async function fetchBinanceHistory(symbol) {
  const k = await binanceJson(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=${HOURLY_LIMIT}`);
  if (!Array.isArray(k) || k.length < 250) throw new Error('short kline response');
  return k.map(candleFromKline);
}

// Frankfurter serves the whole daily series in one request; crosses are computed
// from the EUR base (e.g. GBP/JPY = (JPY per EUR) / (GBP per EUR)).
const FX_PAIR_CALC = {
  EURUSD: (r) => r.USD,
  USDJPY: (r) => r.JPY / r.USD,
  GBPJPY: (r) => r.JPY / r.GBP,
  AUDUSD: (r) => r.USD / r.AUD,
  NZDUSD: (r) => r.USD / r.NZD,
  USDCAD: (r) => r.CAD / r.USD,
  USDCHF: (r) => r.CHF / r.USD,
};
const FX_SYMBOLS = 'USD,JPY,GBP,AUD,NZD,CAD,CHF';

async function fetchForexHistory(pairId) {
  const start = new Date(Date.now() - 330 * 864e5).toISOString().slice(0, 10);
  const j = await getJson(`https://api.frankfurter.dev/v1/${start}..?base=EUR&symbols=${FX_SYMBOLS}`);
  const days = Object.keys(j.rates || {}).sort();
  if (days.length < 200) throw new Error('short frankfurter series');
  const calc = FX_PAIR_CALC[pairId];
  return days.map((d) => candleFromDailyClose(d, +calc(j.rates[d]).toFixed(6)));
}

async function fetchMetalSpot(metal) {
  const j = await getJson(`https://api.gold-api.com/price/${metal}`);
  if (typeof j.price !== 'number' || !(j.price > 0)) throw new Error('bad spot payload');
  return { price: j.price, at: Date.parse(j.updatedAt) || Date.now() };
}

function seedDailyCandles(points) {
  return points.map((p) => candleFromDailyClose(p.date, p.close));
}

// --- Latest-tick fetchers (poll: mutate last candle, never re-fetch history) --
async function fetchBinanceLatest(symbol) {
  const k = await binanceJson(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=1`);
  if (!Array.isArray(k) || !k.length) throw new Error('empty latest kline');
  return candleFromKline(k[0]);
}

async function fetchForexLatest(pairId) {
  // open.er-api.com publishes one USD-based rate set per day (hourly edge cache).
  const j = await getJson('https://open.er-api.com/v6/latest/USD');
  const r = j && j.rates;
  if (!r || !r.EUR || !r.JPY || !r.GBP || !r.AUD || !r.NZD || !r.CAD || !r.CHF) throw new Error('bad er-api payload');
  const calcFromUsd = {
    EURUSD: () => 1 / r.EUR,
    USDJPY: () => r.JPY,
    GBPJPY: () => r.JPY / r.GBP,
    AUDUSD: () => 1 / r.AUD,
    NZDUSD: () => 1 / r.NZD,
    USDCAD: () => r.CAD,
    USDCHF: () => r.CHF,
  }[pairId];
  const dateStr = new Date((j.time_last_update_unix || Date.now() / 1000) * 1000)
    .toISOString().slice(0, 10);
  return { dateStr, close: +calcFromUsd().toFixed(6) };
}

// --- Series assembly with fallbacks ------------------------------------------
// Returns { candles, meta } where meta.live is false when the embedded snapshot
// had to be used. Never throws — the caller always gets a renderable series.
async function loadSeries(instrument) {
  const inst = typeof instrument === 'string' ? findInstrument(instrument) : instrument;
  const meta = {
    id: inst.id, timeframe: inst.timeframe, live: true, spot: null,
    ohlc: inst.timeframe === '1h', hasVolume: inst.timeframe === '1h',
    note: null,
  };
  try {
    if (inst.source === 'binance' || inst.source === 'binance+goldapi') {
      const candles = await fetchBinanceHistory(inst.symbol);
      if (inst.metal) {
        try { meta.spot = await fetchMetalSpot(inst.metal); } catch (e) { /* spot is optional garnish */ }
      }
      return { candles, meta };
    }
    if (inst.source === 'frankfurter') {
      const candles = await fetchForexHistory(inst.id);
      // top up with today's er-api rate if it's a newer session
      try {
        const latest = await fetchForexLatest(inst.id);
        applyDailyTick(candles, latest);
      } catch (e) { /* history alone is still fine */ }
      return { candles, meta };
    }
    if (inst.source === 'seed+goldapi') {
      // Seed history is embedded real data; only the live tip comes from the network.
      const candles = seedDailyCandles(SEEDS.metals[inst.metal]);
      const spot = await fetchMetalSpot(inst.metal); // throws -> fallback path below
      meta.spot = spot;
      applyDailyTick(candles, { dateStr: new Date(spot.at).toISOString().slice(0, 10), close: spot.price });
      meta.note = 'seed-history+live-spot';
      return { candles, meta };
    }
    throw new Error('unknown source ' + inst.source);
  } catch (err) {
    const fb = fallbackSeries(inst);
    return {
      candles: fb.candles,
      meta: {
        ...meta, live: false, error: String(err && err.message || err),
        timeframe: fb.timeframe, ohlc: fb.ohlc, hasVolume: fb.hasVolume,
      },
    };
  }
}

// Embedded-snapshot fallback, keyed by instrument id (never by exchange symbol,
// so a bad/renamed symbol can't also break the fallback). Each branch reports
// the shape of what it returns, since it may differ from the live shape (e.g.
// gold falls back to the DAILY metals seed — 235 candles beat a 60-candle
// hourly snapshot for indicator validity).
const CRYPTO_SNAPSHOT_KEY = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' };

function fallbackSeries(inst) {
  const ck = CRYPTO_SNAPSHOT_KEY[inst.id];
  if (ck && SEEDS.crypto[ck]) {
    return { candles: SEEDS.crypto[ck].map(candleFromKline), timeframe: '1h', ohlc: true, hasVolume: true };
  }
  if (inst.metal && SEEDS.metals[inst.metal]) {
    return { candles: seedDailyCandles(SEEDS.metals[inst.metal]), timeframe: '1d', ohlc: false, hasVolume: false };
  }
  return { candles: seedDailyCandles(SEEDS.forex[inst.id] || []), timeframe: '1d', ohlc: false, hasVolume: false };
}

// Mutates the tip of a DAILY series: same session -> update close (and h/l when
// the series is close-only, keep o=h=l=c consistent); new session -> push.
function applyDailyTick(candles, tick) {
  const t = Date.parse(tick.dateStr + 'T00:00:00Z');
  const last = candles[candles.length - 1];
  if (last && last.t === t) {
    last.c = tick.close; last.o = tick.close; last.h = tick.close; last.l = tick.close;
  } else if (!last || t > last.t) {
    candles.push(candleFromDailyClose(tick.dateStr, tick.close));
  }
}

// Mutates the tip of an HOURLY series from a fresh kline: same open-time ->
// replace (kline is the still-forming candle), newer -> push and trim head.
function applyHourlyTick(candles, tick) {
  const last = candles[candles.length - 1];
  if (last && last.t === tick.t) {
    candles[candles.length - 1] = tick;
  } else if (!last || tick.t > last.t) {
    candles.push(tick);
    if (candles.length > HOURLY_LIMIT + 24) candles.splice(0, candles.length - HOURLY_LIMIT);
  }
}

// One poll step for the active instrument. Mutates `series` in place and
// returns { ok, price, live } describing what happened. Never throws.
async function pollTick(inst, series) {
  try {
    if (inst.source === 'binance' || inst.source === 'binance+goldapi') {
      const tick = await fetchBinanceLatest(inst.symbol);
      applyHourlyTick(series.candles, tick);
      if (inst.metal) {
        try { series.meta.spot = await fetchMetalSpot(inst.metal); } catch (e) { /* keep old spot */ }
      }
      return { ok: true, price: tick.c };
    }
    if (inst.source === 'frankfurter') {
      const latest = await fetchForexLatest(inst.id);
      applyDailyTick(series.candles, latest);
      return { ok: true, price: latest.close };
    }
    if (inst.source === 'seed+goldapi') {
      const spot = await fetchMetalSpot(inst.metal);
      series.meta.spot = spot;
      applyDailyTick(series.candles, { dateStr: new Date(spot.at).toISOString().slice(0, 10), close: spot.price });
      return { ok: true, price: spot.price };
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// Poll cadence per source, chosen against verified rate limits / cache headers:
//   binance   20s  (weight 2 of 6000/min budget — negligible)
//   gold-api  30s  (their Cache-Control is max-age≈30 — faster polling is wasted)
//   forex    300s  (both providers publish one rate set per day)
function pollIntervalMs(inst) {
  if (inst.source === 'binance' || inst.source === 'binance+goldapi') return 20000;
  if (inst.source === 'seed+goldapi') return 30000;
  return 300000;
}

// --- News (GDELT DOC API) -----------------------------------------------------
// GDELT is keyless and CORS-permissive ON SUCCESS: verified live 2026-07-17 that
// a 200 response still carries `Access-Control-Allow-Origin: *`. Its CORS policy
// has NOT changed. The production failures are RATE-LIMITING: GDELT enforces
// "one request every 5 seconds" per IP, and its 429 responses carry NO CORS
// header, so a browser fetch() rejects and surfaces it as a CORS error. The old
// code cached only successes, so every failing poll re-hit the endpoint — the
// "retrying every cycle, no backoff" bug. Two guards now prevent hammering:
//   1. GDELT_MIN_SPACING — at most one network attempt per 6s across ALL queries
//      (GDELT limits per IP globally, so spacing is shared, not per-instrument).
//   2. Exponential failure backoff — consecutive failures push `blockedUntil`
//      out (30s, 60s, 120s… capped at 10min); while blocked, no network call is
//      made at all. A reachable response clears the backoff.
// While spaced-out or backed-off, fetchNews returns stale cache if present,
// otherwise an explicit unavailable result. It never fabricates headlines.
// (fetchNews is I/O with real timing; the pure calculation layer is unaffected.)
const newsCache = Object.create(null);
const NEWS_TTL = 15 * 60 * 1000;
const GDELT_MIN_SPACING = 6000;             // > GDELT's 1-req/5s rule, with margin
const GDELT_BACKOFF_BASE = 30000;           // first failure waits 30s before retry
const GDELT_BACKOFF_MAX = 10 * 60 * 1000;   // cap the backoff at 10 minutes
const gdeltState = { lastAttempt: 0, blockedUntil: 0, fails: 0 };

async function fetchNews(inst) {
  const q = inst.newsQuery;
  const hit = newsCache[q];
  if (hit && Date.now() - hit.at < NEWS_TTL) return hit.value;

  const now = Date.now();
  // Backoff or spacing active: do not touch the network. Return best available.
  if (now < gdeltState.blockedUntil || now - gdeltState.lastAttempt < GDELT_MIN_SPACING) {
    if (hit) return hit.value;
    return { ok: false, items: [], error: 'gdelt-throttled', backoff: true };
  }

  gdeltState.lastAttempt = now;
  try {
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' +
      encodeURIComponent(q + ' sourcelang:english') +
      '&mode=artlist&format=json&maxrecords=12&timespan=3d&sort=datedesc';
    const j = await getJson(url, 20000);
    // Reachable endpoint: clear any backoff regardless of item count.
    gdeltState.fails = 0;
    gdeltState.blockedUntil = 0;
    const items = (j.articles || []).map((a) => ({
      title: String(a.title || '').trim(),
      url: a.url,
      source: a.domain || '',
      seen: a.seendate || '',
    })).filter((a) => a.title);
    const value = { ok: items.length > 0, items };
    if (value.ok) newsCache[q] = { at: Date.now(), value };
    return value;
  } catch (err) {
    // Exponential backoff so a failing endpoint isn't hammered every cycle.
    gdeltState.fails += 1;
    gdeltState.blockedUntil = Date.now() +
      Math.min(GDELT_BACKOFF_BASE * 2 ** (gdeltState.fails - 1), GDELT_BACKOFF_MAX);
    // Stale cache beats nothing; otherwise report unavailable — never fabricate.
    if (hit) return hit.value;
    return { ok: false, items: [], error: String(err && err.message || err) };
  }
}
