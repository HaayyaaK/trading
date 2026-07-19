// ============================================================================
// UI LAYER — state, deterministic rendering, language/theme systems, charts.
// ----------------------------------------------------------------------------
// Rendering contract: every render*() function is a pure projection of
// `appState` — no clocks, no fetches, no randomness inside render paths, so
// the same state always produces the same DOM regardless of re-render timing.
// (Timestamps shown in the UI are data-arrival times stored in state by the
// fetch path, never Date.now() read at render time.)
// All state lives in JS for the session — no localStorage (per spec §4).
// ============================================================================

const appState = {
  lang: 'en',            // default English (updated from the original ar default; §4: no persistence, so this is simply the static first-load default)
  theme: 'dark',
  assetClass: 'crypto',
  instrumentId: 'BTCUSD',
  timeframe: '1h',       // user-chosen intraday tf; daily-sourced assets lock to '1d'
  phase: 'idle',         // idle | loading | ready
  series: null,          // { candles, meta } from data layer
  analysis: null,        // runAnalysis() result
  news: null,            // fetchNews() result
  newsForId: null,       // which instrument the cached news belongs to
  lastUpdateAt: null,    // ms epoch of last successful data event (not render)
  pollTimer: null,
  nextPollAt: null,      // ms epoch when the next poll is scheduled (null = not polling)
  charts: { price: null, volume: null, volatility: null },
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

// Numbers stay Western in both languages (financial convention, spec §2.1).
function fmt(n, decimals) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtSigned(n, decimals) {
  if (n === null || !Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + fmt(n, decimals);
}
function fmtTime(ms, lang) {
  if (!ms) return '—';
  // 12-hour "h:mm AM/PM" on the status badge; Western numerals in both languages
  return new Date(ms).toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit', hour12: true, numberingSystem: 'latn' });
}

const T = (key) => t(appState.lang, key);
const stateCls = { bullish: 'bull', bearish: 'bear', neutral: 'neut', na: 'na' };
const stateColorVar = { bullish: '--bull', bearish: '--bear', neutral: '--neut' };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------------------
// Header / chrome
// ---------------------------------------------------------------------------
function renderChrome() {
  const L = appState.lang;
  document.documentElement.setAttribute('lang', L);
  document.documentElement.setAttribute('dir', L === 'ar' ? 'rtl' : 'ltr');
  document.documentElement.setAttribute('data-theme', appState.theme);

  $('#app-title').textContent = T('appTitle');
  $('#app-subtitle').textContent = T('appSubtitle');
  $('#btn-ar').classList.toggle('active', L === 'ar');
  $('#btn-en').classList.toggle('active', L === 'en');
  const themeBtn = $('#btn-theme');
  // FontAwesome sun/moon; show the icon of the mode you'd switch TO
  themeBtn.innerHTML = appState.theme === 'dark'
    ? '<i class="fa-solid fa-sun" aria-hidden="true"></i>'
    : '<i class="fa-solid fa-moon" aria-hidden="true"></i>';
  themeBtn.title = T(appState.theme === 'dark' ? 'themeToLight' : 'themeToDark');

  const badge = $('#status-badge');
  badge.className = 'status-badge';
  let key = 'statusIdle';
  if (appState.phase === 'loading') key = 'statusLoading';
  else if (appState.phase === 'ready') {
    if (appState.series && appState.series.meta.live) { key = 'statusLive'; badge.classList.add('is-live'); }
    else { key = 'statusStale'; badge.classList.add('is-stale'); }
  }
  // Countdown container presence depends only on appState.nextPollAt !== null
  // (state, not the wall clock) — keeps renderChrome() a pure projection of
  // state. The live seconds value itself is filled in by tickCountdown(),
  // called once right after this render and then every second afterward; see
  // that function for why the clock read is kept out of the render path.
  const countdownHtml = appState.nextPollAt !== null
    ? `<span class="badge-countdown" title="${T('nextPollTitle')}"><i class="fa-regular fa-clock" aria-hidden="true"></i><span class="num" id="poll-countdown"></span></span>`
    : '';
  badge.innerHTML = `<span class="dot"></span><span>${T(key)}</span>` +
    (appState.lastUpdateAt ? ` <span class="num" style="font-weight:600">${fmtTime(appState.lastUpdateAt, L)}</span>` : '') +
    countdownHtml;

  // selection card
  $('#selection-title').textContent = T('selectionTitle');
  $('#label-class').textContent = T('assetClass');
  $('#label-instrument').textContent = T('instrument');
  $('#label-timeframe').textContent = T('timeframe');
  $('#btn-run').textContent = appState.phase === 'loading' ? T('running') : T('runAnalysis');
  $('#btn-run').disabled = appState.phase === 'loading';
  $('#auto-note').textContent = T('autoRefreshNote');

  const classSel = $('#sel-class');
  const classKeys = { crypto: 'classCrypto', forex: 'classForex', commodities: 'classCommodities' };
  classSel.innerHTML = Object.keys(INSTRUMENTS)
    .map((k) => `<option value="${k}" ${k === appState.assetClass ? 'selected' : ''}>${T(classKeys[k])}</option>`).join('');
  const instSel = $('#sel-instrument');
  instSel.innerHTML = INSTRUMENTS[appState.assetClass]
    .map((i) => `<option value="${i.id}" ${i.id === appState.instrumentId ? 'selected' : ''}>${L === 'ar' ? i.labelAr : i.labelEn}</option>`).join('');

  // timeframe: full range for Binance-sourced instruments (crypto + gold proxy);
  // daily-locked with a visible reason for daily-sourced classes (forex/silver).
  const inst = findInstrument(appState.instrumentId);
  const intraday = supportsIntradayTimeframe(inst);
  const tfSel = $('#sel-timeframe');
  const tfKeys = { '1h': 'tf1h', '4h': 'tf4h', '8h': 'tf8h', '12h': 'tf12h', '1d': 'tf1d' };
  const shownTf = intraday ? appState.timeframe : '1d';
  const tfOptions = intraday ? TIMEFRAMES : ['1d'];
  tfSel.innerHTML = tfOptions
    .map((tf) => `<option value="${tf}" ${tf === shownTf ? 'selected' : ''}>${T(tfKeys[tf])}</option>`).join('');
  tfSel.disabled = !intraday;
  $('#tf-note').textContent = intraday ? '' : T('tfDailyLocked');
  $('#tf-note').style.display = intraday ? 'none' : '';

  $('#footer-sources').textContent = T('footerSources');
  $('#footer-disclaimer').textContent = T('footerDisclaimer');
  $('#footer-disclaimer-link-text').textContent = T('footerDisclaimerLink');
  // Same-tab navigation to disclaimer.html (see report: chosen over an
  // in-page content swap to avoid a second copy of the legal text living in
  // two files, and over a new tab so it stays within the current browsing
  // context). Pass the current language/theme so the disclaimer page opens
  // in a matching state instead of resetting to its own ar/dark default.
  $('#footer-disclaimer-link').setAttribute('href', `disclaimer.html?lang=${L}&theme=${appState.theme}`);
  $('#footer-copyright').textContent = `© ${new Date().getFullYear()} ${T('appTitle')}`;
}

// ---------------------------------------------------------------------------
// Composite gauge (hand-built SVG semicircle; physical/direction-neutral)
// ---------------------------------------------------------------------------
function gaugeSvg(value) {
  const W = 280, H = 165, cx = W / 2, cy = 145, R = 118;
  const a = (frac) => {
    const ang = Math.PI * (1 - frac);            // frac 0..1 across the arc
    return [cx + R * Math.cos(ang), cy - R * Math.sin(ang)];
  };
  const arc = (f0, f1, color, width) => {
    const [x0, y0] = a(f0), [x1, y1] = a(f1);
    return `<path d="M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  };
  const bear = cssVar('--bear'), neut = cssVar('--neut'), bull = cssVar('--bull');
  const border = cssVar('--border-strong'), text3 = cssVar('--text-3');
  let needle = '';
  if (value !== null && Number.isFinite(value)) {
    const f = (value + 1) / 2;
    const ang = Math.PI * (1 - f);
    const nx = cx + (R - 26) * Math.cos(ang), ny = cy - (R - 26) * Math.sin(ang);
    const color = value > 0.15 ? bull : value < -0.15 ? bear : neut;
    needle = `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="7" fill="${color}"/>
      <text x="${cx}" y="${cy - 34}" text-anchor="middle" font-size="30" font-weight="800" fill="${color}" class="num">${fmtSigned(value, 2)}</text>`;
  } else {
    needle = `<text x="${cx}" y="${cy - 34}" text-anchor="middle" font-size="20" font-weight="700" fill="${text3}">${T('naShort')}</text>`;
  }
  const ticks = [-1, -0.5, 0, 0.5, 1].map((v) => {
    const f = (v + 1) / 2, ang = Math.PI * (1 - f);
    const x = cx + (R + 14) * Math.cos(ang), y = cy - (R + 14) * Math.sin(ang);
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="10" fill="${text3}" class="num">${v}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
    ${arc(0, 1, border, 3)}
    ${arc(0.0, 0.42, bear, 9)}${arc(0.44, 0.56, neut, 9)}${arc(0.58, 1, bull, 9)}
    ${ticks}${needle}</svg>`;
}

// Compact semicircle gauge for the Indicator Gauges card — same visual
// language and color logic as gaugeSvg() above (arc bands, needle, na text),
// scaled down and without tick labels/embedded number so several fit per row;
// the label and value are rendered as separate HTML text beneath it instead.
function miniGaugeSvg(value) {
  const W = 120, H = 72, cx = W / 2, cy = 64, R = 50;
  const a = (frac) => {
    const ang = Math.PI * (1 - frac);
    return [cx + R * Math.cos(ang), cy - R * Math.sin(ang)];
  };
  const arc = (f0, f1, color, width) => {
    const [x0, y0] = a(f0), [x1, y1] = a(f1);
    return `<path d="M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  };
  const bear = cssVar('--bear'), neut = cssVar('--neut'), bull = cssVar('--bull');
  const border = cssVar('--border-strong'), text3 = cssVar('--text-3');
  let needle = '';
  if (value !== null && Number.isFinite(value)) {
    const f = (value + 1) / 2;
    const ang = Math.PI * (1 - f);
    const nx = cx + (R - 12) * Math.cos(ang), ny = cy - (R - 12) * Math.sin(ang);
    const color = value > 0.15 ? bull : value < -0.15 ? bear : neut;
    needle = `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>`;
  } else {
    needle = `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="11" font-weight="700" fill="${text3}">${T('naShort')}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-hidden="true">
    ${arc(0, 1, border, 6)}
    ${arc(0.0, 0.42, bear, 6)}${arc(0.44, 0.56, neut, 6)}${arc(0.58, 1, bull, 6)}
    ${needle}</svg>`;
}

// ---------------------------------------------------------------------------
// Reading card
// ---------------------------------------------------------------------------
function srcDisclosureKey(inst) {
  if (inst.id === 'GOLD') return 'srcGold';
  if (inst.id === 'SILVER') return 'srcSilver';
  if (inst.source === 'frankfurter') return 'srcForex';
  return 'srcCrypto';
}

function renderReading() {
  const box = $('#reading-body');
  $('#reading-title').textContent = T('readingTitle');
  const a = appState.analysis, s = appState.series;
  if (!a || !s) { box.innerHTML = `<div class="skeleton"></div>`; return; }
  const inst = findInstrument(appState.instrumentId);
  const L = appState.lang;

  const lean = a.combined === null ? 'neut' : a.combined > 0.15 ? 'bull' : a.combined < -0.15 ? 'bear' : 'neut';
  const leanKey = lean === 'bull' ? 'leanBullish' : lean === 'bear' ? 'leanBearish' : 'leanNeutral';

  // tier-weight note: visible whenever effective weights differ from 20/30/50
  const wu = a.weightsUsed || {};
  const redistributed = ['t1', 't2', 't3'].some((k) =>
    Math.abs((wu[k] ?? 0) - { t1: 0.2, t2: 0.3, t3: 0.5 }[k]) > 0.001);
  const weightsNote = redistributed
    ? `<div class="notice warn">${T('weightsRedistributed')} <span class="num">T1 ${Math.round((wu.t1 || 0) * 100)}% · T2 ${Math.round((wu.t2 || 0) * 100)}% · T3 ${Math.round((wu.t3 || 0) * 100)}%</span></div>`
    : `<div class="notice src">${T('weightsDefault')}</div>`;

  const spot = s.meta.spot
    ? ` · <span class="num">${fmt(s.meta.spot.price, inst.decimals)}</span> ${L === 'ar' ? '(السعر الفوري الرسمي)' : '(official spot)'}`
    : '';

  const range = a.levels.atrRange;
  const vol = a.volatility;
  const volKey = vol ? { low: 'volLow', moderate: 'volModerate', elevated: 'volElevated', high: 'volHigh' }[vol.band] : null;

  // nearest structural levels: closest fib above + below current price
  let nearUp = null, nearDown = null;
  if (a.levels.fib) {
    for (const lv of a.levels.fib.levels) {
      if (lv.price > a.price && (!nearUp || lv.price < nearUp.price)) nearUp = lv;
      if (lv.price < a.price && (!nearDown || lv.price > nearDown.price)) nearDown = lv;
    }
  }

  box.innerHTML = `
    <div class="reading-layout">
      <div class="gauge-wrap">
        ${gaugeSvg(a.combined)}
        <div class="lean-label ${lean}">${T(leanKey)}</div>
        <div class="reading-numbers">
          <div class="item"><div class="v num">${fmtSigned(a.compositeTechnical, 2)}</div><div class="k">${T('technicalReading')}</div></div>
          <div class="item"><div class="v num">${a.sentimentIncluded ? fmtSigned(a.sentiment.score, 2) : '—'}</div><div class="k">${T('sentimentReading')}</div></div>
          <div class="item"><div class="v num">${fmt(a.price, inst.decimals)}</div><div class="k num" style="direction:ltr">${L === 'ar' ? inst.labelAr : inst.labelEn}</div></div>
        </div>
      </div>
      <div>
        <div class="notice advice">⚖ ${T('notAdvice')}</div>
        ${a.sentimentIncluded ? '' : `<div class="notice warn">${T('sentimentExcluded')}</div>`}
        ${weightsNote}
        <div class="notice src">ℹ ${T(srcDisclosureKey(inst))}${spot}</div>
        ${s.meta.live ? '' : `<div class="notice warn">⚠ ${T('dataUnavailable')}</div>`}
        <div class="info-grid">
          <div class="info-tile">
            <div class="t">${T('atrRangeTitle')}</div>
            <div class="big num">${range ? `${fmt(range.low, inst.decimals)} – ${fmt(range.high, inst.decimals)}` : T('naHistory')}</div>
            <div class="sub">${T('atrRangeNote')}</div>
          </div>
          <div class="info-tile">
            <div class="t">${T('structLevelsTitle')}</div>
            <div class="big num">${nearDown ? `▾ ${fmt(nearDown.price, inst.decimals)}` : '—'}&nbsp;&nbsp;${nearUp ? `▴ ${fmt(nearUp.price, inst.decimals)}` : '—'}</div>
            <div class="sub">${T('structSupport')} / ${T('structResistance')} (${T('fibLevel')})</div>
          </div>
          <div class="info-tile">
            <div class="t">${T('volDescriptorTitle')}</div>
            <div class="big">${vol ? T(volKey) : T('naHistory')}</div>
            <div class="sub">${vol ? `${T('volPercentile')}: <span class="num">${Math.round(vol.percentile * 100)}%</span> · ATR <span class="num">${fmt(vol.atrPct * 100, 2)}%</span>` : ''}</div>
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tiers + indicators + consensus + levels (left column)
// ---------------------------------------------------------------------------
// meters use physical left/width so "positive extends right" in RTL and LTR
function meterFill(reading) {
  if (reading === null) return '';
  const half = Math.min(Math.abs(reading), 1) * 50;
  const left = reading >= 0 ? 50 : 50 - half;
  const color = cssVar(stateColorVar[reading > 0.15 ? 'bullish' : reading < -0.15 ? 'bearish' : 'neutral']);
  return `<span class="fill" style="left:${left}%;width:${half}%;background:${color}"></span>`;
}

function naReason(ind, seriesMeta) {
  if (ind.id === 'cmf' || (ind.reason === 'volume-unavailable')) return T('naVolume');
  return T('naHistory');
}

function indicatorName(ind) {
  const map = {
    emaCross: 'indEmaCross', rsi: 'indRsi', macd: 'indMacd', bollinger: 'indBollinger',
    kama: 'indKama', laguerre: 'indLaguerre', squeeze: 'indSqueeze', cmf: 'indCmf',
    t3forex: 'indT3forex', t3crypto: 'indT3crypto', t3commodity: 'indT3commodity',
  };
  return T(map[ind.id] || ind.id);
}

function indicatorValueText(ind, decimals) {
  if (ind.reading === null) return '';
  switch (ind.id) {
    case 'rsi': return fmt(ind.value, 1) + (ind.zone !== 'mid' ? ` · ${T(ind.zone === 'overbought' ? 'zoneOverbought' : 'zoneOversold')}` : '');
    case 'laguerre': return fmt(ind.value, 2);
    case 'cmf': return fmtSigned(ind.value, 3);
    case 'emaCross': return `${fmt(ind.value.ema50, decimals)} / ${fmt(ind.value.ema200, decimals)}`;
    case 'kama': return fmt(ind.value, decimals);
    case 'macd': return fmtSigned(ind.value.hist, decimals >= 4 ? 5 : 2);
    case 'bollinger': return `%B ${fmt(ind.value.pctB * 100, 0)}%`;
    case 'squeeze': return T(ind.phase === 'compression' ? 'phaseCompression' : 'phaseExpansion');
    case 't3forex': return `LRSI ${fmt(ind.detail.laguerre, 2)}`;
    case 't3crypto': return `CMF ${fmtSigned(ind.detail.cmf, 3)} · z ${fmtSigned(ind.detail.vwapZ, 2)}`;
    case 't3commodity': return `ADX ${fmt(ind.detail.adx, 1)}`;
    default: return '';
  }
}

function tileHtml(ind, decimals) {
  const cls = stateCls[ind.state];
  const chip = `<span class="chip ${cls}">${T(ind.state === 'na' ? 'naShort' : ind.state)}</span>`;
  const body = ind.reading === null
    ? `<div class="na-note">${naReason(ind)}</div>`
    : `<div class="meter"><span class="mid"></span>${meterFill(ind.reading)}</div>`;
  return `<div class="ind-tile">
    <div class="row1"><span class="n">${indicatorName(ind)}</span>${chip}</div>
    ${ind.reading !== null ? `<div class="row1" style="margin-block-start:4px"><span class="v num">${indicatorValueText(ind, decimals)}</span><span class="v num">${fmtSigned(ind.reading, 2)}</span></div>` : ''}
    ${body}
  </div>`;
}

function renderDetail() {
  const a = appState.analysis;
  $('#tiers-title').textContent = T('tiersTitle');
  $('#indicators-title').textContent = T('indicatorsTitle');
  $('#levels-title').textContent = T('levelsTableTitle');
  const tiersBox = $('#tiers-body'), indBox = $('#indicators-body'), lvlBox = $('#levels-body');
  if (!a) { tiersBox.innerHTML = '<div class="skeleton"></div>'; indBox.innerHTML = '<div class="skeleton"></div>'; lvlBox.innerHTML = '<div class="skeleton"></div>'; return; }
  const inst = findInstrument(appState.instrumentId);
  const d = inst.decimals;

  // tiers
  const wu = a.weightsUsed || {};
  const tierRow = (key, labelKey, score) => {
    const val = score === null ? `<span class="chip na">${T('tierNA')}</span>` : `<span class="num">${fmtSigned(score, 2)}</span>`;
    return `<div class="tier-row">
      <div class="name">${T(labelKey)} <span class="w num">(${T('tierWeight')} ${Math.round((wu[key] ?? 0) * 100)}%)</span></div>
      <div class="tier-bar"><span class="mid"></span>${score === null ? '' : meterFill(score)}</div>
      <div class="val">${val}</div>
    </div>`;
  };
  tiersBox.innerHTML =
    tierRow('t1', 'tier1', a.tiers.t1.score) +
    tierRow('t2', 'tier2', a.tiers.t2.score) +
    tierRow('t3', 'tier3', a.tiers.t3.score);

  // indicators grouped by category
  const cats = [['trend', 'catTrend'], ['momentum', 'catMomentum'], ['volatility', 'catVolatility'], ['volume', 'catVolume']];
  let html = '';
  for (const [cat, key] of cats) {
    const inds = a.indicators.filter((i) => (i.category || 'trend') === cat && !i.id.startsWith('t3'));
    if (!inds.length) continue;
    html += `<div class="cat-title">${T(key)}</div><div class="ind-grid">${inds.map((i) => tileHtml(i, d)).join('')}</div>`;
  }
  // tier-3 composite as its own row
  const t3 = a.indicators.find((i) => i.id.startsWith('t3'));
  if (t3) html += `<div class="cat-title">${T('tier3')}</div><div class="ind-grid" style="grid-template-columns:1fr">${tileHtml(t3, d)}</div>`;
  // consensus — a proportional stacked bar (at-a-glance) + a labelled legend.
  // Describes indicator STATES, not votes on a trade (§0 framing preserved).
  const c = a.consensus;
  const total = (c.bullish + c.bearish + c.neutral + c.na) || 1;
  const pct = (n) => (n / total * 100).toFixed(2);
  const seg = (n, cls) => (n ? `<span class="${cls}" style="inline-size:${pct(n)}%"></span>` : '');
  const chip = (n, cls, key) => `<span class="chip ${cls}">${T(key)} <span class="count num">${n}</span></span>`;
  html += `<div>
      <div class="consensus-bar" role="img" aria-label="${c.bullish} ${T('bullish')}, ${c.neutral} ${T('neutral')}, ${c.bearish} ${T('bearish')}">
        ${seg(c.bullish, 'seg-bull')}${seg(c.neutral, 'seg-neut')}${seg(c.bearish, 'seg-bear')}${seg(c.na, 'seg-na')}
      </div>
      <div class="consensus-legend">
        ${chip(c.bullish, 'bull', 'bullish')}${chip(c.neutral, 'neut', 'neutral')}${chip(c.bearish, 'bear', 'bearish')}
        ${c.na ? chip(c.na, 'na', 'naShort') : ''}
      </div>
      <div class="hint" style="margin-block-start:8px">${T('consensusNote')}</div>
    </div>`;
  indBox.innerHTML = html;

  // levels table
  let rows = '';
  if (a.levels.fib) {
    for (const lv of a.levels.fib.levels) {
      rows += `<tr><td>${T('fibLevel')}</td><td class="num">${fmt(lv.price, d)}</td><td class="num">${(lv.ratio * 100).toFixed(1)}%</td></tr>`;
    }
  }
  if (a.levels.pivots) {
    const p = a.levels.pivots;
    for (const [k, lbl] of [['p', 'pivotP'], ['r1', 'pivotR1'], ['s1', 'pivotS1'], ['r2', 'pivotR2'], ['s2', 'pivotS2']]) {
      rows += `<tr><td>${T('pivotLevel')}</td><td class="num">${fmt(p[k], d)}</td><td>${T(lbl)}</td></tr>`;
    }
  }
  const t3d = a.tiers.t3.composite && a.tiers.t3.composite.detail;
  if (t3d && t3d.nearestSupport) rows += `<tr><td>${T('zoneLevel')}</td><td class="num">${fmt(t3d.nearestSupport.price, d)}</td><td>${T('structSupport')} · ${t3d.nearestSupport.touches} ${T('zoneTouches')}</td></tr>`;
  if (t3d && t3d.nearestResistance) rows += `<tr><td>${T('zoneLevel')}</td><td class="num">${fmt(t3d.nearestResistance.price, d)}</td><td>${T('structResistance')} · ${t3d.nearestResistance.touches} ${T('zoneTouches')}</td></tr>`;
  lvlBox.innerHTML = `
    ${a.levels.pivots ? '' : `<div class="notice src" style="margin-block-end:10px">${T('pivotsNA')}</div>`}
    <table class="levels">
      <thead><tr><th>${T('levelType')}</th><th>${T('levelPrice')}</th><th>${T('levelMeta')}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// News + charts (right column)
// ---------------------------------------------------------------------------
function renderNews() {
  $('#news-title').textContent = T('newsTitle');
  const box = $('#news-body');
  const a = appState.analysis, news = appState.news;
  if (appState.phase === 'loading') { box.innerHTML = '<div class="skeleton"></div>'; return; }
  if (!news || !news.ok || !news.items.length) {
    box.innerHTML = `<div class="notice warn">${T('newsUnavailable')}</div>`;
    return;
  }
  const per = (a && a.sentiment.ok) ? a.sentiment.perHeadline : [];
  const items = news.items.map((n, idx) => {
    const sc = per[idx] ? per[idx].score : 0;
    const cls = sc > 0.05 ? 'bull' : sc < -0.05 ? 'bear' : 'neut';
    return `<div class="news-item">
      <span class="chip ${cls} num">${fmtSigned(sc, 2)}</span>
      <div><a class="title" href="${n.url}" target="_blank" rel="noopener noreferrer">${n.title}</a>
      <div class="meta">${n.source}</div></div>
    </div>`;
  }).join('');
  const avg = a && a.sentiment.ok
    ? `<div class="hint" style="margin-block-end:8px">${T('newsSentAvg')}: <b class="num">${fmtSigned(a.sentiment.score, 2)}</b></div>` : '';
  box.innerHTML = avg + `<div class="news-list">${items}</div>`;
}

// Trend duration — how long has each of two moving-average-based states held,
// and how much has price moved while it held (spec §0: a duration, not a
// forecast). Built directly from ema(closes) via indicators.js's
// trendDurations(), so it works identically across every asset class and
// timeframe with no close-to-close adaptation needed (see indicators.js).
function trendDurationTile(streak, labelKey, aboveKey, belowKey) {
  if (!streak) {
    return `<div class="info-tile"><div class="t">${T(labelKey)}</div><div class="sub">${T('tdNa')}</div></div>`;
  }
  const dirLabel = streak.dir === 'up' ? T(aboveKey) : T(belowKey);
  const barsText = (streak.censored ? T('tdAtLeast') + ' ' : '') + fmt(streak.bars, 0) + ' ' + T('tdBarsUnit');
  return `<div class="info-tile">
    <div class="t">${T(labelKey)}</div>
    <div class="dir">${dirLabel}</div>
    <div class="big num">${barsText}</div>
    <div class="sub">${T('tdSince')}: <span class="num">${fmtSigned(streak.changePct, 2)}%</span></div>
    ${streak.censored ? `<div class="sub">${T('tdCensoredNote')}</div>` : ''}
  </div>`;
}

function renderTrendDuration() {
  $('#trend-duration-title').textContent = T('trendDurationTitle');
  const box = $('#trend-duration-body');
  const s = appState.series;
  if (!s) { box.innerHTML = appState.phase === 'loading' ? '<div class="skeleton"></div>' : ''; return; }
  const cl = s.candles.map((c) => c.c);
  const td = trendDurations(cl);
  box.innerHTML = `<div class="td-grid">
      ${trendDurationTile(td.priceVsEma50, 'tdPriceEma', 'tdAbove', 'tdBelow')}
      ${trendDurationTile(td.ema50VsEma200, 'tdEmaCross', 'tdGolden', 'tdDeath')}
    </div>
    <div class="td-note">${T('trendDurationNote')}</div>`;
}

// Indicator Gauges card — a compact radial-gauge view of readings ALREADY
// computed for the Indicator States card (a.indicators). Reuses indicatorName()
// / indicatorValueText() verbatim rather than re-deriving labels/values, so
// this is a second VISUALIZATION of the same numbers, never a second source of
// truth. Fixed set: EMA50/200 cross + KAMA (trend), RSI + MACD + Laguerre RSI
// (momentum), Bollinger %B + volatility squeeze (volatility), plus whichever
// Tier-3 asset-class composite applies (forex/crypto/commodity) — these seven
// are computed for every asset class/timeframe given enough history, so the
// card looks the same shape everywhere rather than being mostly "n/a" tiles
// for some instruments. CMF/volume is left out here since it's only available
// for hourly OHLC assets with real volume (already shown in Indicator States);
// Stochastic Oscillator and a Fibonacci "position" gauge were considered and
// deliberately left out (see PROJECT_STATUS.md) rather than adding new
// indicator math or inventing a derived metric not already computed elsewhere.
const GAUGE_IDS = ['emaCross', 'kama', 'rsi', 'macd', 'laguerre', 'bollinger', 'squeeze'];

function gaugeTileHtml(ind, decimals) {
  const valueText = ind.reading === null ? T('naShort') : indicatorValueText(ind, decimals);
  return `<div class="gauge-tile">
    ${miniGaugeSvg(ind.reading)}
    <div class="g-label">${indicatorName(ind)}</div>
    <div class="g-value num">${valueText}</div>
  </div>`;
}

function renderGauges() {
  $('#gauges-title').textContent = T('gaugesTitle');
  const box = $('#gauges-body');
  const a = appState.analysis;
  if (!a) { box.innerHTML = appState.phase === 'loading' ? '<div class="skeleton"></div>' : ''; return; }
  const inst = findInstrument(appState.instrumentId);
  const d = inst.decimals;
  const tiles = GAUGE_IDS.map((id) => a.indicators.find((i) => i.id === id)).filter(Boolean);
  const t3 = a.indicators.find((i) => i.id.startsWith('t3'));
  if (t3) tiles.push(t3);
  box.innerHTML = `<div class="gauge-grid">${tiles.map((ind) => gaugeTileHtml(ind, d)).join('')}</div>
    <div class="gauge-note">${T('gaugesNote')}</div>`;
}

// Charts are drawn with Apache ECharts (local vendor build). Colors are pulled
// from the active CSS theme tokens on every render, and renderCharts() is called
// from renderAll() on theme toggle, so charts re-theme correctly in dark/light
// (not just the DOM around them). ECharts instances are disposed and re-created
// each render, which guarantees the fresh palette is applied.
function chartColors() {
  return {
    text: cssVar('--text-2'), text3: cssVar('--text-3'), grid: cssVar('--grid-line'),
    accent: cssVar('--accent'), bull: cssVar('--bull'), bear: cssVar('--bear'), neut: cssVar('--neut'),
    card: cssVar('--card'), border: cssVar('--border'),
  };
}
function hexA(hex, a) {
  const h = hex.replace('#', '').trim();
  if (h.length < 3) return hex;
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(f, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function destroyCharts() {
  for (const k of Object.keys(appState.charts)) {
    if (appState.charts[k]) { appState.charts[k].dispose(); appState.charts[k] = null; }
  }
}

function echartsBase(th, labels) {
  return {
    animation: false,
    grid: { left: 6, right: 10, top: 24, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category', data: labels, boundaryGap: true,
      axisLine: { lineStyle: { color: th.border } },
      axisLabel: { color: th.text, fontSize: 10, hideOverlap: true },
      axisTick: { show: false }, splitLine: { show: false },
    },
    yAxis: {
      type: 'value', scale: true,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: th.text, fontSize: 10 },
      splitLine: { lineStyle: { color: th.grid } },
    },
    tooltip: {
      trigger: 'axis', confine: true,
      axisPointer: { type: 'cross', lineStyle: { color: th.text3 }, crossStyle: { color: th.text3 } },
      backgroundColor: th.card, borderColor: th.border, textStyle: { color: th.text, fontSize: 11 },
    },
    textStyle: { fontFamily: 'IBM Plex Sans Arabic, sans-serif' },
  };
}

function renderCharts() {
  $('#charts-title').textContent = appState.lang === 'ar' ? 'الرسوم المصغّرة' : 'Mini-charts';
  // Skip drawing while the charts card is collapsed: ECharts sizes to its
  // container, which is display:none when collapsed and would render at 0px.
  // The collapse toggle re-runs renderCharts() on expand, so sizing is correct.
  if (cardCollapsed('charts')) return;
  const s = appState.series;
  destroyCharts();
  $('#chart-price-t').textContent = T('chartPrice');
  $('#chart-volume-t').textContent = T('chartVolume');
  $('#chart-volatility-t').textContent = T('chartVolatility');
  if (!s || typeof echarts === 'undefined') return;
  const th = chartColors();
  const N = 120;
  const full = s.candles;
  const cl = full.map((c) => c.c);
  const candles = full.slice(-N);
  // label granularity by timeframe: 1h -> HH:MM; 4h/8h/12h -> MM-DD HH:MM
  // (same intraday clock recurs across days, so the date is needed); 1d -> MM-DD
  const tf = s.meta.timeframe;
  const labels = candles.map((c) => {
    const iso = new Date(c.t).toISOString();
    if (tf === '1h') return iso.slice(11, 16);
    if (tf === '1d') return iso.slice(5, 10);
    return iso.slice(5, 10) + ' ' + iso.slice(11, 16);
  });
  const e50 = ema(cl, 50).slice(-N);
  const km = kama(cl, 10, 2, 30).slice(-N);

  // --- Price: real candlesticks for OHLC series (crypto/gold), a line for
  //     close-only series (forex/silver) where candlesticks would be dojis.
  const priceInst = echarts.init($('#chart-price'));
  const priceOpt = echartsBase(th, labels);
  priceOpt.legend = { data: ['EMA50', 'KAMA'], top: 0, right: 6, textStyle: { color: th.text, fontSize: 10 }, itemWidth: 16, itemHeight: 8 };
  const overlays = [
    { name: 'EMA50', type: 'line', data: e50, showSymbol: false, smooth: true, lineStyle: { width: 1.4, color: th.accent }, z: 3 },
    { name: 'KAMA', type: 'line', data: km, showSymbol: false, smooth: true, lineStyle: { width: 1.4, color: th.neut, type: 'dashed' }, z: 3 },
  ];
  if (s.meta.ohlc) {
    priceOpt.series = [
      { name: 'OHLC', type: 'candlestick', data: candles.map((c) => [c.o, c.c, c.l, c.h]),
        itemStyle: { color: th.bull, color0: th.bear, borderColor: th.bull, borderColor0: th.bear }, z: 2 },
      ...overlays,
    ];
  } else {
    priceOpt.series = [
      { name: 'Close', type: 'line', data: candles.map((c) => c.c), showSymbol: false, smooth: true,
        lineStyle: { width: 1.8, color: th.accent },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: hexA(th.accent, .28) }, { offset: 1, color: hexA(th.accent, 0) }]) }, z: 2 },
      ...overlays,
    ];
  }
  priceInst.setOption(priceOpt);
  appState.charts.price = priceInst;

  // --- Volume: real volume only, colored by candle direction. Never fabricated.
  if (s.meta.hasVolume) {
    $('#chart-volume').style.display = '';
    $('#chart-volume-na').style.display = 'none';
    const volInst = echarts.init($('#chart-volume'));
    const volOpt = echartsBase(th, labels);
    volOpt.series = [{
      type: 'bar', barWidth: '62%',
      data: candles.map((c) => ({ value: c.v, itemStyle: { color: hexA(c.c >= c.o ? th.bull : th.bear, .8) } })),
    }];
    volInst.setOption(volOpt);
    appState.charts.volume = volInst;
  } else {
    $('#chart-volume').style.display = 'none';
    const na = $('#chart-volume-na');
    na.style.display = '';
    na.textContent = T('chartVolumeNA');
  }

  // --- Volatility: Bollinger band width (%) with a gradient area.
  const bw = bollinger(cl, 20, 2).width.slice(-N).map((x) => (x === null ? null : +(x * 100).toFixed(3)));
  const vlyInst = echarts.init($('#chart-volatility'));
  const vlyOpt = echartsBase(th, labels);
  vlyOpt.series = [{
    type: 'line', data: bw, showSymbol: false, smooth: true, connectNulls: false,
    lineStyle: { width: 1.6, color: th.bear },
    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: hexA(th.bear, .35) }, { offset: 1, color: hexA(th.bear, 0) }]) },
  }];
  vlyInst.setOption(vlyOpt);
  appState.charts.volatility = vlyInst;
}

function renderReport() {
  const a = appState.analysis, s = appState.series;
  const titleEl = $('#report-title'), box = $('#report-body');
  titleEl.textContent = appState.lang === 'ar' ? 'التقرير التحليلي المكتوب' : 'Written analysis report';
  if (!a || !s) { box.innerHTML = appState.phase === 'loading' ? '<div class="skeleton"></div>' : ''; return; }
  const inst = findInstrument(appState.instrumentId);
  const rep = buildReport(a, s, inst, appState.lang);
  titleEl.textContent = rep.title;
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  box.innerHTML = `<div class="report-paras">${rep.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
}

function renderAll() {
  renderChrome();
  renderReading();
  renderReport();
  renderDetail();
  renderNews();
  renderCharts();
  renderTrendDuration();
  renderGauges();
  tickCountdown(); // fill the countdown chip renderChrome() just created; see its comment
}

// ---------------------------------------------------------------------------
// Actions & polling
// ---------------------------------------------------------------------------
function stopPolling() {
  if (appState.pollTimer) { clearInterval(appState.pollTimer); appState.pollTimer = null; }
  appState.nextPollAt = null;
}

// Countdown to the next automatic poll, based on the SAME pollIntervalMs(inst)
// the active poll timer was actually scheduled with (see startPolling) — so
// it's always accurate for whichever instrument is currently running, and
// resets the moment a poll actually occurs (each tick recomputes it below).
// Deliberately reads the wall clock, so — per this file's determinism
// contract (top of file) — it is kept OUT of renderChrome()/renderAll() and
// lives only here, called once right after each render (to fill the just-
// rendered countdown chip with no visible gap) and every second afterward
// from its own timer started in initUi().
function pollCountdownText() {
  if (!appState.nextPollAt) return null;
  const totalSec = Math.max(0, Math.ceil((appState.nextPollAt - Date.now()) / 1000));
  const m = Math.floor(totalSec / 60), s = totalSec % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function tickCountdown() {
  const el = document.getElementById('poll-countdown');
  if (!el) return;
  const text = pollCountdownText();
  if (text !== null) el.textContent = text;
}

async function runFlow() {
  const inst = findInstrument(appState.instrumentId);
  stopPolling();
  appState.phase = 'loading';
  appState.series = null; appState.analysis = null;
  renderAll();
  try {
    const series = await loadSeries(inst, appState.timeframe);
    // news is optional garnish — analysis proceeds without it
    let news = null;
    try { news = await fetchNews(inst); } catch (e) { news = { ok: false, items: [] }; }
    appState.series = series;
    appState.news = news;
    appState.newsForId = inst.id;
    appState.analysis = runAnalysis(series, news && news.ok ? news.items : []);
    appState.lastUpdateAt = Date.now(); // data-arrival timestamp (state, not render)
    appState.phase = 'ready';
  } catch (err) {
    // loadSeries never throws by contract; this is a belt-and-braces guard
    appState.phase = 'ready';
  }
  // start polling BEFORE the render below, so appState.nextPollAt is already
  // set (to THIS instrument's interval) by the time renderChrome() decides
  // whether to show the countdown chip at all — otherwise the chip wouldn't
  // appear until the first poll tick fires, up to pollIntervalMs later.
  startPolling(inst);
  renderAll();
}

function startPolling(inst) {
  stopPolling();
  appState.nextPollAt = Date.now() + pollIntervalMs(inst);
  appState.pollTimer = setInterval(async () => {
    if (!appState.series || appState.phase !== 'ready') return;
    const res = await pollTick(inst, appState.series);
    if (res.ok) {
      appState.series.meta.live = true;
      appState.lastUpdateAt = Date.now();
    } else if (res.error) {
      appState.series.meta.live = false; // show "last known values" honestly
    }
    // refresh news from cache/network at its own cadence (fetchNews self-caches 15 min)
    let items = appState.news && appState.news.ok ? appState.news.items : [];
    try {
      const news = await fetchNews(inst);
      if (news.ok) { appState.news = news; items = news.items; }
    } catch (e) { /* keep previous news */ }
    appState.analysis = runAnalysis(appState.series, items);
    appState.nextPollAt = Date.now() + pollIntervalMs(inst); // reset for the next cycle
    renderAll();
  }, pollIntervalMs(inst));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// Collapsible cards — every card header toggles its body, EXCEPT asset
// selection + current market reading, which are always-on: no chevron, no
// role/tabindex, no click/keydown listener is ever attached for them, so
// there is no interaction path (mouse or keyboard) that can collapse them —
// not just "permanently expanded with a dead button still showing." Their
// distinct visual treatment lives in styles.css (accent-tinted gradient +
// border). Every card — including the collapsible ones — starts EXPANDED on
// load; the toggle itself still works normally afterward. Collapse state
// lives as a class on the static .card element, so it survives renderAll()
// (which only rewrites body innerHTML) with no storage — session-only, reset
// on reload (§4).
// ---------------------------------------------------------------------------
const ALWAYS_EXPANDED = new Set(['selection', 'reading']);
function cardSection(name) { return document.querySelector(`.card[data-card="${name}"]`); }
function cardCollapsed(name) { const s = cardSection(name); return !!s && s.classList.contains('collapsed'); }

function setupCollapsibleCards() {
  // FontAwesome caret; expanded = down, collapsed = up (CSS rotate). Up/down
  // only — never left/right — so the direction reads the same in RTL and LTR.
  const chevron = '<i class="fa-solid fa-caret-down" aria-hidden="true"></i>';
  document.querySelectorAll('.card[data-card] .card-head').forEach((head) => {
    const section = head.closest('.card');
    if (ALWAYS_EXPANDED.has(section.dataset.card)) {
      section.classList.remove('collapsed'); // no chevron, no listeners, never collapsible
      return;
    }
    head.appendChild(el('span', 'card-chevron', chevron));
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    section.classList.remove('collapsed'); // every card starts expanded; toggle still works below
    head.setAttribute('aria-expanded', 'true');
    const toggle = () => {
      const collapsed = section.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!collapsed));
      // charts must be (re)drawn at real size when their card becomes visible
      if (!collapsed && section.dataset.card === 'charts') renderCharts();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

function initUi() {
  setupCollapsibleCards();
  // Live countdown to the next poll: a dedicated 1s ticker, entirely outside
  // renderAll()'s deterministic render path (see pollCountdownText()). Runs
  // for the page's lifetime; a no-op whenever the countdown chip isn't
  // present (idle, loading, or no active poll).
  setInterval(tickCountdown, 1000);
  // ECharts is not auto-responsive; resize instances on viewport change.
  let resizeRaf = null;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      for (const k of Object.keys(appState.charts)) {
        if (appState.charts[k]) appState.charts[k].resize();
      }
    });
  });
  $('#btn-ar').addEventListener('click', () => { appState.lang = 'ar'; renderAll(); });
  $('#btn-en').addEventListener('click', () => { appState.lang = 'en'; renderAll(); });
  $('#btn-theme').addEventListener('click', () => {
    appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
    renderAll(); // charts rebuilt with the new token palette (spec §2.2)
  });
  $('#sel-class').addEventListener('change', (e) => {
    appState.assetClass = e.target.value;
    appState.instrumentId = INSTRUMENTS[appState.assetClass][0].id;
    renderChrome();
  });
  $('#sel-instrument').addEventListener('change', (e) => {
    appState.instrumentId = e.target.value;
    // GOLD (intraday-capable) and SILVER (daily-locked) share the commodities
    // class, so the timeframe gating must refresh on instrument change too.
    renderChrome();
  });
  $('#sel-timeframe').addEventListener('change', (e) => {
    const inst = findInstrument(appState.instrumentId);
    if (supportsIntradayTimeframe(inst)) appState.timeframe = e.target.value;
  });
  $('#btn-run').addEventListener('click', runFlow);
  renderAll();
}

document.addEventListener('DOMContentLoaded', initUi);
