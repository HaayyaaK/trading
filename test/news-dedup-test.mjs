// Deterministic verification of dedupeNewsItems() (dev-only): exact URL dups,
// title-fallback dedup when URL is missing, distinct-but-similar headlines
// preserved (no fuzzy over-matching), and order/determinism.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const sb = { console, Math, JSON, Object, Array, Number, String, Date, Set };
vm.createContext(sb);
vm.runInContext(readFileSync(new URL('src/data.js', root), 'utf8')
  .replace(/^async function fetchNews[\s\S]*$/m, ''), sb); // isolate the pure helper, skip the async I/O below it
const dedupeNewsItems = vm.runInContext('dedupeNewsItems', sb);

let failures = 0;
const ck = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!c) failures++; };

// 1. exact URL duplicate (the reported real-world case: same headline twice)
{
  const items = [
    { title: 'New to The Street... Bloomberg Television', url: 'https://x.com/a', source: 'x.com' },
    { title: 'Some other headline', url: 'https://x.com/b', source: 'x.com' },
    { title: 'New to The Street... Bloomberg Television', url: 'https://x.com/a', source: 'x.com' },
  ];
  const out = dedupeNewsItems(items);
  ck('exact URL duplicate removed, first occurrence kept', out.length === 2 && out[0].url === 'https://x.com/a' && out[1].url === 'https://x.com/b',
    JSON.stringify(out.map((i) => i.url)));
}
// 2. URL with incidental whitespace still matches (trimmed)
{
  const items = [
    { title: 'A', url: 'https://x.com/a ', source: 'x' },
    { title: 'A', url: ' https://x.com/a', source: 'x' },
  ];
  const out = dedupeNewsItems(items);
  ck('whitespace-trimmed URL still dedupes', out.length === 1);
}
// 3. no URL -> falls back to normalized (trim+lowercase) title
{
  const items = [
    { title: 'Bitcoin Holds Steady', url: undefined, source: 'a.com' },
    { title: '  bitcoin holds steady  ', url: undefined, source: 'b.com' },
  ];
  const out = dedupeNewsItems(items);
  ck('title-fallback dedup (normalized) when URL missing', out.length === 1, JSON.stringify(out));
}
// 4. distinct headlines with similar-but-not-identical wording are NOT collapsed
{
  const items = [
    { title: 'Bitcoin rises 2% today', url: 'https://x.com/1' },
    { title: 'Bitcoin rises 3% today', url: 'https://x.com/2' },
    { title: 'Bitcoin rises 2% today, analysts say', url: 'https://x.com/3' },
  ];
  const out = dedupeNewsItems(items);
  ck('genuinely distinct similar-wording headlines all preserved (no fuzzy over-match)', out.length === 3);
}
// 5. mixed: some with URL, some without, some duplicate by each key independently
{
  const items = [
    { title: 'X', url: 'https://a.com/1' },
    { title: 'X', url: undefined },
    { title: 'x', url: undefined }, // same normalized title as prior title-fallback item
    { title: 'X', url: 'https://a.com/1' }, // exact dup of item 1
  ];
  const out = dedupeNewsItems(items);
  ck('mixed URL/title-fallback keys dedupe independently and correctly', out.length === 2, JSON.stringify(out));
}
// 6. determinism: same input twice -> identical output
{
  const items = [{ title: 'A', url: 'https://x/1' }, { title: 'A', url: 'https://x/1' }, { title: 'B', url: 'https://x/2' }];
  const a = dedupeNewsItems(items), b = dedupeNewsItems(items);
  ck('determinism', JSON.stringify(a) === JSON.stringify(b));
}
// 7. empty input -> empty output, no throw
{
  const out = dedupeNewsItems([]);
  ck('empty input handled', Array.isArray(out) && out.length === 0);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall news-dedup checks passed');
process.exit(failures ? 1 : 0);
