// Report-engine verification (dev-only): builds reports across engineered
// market states in both languages and checks (1) no directive/advice language,
// (2) determinism, (3) caveat narration coverage, (4) real phrasing variation
// between states, (5) NA/redistribution narration.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const code = ['src/seeds.js', 'src/i18n.js', 'src/indicators.js', 'src/analysis.js', 'src/report.js']
  .map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n;\n');
const sb = { console, Math, JSON, Object, Array, Number, String, Date, Infinity, NaN };
vm.createContext(sb);
vm.runInContext(code, sb);
const g = (name) => vm.runInContext(name, sb);
const runAnalysis = g('runAnalysis'), buildReport = g('buildReport'), findInstrument0 = null;
const SEEDS = g('SEEDS');

const fixture = JSON.parse(readFileSync(new URL('test/fixture-btc-1h.json', root), 'utf8'));
const btc = fixture.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// instrument defs (mirroring the registry shapes the UI passes in)
const INST = {
  BTC: { id: 'BTCUSD', labelAr: 'بيتكوين (BTC/USD)', labelEn: 'Bitcoin (BTC/USD)', decimals: 2, source: 'binance' },
  GOLD: { id: 'GOLD', labelAr: 'الذهب (XAU/USD)', labelEn: 'Gold (XAU/USD)', decimals: 2, source: 'binance+goldapi' },
  SILVER: { id: 'SILVER', labelAr: 'الفضة (XAG/USD)', labelEn: 'Silver (XAG/USD)', decimals: 3, source: 'seed+goldapi' },
  GBPJPY: { id: 'GBPJPY', labelAr: 'استرليني/ين GBP/JPY', labelEn: 'GBP/JPY', decimals: 2, source: 'frankfurter' },
};
const daily = (points) => points.map((p) => ({ t: Date.parse(p.date + 'T00:00:00Z'), o: p.close, h: p.close, l: p.close, c: p.close, v: 0 }));

// ---- engineered states -------------------------------------------------------
const states = {};
// 1. real BTC (currently bearish), sentiment included
states.btcBear = {
  inst: INST.BTC,
  series: { candles: btc, meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } },
  heads: [{ title: 'Bitcoin plunges as panic selloff deepens' }, { title: 'Crypto fear grows after crash' }],
};
// 2. mirrored BTC -> bullish state (price flipped around its mean; volume kept)
const mean = btc.reduce((s, c) => s + c.c, 0) / btc.length;
const flip = (x) => 2 * mean - x;
states.btcBull = {
  inst: INST.BTC,
  series: {
    candles: btc.map((c) => ({ t: c.t, o: flip(c.o), h: flip(c.l), l: flip(c.h), c: flip(c.c), v: c.v })),
    meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true },
  },
  heads: [{ title: 'Bitcoin surges to record high, inflows soar' }],
};
// 3. NA-heavy: 40 candles only -> EMA200/t3 unavailable, weights redistributed
states.naHeavy = {
  inst: INST.BTC,
  series: { candles: btc.slice(0, 40), meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } },
  heads: [],
};
// 4. silver seed history (close-only, volume NA, c2c variants)
states.silver = {
  inst: INST.SILVER,
  series: { candles: daily(SEEDS.metals.XAG), meta: { id: 'SILVER', timeframe: '1d', ohlc: false, hasVolume: false, live: true } },
  heads: [],
};
// 5. gold on fallback (live=false) -> PAXG + fallback caveats together
states.goldFallback = {
  inst: INST.GOLD,
  series: { candles: btc, meta: { id: 'GOLD', timeframe: '1h', ohlc: true, hasVolume: true, live: false } },
  heads: [],
};
// 6. forex daily closes (GBP/JPY from seeds)
states.forex = {
  inst: INST.GBPJPY,
  series: { candles: daily(SEEDS.forex.GBPJPY), meta: { id: 'GBPJPY', timeframe: '1d', ohlc: false, hasVolume: false, live: true } },
  heads: [],
};
// 7. squeeze-on: synthetic trend then 45 bars of near-flat consolidation
{
  const cands = [];
  let p = 100;
  for (let i = 0; i < 260; i++) {
    p += Math.sin(i / 15) * 0.8 + 0.15; // deterministic wavy drift
    const h = p + 0.6, l = p - 0.6;
    cands.push({ t: i * 36e5, o: p, h, l, c: p + Math.sin(i / 7) * 0.3, v: 1000 + (i % 50) });
  }
  const last = cands[cands.length - 1].c;
  for (let i = 0; i < 45; i++) { // tight coil: range collapses
    const j = 260 + i;
    const c = last + Math.sin(i / 3) * 0.05;
    cands.push({ t: j * 36e5, o: c, h: c + 0.08, l: c - 0.08, c, v: 900 });
  }
  states.squeezeOn = {
    inst: INST.BTC,
    series: { candles: cands, meta: { id: 'BTCUSD', timeframe: '1h', ohlc: true, hasVolume: true, live: true } },
    heads: [],
  };
}

// ---- build all reports ---------------------------------------------------------
const reports = {};
for (const [key, st] of Object.entries(states)) {
  const a = runAnalysis(st.series, st.heads);
  reports[key] = {};
  for (const lang of ['ar', 'en']) {
    reports[key][lang] = buildReport(a, st.series, st.inst, lang);
  }
  reports[key].analysis = a;
}

// sanity: squeeze fixture actually has squeeze ON at the tip
check('squeeze fixture is squeeze-on', reports.squeezeOn.analysis.indicators.find((i) => i.id === 'squeeze').value.on === true);
check('naHeavy fixture redistributed', reports.naHeavy.analysis.weightsUsed.t3 === 0,
  JSON.stringify(reports.naHeavy.analysis.weightsUsed));

// ---- 1. banned directive language, all states x both languages ------------------
const bannedAr = ['اشترِ', 'ينبغي الشراء', 'ننصح', 'يُنصح', 'توصيتنا', 'وقف الخسارة', 'جني الأرباح', 'إشارة شراء', 'إشارة بيع', 'ادخل الصفقة', 'اخرج من الصفقة', 'هدف سعري'];
const bannedEnRe = /\b(buy|sell(?!off)|should (?:buy|sell|enter|exit)|recommend\w*|advis\w*|take.?profit|stop.?loss|price target|go long|go short|entry point|exit point|signal)\b/i;
for (const [key, r] of Object.entries(reports)) {
  const arText = r.ar.paragraphs.join(' ');
  const enText = r.en.paragraphs.join(' ');
  const arHit = bannedAr.find((b) => arText.includes(b));
  const enHit = enText.match(bannedEnRe);
  check(`no directive language [${key}]`, !arHit && !enHit, arHit || (enHit && enHit[0]) || 'clean');
}

// ---- 2. determinism ---------------------------------------------------------------
{
  const st = states.btcBear;
  const a1 = runAnalysis(st.series, st.heads), a2 = runAnalysis(st.series, st.heads);
  const r1 = buildReport(a1, st.series, st.inst, 'ar'), r2 = buildReport(a2, st.series, st.inst, 'ar');
  check('report determinism', JSON.stringify(r1) === JSON.stringify(r2));
}

// ---- 3. caveat narration coverage ---------------------------------------------------
check('gold report narrates PAXG proxy', reports.goldFallback.ar.paragraphs.join(' ').includes('PAXG')
  && reports.goldFallback.en.paragraphs.join(' ').includes('PAXG'));
check('gold report narrates fallback mode', reports.goldFallback.ar.paragraphs.join(' ').includes('آخر')
  && /last known|unreachable/.test(reports.goldFallback.en.paragraphs.join(' ')));
check('silver report narrates seed history', reports.silver.ar.paragraphs.join(' ').includes('مضمّنة')
  && /embedded/.test(reports.silver.en.paragraphs.join(' ')));
check('silver report narrates c2c adaptation', /إغلاقٍ إلى إغلاق/.test(reports.silver.ar.paragraphs.join(' '))
  && /close-to-close/.test(reports.silver.en.paragraphs.join(' ')));
check('forex report narrates ECB daily closes', reports.forex.ar.paragraphs.join(' ').includes('المركزي الأوروبي')
  && /ECB reference rates/.test(reports.forex.en.paragraphs.join(' ')));
check('NA-heavy report narrates redistribution with %', /40٪|40%/.test(reports.naHeavy.ar.paragraphs.join(' '))
  && /40%/.test(reports.naHeavy.en.paragraphs.join(' ')));
check('NA-heavy report enumerates NA indicators', reports.naHeavy.ar.paragraphs.join(' ').includes('غير متاحة لهذه الأداة')
  && /unavailable for this instrument/i.test(reports.naHeavy.en.paragraphs.join(' ')));
check('no-news state narrated', reports.silver.ar.paragraphs.join(' ').includes('فنية بحتة')
  && /purely technical/.test(reports.silver.en.paragraphs.join(' ')));
check('with-news state narrated with count', /الـ2/.test(reports.btcBear.ar.paragraphs.join(' '))
  && /the 2 examined headlines/.test(reports.btcBear.en.paragraphs.join(' ')));

// ---- 4. phrasing varies by state, not just numbers -----------------------------------
const openBear = reports.btcBear.en.paragraphs[0], openBull = reports.btcBull.en.paragraphs[0];
check('bull vs bear openings differ in wording', /bearish skew/.test(openBear) && /bullish skew/.test(openBull));
check('squeeze-on visibly reshapes tier-2 prose',
  /coiling in a narrow range/.test(reports.squeezeOn.en.paragraphs.join(' '))
  && !/coiling in a narrow range/.test(reports.btcBear.en.paragraphs.join(' '))
  && /يتجمّع في نطاق ضيق/.test(reports.squeezeOn.ar.paragraphs.join(' ')));
const t3Texts = ['btcBear', 'silver', 'forex'].map((k) => reports[k].en.paragraphs.find((p) => p.includes('composite')));
check('tier-3 narrative differs per asset class', new Set(t3Texts).size === 3);

// closing disclaimer present everywhere
check('closing disclaimer in every report', Object.entries(reports).every(([k, r]) =>
  r.ar.paragraphs.at(-1).includes('نصيحة استثمارية') && /not investment advice/.test(r.en.paragraphs.at(-1))));

// ---- sample output for human review ----------------------------------------------------
console.log('\n--- sample: BTC bearish (ar) ---');
for (const p of reports.btcBear.ar.paragraphs) console.log('•', p);
console.log('\n--- sample: silver NA-rich (en) ---');
for (const p of reports.silver.en.paragraphs) console.log('•', p);

console.log(failures ? `\n${failures} FAILURES` : '\nall report checks passed');
process.exit(failures ? 1 : 0);
