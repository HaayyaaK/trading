// Verification against the FINAL inlined index.html (dev-only).
// Extracts the inline <script> blocks from the deliverable itself (not the
// src/ files) and re-runs: the §0 banned-language matrix (7 states x 2
// languages), analysis + report determinism, and placeholder/no-dead-code
// sweeps — so what is checked is exactly what ships.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// ---- structure of the deliverable ------------------------------------------
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('7 inline script blocks', inline.length === 7, `${inline.length}`);
check('no src/ references', !/(?:src|href)="src\//.test(html));
check('no TODO/placeholder/stub markers', !/TODO|FIXME|placeholder|not implemented|stub\b/i.test(html));
// one external script: the local ECharts vendor build (FontAwesome is a <link>)
check('single external script (local ECharts)', (html.match(/<script src=/g) || []).length === 1);
check('vendor libs are local (assets/), not CDN', /src="assets\/echarts/.test(html) && /href="assets\/fontawesome/.test(html) && !/cdn\.jsdelivr|unpkg/.test(html));

// ---- run the deliverable's own code in a vm ---------------------------------
const sb = { console, Math, JSON, Object, Array, Number, String, Date, Infinity, NaN };
vm.createContext(sb);
vm.runInContext(inline.join('\n;\n').replace(/document\.addEventListener\('DOMContentLoaded', initUi\);/, ''), sb, { filename: 'inlined-index' });
const g = (n) => vm.runInContext(n, sb);
const runAnalysis = g('runAnalysis'), buildReport = g('buildReport'), SEEDS = g('SEEDS');

const fixture = JSON.parse(readFileSync(new URL('test/fixture-btc-1h.json', root), 'utf8'));
const btc = fixture.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
const daily = (pts) => pts.map((p) => ({ t: Date.parse(p.date + 'T00:00:00Z'), o: p.close, h: p.close, l: p.close, c: p.close, v: 0 }));
const mean = btc.reduce((s, c) => s + c.c, 0) / btc.length;
const flip = (x) => 2 * mean - x;

const INST = {
  BTC: { id: 'BTCUSD', labelAr: 'بيتكوين (BTC/USD)', labelEn: 'Bitcoin (BTC/USD)', decimals: 2, source: 'binance' },
  GOLD: { id: 'GOLD', labelAr: 'الذهب (XAU/USD)', labelEn: 'Gold (XAU/USD)', decimals: 2, source: 'binance+goldapi' },
  SILVER: { id: 'SILVER', labelAr: 'الفضة (XAG/USD)', labelEn: 'Silver (XAG/USD)', decimals: 3, source: 'seed+goldapi' },
  GBPJPY: { id: 'GBPJPY', labelAr: 'استرليني/ين GBP/JPY', labelEn: 'GBP/JPY', decimals: 2, source: 'frankfurter' },
};
const squeezeCandles = (() => {
  const cands = []; let p = 100;
  for (let i = 0; i < 260; i++) { p += Math.sin(i / 15) * 0.8 + 0.15; cands.push({ t: i * 36e5, o: p, h: p + 0.6, l: p - 0.6, c: p + Math.sin(i / 7) * 0.3, v: 1000 + (i % 50) }); }
  const last = cands[cands.length - 1].c;
  for (let i = 0; i < 45; i++) { const c = last + Math.sin(i / 3) * 0.05; cands.push({ t: (260 + i) * 36e5, o: c, h: c + 0.08, l: c - 0.08, c, v: 900 }); }
  return cands;
})();

const states = {
  btcBear: { inst: INST.BTC, series: { candles: btc, meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } }, heads: [{ title: 'Bitcoin plunges as panic selloff deepens' }] },
  btcBull: { inst: INST.BTC, series: { candles: btc.map((c) => ({ t: c.t, o: flip(c.o), h: flip(c.l), l: flip(c.h), c: flip(c.c), v: c.v })), meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } }, heads: [{ title: 'Bitcoin surges to record high, inflows soar' }] },
  naHeavy: { inst: INST.BTC, series: { candles: btc.slice(0, 40), meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } }, heads: [] },
  silver: { inst: INST.SILVER, series: { candles: daily(SEEDS.metals.XAG), meta: { id: 'SILVER', timeframe: '1d', ohlc: false, hasVolume: false, live: true } }, heads: [] },
  goldFallback: { inst: INST.GOLD, series: { candles: btc, meta: { id: 'GOLD', timeframe: '1h', ohlc: true, hasVolume: true, live: false } }, heads: [] },
  forex: { inst: INST.GBPJPY, series: { candles: daily(SEEDS.forex.GBPJPY), meta: { id: 'GBPJPY', timeframe: '1d', ohlc: false, hasVolume: false, live: true } }, heads: [] },
  squeezeOn: { inst: INST.BTC, series: { candles: squeezeCandles, meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } }, heads: [] },
};

const bannedAr = ['اشترِ', 'ينبغي الشراء', 'ننصح', 'يُنصح', 'توصيتنا', 'وقف الخسارة', 'جني الأرباح', 'إشارة شراء', 'إشارة بيع', 'ادخل الصفقة', 'اخرج من الصفقة', 'هدف سعري'];
const bannedEnRe = /\b(buy|sell(?!off)|should (?:buy|sell|enter|exit)|recommend\w*|advis\w*|take.?profit|stop.?loss|price target|go long|go short|entry point|exit point|signal)\b/i;

for (const [key, st] of Object.entries(states)) {
  const a = runAnalysis(st.series, st.heads);
  const ar = buildReport(a, st.series, st.inst, 'ar').paragraphs.join(' ');
  const en = buildReport(a, st.series, st.inst, 'en').paragraphs.join(' ');
  const arHit = bannedAr.find((b) => ar.includes(b));
  const enHit = en.match(bannedEnRe);
  check(`final-file banned-language [${key}]`, !arHit && !enHit, arHit || (enHit && enHit[0]) || 'clean');
}

// determinism on the inlined code specifically
{
  const st = states.btcBear;
  const strip = (r) => JSON.stringify({ ...r, elapsedMs: 0 });
  const a1 = runAnalysis(st.series, st.heads), a2 = runAnalysis(st.series, st.heads);
  check('final-file analysis determinism', strip(a1) === strip(a2));
  const r1 = buildReport(a1, st.series, st.inst, 'ar'), r2 = buildReport(a2, st.series, st.inst, 'ar');
  check('final-file report determinism', JSON.stringify(r1) === JSON.stringify(r2));
}

console.log(failures ? `\n${failures} FAILURES` : '\nall final-file checks passed');
process.exit(failures ? 1 : 0);
