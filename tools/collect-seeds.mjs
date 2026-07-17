// Build-time seed collector for the market dashboard.
// Gathers REAL data to embed as fallback snapshots / seed history in the final HTML:
//  - Silver (XAG) + Gold (XAU) daily USD fixes from fawazahmed0 currency-api (jsDelivr CDN)
//  - Forex daily series from Frankfurter (one call, ECB reference rates)
//  - Crypto/gold-proxy last-known compact snapshots from Binance
// Output: seeds.json in this directory.

import { writeFileSync } from 'node:fs';

const OUT = new URL('./seeds.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function* weekdaysBack(nCalendarDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1); // start yesterday (today's fix may not be published)
  for (let i = 0; i < nCalendarDays; i++) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() - 1);
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function metalDaily(sym, dates) {
  const out = [];
  const CONC = 8;
  for (let i = 0; i < dates.length; i += CONC) {
    const batch = dates.slice(i, i + CONC).map(async (date) => {
      try {
        const j = await fetchJson(
          `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${sym}.min.json`
        );
        const usd = j?.[sym]?.usd;
        if (typeof usd === 'number' && usd > 0) return { date, close: usd };
      } catch { /* missing date version — skip */ }
      return null;
    });
    out.push(...(await Promise.all(batch)));
    process.stdout.write(`\r${sym}: ${Math.min(i + CONC, dates.length)}/${dates.length}`);
  }
  console.log();
  return out.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

const dates = [...weekdaysBack(330)]; // ~235 weekdays -> EMA200-valid daily series

const [xag, xau] = [await metalDaily('xag', dates), await metalDaily('xau', dates)];

// Frankfurter: full daily EUR-based series in one call; crosses computed client-side.
const start = dates[dates.length - 1];
const fx = await fetchJson(
  `https://api.frankfurter.dev/v1/${start}..?base=EUR&symbols=USD,JPY,GBP,AUD,NZD,CAD,CHF`
);

// Binance compact last-known snapshots (last 60 hourly candles per symbol).
async function binanceSnap(symbol) {
  const k = await fetchJson(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=60`
  );
  // keep [openTime, open, high, low, close, volume] as numbers
  return k.map((c) => [c[0], +c[1], +c[2], +c[3], +c[4], +c[5]]);
}
const [btc, eth, paxg] = await Promise.all(
  ['BTCUSDT', 'ETHUSDT', 'PAXGUSDT'].map(binanceSnap)
);

// Forex per-pair daily close arrays (computed from EUR base), full series for seeds
// plus we keep everything — final file will embed last 10 sessions as the §3 fallback
// and the metals keep the full daily series (silver has no free live-history endpoint).
const days = Object.keys(fx.rates).sort();
const pair = (fn) => days.map((d) => ({ date: d, close: +fn(fx.rates[d]).toFixed(6) }));
const forex = {
  EURUSD: pair((r) => r.USD),
  USDJPY: pair((r) => r.JPY / r.USD),
  GBPJPY: pair((r) => r.JPY / r.GBP),
  AUDUSD: pair((r) => r.USD / r.AUD),
  NZDUSD: pair((r) => r.USD / r.NZD),
  USDCAD: pair((r) => r.CAD / r.USD),
  USDCHF: pair((r) => r.CHF / r.USD),
};

const seeds = {
  generatedAt: new Date().toISOString(),
  metals: { XAG: xag, XAU: xau },
  forex,
  crypto: { BTCUSDT: btc, ETHUSDT: eth, PAXGUSDT: paxg },
};

writeFileSync(OUT, JSON.stringify(seeds));

// also regenerate src/seeds.js in the exact embedded format (run node build.mjs after)
const r4 = (x) => +x.toFixed(4);
const embedded = {
  generatedAt: seeds.generatedAt,
  metals: {
    XAG: xag.map((p) => ({ date: p.date, close: r4(p.close) })),
    XAU: xau.map((p) => ({ date: p.date, close: r4(p.close) })),
  },
  forex,
  crypto: seeds.crypto,
};
const js = '// Generated at build time (' + seeds.generatedAt + ') from live sources:\n' +
  '// - metals: fawazahmed0 currency-api daily USD fixes (jsDelivr CDN)\n' +
  '// - forex: Frankfurter (ECB reference rates), crosses computed from EUR base\n' +
  '// - crypto: Binance klines snapshot (last 60 hourly candles)\n' +
  '// Used as: silver seed history (no free live-history endpoint exists for XAG)\n' +
  '// and as last-known fallback snapshots per build-spec section 3.\n' +
  'const SEEDS = ' + JSON.stringify(embedded) + ';\n';
writeFileSync(new URL('../src/seeds.js', import.meta.url), js);
console.log(
  `wrote seeds.json + src/seeds.js: XAG=${xag.length}d XAU=${xau.length}d ` +
  Object.entries(forex).map(([k, v]) => `${k}=${v.length}d`).join(' ') +
  ` crypto=60x3 hourly`
);
