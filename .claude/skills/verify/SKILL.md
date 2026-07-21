---
name: verify
description: How to launch and drive Market Mirsad (this repo) for real-app verification.
---

# Verifying Market Mirsad

Single-file static app: `index.html` is a **generated build artifact** —
inlined from `src/*.js`, `src/styles.css`, `src/shell.html` by `build.mjs`.
If `src/` changed, run `node build.mjs` before verifying, then confirm
`git diff --stat index.html` shows only the expected delta (or none, if you
rebuilt from unchanged sources).

## Launch

No build step needed to just view it — it's plain HTML/CSS/JS + local vendor
assets (`assets/`) + live external data APIs (Binance, Frankfurter, gold-api,
GDELT — all keyless, real network calls, no mocking needed for a normal run).

Two supported ways to serve it, both work identically (verified):

```bash
# A. static file server (mirrors production/IIS hosting)
node -e "
const http=require('http'),fs=require('fs'),path=require('path');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.ico':'image/x-icon','.png':'image/png'};
http.createServer((req,res)=>{
  const p=path.join(process.cwd(), req.url==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));
  if(!fs.existsSync(p)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':mime[path.extname(p)]||'application/octet-stream'});
  res.end(fs.readFileSync(p));
}).listen(9010);
" &
# then open http://localhost:9010/

# B. file:// direct open — this project explicitly supports no-server use.
# Both must be checked when touching anything load/default-state related.
```

Drive with Playwright (`chromium.launch()` + a real page) — this is a browser
GUI surface, so pixels/DOM state are the evidence, not unit calls into
`src/*.js`.

## What to check on any UI/state change

- **Lang/theme/collapse are session-only, no persistence (§4).** After any
  interaction, do a real `page.reload()` and confirm state resets to the
  static defaults — this is a real, load-bearing guarantee in this codebase,
  not an assumption. Don't skip it.
- **`file://` and served-via-http must both work** — this app is explicitly
  designed to be opened directly as a static file with no server. A change
  that only works when served (e.g. an accidental `fetch()` of a same-origin
  file, which fails under `file://` due to opaque-origin CORS) is a real bug.
- **Collapsible cards**: verify toggle via a **real** `page.keyboard.press('Enter'/' ')`
  after `.focus()` on the card header, not a synthetic `dispatchEvent` — the
  app's a11y contract is `role="button"` + `tabindex="0"` + real keydown
  handling, and only a real keypress exercises the browser's own event path.
- **GDELT news** rate-limits unpredictably and its 429s carry no CORS header,
  so they surface in the console as CORS errors. This is expected/known, not
  a regression — the app's own backoff handles it and shows an honest
  "unavailable" state. Don't chase it.

## Gotchas

- Starting a background server twice on the same port throws `EADDRINUSE`
  from the second attempt — if the first attempt's shell already returned
  (even reporting a nonzero exit), check `curl -o /dev/null -w '%{http_code}'`
  before assuming the port is free; it may already be serving.
- Screenshot text at 1440px width can visually read as Arabic-Indic digits at
  a glance when compressed — if a rendered number looks suspicious, confirm
  via `element.textContent` / char codes before flagging it as a bug. This
  project's convention is Western numerals in both languages.
