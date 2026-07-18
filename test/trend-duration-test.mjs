// Deterministic verification of trendDurations() (dev-only): hand-crafted
// arrays with manually walked-through expected results, a left-censored case,
// a brand-new-flip edge case, an all-null (NA) case, and a real-fixture sanity
// check with independent brute-force recomputation.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const sb = { console, Math, JSON, Object, Array, Number, String, Date, Infinity, NaN };
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('src/indicators.js', root), 'utf8'), sb);
const streakFromSide = vm.runInContext('streakFromSide', sb);
const trendDurations = vm.runInContext('trendDurations', sb);
const ema = vm.runInContext('ema', sb);

let failures = 0;
const ck = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!c) failures++; };

// 1. hand-walked streak: side flips from + to - three bars before the tip
{
  const side = [1, 1, 1, -1, -1, -1, -1];
  const cl = [10, 11, 12, 9, 8, 8.5, 7];
  const r = streakFromSide(side, cl);
  ck('basic streak: bars/change/dir/censored', r.bars === 3 && Math.abs(r.changePct - (-22.222222222222225)) < 1e-9 && r.dir === 'down' && r.censored === false,
    JSON.stringify(r));
}
// 2. left-censored: state constant across the whole visible window
{
  const side = [1, 1, 1, 1];
  const cl = [10, 11, 12, 13];
  const r = streakFromSide(side, cl);
  ck('left-censored (state never flips in window) -> censored=true', r.bars === 3 && r.censored === true, JSON.stringify(r));
}
// 3. flip happens exactly at the tip -> 0 bars elapsed, 0% change
{
  const side = [1, -1];
  const cl = [10, 9];
  const r = streakFromSide(side, cl);
  ck('flip at the tip -> bars=0, change=0%', r.bars === 0 && r.changePct === 0 && r.dir === 'down' && r.censored === false, JSON.stringify(r));
}
// 4. all-null -> NA
{
  const r = streakFromSide([null, null, null], [1, 2, 3]);
  ck('all-null side -> null (NA)', r === null);
}
// 5. determinism: same input twice -> identical output
{
  const side = [1, 1, -1, -1, 1];
  const cl = [1, 2, 3, 2, 5];
  const a = streakFromSide(side, cl), b = streakFromSide(side, cl);
  ck('determinism', JSON.stringify(a) === JSON.stringify(b));
}

// 6. real-fixture sanity: brute-force independent recomputation against the
// live BTC fixture, cross-checked against trendDurations()'s own ema() calls.
{
  const fixture = JSON.parse(readFileSync(new URL('test/fixture-btc-1h.json', root), 'utf8'));
  const cl = fixture.map((k) => +k[4]);
  const td = trendDurations(cl);

  // brute-force reference for priceVsEma50, built independently (no shared
  // helper with streakFromSide/trendDurations beyond the ema() primitive).
  const e50 = ema(cl, 50);
  const n = cl.length;
  const tipSign = Math.sign(cl[n - 1] - e50[n - 1]);
  let i = n - 1;
  while (i > 0 && e50[i - 1] !== null && Math.sign(cl[i - 1] - e50[i - 1]) === tipSign) i--;
  const expectBars = (n - 1) - i;
  const expectPct = ((cl[n - 1] - cl[i]) / cl[i]) * 100;
  ck('real-fixture priceVsEma50 matches brute-force reference',
    td.priceVsEma50.bars === expectBars && Math.abs(td.priceVsEma50.changePct - expectPct) < 1e-9,
    `mine=${JSON.stringify(td.priceVsEma50)} ref bars=${expectBars} pct=${expectPct.toFixed(4)}`);

  // EMA200 needs deeper history than this 500-candle hourly fixture guarantees
  // to be non-null at every bar; just assert the shape is sane either way.
  ck('real-fixture ema50VsEma200 is either a valid streak or explicit NA',
    td.ema50VsEma200 === null || (Number.isFinite(td.ema50VsEma200.bars) && td.ema50VsEma200.bars >= 0),
    JSON.stringify(td.ema50VsEma200));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall trend-duration checks passed');
process.exit(failures ? 1 : 0);
