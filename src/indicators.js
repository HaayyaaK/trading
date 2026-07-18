// ============================================================================
// INDICATOR MATH — pure, deterministic functions of a candle array.
// ----------------------------------------------------------------------------
// Conventions used throughout:
//  - Input candles: [{t,o,h,l,c,v}, ...] oldest -> newest (Phase 1 shape).
//  - Output series are arrays ALIGNED to the input, padded with `null` while
//    the lookback is not yet valid. No extrapolation, no padding with fakes:
//    a caller that needs "the current value" checks the tip for null and must
//    surface an explicit "not enough data" state (see analysis.js).
//  - Everything is a pure function: same candles in -> same numbers out,
//    independent of wall-clock time or polling cadence.
//  - Seeding conventions match the reference implementations they were
//    verified against (technicalindicators / pandas-ta) — see
//    test/indicators-ref-test.mjs for the numeric comparison and tolerances.
//
// CLOSE-ONLY ADAPTATIONS (forex + silver daily series have one official fix
// per day, so h == l == c). Every formula that conventionally needs high/low
// takes an `ohlc` flag and, when false, switches to a documented
// close-to-close variant. Adapted formulas are marked with [C2C] below:
//   [C2C] True Range  -> |close - prevClose|            (used by ATR, Keltner)
//   [C2C] +DM / -DM   -> max(Δclose,0) / max(-Δclose,0) (used by ADX/DI)
//   [C2C] TTM squeeze midline -> uses highest/lowest CLOSE instead of high/low
//   [C2C] Swing points (Tier 3 forex) -> fractals on closes, not highs/lows
// Volume-dependent math (CMF, VWAP) is NOT adapted — without real volume it is
// meaningless, so it reports "not available" for close-only series instead.
// ============================================================================

function closes(candles) { return candles.map((x) => x.c); }

function nullPad(n) { return new Array(n).fill(null); }

// --- Simple / exponential moving averages -----------------------------------
function sma(values, period) {
  const out = nullPad(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// EMA seeded with the SMA of the first `period` values (the convention used by
// both technicalindicators and pandas-ta with sma=True).
function ema(values, period) {
  const out = nullPad(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (RMA) — used by RSI, ATR, ADX. Seeded with SMA.
function rma(values, period) {
  const out = nullPad(values.length);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

// --- RSI (Wilder, 14) --------------------------------------------------------
function rsi(values, period) {
  const out = nullPad(values.length);
  if (values.length <= period) return out;
  const gains = [], losses = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const avgG = rma(gains, period);
  const avgL = rma(losses, period);
  for (let i = period - 1; i < gains.length; i++) {
    const g = avgG[i], l = avgL[i];
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// --- MACD (12, 26, 9) --------------------------------------------------------
function macd(values, fast, slow, refPeriod) {
  const emaF = ema(values, fast);
  const emaS = ema(values, slow);
  const line = values.map((_, i) =>
    emaF[i] !== null && emaS[i] !== null ? emaF[i] - emaS[i] : null);
  // reference line = EMA of the macd line, starting where the line becomes valid
  const firstIdx = line.findIndex((x) => x !== null);
  const sig = nullPad(values.length);
  if (firstIdx >= 0) {
    const valid = line.slice(firstIdx);
    const sigValid = ema(valid, refPeriod);
    for (let i = 0; i < sigValid.length; i++) sig[firstIdx + i] = sigValid[i];
  }
  const hist = line.map((x, i) => (x !== null && sig[i] !== null ? x - sig[i] : null));
  return { line, ref: sig, hist };
}

// --- Bollinger Bands (20, 2) — population standard deviation ------------------
function bollinger(values, period, mult) {
  const mid = sma(values, period);
  const upper = nullPad(values.length);
  const lower = nullPad(values.length);
  const width = nullPad(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] !== 0 ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

// --- True Range / ATR ---------------------------------------------------------
// [C2C] when ohlc=false the daily series has one fix per day (h==l==c), so the
// classic TR collapses to 0. The honest substitute is the close-to-close move.
function trueRange(candles, ohlc) {
  const out = nullPad(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i], pc = candles[i - 1].c;
    out[i] = ohlc
      ? Math.max(cur.h - cur.l, Math.abs(cur.h - pc), Math.abs(cur.l - pc))
      : Math.abs(cur.c - pc);
  }
  return out;
}

function atr(candles, period, ohlc) {
  const tr = trueRange(candles, ohlc).slice(1); // drop leading null
  const smoothed = rma(tr, period);
  return [null, ...smoothed];
}

// --- ADX / DI (Wilder, 14) ----------------------------------------------------
// [C2C] +DM/-DM conventionally come from high/low expansion. For close-only
// series each day's move contributes one-sided close-to-close direction, so
// DI/ADX then measure the persistence of daily close moves. Same smoothing.
function adx(candles, period, ohlc) {
  const n = candles.length;
  const empty = { adx: nullPad(n), plusDi: nullPad(n), minusDi: nullPad(n) };
  if (n < 2 * period + 1) return empty;
  const pDM = [], mDM = [], trArr = [];
  for (let i = 1; i < n; i++) {
    const cur = candles[i], prev = candles[i - 1];
    let up, dn;
    if (ohlc) {
      up = cur.h - prev.h;
      dn = prev.l - cur.l;
    } else {
      const d = cur.c - prev.c;
      up = d; dn = -d;
    }
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    trArr.push(ohlc
      ? Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c))
      : Math.abs(cur.c - prev.c));
  }
  const sTR = rma(trArr, period), sP = rma(pDM, period), sM = rma(mDM, period);
  const plusDi = nullPad(n), minusDi = nullPad(n), dx = [];
  for (let i = period - 1; i < trArr.length; i++) {
    const p = sTR[i] > 0 ? (100 * sP[i]) / sTR[i] : 0;
    const m = sTR[i] > 0 ? (100 * sM[i]) / sTR[i] : 0;
    plusDi[i + 1] = p; minusDi[i + 1] = m;
    dx.push(p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0);
  }
  const adxValid = rma(dx, period);
  const out = nullPad(n);
  for (let i = 0; i < adxValid.length; i++) {
    if (adxValid[i] !== null) out[period + i] = adxValid[i];
  }
  return { adx: out, plusDi, minusDi };
}

// --- Tier 2: Kaufman's Adaptive Moving Average (10, 2, 30) ---------------------
// ER   = |close_i - close_{i-er}| / Σ|close_j - close_{j-1}| over the window
// SC   = (ER * (fastSC - slowSC) + slowSC)^2   with fastSC=2/(2+1), slowSC=2/(30+1)
// KAMA = KAMA_prev + SC * (close - KAMA_prev), seeded with close[er-1]
// (seed convention matches pandas-ta; verified in the reference test)
function kama(values, erPeriod, fastP, slowP) {
  const out = nullPad(values.length);
  if (values.length <= erPeriod) return out;
  const fastSC = 2 / (fastP + 1), slowSC = 2 / (slowP + 1);
  let prev = values[erPeriod - 1];
  out[erPeriod - 1] = prev;
  for (let i = erPeriod; i < values.length; i++) {
    let vol = 0;
    for (let j = i - erPeriod + 1; j <= i; j++) vol += Math.abs(values[j] - values[j - 1]);
    const er = vol > 0 ? Math.abs(values[i] - values[i - erPeriod]) / vol : 0;
    const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
    prev = prev + sc * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

// --- Tier 2: Laguerre RSI (Ehlers, gamma 0.5) ----------------------------------
// A four-stage Laguerre filter cascade; the "RSI" is the up-move share of the
// absolute differences between successive filter stages. Output in [0, 1].
//   L0 = (1-γ)·p + γ·L0'      L1 = -γ·L0 + L0' + γ·L1'
//   L2 = -γ·L1 + L1' + γ·L2'  L3 = -γ·L2 + L2' + γ·L3'
//   CU = Σ max(Lk - Lk+1, 0), CD = Σ max(Lk+1 - Lk, 0), LRSI = CU/(CU+CD)
// Verified against a hand-stepped independent computation of the recursion.
function laguerreRsi(values, gamma) {
  const out = nullPad(values.length);
  if (!values.length) return out;
  let l0 = values[0], l1 = values[0], l2 = values[0], l3 = values[0];
  // First WARMUP bars are suppressed (null): the filter state still remembers
  // its price-seeded start, so early values are not yet trustworthy.
  const WARMUP = 20;
  for (let i = 0; i < values.length; i++) {
    const p = values[i];
    const p0 = l0, p1 = l1, p2 = l2;
    l0 = (1 - gamma) * p + gamma * p0;
    l1 = -gamma * l0 + p0 + gamma * p1;
    l2 = -gamma * l1 + p1 + gamma * p2;
    l3 = -gamma * l2 + p2 + gamma * l3;
    let cu = 0, cd = 0;
    if (l0 >= l1) cu += l0 - l1; else cd += l1 - l0;
    if (l1 >= l2) cu += l1 - l2; else cd += l2 - l1;
    if (l2 >= l3) cu += l2 - l3; else cd += l3 - l2;
    if (i >= WARMUP) out[i] = cu + cd > 0 ? cu / (cu + cd) : 0.5;
  }
  return out;
}

// --- Tier 2: volatility squeeze (Bollinger inside Keltner, TTM-style) ----------
// squeeze ON  = BB(20,2) fully inside KC(20, 1.5×TR-SMA20) -> volatility coiling
// squeeze OFF = bands released                             -> expansion phase
// Keltner convention: SMA(20) midline ± 1.5 × SMA(20) of true range — the
// TradingView "LazyBear" / pandas-ta squeeze default, which this implementation
// is numerically verified against. (Classic Keltner uses EMA; platforms differ,
// so the convention is pinned here deliberately.)
// Momentum: linear-regression endpoint (20) of close minus the midline
//   midline = ((highestHigh20 + lowestLow20)/2 + SMA20)/2   (Donchian/SMA blend)
// [C2C] for close-only series highest/lowest use closes, ATR is close-to-close.
function linregEndpoint(values, period, atIdx) {
  // least-squares fit over values[atIdx-period+1 .. atIdx], evaluated at the end
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < period; k++) {
    const x = k, y = values[atIdx - period + 1 + k];
    sx += x; sy += y; sxy += x * y; sxx += x * x;
  }
  const denom = period * sxx - sx * sx;
  if (denom === 0) return sy / period;
  const b = (period * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / period;
  return a + b * (period - 1);
}

function squeeze(candles, ohlc) {
  const n = candles.length;
  const cl = closes(candles);
  const bb = bollinger(cl, 20, 2);
  const trSma = [null, ...sma(trueRange(candles, ohlc).slice(1), 20)];
  const on = nullPad(n), momentum = nullPad(n);
  const detrended = nullPad(n);
  for (let i = 0; i < n; i++) {
    if (bb.upper[i] === null || trSma[i] === null || bb.mid[i] === null) continue;
    const kcU = bb.mid[i] + 1.5 * trSma[i];
    const kcL = bb.mid[i] - 1.5 * trSma[i];
    on[i] = bb.upper[i] < kcU && bb.lower[i] > kcL;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 19; j <= i; j++) {
      hh = Math.max(hh, ohlc ? candles[j].h : candles[j].c);
      ll = Math.min(ll, ohlc ? candles[j].l : candles[j].c);
    }
    detrended[i] = cl[i] - ((hh + ll) / 2 + (bb.mid[i] ?? cl[i])) / 2;
  }
  for (let i = 0; i < n; i++) {
    if (detrended[i] === null) continue;
    let ok = true;
    for (let j = i - 19; j <= i; j++) if (j < 0 || detrended[j] === null) { ok = false; break; }
    if (ok) momentum[i] = linregEndpoint(detrended, 20, i);
  }
  return { on, momentum };
}

// --- Chaikin Money Flow (20) — requires real H/L/V (crypto + gold hourly only) --
function cmf(candles, period) {
  const out = nullPad(candles.length);
  for (let i = period - 1; i < candles.length; i++) {
    let mfv = 0, vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const { h, l, c, v } = candles[j];
      if (h !== l) mfv += (((c - l) - (h - c)) / (h - l)) * v;
      vol += v;
    }
    out[i] = vol > 0 ? mfv / vol : 0;
  }
  return out;
}

// --- Rolling VWAP deviation z-score (window 48 = two days of hourly bars) -------
// vwap_i = Σ(tp·v)/Σv over the window, tp = (h+l+c)/3
// z_i    = (close - vwap) / stdev(close - vwap over the window)
// Requires real volume; not computed for close-only series.
function vwapDeviation(candles, window) {
  const n = candles.length;
  const out = { vwap: nullPad(n), z: nullPad(n) };
  for (let i = window - 1; i < n; i++) {
    let pv = 0, vol = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const tp = (candles[j].h + candles[j].l + candles[j].c) / 3;
      pv += tp * candles[j].v; vol += candles[j].v;
    }
    if (vol <= 0) continue;
    const vw = pv / vol;
    let s = 0, s2 = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const d = candles[j].c - vw; s += d; s2 += d * d;
    }
    const mean = s / window;
    const sd = Math.sqrt(Math.max(s2 / window - mean * mean, 0));
    out.vwap[i] = vw;
    out.z[i] = sd > 0 ? (candles[i].c - vw) / sd : 0;
  }
  return out;
}

// --- Structural levels ----------------------------------------------------------
// Swing points via symmetric fractals: a bar whose value is the strict maximum
// (or minimum) of its 2k+1 neighborhood. [C2C] close-only series use closes;
// OHLC series use true highs/lows.
function swingPoints(candles, k, ohlc) {
  const highsArr = candles.map((c) => (ohlc ? c.h : c.c));
  const lowsArr = candles.map((c) => (ohlc ? c.l : c.c));
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (highsArr[j] >= highsArr[i]) isHigh = false;
      if (lowsArr[j] <= lowsArr[i]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ i, price: highsArr[i], t: candles[i].t });
    if (isLow) lows.push({ i, price: lowsArr[i], t: candles[i].t });
  }
  return { highs, lows };
}

// Cluster swing points that sit within `tol` (absolute price) of each other
// into zones; a zone's strength = number of touches, price = touch average.
function clusterZones(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const zones = [];
  for (const p of sorted) {
    const z = zones[zones.length - 1];
    if (z && p.price - z.max <= tol) {
      z.sum += p.price; z.n += 1; z.max = Math.max(z.max, p.price);
      z.lastT = Math.max(z.lastT, p.t);
    } else {
      zones.push({ sum: p.price, n: 1, max: p.price, lastT: p.t });
    }
  }
  return zones.map((z) => ({ price: z.sum / z.n, touches: z.n, lastT: z.lastT }));
}

// Fibonacci retracement of the dominant swing over the lookback window.
function fibLevels(candles, lookback, ohlc) {
  const n = candles.length;
  if (n < lookback) return null;
  let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
  for (let i = n - lookback; i < n; i++) {
    const h = ohlc ? candles[i].h : candles[i].c;
    const l = ohlc ? candles[i].l : candles[i].c;
    if (h > hi) { hi = h; hiI = i; }
    if (l < lo) { lo = l; loI = i; }
  }
  if (!(hi > lo)) return null;
  const up = loI < hiI; // dominant move direction inside the window
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = ratios.map((r) => ({
    ratio: r,
    price: up ? hi - (hi - lo) * r : lo + (hi - lo) * r,
  }));
  return { high: hi, low: lo, direction: up ? 'up' : 'down', levels };
}

// Classic floor-trader pivots from the previous completed UTC day.
// Only meaningful with real intraday OHLC — returns null for close-only series.
function pivotPoints(candles, ohlc) {
  if (!ohlc || candles.length < 48) return null;
  const dayOf = (t) => Math.floor(t / 864e5);
  const lastDay = dayOf(candles[candles.length - 1].t);
  let h = -Infinity, l = Infinity, c = null, seen = false;
  for (const cd of candles) {
    if (dayOf(cd.t) === lastDay - 1) {
      seen = true;
      h = Math.max(h, cd.h); l = Math.min(l, cd.l); c = cd.c;
    }
  }
  if (!seen || c === null) return null;
  const p = (h + l + c) / 3;
  return {
    p,
    r1: 2 * p - l, s1: 2 * p - h,
    r2: p + (h - l), s2: p - (h - l),
  };
}

// --- Trend duration (persistence) -----------------------------------------
// Purely descriptive: for how long has a two-sided state held, and how much
// has price moved while it held. No forecast, no implication about what
// happens next — a duration is not a signal.
// Built from EMA(close) only, so — unlike ATR/ADX/squeeze — it needs NO
// close-to-close adaptation and is directly comparable across every asset
// class and timeframe (crypto/gold hourly, forex/silver daily alike).
//
// Walks a per-bar "side" array (+1/-1/null) backward from the tip to find how
// many consecutive bars have shared the tip's side. If the streak runs all
// the way to the first bar where `side` is defined, the true start is
// unknown (it may have begun before the loaded history) — that case is
// marked `censored: true` so the caller reports "at least N", never a false
// exact count.
function streakFromSide(side, cl) {
  const n = side.length;
  const tipSide = side[n - 1];
  if (tipSide === null || tipSide === undefined) return null;
  const firstValid = side.findIndex((s) => s !== null);
  if (firstValid === -1) return null;
  let startIdx = n - 1;
  for (let i = n - 2; i >= firstValid; i--) {
    if (side[i] !== tipSide) break;
    startIdx = i;
  }
  const bars = (n - 1) - startIdx;
  const startPrice = cl[startIdx];
  const changePct = startPrice !== 0 ? ((cl[n - 1] - startPrice) / startPrice) * 100 : 0;
  return { bars, changePct, censored: startIdx === firstValid, dir: tipSide > 0 ? 'up' : 'down' };
}

function trendDurations(cl) {
  const e50 = ema(cl, 50);
  const e200 = ema(cl, 200);
  const sideVsEma50 = cl.map((c, i) => (e50[i] === null ? null : Math.sign(c - e50[i]) || null));
  const sideEma50Vs200 = e50.map((v, i) => (v === null || e200[i] === null ? null : Math.sign(v - e200[i]) || null));
  return {
    priceVsEma50: streakFromSide(sideVsEma50, cl),
    ema50VsEma200: streakFromSide(sideEma50Vs200, cl),
  };
}
