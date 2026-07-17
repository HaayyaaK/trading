// Deterministic verification of the GDELT backoff/spacing logic (dev-only).
// Loads src/data.js in a vm with a mock fetch and a controllable clock, then
// drives failure/success sequences and asserts the network is NOT hit while
// spaced-out or backed-off, that backoff grows exponentially, and that a
// reachable response clears it.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);

let clock = 100000;          // start high so first call clears the spacing guard
let fetchCalls = 0;
let mode = 'fail';           // 'fail' -> reject like a browser CORS/network error
let articles = [];

const mockFetch = async () => {
  fetchCalls += 1;
  if (mode === 'fail') throw new TypeError('Failed to fetch'); // browser 429-no-CORS shape
  return { ok: true, status: 200, json: async () => ({ articles }) };
};

const sb = {
  fetch: mockFetch,
  AbortController, setTimeout, clearTimeout,
  Date: { now: () => clock },
  console, Math, JSON, Object, Array, String, Number, Promise, Error, TypeError,
};
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('src/data.js', root), 'utf8'), sb);
const fetchNews = sb.fetchNews;

const inst = { newsQuery: '(bitcoin OR btc)' };
const inst2 = { newsQuery: '(gold price OR xauusd)' };

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// 1. First attempt fails -> network hit once, backoff armed to now+30s
let r = await fetchNews(inst);
check('1st call hits network and fails', fetchCalls === 1 && r.ok === false && !r.backoff, `calls=${fetchCalls}, err=${r.error}`);

// 2. 6s later (past spacing, within 30s backoff) -> NO network, backoff flagged
clock += 6000;
r = await fetchNews(inst);
check('within backoff: no network call', fetchCalls === 1 && r.backoff === true, `calls=${fetchCalls}`);

// 3. a different query also blocked by the shared backoff (per-IP, not per-query)
r = await fetchNews(inst2);
check('backoff is global across queries', fetchCalls === 1 && r.backoff === true, `calls=${fetchCalls}`);

// 4. Past the 30s backoff -> network hit again, fails -> backoff doubles to 60s
clock = 100000 + 31000;
r = await fetchNews(inst);
check('after backoff expires: network retried', fetchCalls === 2 && r.ok === false, `calls=${fetchCalls}`);

// 5. 31s later: first backoff (30s) would allow, but doubled (60s) still blocks
clock += 31000;
r = await fetchNews(inst);
check('backoff grew exponentially (60s, still blocked at +31s)', fetchCalls === 2 && r.backoff === true, `calls=${fetchCalls}`);

// 6. Past the 60s backoff, now succeed -> network hit, ok, backoff cleared
clock = 100000 + 31000 + 61000;
mode = 'ok';
articles = [{ title: 'Bitcoin holds steady', url: 'http://x', domain: 'x.com' }];
r = await fetchNews(inst);
check('success returns items and clears backoff', fetchCalls === 3 && r.ok === true && r.items.length === 1, `calls=${fetchCalls}`);

// 7. Within TTL -> served from cache, no network
clock += 1000;
r = await fetchNews(inst);
check('cached within TTL: no network', fetchCalls === 3 && r.ok === true, `calls=${fetchCalls}`);

// 8. After success, a fresh query within 6s spacing is skipped (spacing enforced)
clock += 3000;
r = await fetchNews(inst2);
check('spacing enforced after success', fetchCalls === 3 && r.backoff === true, `calls=${fetchCalls}`);

// 9. Past spacing, that query now succeeds -> network hit
clock += 4000;
r = await fetchNews(inst2);
check('past spacing: new query fetched', fetchCalls === 4 && r.ok === true, `calls=${fetchCalls}`);

// 10. Old behavior guard: a sustained-failure loop must not hit the network
//     every call. Simulate 20 rapid poll cycles during an outage.
mode = 'fail';
clock += 20 * 60 * 1000;      // jump past any backoff so the first one attempts
const before = fetchCalls;
for (let i = 0; i < 20; i++) { clock += 20000; await fetchNews(inst); } // 20 polls, 20s apart
const during = fetchCalls - before;
check('20 poll cycles during outage cause few network hits (not 20)', during <= 6, `network hits=${during}/20`);

console.log(failures ? `\n${failures} FAILURES` : '\nall news-backoff checks passed');
process.exit(failures ? 1 : 0);
