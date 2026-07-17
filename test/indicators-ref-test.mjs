// Reference verification for src/indicators.js + src/analysis.js (dev-only).
// Part 1: compare against the `technicalindicators` npm package (Tier 1 set).
// Part 2: dump my values to JSON for the pandas-ta comparison (ref-python.py).
// Part 3: hand-stepped independent references (Laguerre RSI, VWAP deviation).
// Part 4: determinism + insufficient-data + performance checks.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Haayy/AppData/Local/Temp/claude/C--inetpub-wwwroot-projects-hayyaak-trading/c8f80e16-4b16-4295-b0b6-5a3376086017/scratchpad/package.json');
const TI = require('technicalindicators');

const root = new URL('..', import.meta.url);
const code = ['src/seeds.js', 'src/indicators.js', 'src/analysis.js']
  .map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n;\n');
const sb = { console, Math, JSON, Object, Array, Number, String, Date, Infinity, NaN, performance: undefined };
vm.createContext(sb);
vm.runInContext(code, sb);

const fixture = JSON.parse(readFileSync(new URL('test/fixture-btc-1h.json', root), 'utf8'));
const candles = fixture.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
const cl = candles.map((c) => c.c);
const highs = candles.map((c) => c.h), lows = candles.map((c) => c.l);

let failures = 0;
function cmpSeries(name, mine, ref, tol, offset = 0) {
  // compare the aligned tails; `offset` shifts ref to line up warmups
  const m = mine.filter((x) => x !== null);
  const r = ref.slice(offset);
  const n = Math.min(m.length, r.length);
  let maxDiff = 0, count = 0;
  for (let i = 1; i <= n; i++) {
    const a = m[m.length - i], b = r[r.length - i];
    if (typeof b !== 'number' || Number.isNaN(b)) continue;
    maxDiff = Math.max(maxDiff, Math.abs(a - b));
    count++;
  }
  const pass = count >= Math.min(n, 100) * 0.9 && maxDiff <= tol;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  — ${count} pts compared, maxDiff=${maxDiff.toExponential(2)} (tol ${tol})`);
  if (!pass) failures++;
  return maxDiff;
}

// ---- Part 1: technicalindicators references ---------------------------------
console.log('--- vs technicalindicators (npm) ---');
cmpSeries('EMA(50)', sb.ema(cl, 50), TI.EMA.calculate({ period: 50, values: cl }), 1e-6);
cmpSeries('EMA(200)', sb.ema(cl, 200), TI.EMA.calculate({ period: 200, values: cl }), 1e-6);
cmpSeries('RSI(14)', sb.rsi(cl, 14), TI.RSI.calculate({ period: 14, values: cl }), 0.011); // TI rounds internally to 2dp
const tiMacd = TI.MACD.calculate({ values: cl, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
const myMacd = sb.macd(cl, 12, 26, 9);
cmpSeries('MACD line', myMacd.line, tiMacd.map((x) => x.MACD).filter((x) => x !== undefined), 1e-6);
cmpSeries('MACD ref line', myMacd.ref, tiMacd.map((x) => x.signal).filter((x) => x !== undefined), 1e-6);
const tiBB = TI.BollingerBands.calculate({ period: 20, stdDev: 2, values: cl });
const myBB = sb.bollinger(cl, 20, 2);
cmpSeries('BB upper', myBB.upper, tiBB.map((x) => x.upper), 1e-6);
cmpSeries('BB lower', myBB.lower, tiBB.map((x) => x.lower), 1e-6);
const tiATR = TI.ATR.calculate({ period: 14, high: highs, low: lows, close: cl });
cmpSeries('ATR(14) ohlc', sb.atr(candles, 14, true), tiATR, 1e-6);
const tiADX = TI.ADX.calculate({ period: 14, high: highs, low: lows, close: cl });
const myADX = sb.adx(candles, 14, true);
cmpSeries('ADX(14)', myADX.adx, tiADX.map((x) => x.adx), 0.35); // seeding conventions differ; see report
cmpSeries('+DI(14)', myADX.plusDi, tiADX.map((x) => x.pdi), 0.05);
cmpSeries('-DI(14)', myADX.minusDi, tiADX.map((x) => x.mdi), 0.05);

// ---- Part 2: dump for pandas-ta ----------------------------------------------
const dump = {
  candles: candles.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]),
  ema50: sb.ema(cl, 50), rsi14: sb.rsi(cl, 14),
  macdLine: myMacd.line, bbUpper: myBB.upper, bbLower: myBB.lower,
  atr14: sb.atr(candles, 14, true),
  adx14: myADX.adx,
  kama: sb.kama(cl, 10, 2, 30),
  cmf20: sb.cmf(candles, 20),
  squeezeOn: sb.squeeze(candles, true).on,
};
writeFileSync(new URL('test/mine.json', root), JSON.stringify(dump));
console.log('wrote test/mine.json for pandas-ta comparison');

// ---- Part 3: hand-stepped references ------------------------------------------
console.log('--- hand-stepped references ---');
// Laguerre RSI: independent literal transcription of Ehlers's recursion,
// written stepwise (no shared code with src/indicators.js).
function laguerreHand(values, gamma) {
  let L0 = values[0], L1 = values[0], L2 = values[0], L3 = values[0];
  const res = [];
  for (const p of values) {
    const L0p = L0, L1p = L1, L2p = L2, L3p = L3;
    L0 = (1 - gamma) * p + gamma * L0p;
    L1 = -gamma * L0 + L0p + gamma * L1p;
    L2 = -gamma * L1 + L1p + gamma * L2p;
    L3 = -gamma * L2 + L2p + gamma * L3p;
    let CU = 0, CD = 0;
    if (L0 >= L1) CU = L0 - L1; else CD = L1 - L0;
    if (L1 >= L2) CU += L1 - L2; else CD += L2 - L1;
    if (L2 >= L3) CU += L2 - L3; else CD += L3 - L2;
    res.push(CU + CD !== 0 ? CU / (CU + CD) : 0.5);
  }
  return res;
}
{
  const mine = sb.laguerreRsi(cl, 0.5).filter((x) => x !== null);
  const ref = laguerreHand(cl, 0.5).slice(20);
  let maxDiff = 0;
  for (let i = 0; i < mine.length; i++) maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i]));
  const inRange = mine.every((x) => x >= 0 && x <= 1);
  const pass = maxDiff < 1e-12 && inRange;
  console.log(`${pass ? 'PASS' : 'FAIL'}  Laguerre RSI vs hand-stepped recursion — maxDiff=${maxDiff.toExponential(2)}, all in [0,1]=${inRange}`);
  if (!pass) failures++;
}
// VWAP deviation: brute-force recomputation with independent arithmetic.
{
  const vd = sb.vwapDeviation(candles, 48);
  const i = candles.length - 1;
  let pv = 0, vol = 0;
  for (let j = i - 47; j <= i; j++) {
    pv += ((candles[j].h + candles[j].l + candles[j].c) / 3) * candles[j].v;
    vol += candles[j].v;
  }
  const vw = pv / vol;
  const devs = [];
  for (let j = i - 47; j <= i; j++) devs.push(candles[j].c - vw);
  const mean = devs.reduce((s, x) => s + x, 0) / devs.length;
  const sd = Math.sqrt(devs.reduce((s, x) => s + (x - mean) ** 2, 0) / devs.length);
  const zRef = (candles[i].c - vw) / sd;
  const pass = Math.abs(vd.vwap[i] - vw) < 1e-9 && Math.abs(vd.z[i] - zRef) < 1e-9;
  console.log(`${pass ? 'PASS' : 'FAIL'}  VWAP deviation vs independent arithmetic — vwap=${vw.toFixed(2)}, z=${zRef.toFixed(3)}`);
  if (!pass) failures++;
}

// ---- Part 4: determinism, insufficient-data, performance ----------------------
console.log('--- behavioral checks ---');
const series = { candles, meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true } };
const heads = [{ title: 'Bitcoin surges to record high as inflows soar' }, { title: 'Analysts warn of crash risk after rally' }];
const r1 = sb.runAnalysis(series, heads);
const r2 = sb.runAnalysis(series, heads);
const strip = (r) => JSON.stringify({ ...r, elapsedMs: 0 });
{
  const pass = strip(r1) === strip(r2);
  console.log(`${pass ? 'PASS' : 'FAIL'}  determinism — two runs on identical input are byte-identical (excl. elapsedMs)`);
  if (!pass) failures++;
}
{
  const short = { candles: candles.slice(0, 30), meta: series.meta };
  const r = sb.runAnalysis(short, []);
  const emaNa = r.indicators.find((i) => i.id === 'emaCross').state === 'na';
  const listed = r.insufficient.includes('emaCross');
  const noFake = r.tiers.t1.members.every((m) => m.reading === null || Number.isFinite(m.reading));
  const pass = emaNa && listed && noFake && r.weightsUsed.t1 !== undefined;
  console.log(`${pass ? 'PASS' : 'FAIL'}  insufficient data — 30 candles: emaCross na=${emaNa}, listed=${listed}, weightsUsed=${JSON.stringify(r.weightsUsed)}`);
  if (!pass) failures++;
}
{
  // close-only series must not produce volume readings and must use C2C ATR
  const SEEDS = vm.runInContext('SEEDS', sb); // const doesn't land on the vm global
  const daily = { candles: SEEDS.metals.XAG.map((p) => ({ t: Date.parse(p.date), o: p.close, h: p.close, l: p.close, c: p.close, v: 0 })), meta: { id: 'SILVER', timeframe: '1d', ohlc: false, hasVolume: false } };
  const r = sb.runAnalysis(daily, []);
  const noVol = r.indicators.find((i) => i.id === 'cmf').state === 'na';
  const hasAtr = r.levels.atrRange !== null && r.levels.atrRange.atr > 0;
  const noPivots = r.levels.pivots === null;
  const pass = noVol && hasAtr && noPivots && r.ok;
  console.log(`${pass ? 'PASS' : 'FAIL'}  close-only series — volume na=${noVol}, C2C ATR=${hasAtr && r.levels.atrRange.atr.toFixed(3)}, pivots suppressed=${noPivots}, composite=${r.compositeTechnical?.toFixed(3)}`);
  if (!pass) failures++;
}
{
  const N = 200;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) sb.runAnalysis(series, heads);
  const per = (Date.now() - t0) / N;
  console.log(`INFO  performance — full runAnalysis (500 candles, all tiers): ${per.toFixed(2)} ms/run`);
}
{
  const s = sb.scoreSentiment(heads);
  console.log(`INFO  sentiment sample — ${JSON.stringify(s.perHeadline)} avg=${s.score.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
process.exit(failures ? 1 : 0);
