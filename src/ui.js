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
  lang: 'ar',            // default Arabic (spec §2.1)
  theme: 'dark',
  assetClass: 'crypto',
  instrumentId: 'BTCUSD',
  phase: 'idle',         // idle | loading | ready
  series: null,          // { candles, meta } from data layer
  analysis: null,        // runAnalysis() result
  news: null,            // fetchNews() result
  newsForId: null,       // which instrument the cached news belongs to
  lastUpdateAt: null,    // ms epoch of last successful data event (not render)
  pollTimer: null,
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
  themeBtn.textContent = appState.theme === 'dark' ? '☀' : '☾';
  themeBtn.title = T(appState.theme === 'dark' ? 'themeToLight' : 'themeToDark');

  const badge = $('#status-badge');
  badge.className = 'status-badge';
  let key = 'statusIdle';
  if (appState.phase === 'loading') key = 'statusLoading';
  else if (appState.phase === 'ready') {
    if (appState.series && appState.series.meta.live) { key = 'statusLive'; badge.classList.add('is-live'); }
    else { key = 'statusStale'; badge.classList.add('is-stale'); }
  }
  badge.innerHTML = `<span class="dot"></span><span>${T(key)}</span>` +
    (appState.lastUpdateAt ? ` <span class="num" style="font-weight:600">${fmtTime(appState.lastUpdateAt, L)}</span>` : '');

  // selection card
  $('#selection-title').textContent = T('selectionTitle');
  $('#label-class').textContent = T('assetClass');
  $('#label-instrument').textContent = T('instrument');
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

  $('#footer-sources').textContent = T('footerSources');
  $('#footer-disclaimer').textContent = T('footerDisclaimer');
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
  // consensus
  const c = a.consensus;
  html += `<div class="consensus">
      <span class="chip bull">${T('bullish')} <span class="count num">${c.bullish}</span></span>
      <span class="chip bear">${T('bearish')} <span class="count num">${c.bearish}</span></span>
      <span class="chip neut">${T('neutral')} <span class="count num">${c.neutral}</span></span>
      ${c.na ? `<span class="chip na">${T('naShort')} <span class="count num">${c.na}</span></span>` : ''}
      <span class="hint">${T('consensusNote')}</span>
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

function chartTheme() {
  return {
    text: cssVar('--text-2'), grid: cssVar('--grid-line'),
    accent: cssVar('--accent'), bull: cssVar('--bull'), bear: cssVar('--bear'), neut: cssVar('--neut'),
  };
}

function destroyCharts() {
  for (const k of Object.keys(appState.charts)) {
    if (appState.charts[k]) { appState.charts[k].destroy(); appState.charts[k] = null; }
  }
}

function renderCharts() {
  $('#charts-title').textContent = appState.lang === 'ar' ? 'الرسوم المصغّرة' : 'Mini-charts';
  const s = appState.series;
  destroyCharts();
  const priceT = $('#chart-price-t'), volT = $('#chart-volume-t'), vlyT = $('#chart-volatility-t');
  priceT.textContent = T('chartPrice'); volT.textContent = T('chartVolume'); vlyT.textContent = T('chartVolatility');
  if (!s || typeof Chart === 'undefined') return;
  const th = chartTheme();
  const N = 120;
  const candles = s.candles;
  const cl = candles.map((c) => c.c);
  const labels = candles.slice(-N).map((c) => {
    const dt = new Date(c.t);
    return s.meta.timeframe === '1h'
      ? dt.toISOString().slice(11, 16)
      : dt.toISOString().slice(5, 10);
  });
  const base = {
    responsive: true, animation: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: th.text, maxTicksLimit: 6, font: { size: 10 } }, grid: { color: th.grid } },
      y: { ticks: { color: th.text, font: { size: 10 } }, grid: { color: th.grid } },
    },
  };
  // price + EMA50 + KAMA
  const e50 = ema(cl, 50).slice(-N), km = kama(cl, 10, 2, 30).slice(-N);
  appState.charts.price = new Chart($('#chart-price'), {
    type: 'line',
    data: { labels, datasets: [
      { data: cl.slice(-N), borderColor: th.accent, borderWidth: 1.8, pointRadius: 0, tension: .25 },
      { data: e50, borderColor: th.bull, borderWidth: 1.1, pointRadius: 0, tension: .25 },
      { data: km, borderColor: th.neut, borderWidth: 1.1, pointRadius: 0, tension: .25, borderDash: [4, 3] },
    ] },
    options: base,
  });
  // volume (real volume only — never fabricated)
  if (s.meta.hasVolume) {
    $('#chart-volume').style.display = '';
    $('#chart-volume-na').style.display = 'none';
    const vols = candles.slice(-N).map((c) => c.v);
    const colors = candles.slice(-N).map((c) => (c.c >= c.o ? th.bull : th.bear));
    appState.charts.volume = new Chart($('#chart-volume'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vols, backgroundColor: colors }] },
      options: base,
    });
  } else {
    $('#chart-volume').style.display = 'none';
    const na = $('#chart-volume-na');
    na.style.display = '';
    na.textContent = T('chartVolumeNA');
  }
  // volatility: BB width
  const bw = bollinger(cl, 20, 2).width.slice(-N).map((x) => (x === null ? null : x * 100));
  appState.charts.volatility = new Chart($('#chart-volatility'), {
    type: 'line',
    data: { labels, datasets: [{ data: bw, borderColor: th.bear, borderWidth: 1.4, pointRadius: 0, tension: .25, fill: { target: 'origin', above: cssVar('--bear-soft') } }] },
    options: base,
  });
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
}

// ---------------------------------------------------------------------------
// Actions & polling
// ---------------------------------------------------------------------------
function stopPolling() {
  if (appState.pollTimer) { clearInterval(appState.pollTimer); appState.pollTimer = null; }
}

async function runFlow() {
  const inst = findInstrument(appState.instrumentId);
  stopPolling();
  appState.phase = 'loading';
  appState.series = null; appState.analysis = null;
  renderAll();
  try {
    const series = await loadSeries(inst);
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
  renderAll();
  startPolling(inst);
}

function startPolling(inst) {
  stopPolling();
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
    renderAll();
  }, pollIntervalMs(inst));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function initUi() {
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
  $('#sel-instrument').addEventListener('change', (e) => { appState.instrumentId = e.target.value; });
  $('#btn-run').addEventListener('click', runFlow);
  renderAll();
}

document.addEventListener('DOMContentLoaded', initUi);
