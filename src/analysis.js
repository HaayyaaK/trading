// ============================================================================
// ANALYSIS LAYER — turns indicator math into descriptive readings and the
// three-tier composite. Everything here DESCRIBES what the data shows; nothing
// is a recommendation, and no output is worded as an instruction to trade.
// ----------------------------------------------------------------------------
// Reading scale used everywhere: a number in [-1, +1].
//   +1 = the indicator's state skews strongly bullish *as a description*
//    0 = neutral / mixed
//   -1 = skews strongly bearish
// state labels derive from the reading: > +0.15 'bullish', < -0.15 'bearish',
// otherwise 'neutral'; 'na' = not enough data (excluded from every average —
// never padded or extrapolated, per the determinism/no-invention rules).
//
// Determinism: runAnalysis(series, headlines) is a pure function of the candle
// array + headline strings. No clocks, no randomness, no fetch.
// ============================================================================

const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const stateOf = (r) => (r === null ? 'na' : r > 0.15 ? 'bullish' : r < -0.15 ? 'bearish' : 'neutral');

function tip(arr) { return arr.length ? arr[arr.length - 1] : null; }
function at(arr, back) { return arr.length > back ? arr[arr.length - 1 - back] : null; }

// ---------------------------------------------------------------------------
// Individual indicator readings (Tier 1 + Tier 2 members)
// Each returns { id, category, reading, state, value, extra? } — reading null
// (state 'na') whenever its lookback is not satisfied at the tip.
// ---------------------------------------------------------------------------
function readEmaCross(cl) {
  const e50 = ema(cl, 50), e200 = ema(cl, 200);
  const a = tip(e50), b = tip(e200), price = tip(cl);
  if (a === null || b === null) return { id: 'emaCross', category: 'trend', reading: null, state: 'na', value: null };
  // distance between EMAs, normalized by price, saturating at ±2%
  const spread = clamp1(((a - b) / price) / 0.02);
  // price side of the fast EMA adds conviction
  const side = price > a ? 0.25 : price < a ? -0.25 : 0;
  const reading = clamp1(0.75 * spread + side);
  return { id: 'emaCross', category: 'trend', reading, state: stateOf(reading), value: { ema50: a, ema200: b } };
}

function readRsi(cl) {
  const r = tip(rsi(cl, 14));
  if (r === null) return { id: 'rsi', category: 'momentum', reading: null, state: 'na', value: null };
  // 50 = neutral; overbought/oversold read as stretched, not as an instruction
  const reading = clamp1((r - 50) / 25);
  return { id: 'rsi', category: 'momentum', reading, state: stateOf(reading), value: r, zone: r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : 'mid' };
}

function readMacd(cl, price) {
  const m = macd(cl, 12, 26, 9);
  const line = tip(m.line), sig = tip(m.ref), hist = tip(m.hist), histPrev = at(m.hist, 1);
  if (line === null || sig === null) return { id: 'macd', category: 'momentum', reading: null, state: 'na', value: null };
  const sep = clamp1(((line - sig) / price) / 0.005); // reference-line separation, saturates at 0.5% of price
  const grow = histPrev !== null && hist !== null ? (Math.abs(hist) >= Math.abs(histPrev) ? 1 : -1) : 0;
  const reading = clamp1(sep * (0.8 + 0.2 * grow));
  return { id: 'macd', category: 'momentum', reading, state: stateOf(reading), value: { line, ref: sig, hist } };
}

function readBollinger(cl) {
  const bb = bollinger(cl, 20, 2);
  const u = tip(bb.upper), l = tip(bb.lower), mid = tip(bb.mid), price = tip(cl);
  if (u === null) return { id: 'bollinger', category: 'volatility', reading: null, state: 'na', value: null };
  // %B centered: 0 at midline, ±1 at the bands
  const pctB = u === l ? 0 : ((price - l) / (u - l)) * 2 - 1;
  const reading = clamp1(pctB);
  return { id: 'bollinger', category: 'volatility', reading, state: stateOf(reading), value: { upper: u, mid, lower: l, pctB: (pctB + 1) / 2 } };
}

function readKama(cl) {
  const k = kama(cl, 10, 2, 30);
  const cur = tip(k), prev = at(k, 3), price = tip(cl);
  if (cur === null || prev === null) return { id: 'kama', category: 'trend', reading: null, state: 'na', value: null };
  const slope = clamp1(((cur - prev) / price) / 0.004); // 3-bar KAMA slope, saturates at 0.4% of price
  const side = price > cur ? 0.3 : price < cur ? -0.3 : 0;
  const reading = clamp1(0.7 * slope + side);
  return { id: 'kama', category: 'trend', reading, state: stateOf(reading), value: cur };
}

function readLaguerre(cl) {
  const lr = tip(laguerreRsi(cl, 0.5));
  if (lr === null) return { id: 'laguerre', category: 'momentum', reading: null, state: 'na', value: null };
  const reading = clamp1((lr - 0.5) * 2);
  return { id: 'laguerre', category: 'momentum', reading, state: stateOf(reading), value: lr };
}

function readSqueeze(candles, ohlc) {
  const sq = squeeze(candles, ohlc);
  const on = tip(sq.on), mom = tip(sq.momentum);
  if (on === null || mom === null) return { id: 'squeeze', category: 'volatility', reading: null, state: 'na', value: null };
  // normalize momentum by recent absolute scale so the reading is price-free
  const window = sq.momentum.slice(-60).filter((x) => x !== null).map(Math.abs);
  const scale = window.length ? Math.max(...window) : 0;
  const norm = scale > 0 ? clamp1(mom / scale) : 0;
  // While coiled, direction is muted (compression says "move brewing", not which way)
  const reading = clamp1(on ? norm * 0.35 : norm);
  return { id: 'squeeze', category: 'volatility', reading, state: stateOf(reading), value: { on, momentum: mom }, phase: on ? 'compression' : 'expansion' };
}

// ---------------------------------------------------------------------------
// Tier 3 composites — one per asset class, documented in place.
// ---------------------------------------------------------------------------

// FOREX — swing-zone structure + Laguerre momentum confirmation.
// What it measures: where price sits relative to clustered swing-high/low zones
// (a transparent take on supply/demand structure) and whether smoothed momentum
// agrees. Why forex-appropriate: daily FX closes mean-revert around well-tested
// levels more than they trend; distance-to-structure is the dominant input.
// Known limitations: [C2C] swings come from daily CLOSES (no intraday wicks),
// so zones are cruder than intraday structure; a fast regime change (central
// bank surprise) invalidates recent zones until new swings print.
function tier3Forex(candles, cl) {
  const a = tip(atr(candles, 14, false));
  const lr = tip(laguerreRsi(cl, 0.5));
  const price = tip(cl);
  if (a === null || lr === null || candles.length < 60) {
    return { id: 't3forex', reading: null, state: 'na', detail: null };
  }
  const swings = swingPoints(candles, 3, false);
  const tol = a * 0.75; // zone half-width scaled by current volatility
  const zones = clusterZones([...swings.highs, ...swings.lows], tol);
  const below = zones.filter((z) => z.price < price).sort((x, y) => y.price - x.price)[0] || null;
  const above = zones.filter((z) => z.price > price).sort((x, y) => x.price - y.price)[0] || null;
  // Position score: near a tested lower zone -> data skews supportive (+);
  // near a tested upper zone -> resistive (−). Proximity in ATR units, capped
  // at 3 ATR; zone strength (touch count) scales conviction up to 3 touches.
  let zoneScore = 0;
  if (below) {
    const prox = Math.max(0, 1 - (price - below.price) / (3 * a));
    zoneScore += prox * Math.min(below.touches, 3) / 3;
  }
  if (above) {
    const prox = Math.max(0, 1 - (above.price - price) / (3 * a));
    zoneScore -= prox * Math.min(above.touches, 3) / 3;
  }
  const momScore = (lr - 0.5) * 2;
  const reading = clamp1(0.6 * clamp1(zoneScore) + 0.4 * momScore);
  return {
    id: 't3forex', reading, state: stateOf(reading),
    detail: { nearestSupport: below, nearestResistance: above, laguerre: lr, atr: a },
  };
}

// CRYPTO — volume-weighted momentum: CMF(20) + rolling-VWAP deviation z-score.
// What it measures: whether volume is flowing into up-moves (CMF) and how far
// price has stretched from its volume-weighted mean (z of VWAP deviation).
// Why crypto-appropriate: 24/7 volume is the most informative confirmation in
// crypto; expansion/contraction of that stretch tracks volatility regimes.
// Known limitations: exchange volume is Binance-only (not global), and a large
// |z| reads as "stretched", which caps rather than amplifies the score.
function tier3Crypto(candles) {
  if (candles.length < 60) return { id: 't3crypto', reading: null, state: 'na', detail: null };
  const c20 = tip(cmf(candles, 20));
  const vd = vwapDeviation(candles, 48);
  const z = tip(vd.z);
  if (c20 === null || z === null) return { id: 't3crypto', reading: null, state: 'na', detail: null };
  const cmfScore = clamp1(c20 * 5);          // CMF ±0.20 is already a strong flow reading
  let zScore = clamp1(z / 2);                // ±2σ saturates
  if (Math.abs(z) > 2.5) zScore *= 0.6;      // beyond ~2.5σ: stretched, damp not amplify
  const reading = clamp1(0.5 * cmfScore + 0.5 * zScore);
  const bw = bollinger(candles.map((x) => x.c), 20, 2).width;
  const bwTip = tip(bw), bwWindow = bw.slice(-120).filter((x) => x !== null);
  const expanding = bwTip !== null && bwWindow.length > 10 &&
    bwTip > bwWindow.reduce((s, x) => s + x, 0) / bwWindow.length;
  return {
    id: 't3crypto', reading, state: stateOf(reading),
    detail: { cmf: c20, vwapZ: z, volatilityPhase: expanding ? 'expansion' : 'contraction' },
  };
}

// COMMODITIES (gold/silver) — ATR-calibrated volatility + ADX trend strength.
// What it measures: trend direction from DI+/DI−, conviction from ADX, with
// conviction damped when ATR sits in its own extreme percentile (noisy chop
// masquerading as trend). Why metals-appropriate: gold/silver trend in bursts
// between long noisy ranges; raw momentum overreads them without an ADX gate.
// Known limitations: [C2C] silver's daily close-only series uses close-to-close
// DM and TR, so DI/ADX measure persistence of daily moves, not intraday range.
function tier3Commodity(candles, ohlc) {
  if (candles.length < 60) return { id: 't3commodity', reading: null, state: 'na', detail: null };
  const { adx: adxArr, plusDi, minusDi } = adx(candles, 14, ohlc);
  const a = tip(adxArr), p = tip(plusDi), m = tip(minusDi);
  const atrArr = atr(candles, 14, ohlc);
  const atrTip = tip(atrArr), price = tip(candles).c;
  if (a === null || p === null || m === null || atrTip === null) {
    return { id: 't3commodity', reading: null, state: 'na', detail: null };
  }
  const dir = clamp1((p - m) / 25);                 // DI spread, saturates at 25 points
  const strength = Math.min(a, 50) / 50;            // ADX 50+ = fully trending
  // ATR percentile within its own trailing distribution (up to 250 bars)
  const hist = atrArr.slice(-250).filter((x) => x !== null).map((x) => x / price);
  const cur = atrTip / price;
  const pct = hist.length ? hist.filter((x) => x <= cur).length / hist.length : 0.5;
  const damp = pct > 0.85 ? 1 - (pct - 0.85) * 2 : 1; // extreme-vol damping, floor 0.7
  const reading = clamp1(dir * strength * damp);
  return {
    id: 't3commodity', reading, state: stateOf(reading),
    detail: { adx: a, plusDi: p, minusDi: m, atr: atrTip, atrPercentile: pct },
  };
}

// ---------------------------------------------------------------------------
// Sentiment — local lexicon scored per headline, averaged. [-1, +1] per line.
// ---------------------------------------------------------------------------
const SENTIMENT_LEXICON = {
  // bullish-leaning terms
  surge: 0.8, soar: 0.9, rally: 0.7, jump: 0.6, gain: 0.5, gains: 0.5, rise: 0.4,
  rises: 0.4, rising: 0.4, climb: 0.5, climbs: 0.5, record: 0.5, high: 0.3,
  breakout: 0.6, bullish: 0.9, bull: 0.6, upgrade: 0.6, upgraded: 0.6, beat: 0.5,
  beats: 0.5, strong: 0.4, strength: 0.4, boom: 0.7, recovery: 0.5, recover: 0.4,
  rebound: 0.5, optimism: 0.6, optimistic: 0.6, adoption: 0.4, approval: 0.5,
  approve: 0.5, approved: 0.5, inflow: 0.5, inflows: 0.5, accumulate: 0.4,
  accumulation: 0.4, outperform: 0.6, double: 0.4, milestone: 0.3, growth: 0.4,
  // bearish-leaning terms
  crash: -0.9, plunge: -0.8, plunges: -0.8, tumble: -0.7, tumbles: -0.7,
  slump: -0.7, sink: -0.6, sinks: -0.6, drop: -0.5, drops: -0.5, fall: -0.4,
  falls: -0.4, falling: -0.4, decline: -0.4, declines: -0.4, low: -0.3,
  bearish: -0.9, bear: -0.6, downgrade: -0.6, downgraded: -0.6, miss: -0.5,
  weak: -0.4, weakness: -0.4, fear: -0.6, fears: -0.6, panic: -0.8, risk: -0.3,
  risks: -0.3, warning: -0.5, warns: -0.5, ban: -0.6, banned: -0.6, hack: -0.7,
  hacked: -0.7, fraud: -0.7, lawsuit: -0.5, sue: -0.5, sues: -0.5, crisis: -0.7,
  recession: -0.6, inflation: -0.3, selloff: -0.7, 'sell-off': -0.7, outflow: -0.5,
  outflows: -0.5, liquidation: -0.6, liquidations: -0.6, default: -0.5, war: -0.5,
  sanctions: -0.4, bubble: -0.5, correction: -0.4, volatile: -0.2, uncertainty: -0.4,
};
const NEGATORS = ['not', 'no', "isn't", "aren't", "won't", 'without', 'despite', 'ends', 'end'];

function scoreHeadline(title) {
  const tokens = String(title).toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, ' ').split(/\s+/).filter(Boolean);
  let sum = 0, hits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = SENTIMENT_LEXICON[tokens[i]];
    if (w === undefined) continue;
    // a negator within the 2 preceding tokens flips the term's direction
    const negated = tokens.slice(Math.max(0, i - 2), i).some((t) => NEGATORS.includes(t));
    sum += negated ? -w : w;
    hits++;
  }
  if (!hits) return 0;
  return clamp1(sum / Math.sqrt(hits)); // sqrt damping: many weak words ≠ one strong word
}

function scoreSentiment(headlines) {
  if (!headlines || !headlines.length) return { ok: false, score: null, perHeadline: [] };
  const perHeadline = headlines.map((h) => ({ title: h.title, score: +scoreHeadline(h.title).toFixed(2) }));
  const score = clamp1(perHeadline.reduce((s, x) => s + x.score, 0) / perHeadline.length);
  return { ok: true, score, perHeadline };
}

// ---------------------------------------------------------------------------
// Fusion — the composite reading. Weights per the spec:
//   Composite Technical = T1×0.20 + T2×0.30 + T3×0.50
//   Combined            = Technical×0.70 + Sentiment×0.30
// If a tier has no valid members (short history) its weight is redistributed
// pro-rata to the tiers that do have data, and this is reported explicitly in
// `weightsUsed` — never silently faked. If sentiment is unavailable, Combined
// falls back to the technical reading alone with sentimentIncluded=false.
// ---------------------------------------------------------------------------
function tierScore(members) {
  const valid = members.filter((m) => m.reading !== null);
  if (!valid.length) return null;
  return clamp1(valid.reduce((s, m) => s + m.reading, 0) / valid.length);
}

function runAnalysis(series, headlines) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const { candles, meta } = series;
  const cl = candles.map((c) => c.c);
  const price = cl[cl.length - 1];
  const ohlc = !!meta.ohlc;

  // --- indicator readings -------------------------------------------------
  const t1members = [readEmaCross(cl), readRsi(cl), readMacd(cl, price), readBollinger(cl)];
  const t2members = [readKama(cl), readLaguerre(cl), readSqueeze(candles, ohlc)];
  let t3;
  if (meta.id === 'BTCUSD' || meta.id === 'ETHUSD') {
    t3 = meta.hasVolume
      ? tier3Crypto(candles)
      : { id: 't3crypto', reading: null, state: 'na', detail: null, reason: 'volume-unavailable' };
  } else if (meta.id === 'GOLD' || meta.id === 'SILVER') {
    t3 = tier3Commodity(candles, ohlc);
  } else {
    t3 = tier3Forex(candles, cl);
  }

  // volume gauge (crypto/gold hourly only) — descriptive extra, not a tier
  let volumeReading = { id: 'cmf', category: 'volume', reading: null, state: 'na', value: null };
  if (meta.hasVolume) {
    const c20 = tip(cmf(candles, 20));
    if (c20 !== null) {
      const r = clamp1(c20 * 5);
      volumeReading = { id: 'cmf', category: 'volume', reading: r, state: stateOf(r), value: c20 };
    }
  }

  const indicators = [...t1members, ...t2members, volumeReading, t3];

  // --- tiers + weight redistribution --------------------------------------
  const rawTiers = [
    { key: 't1', weight: 0.20, score: tierScore(t1members) },
    { key: 't2', weight: 0.30, score: tierScore(t2members) },
    { key: 't3', weight: 0.50, score: t3.reading },
  ];
  const avail = rawTiers.filter((t) => t.score !== null);
  const totalW = avail.reduce((s, t) => s + t.weight, 0);
  const weightsUsed = {};
  let compositeTechnical = null;
  if (avail.length && totalW > 0) {
    compositeTechnical = clamp1(avail.reduce((s, t) => s + t.score * (t.weight / totalW), 0));
    for (const t of rawTiers) weightsUsed[t.key] = t.score === null ? 0 : +(t.weight / totalW).toFixed(3);
  }

  // --- sentiment + combined ------------------------------------------------
  const sentiment = scoreSentiment(headlines);
  let combined = compositeTechnical, sentimentIncluded = false;
  if (compositeTechnical !== null && sentiment.ok) {
    combined = clamp1(compositeTechnical * 0.7 + sentiment.score * 0.3);
    sentimentIncluded = true;
  }

  // --- consensus counts (indicator states, not votes on a trade) ----------
  const consensus = { bullish: 0, bearish: 0, neutral: 0, na: 0 };
  for (const ind of indicators) consensus[ind.state]++;

  // --- structural levels & volatility descriptor ---------------------------
  const atr14 = tip(atr(candles, 14, ohlc));
  const atrRange = atr14 !== null ? { low: price - atr14, high: price + atr14, atr: atr14 } : null;
  const fib = fibLevels(candles, Math.min(120, candles.length), ohlc);
  const pivots = pivotPoints(candles, ohlc);

  let volatility = null;
  if (atr14 !== null) {
    const atrArr = atr(candles, 14, ohlc);
    const hist = atrArr.slice(-250).filter((x) => x !== null).map((x) => x / price);
    const pct = hist.length ? hist.filter((x) => x <= atr14 / price).length / hist.length : 0.5;
    volatility = {
      atrPct: atr14 / price,
      percentile: pct,
      band: pct < 0.25 ? 'low' : pct < 0.6 ? 'moderate' : pct < 0.85 ? 'elevated' : 'high',
    };
  }

  const elapsedMs = ((typeof performance !== 'undefined' ? performance : Date).now()) - t0;

  return {
    ok: compositeTechnical !== null,
    price,
    indicators,
    tiers: {
      t1: { score: rawTiers[0].score, members: t1members },
      t2: { score: rawTiers[1].score, members: t2members },
      t3: { score: t3.reading, composite: t3 },
    },
    weightsUsed,
    compositeTechnical,
    sentiment,
    sentimentIncluded,
    combined,
    consensus,
    levels: { atrRange, fib, pivots },
    volatility,
    insufficient: indicators.filter((i) => i.state === 'na').map((i) => i.id),
    elapsedMs,
  };
}
