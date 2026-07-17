# Build Prompt for Claude Code — Multi-Asset Market Analysis Dashboard (Single HTML File)

Use this as the master prompt for a Claude Code session. It supersedes and replaces all earlier
draft prompts for this project — those drafts contradicted each other on architecture (WebSockets
vs polling, Python/Streamlit vs static HTML, CORS proxies vs direct APIs) and on purpose (signal
generator vs analysis tool). This document resolves every conflict with one decision. Treat
anything below as final — do not resurrect the dropped options even if they resurface in old
context.

**This is a brand-new, standalone project.** It is not connected to, built on, or a continuation
of any other project — trading-related or otherwise — that may exist in this account, on this
machine, or in any repository. Do not reference, reuse, or assume shared code, architecture,
terminology, database, or deployment setup from anything else. Start clean.

Feed this to Claude Code as one shot if the session can hold it comfortably; otherwise split at
the `## Phase` boundaries and paste one phase at a time, letting Claude Code confirm each phase
is verified and working before moving to the next.

---

## 0. Purpose statement — read this first

This is a **market analysis and visualization tool, not a trading signal or advisory system.**

No BUY/SELL/HOLD verdict. No "STRONG BUY" banner. No auto-generated Take Profit / Stop Loss
targets. No confidence score presented as a recommendation. This constraint is intentional and
final — it is not a placeholder for a future "smarter" version. If you find yourself computing
something that reads as investment advice, reframe the output as a description of what the data
currently shows ("RSI is at 71, in overbought territory" — not "Sell now").

Terminology to use consistently everywhere — UI copy, variable names, function names, comments:

- Say **"analysis"**, **"reading"**, or **"indicator state"** — never "signal," "recommendation,"
  "verdict," or "call."
- Say **"confluence score"** or **"composite reading"** for the fused number — never "final
  verdict" or "trade decision."
- If you show a directional lean (e.g., indicators skew bullish/bearish), label it explicitly as
  **"what the current data shows,"** with a visible one-line disclaimer that this is not trading
  advice.

This file is a standalone client-side tool, separate from any other project in this account. Do
not assume shared backend, database, or deployment target unless the person tells you otherwise
later.

---

## 1. Deliverable

One self-contained `.html` file. No build step, no server, no Python. Everything — HTML, CSS,
JavaScript — lives in this single file, opened directly in a browser or served statically from
IIS.

**Design freedom:** There is no template or existing design to preserve, match, or reference for
this build. Design the UI from scratch. Use your own judgment for layout, visual identity, color
system, typography, card treatments, and information hierarchy — the only hard constraints are
the functional requirements in this document (bilingual, dual-theme, the section content in §7,
the analysis-not-advice framing in §0). Beyond that, this is an open creative brief: aim for
something that feels premium, modern, and genuinely well-designed — not a generic
Tailwind-starter look. Consider unconventional layout choices, a distinctive color identity, and
thoughtful micro-interactions/animations where they add clarity rather than noise.

Your job:

1. Design and build the full UI from a blank slate.
2. Wire it to real, free, client-side-fetchable market data (§3).
3. Implement the actual indicator math (§5).
4. Build the bilingual and dual-theme systems (§2).
5. Keep the file production-ready: no placeholder functions, no TODO comments, no dead code paths.

---

## 2. New Requirements Not in the Original Template

### 2.1 Bilingual UI (Arabic / English)

- A visible toggle (flag icons or "AR / EN" pill) in the header, not buried in a menu.
- Full UI string translation — labels, section headers, disclaimers, indicator names, news
  panel — via a single JS object keyed by string ID (`const i18n = { ar: {...}, en: {...} }`),
  not scattered inline strings. This keeps future translation edits to one place.
- Switching language also switches `dir` (`rtl` for Arabic, `ltr` for English) and swaps the font
  stack appropriately (Cairo for Arabic is already in the template; use a clean sans-serif like
  Inter or system-ui for English — don't force Cairo onto Latin text).
- Numbers and indicator values stay in Western numerals in both languages (financial convention);
  only labels/prose translate.
- Default language: Arabic (matches the existing template's `lang="ar" dir="rtl"`), with the
  toggle persisting the user's choice in-memory for the session (no localStorage — see §4).

### 2.2 Dual Theme (Dark / Light)

- Toggle in the header alongside the language switch.
- Design both themes as first-class, intentional palettes — not one theme with the other as a
  mechanical inversion. Dark and light should each feel deliberately designed.
- Pick semantic colors for bullish/bearish/neutral readings and keep them consistent (same hues,
  adjusted for contrast) across both themes so they stay recognizable regardless of mode.
- Implement via a `data-theme` attribute on `<html>` and CSS custom properties — do not duplicate
  every Tailwind class into a parallel light/dark class set. Define theme tokens once (background,
  surface, border, text-primary, text-secondary, accent) and reference them everywhere.
- Charts (Chart.js) must also reflect the active theme — axis/gridline/label colors need to be
  re-rendered or updated on toggle, not left dark-styled on a light background.

---

## 3. Asset Coverage & Data Sourcing (100% free, no API keys, no paid tiers)

Three asset classes, matching Template.html's existing dropdown structure:

| Class | Instruments | Primary source | Fallback |
|---|---|---|---|
| Crypto | BTC-USD, ETH-USD | Binance public REST (`/api/v3/klines`, `/api/v3/ticker/price`) — no key required, permissive CORS | Hardcoded last-known snapshot if fetch fails |
| Forex | EUR/USD, GBP/JPY, USD/JPY, AUD/USD | A free, no-key REST endpoint with real CORS support (research current working options — e.g. exchange-rate APIs or a Yahoo Finance JSON endpoint) | Hardcoded array of the last 10 sessions per pair |
| Commodities | Gold, Silver | Same approach as Forex | Same fallback pattern |

**Decide the mechanism yourself, but the fetch strategy must satisfy all of these constraints:**

- No WebSockets. Use polling only — you decide the interval based on what's stable and doesn't
  risk rate-limiting (research free-tier rate limits for whatever endpoints you pick before
  committing to an interval; err toward 20–30 seconds if uncertain).
- On initial load or asset switch: fetch a full historical candle set once (enough candles for
  every indicator's lookback period to be valid — verify this against the slowest indicator, e.g.
  EMA 200, rather than picking a round number arbitrarily).
- On each subsequent poll: fetch only the latest price/candle and mutate the last element of the
  existing in-memory array — do not re-fetch full history on every tick.
- If a CORS-blocking issue turns up for any endpoint at implementation time, either find a
  genuinely CORS-permissive alternative or fall back to the hardcoded snapshot for that
  instrument — do not silently route through an unverified third-party CORS proxy; if a proxy is
  truly necessary, name it explicitly in code comments and in your phase report so it can be
  reviewed, since third-party proxies are a reliability and trust liability for a "trusty"
  dashboard.
- Every fetch wrapped in `try...catch`. On failure, the UI must show a clear "data unavailable,
  showing last known values" state — never a silent freeze or a blank card.

**News/sentiment source:** a free, CORS-permissive financial news API or aggregator (research
current options — CryptoPanic's free tier has historically worked for crypto; verify what's
actually reachable client-side without a key at implementation time rather than assuming). If
nothing free and CORS-permissive can be verified working, it's acceptable to drop live news and
clearly label the sentiment panel as unavailable rather than fabricate headlines.

---

## 4. Runtime & Performance Guardrails

- Keep calculation-heavy loops scoped to local blocks (no leaking large arrays into global scope)
  so they're eligible for garbage collection between cycles.
- All indicators for a given asset must run on one synchronized candle array — no
  mixed-timeframe math within a single confluence score.
- No `localStorage`/`sessionStorage` — this is a single static HTML file with no guaranteed
  persistence layer; keep all state (language, theme, selected asset, candle cache) in JS
  variables for the session. If you want the person's language/theme choice to persist across
  page loads, ask them directly rather than assuming — don't silently add storage.
- Library use: only include a CDN script if you've used it and it does real work in the file (no
  unused `<script>` tags). If a needed calculation isn't available from a trustworthy CDN library,
  write it in vanilla JS rather than pulling in an unfamiliar package.

---

## 5. The Analysis Model — Three-Tier Confluence (renamed from "Confluence Score" to avoid
recommendation framing)

Keep the tiered structure from the original drafts — it's a reasonable way to organize the
math — but every tier feeds a **descriptive reading**, not a trade call.

### Tier 1 — Baseline (20% weight)
Standard, well-documented indicators: EMA 50/200, RSI (14), MACD (12,26,9), Bollinger Bands
(20,2). Use a CDN library (e.g. `technicalindicators`) if it's verified working and lightweight;
otherwise implement in vanilla JS.

### Tier 2 — Adaptive refinements (30% weight)
Lower-lag, noise-reducing variants: Kaufman's Adaptive Moving Average (KAMA), a Laguerre RSI
filter, and a volatility-squeeze indicator (Bollinger Bands compressing inside Keltner Channels).
These typically aren't in off-the-shelf CDN libraries — implement them yourself in commented
vanilla JS, showing the formula.

### Tier 3 — Asset-specific composite (50% weight)
One custom, clearly-explained composite per asset class. Every formula must be documented in code
comments: what it measures, why it's asset-appropriate, and its known limitations. Do not
describe this as "institutional-grade" or "proprietary" in UI copy — describe what it actually
does.

- **Forex:** a swing-high/low based zone identifier (a documented, transparent take on
  supply/demand structure) combined with momentum confirmation from the Tier 2 Laguerre RSI.
- **Crypto:** a volume-weighted momentum measure (e.g., CMF or VWAP deviation) capturing
  volatility expansion/contraction.
- **Commodities (Gold/Silver):** an ATR-calibrated volatility model combined with ADX for trend
  strength, since these instruments are noisier trenders than cleanly trending assets.

### Fusion
```
Composite Technical Reading = (Tier1 × 0.20) + (Tier2 × 0.30) + (Tier3 × 0.50)
Combined Reading = (Composite Technical Reading × 0.70) + (Sentiment Score × 0.30)
```
Present `Combined Reading` as a descriptive gauge (e.g., "leaning bullish," "mixed/neutral,"
"leaning bearish" with the numeric score shown) — not as an instruction.

You may still compute and display ATR-based volatility bands and structural support/resistance
(Fibonacci, pivot points) since these are legitimate descriptive technical-analysis artifacts —
label them as **"what the current structure shows,"** e.g. "ATR-implied range" and
"nearest structural levels," not "Take Profit" / "Stop Loss."

### Sentiment
A local JSON lexicon of bullish/bearish financial terms, scored per headline (-1.00 to +1.00),
averaged across fetched headlines. If no news source is reachable (§3), show sentiment as
unavailable rather than fabricating a score.

---

## 6. Arabic Analysis Report

Generate a written Arabic explanation of the current reading — what each tier shows, why, and
what the composite score reflects — using the "analysis," not "recommendation," framing
throughout. This replaces the "Trading Verdict" concept from the original drafts. Write it as a
template engine in JS (structured string composition, not one giant hardcoded paragraph) so it
adapts cleanly to the active asset and current numbers.

---

## 7. Layout (required sections — design the visual treatment freely)

1. **Header:** title, status badge, language toggle, theme toggle.
2. **Asset selection card:** class dropdown → instrument dropdown → "Run Analysis" button (not
   "Generate Recommendation").
3. **Current Market Reading card:** prominent but descriptive — the composite score as a gauge,
   the plain-language Arabic/English summary, a visible "not financial advice" note, and a
   3-column info grid for ATR-implied range, nearest structural levels, and a
   qualitative volatility/risk descriptor (not a directive risk rating).
4. **Two-column detail section:**
   - Left: indicator gauges by category (trend, momentum, volatility, volume), a numeric
     consensus badge (e.g., "12 bullish / 5 bearish / 3 neutral" — describing indicator states,
     not votes on a trade), and the structural-levels table.
   - Right: news list with per-headline sentiment tags, plus the volume/volatility mini-charts.

---

## 8. Process expectations for this Claude Code session

- Verify claims before asserting them, especially about which free API endpoints actually have
  working CORS in a browser context right now — endpoints that worked in older documentation
  sometimes stop being CORS-permissive. Test with an actual fetch before committing to one in the
  final file.
- Wrap every network call and every indicator-calculation block in `try...catch`.
- No placeholder functions, no "// TODO: implement," no stubbed-out sections — the file must run
  correctly the first time it's opened.
- At the end, report clearly: which data sources you verified working live, which indicators are
  from a library vs. hand-written, and any instrument/feature you had to fall back on (per §3) so
  nothing "should work" is presented as confirmed without having been checked.
