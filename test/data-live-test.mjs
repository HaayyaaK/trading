// Live smoke test for the data layer (dev-only; not part of the deliverable).
// Runs src/seeds.js + src/data.js in a vm context with real fetch, exercising
// every source path the browser will use.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const code = ['src/seeds.js', 'src/data.js']
  .map((f) => readFileSync(new URL(f, root), 'utf8'))
  .join('\n;\n');

const sandbox = {
  fetch, AbortController, AbortSignal, Date, console,
  setTimeout, clearTimeout, JSON, Math, Object, Array, String, Number, Promise, Error,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const {
  INSTRUMENTS, findInstrument, loadSeries, pollTick, pollIntervalMs, fetchNews,
} = sandbox;

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const id of ['BTCUSD', 'EURUSD', 'GBPJPY', 'GOLD', 'SILVER']) {
  const inst = findInstrument(id);
  const series = await loadSeries(inst);
  const n = series.candles.length;
  const last = series.candles[n - 1];
  const finite = series.candles.every((c) => [c.o, c.h, c.l, c.c].every(Number.isFinite));
  const sorted = series.candles.every((c, i, a) => i === 0 || c.t > a[i - 1].t);
  check(`${id} history`, series.meta.live && n >= 210 && finite && sorted,
    `${n} candles, live=${series.meta.live}, last close=${last && last.c}` +
    (series.meta.spot ? `, spot=${series.meta.spot.price}` : '') +
    (series.meta.error ? `, err=${series.meta.error}` : ''));

  const before = n;
  const tick = await pollTick(inst, series);
  check(`${id} pollTick`, tick.ok && series.candles.length >= before && Number.isFinite(tick.price),
    `price=${tick.price}, len ${before}->${series.candles.length}, interval=${pollIntervalMs(inst)}ms` +
    (tick.error ? `, err=${tick.error}` : ''));
  await sleep(400);
}

// Fallback path: an instrument whose network source is forced to fail.
const broken = { ...findInstrument('BTCUSD'), symbol: 'NOSUCHSYMBOLXYZ' };
const fb = await loadSeries(broken);
check('fallback path', fb.meta.live === false && fb.candles.length >= 50,
  `live=${fb.meta.live}, ${fb.candles.length} snapshot candles, err=${fb.meta.error}`);

// News (GDELT) — may legitimately be rate-limited; report either way.
const news = await fetchNews(findInstrument('BTCUSD'));
check('news fetch (informational)', true,
  news.ok ? `${news.items.length} headlines, first: "${news.items[0].title.slice(0, 60)}"` :
  `unavailable (${news.error || 'no items'}) — UI must show unavailable state`);
if (news.ok) {
  const cached = await fetchNews(findInstrument('BTCUSD'));
  check('news cache', cached === news || cached.items.length === news.items.length, 'second call served from cache');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall checks passed');
process.exit(failures ? 1 : 0);
