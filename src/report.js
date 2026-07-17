// ============================================================================
// WRITTEN ANALYSIS REPORT — a template engine that composes analytical prose
// from the current analysis result (spec §6). Replaces the dropped "Trading
// Verdict" concept: it explains WHAT EACH TIER SHOWS AND WHY, in the
// analysis-not-advice framing, and narrates every caveat in plain language so
// the report alone gives an accurate picture (proxy sources, seed history,
// close-only data, NA readings, redistributed weights, fallback mode).
//
// Determinism: buildReport(analysis, series, inst, lang) is a pure function —
// same inputs, same text, always. All variation is conditional on the data
// (intensity buckets, squeeze phase, NA states…), never random.
//
// Each language's templates are written natively (not translated line-by-line)
// as a table of template functions keyed by string ID — the same single-object
// i18n pattern as i18n.js, with functions because prose needs interpolation
// and real grammar, not slot-filling.
// ============================================================================

// intensity buckets shared by both languages: |x| >= .6 strong, >= .3 clear,
// > .15 mild, else flat/neutral
function bucket(x) {
  if (x === null) return 'na';
  const a = Math.abs(x);
  if (a >= 0.6) return 'strong';
  if (a >= 0.3) return 'clear';
  if (a > 0.15) return 'mild';
  return 'flat';
}
const dirOf = (x) => (x === null ? 'na' : x > 0.15 ? 'up' : x < -0.15 ? 'down' : 'flat');

const num2 = (x) => (x === null || !Number.isFinite(x) ? '—' : (x > 0 ? '+' : '') + x.toFixed(2));
const px = (x, d) => (x === null || !Number.isFinite(x) ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));

const REPORT_T = {
  // ==========================================================================
  ar: {
    title: () => 'التقرير التحليلي المكتوب',
    // ---- opening --------------------------------------------------------
    open: ({ name, price, d, lean, b, score, live }) => {
      const leanTxt = {
        up: { strong: 'ميلاً صاعداً واضحاً في مؤشراتها', clear: 'ميلاً صاعداً ملموساً في مؤشراتها', mild: 'ميلاً صاعداً طفيفاً في مؤشراتها' },
        down: { strong: 'ميلاً هابطاً واضحاً في مؤشراتها', clear: 'ميلاً هابطاً ملموساً في مؤشراتها', mild: 'ميلاً هابطاً طفيفاً في مؤشراتها' },
      };
      const base = lean === 'flat' || lean === 'na'
        ? `تعرض بيانات ${name} عند سعر ${px(price, d)} صورةً مختلطة لا يغلب عليها اتجاه حاسم، إذ تقف القراءة المركبة عند ${num2(score)} داخل النطاق المحايد.`
        : `تُظهر بيانات ${name} عند سعر ${px(price, d)} ${leanTxt[lean][b]}، بقراءة مركبة قدرها ${num2(score)} على مقياس من −1 إلى +1.`;
      return base + (live ? '' : ' (تنبيه: تعذّر الوصول إلى المصدر المباشر، وهذه القراءة محسوبة على آخر قيم معروفة.)');
    },
    // ---- tier 1 -----------------------------------------------------------
    t1Head: () => 'الطبقة الأساسية (وزنها 20٪):',
    t1Ema: ({ above, spread }) => above
      ? `السعر يتحرك فوق متوسطه الأسّي الخمسيني، والمتوسط الخمسيني ${spread === 'up' ? 'يتموضع بدوره فوق متوسط المئتي فترة — وهو ترتيب يصفه المحللون عادةً بالبنية الصاعدة' : 'ما يزال دون متوسط المئتي فترة، أي أن البنية الأطول أمداً لم تنسجم بعد مع الحركة القصيرة'}.`
      : `السعر يتحرك دون متوسطه الأسّي الخمسيني، والمتوسط الخمسيني ${spread === 'down' ? 'يقع أيضاً تحت متوسط المئتي فترة — ترتيب يعكس بنية هابطة في الإطارين معاً' : 'ما يزال فوق متوسط المئتي فترة، فالصورة الطويلة لم تتحول هبوطاً بعد'}.`,
    t1Rsi: ({ v, zone }) => zone === 'overbought'
      ? `مؤشر القوة النسبية عند ${v.toFixed(1)} داخل منطقة التشبّع الشرائي، أي أن الحركة الأخيرة مشدودة إلى الأعلى قياساً بإيقاعها المعتاد.`
      : zone === 'oversold'
        ? `مؤشر القوة النسبية عند ${v.toFixed(1)} داخل منطقة التشبّع البيعي، أي أن الحركة الأخيرة مشدودة إلى الأسفل قياساً بإيقاعها المعتاد.`
        : `مؤشر القوة النسبية عند ${v.toFixed(1)} في المنطقة الوسطى، بلا تشبّع في أي من الاتجاهين.`,
    // spec §0 bans the word "signal" in copy, so MACD's conventional
    // "signal line" is rendered as its reference line (its 9-period average)
    t1Macd: ({ dir }) => dir === 'up'
      ? 'خط الماكد يتحرك فوق خطه المرجعي (متوسط تسع فترات)، بما يصف زخماً قصير الأمد مائلاً للصعود.'
      : dir === 'down'
        ? 'خط الماكد يتحرك تحت خطه المرجعي (متوسط تسع فترات)، بما يصف زخماً قصير الأمد مائلاً للهبوط.'
        : 'خط الماكد ملاصق لخطه المرجعي تقريباً، فالزخم القصير بلا حسم.',
    t1Bb: ({ pctB }) => pctB >= 0.8
      ? 'ويجري التداول قرب الحد الأعلى لنطاقات بولينجر.'
      : pctB <= 0.2
        ? 'ويجري التداول قرب الحد الأدنى لنطاقات بولينجر.'
        : 'ويجري التداول في المنطقة الوسطى من نطاقات بولينجر.',
    // ---- tier 2 -----------------------------------------------------------
    t2Head: () => 'الطبقة التكيّفية (وزنها 30٪):',
    t2Kama: ({ dir }) => dir === 'up'
      ? 'متوسط كوفمان التكيّفي — وهو متوسط يتسارع مع وضوح الاتجاه ويتباطأ مع الضجيج — ينحدر صعوداً والسعر فوقه'
      : dir === 'down'
        ? 'متوسط كوفمان التكيّفي — وهو متوسط يتسارع مع وضوح الاتجاه ويتباطأ مع الضجيج — ينحدر هبوطاً والسعر دونه'
        : 'متوسط كوفمان التكيّفي يسير أفقياً تقريباً، وهو سلوكه المعتاد حين يطغى الضجيج على الاتجاه',
    t2Lag: ({ v }) => v >= 0.8
      ? `، فيما يقف مرشّح لاغير عند ${v.toFixed(2)} قرب سقفه — قراءة زخم مرتفعة بوضوح.`
      : v <= 0.2
        ? `، فيما يقف مرشّح لاغير عند ${v.toFixed(2)} قرب قاعه — قراءة زخم منخفضة بوضوح.`
        : `، فيما يقف مرشّح لاغير عند ${v.toFixed(2)} في منتصف مداه.`,
    t2SqueezeOn: () => 'الأهم في هذه الطبقة أن مؤشر الانضغاط يرصد حالياً انكماش نطاقات بولينجر داخل قنوات كلتنر — أي أن التقلب يتجمّع في نطاق ضيق. هذه الحالة تسبق عادةً حركة أوسع، لكنها لا تحدد وجهتها، ولذلك تُقرأ إشارة الاتجاه من هذه الطبقة بحذر أكبر ما دام الانضغاط قائماً.',
    t2SqueezeOff: ({ dir }) => `مؤشر الانضغاط في طور التمدد، أي أن التقلب المخزّن قد تحرر بالفعل، وميل زخم التمدد الحالي ${dir === 'up' ? 'صاعد' : dir === 'down' ? 'هابط' : 'بلا اتجاه غالب'}.`,
    // ---- tier 3 -----------------------------------------------------------
    t3Head: () => 'مركّب فئة الأصل (وزنه 50٪):',
    t3Forex: ({ sup, res, d, lrsiAgree, dir }) => {
      let s = 'يقيس هذا المركّب موضع السعر من مناطق التأرجح المختبرة (قمم وقيعان يومية متجمعة) مع تأكيد الزخم من مرشّح لاغير. ';
      if (sup) s += `أقرب منطقة دعم بنيوية تقع حول ${px(sup.price, d)} (لُمست ${sup.touches === 1 ? 'مرة واحدة' : sup.touches === 2 ? 'مرتين' : sup.touches + ' مرات'})`;
      if (res) s += `${sup ? '، وأقرب مقاومة حول ' : 'أقرب منطقة مقاومة بنيوية تقع حول '}${px(res.price, d)} (${res.touches === 1 ? 'لمسة واحدة' : res.touches + ' لمسات'})`;
      s += '. ';
      s += lrsiAgree
        ? 'ويأتي الزخم متسقاً مع موضع السعر من هذه المناطق، فيعزز أحدهما قراءة الآخر.'
        : 'غير أن الزخم لا يؤكد موضع السعر من هذه المناطق، وهو تعارض يُضعف حسم هذه الطبقة.';
      if (dir !== 'na') s += ` محصلة المركّب ${dir === 'up' ? 'تميل صعوداً' : dir === 'down' ? 'تميل هبوطاً' : 'محايدة'}.`;
      return s;
    },
    t3Crypto: ({ cmf, z, phase, stretched }) => {
      let s = `يجمع هذا المركّب تدفق الأموال (CMF) مع انحراف السعر عن متوسطه المرجّح بالتداول. تدفق الأموال عند ${num2(cmf)} — ${cmf > 0.05 ? 'أي أن حجم التداول ينحاز إلى موجات الصعود' : cmf < -0.05 ? 'أي أن حجم التداول ينحاز إلى موجات الهبوط' : 'قراءة شبه متعادلة بين موجات الصعود والهبوط'} — والسعر ${Math.abs(z) < 0.5 ? 'ملاصق تقريباً لمتوسطه المرجّح' : `منحرف عن متوسطه المرجّح بمقدار ${num2(z)} انحرافاً معيارياً ${z > 0 ? 'إلى الأعلى' : 'إلى الأسفل'}`}.`;
      if (stretched) s += ' ولأن هذا الانحراف تجاوز حدود امتداده المعتادة، يخفّض المركّب وزن هذه القراءة بدل تضخيمها — فالامتداد المفرط وصفٌ للتمدد لا تأكيد له.';
      s += ` نطاقات التقلب حالياً في طور ${phase === 'expansion' ? 'تمدد' : 'انكماش'}.`;
      return s;
    },
    t3Commodity: ({ adxV, dirWord, pct, damped, c2c }) => {
      let s = `يقيس هذا المركّب قوة الاتجاه عبر ADX مع معايرة التقلب على مدى ATR التاريخي. قراءة ADX عند ${adxV.toFixed(1)} ${adxV >= 25 ? '— فوق عتبة الاتجاه المعتبرة (25)، أي أن هناك اتجاهاً فعلياً قائماً' : '— دون عتبة الاتجاه المعتبرة (25)، أي أن الحركة أقرب إلى التذبذب منها إلى الاتجاه'}، وميل مؤشري الاتجاه ${dirWord === 'up' ? 'لمصلحة الصعود' : dirWord === 'down' ? 'لمصلحة الهبوط' : 'متعادل تقريباً'}.`;
      s += ` التقلب الحالي يقع عند المئين ${Math.round(pct * 100)} من مداه التاريخي`;
      s += damped ? '، وهو ارتفاع كافٍ ليخفّض المركّبُ حسمَه — فالتقلب الحاد في المعادن كثيراً ما يتنكر بهيئة اتجاه.' : '.';
      if (c2c) s += ' (حُسبت هذه المقاييس بنسخة "إغلاقٍ إلى إغلاق" لأن سلسلة هذه الأداة يومية بلا مدى لحظي — انظر فقرة الملاحظات.)';
      return s;
    },
    t3Na: ({ reason }) => `هذه الطبقة غير متاحة لهذه الأداة حالياً (${reason === 'volume' ? 'تتطلب بيانات حجم تداول لحظية غير متوفرة لهذه السلسلة' : 'التاريخ المتاح أقصر من فترة حسابها'})، وقد أُعيد توزيع وزنها على الطبقات المتاحة كما هو مبيّن أدناه.`,
    // ---- sentiment + fusion ------------------------------------------------
    sentAvail: ({ score, n }) => `قراءة الأخبار: متوسط درجة العناوين الـ${n} المفحوصة يبلغ ${num2(score)}${score > 0.15 ? '، أي نبرة إخبارية مائلة للتفاؤل' : score < -0.15 ? '، أي نبرة إخبارية مائلة للتشاؤم' : '، أي نبرة إخبارية شبه محايدة'}. تدخل هذه القراءة بوزن 30٪ في القراءة النهائية.`,
    sentNa: () => 'قراءة الأخبار: لم يتسنَّ الوصول إلى مصدر الأخبار في هذه الجلسة، ولذلك فالقراءة النهائية فنية بحتة ولا تتضمن مكوّن المشاعر — ولم تُختلق أي قيمة بديلة.',
    fusion: ({ score, w, redistributed }) => {
      let s = `التجميع: تتألف القراءة الفنية المركبة (${num2(score)}) من الطبقات الثلاث`;
      s += redistributed
        ? `، مع تنبيه صريح: الأوزان المعيارية (20/30/50) أُعيد توزيعها فعلياً إلى ${Math.round(w.t1 * 100)}٪/${Math.round(w.t2 * 100)}٪/${Math.round(w.t3 * 100)}٪ لغياب بيانات كافية لبعض المكوّنات، فالقراءة أدناه مبنية على ما توفر فقط.`
        : ' بأوزانها المعيارية: 20٪ للأساسية و30٪ للتكيّفية و50٪ لمركّب فئة الأصل.';
      return s;
    },
    // ---- caveats ------------------------------------------------------------
    cavHead: () => 'ملاحظات يجب قراءتها مع هذا التقرير:',
    cavGold: () => 'شموع الذهب مستمدة من رمز PAXG المدعوم بالذهب على منصة Binance، وهو يتتبع السعر الفوري ضمن نحو 0.3٪ — السعر الفوري الرسمي معروض في الواجهة للمقارنة.',
    cavSilver: () => 'سلسلة الفضة التاريخية مضمّنة من بيانات يومية حقيقية جُمعت وقت بناء الأداة، ويُحدَّث سعر اليوم فقط من مصدر فوري مباشر، إذ لا يتوفر مصدر تاريخي مجاني مباشر للفضة.',
    cavForex: () => 'أسعار العملات هنا إغلاقات يومية رسمية (أسعار مرجعية من البنك المركزي الأوروبي) لا بيانات لحظية، ولذلك حُسبت مؤشرات المدى بنسخة "إغلاقٍ إلى إغلاق" الموثقة.',
    cavNa: ({ names }) => `مؤشرات غير متاحة لهذه الأداة: ${names.join('، ')} — تُستبعد من المتوسطات بدل تقدير قيم لها.`,
    cavFallback: () => 'المصدر المباشر كان متعذراً أثناء هذا التحليل، فالأرقام كلها مبنية على آخر لقطة بيانات معروفة.',
    // ---- closing -------------------------------------------------------------
    close: () => 'هذا التقرير وصفٌ آلي لما تُظهره البيانات لحظة توليده، وليس نصيحة استثمارية ولا دعوة لاتخاذ أي إجراء. تتغير القراءات بتغير البيانات.',
  },
  // ==========================================================================
  en: {
    title: () => 'Written analysis report',
    open: ({ name, price, d, lean, b, score, live }) => {
      const leanTxt = {
        up: { strong: 'a pronounced bullish skew', clear: 'a distinct bullish skew', mild: 'a slight bullish skew' },
        down: { strong: 'a pronounced bearish skew', clear: 'a distinct bearish skew', mild: 'a slight bearish skew' },
      };
      const base = lean === 'flat' || lean === 'na'
        ? `At ${px(price, d)}, the data for ${name} presents a mixed picture with no dominant direction — the combined reading sits at ${num2(score)}, inside the neutral band.`
        : `At ${px(price, d)}, the data for ${name} currently shows ${leanTxt[lean][b]}, with a combined reading of ${num2(score)} on a −1 to +1 scale.`;
      return base + (live ? '' : ' (Note: the live source was unreachable; this reading is computed from the last known values.)');
    },
    t1Head: () => 'Baseline tier (20% weight):',
    t1Ema: ({ above, spread }) => above
      ? `Price is trading above its 50-period EMA, and the 50 itself ${spread === 'up' ? 'sits above the 200 — the arrangement analysts usually describe as an intact bullish structure' : 'still sits below the 200, so the longer structure has not yet aligned with the shorter-term move'}.`
      : `Price is trading below its 50-period EMA, and the 50 ${spread === 'down' ? 'also sits below the 200 — a configuration bearish on both horizons' : 'still holds above the 200, so the longer picture has not turned lower yet'}.`,
    t1Rsi: ({ v, zone }) => zone === 'overbought'
      ? `RSI stands at ${v.toFixed(1)}, in overbought territory — the recent move is stretched to the upside relative to its usual rhythm.`
      : zone === 'oversold'
        ? `RSI stands at ${v.toFixed(1)}, in oversold territory — the recent move is stretched to the downside relative to its usual rhythm.`
        : `RSI stands at ${v.toFixed(1)}, mid-range, stretched in neither direction.`,
    // spec §0 bans the word "signal" in copy — MACD's "signal line" is
    // therefore described as its reference line (the 9-period average)
    t1Macd: ({ dir }) => dir === 'up'
      ? 'The MACD line runs above its 9-period reference line, describing short-term momentum that tilts upward.'
      : dir === 'down'
        ? 'The MACD line runs below its 9-period reference line, describing short-term momentum that tilts downward.'
        : 'The MACD line hugs its 9-period reference line; short-term momentum is undecided.',
    t1Bb: ({ pctB }) => pctB >= 0.8
      ? 'Trade is pressing the upper Bollinger band.'
      : pctB <= 0.2
        ? 'Trade is pressing the lower Bollinger band.'
        : 'Trade sits in the middle of the Bollinger range.',
    t2Head: () => 'Adaptive tier (30% weight):',
    t2Kama: ({ dir }) => dir === 'up'
      ? 'Kaufman’s adaptive average — which speeds up in clean trends and slows down in noise — is sloping upward with price above it'
      : dir === 'down'
        ? 'Kaufman’s adaptive average — which speeds up in clean trends and slows down in noise — is sloping downward with price beneath it'
        : 'Kaufman’s adaptive average is tracking essentially sideways, its usual behaviour when noise dominates trend',
    t2Lag: ({ v }) => v >= 0.8
      ? `, while the Laguerre filter reads ${v.toFixed(2)}, pinned near its ceiling — an unambiguously elevated momentum reading.`
      : v <= 0.2
        ? `, while the Laguerre filter reads ${v.toFixed(2)}, pinned near its floor — an unambiguously depressed momentum reading.`
        : `, while the Laguerre filter reads ${v.toFixed(2)}, mid-range.`,
    t2SqueezeOn: () => 'The notable feature of this tier is an active volatility squeeze: the Bollinger bands have contracted inside the Keltner channel, meaning volatility is coiling in a narrow range. That condition usually precedes a wider move but says nothing about its direction, so directional cues from this tier are read with extra caution while the squeeze holds.',
    t2SqueezeOff: ({ dir }) => `The squeeze indicator is in its expansion phase — stored volatility has already been released — and the expansion momentum currently tilts ${dir === 'up' ? 'upward' : dir === 'down' ? 'downward' : 'no way in particular'}.`,
    t3Head: () => 'Asset-class composite (50% weight):',
    t3Forex: ({ sup, res, d, lrsiAgree, dir }) => {
      let s = 'This composite measures where price sits relative to tested swing zones (clustered daily highs and lows) with momentum confirmation from the Laguerre filter. ';
      if (sup) s += `The nearest structural support zone lies around ${px(sup.price, d)} (touched ${sup.touches === 1 ? 'once' : sup.touches + ' times'})`;
      if (res) s += `${sup ? ', the nearest resistance around ' : 'The nearest structural resistance zone lies around '}${px(res.price, d)} (${res.touches === 1 ? 'one touch' : res.touches + ' touches'})`;
      s += '. ';
      s += lrsiAgree
        ? 'Momentum currently agrees with price’s position against these zones, each reinforcing the other’s reading.'
        : 'Momentum, however, does not confirm price’s position against these zones — a disagreement that weakens this tier’s conviction.';
      if (dir !== 'na') s += ` The composite nets out ${dir === 'up' ? 'leaning higher' : dir === 'down' ? 'leaning lower' : 'neutral'}.`;
      return s;
    },
    t3Crypto: ({ cmf, z, phase, stretched }) => {
      let s = `This composite pairs Chaikin Money Flow with price’s deviation from its volume-weighted average. CMF reads ${num2(cmf)} — ${cmf > 0.05 ? 'volume is siding with the up-moves' : cmf < -0.05 ? 'volume is siding with the down-moves' : 'volume is split roughly evenly between up- and down-moves'} — and price is ${Math.abs(z) < 0.5 ? 'hugging its volume-weighted average' : `stretched ${num2(z)} standard deviations ${z > 0 ? 'above' : 'below'} it`}.`;
      if (stretched) s += ' Because that stretch exceeds its usual bounds, the composite damps this reading rather than amplifying it — an extreme extension describes stretch, it does not confirm it.';
      s += ` Volatility bands are currently in ${phase === 'expansion' ? 'an expansion' : 'a contraction'} phase.`;
      return s;
    },
    t3Commodity: ({ adxV, dirWord, pct, damped, c2c }) => {
      let s = `This composite gauges trend strength through ADX, calibrated against the instrument’s own ATR history. ADX reads ${adxV.toFixed(1)} ${adxV >= 25 ? '— above the conventional trending threshold of 25, so a genuine trend is in force' : '— below the conventional trending threshold of 25, so the action is closer to chop than trend'} — with the directional-movement lines ${dirWord === 'up' ? 'favouring the upside' : dirWord === 'down' ? 'favouring the downside' : 'roughly balanced'}.`;
      s += ` Current volatility sits at the ${Math.round(pct * 100)}th percentile of its own history`;
      s += damped ? ', high enough that the composite deliberately reduces its conviction — in metals, violent volatility often masquerades as trend.' : '.';
      if (c2c) s += ' (These measures use the documented close-to-close variants, as this instrument’s series is daily with no intraday range — see the notes paragraph.)';
      return s;
    },
    t3Na: ({ reason }) => `This tier is unavailable for this instrument at the moment (${reason === 'volume' ? 'it requires intraday volume data this series does not carry' : 'the available history is shorter than its lookback'}); its weight has been redistributed across the available tiers, as noted below.`,
    sentAvail: ({ score, n }) => `News reading: the average score across the ${n} examined headlines is ${num2(score)}${score > 0.15 ? ' — a news tone leaning optimistic' : score < -0.15 ? ' — a news tone leaning pessimistic' : ' — an essentially neutral news tone'}. It enters the final reading at 30% weight.`,
    sentNa: () => 'News reading: the news source could not be reached this session, so the final reading is purely technical with no sentiment component — no substitute value was invented.',
    fusion: ({ score, w, redistributed }) => {
      let s = `Fusion: the composite technical reading (${num2(score)}) combines the three tiers`;
      s += redistributed
        ? `, with an explicit caveat: the standard 20/30/50 weights were actually redistributed to ${Math.round(w.t1 * 100)}%/${Math.round(w.t2 * 100)}%/${Math.round(w.t3 * 100)}% because some components lack sufficient data, so the reading rests only on what was available.`
        : ' at their standard weights: 20% baseline, 30% adaptive, 50% asset-class composite.';
      return s;
    },
    cavHead: () => 'Notes that belong with this report:',
    cavGold: () => 'Gold candles are sourced from PAXG, a gold-backed token on Binance that tracks spot within roughly 0.3% — the official spot price is shown in the interface for comparison.',
    cavSilver: () => 'Silver’s historical series is embedded from real daily data collected when this tool was built; only today’s price updates from a live spot feed, as no free live-history source exists for silver.',
    cavForex: () => 'FX prices here are official daily closes (ECB reference rates), not intraday data, so range-based indicators use the documented close-to-close variants.',
    cavNa: ({ names }) => `Indicators unavailable for this instrument: ${names.join(', ')} — they are excluded from the averages rather than estimated.`,
    cavFallback: () => 'The live source was unreachable during this analysis; every figure rests on the last known data snapshot.',
    close: () => 'This report is an automated description of what the data showed at the moment it was generated — not investment advice, and not a prompt to act. Readings change as the data changes.',
  },
};

// ---------------------------------------------------------------------------
// Composer — walks the analysis result once and assembles paragraphs.
// ---------------------------------------------------------------------------
function buildReport(analysis, series, inst, lang) {
  const R = REPORT_T[lang] || REPORT_T.ar;
  const d = inst.decimals;
  const a = analysis;
  const find = (id) => a.indicators.find((i) => i.id === id);
  const paras = [];

  // opening
  paras.push(R.open({
    name: lang === 'ar' ? inst.labelAr : inst.labelEn,
    price: a.price, d,
    lean: dirOf(a.combined), b: bucket(a.combined), score: a.combined,
    live: !!series.meta.live,
  }));

  // tier 1 — only narrate members that actually have data
  const emaI = find('emaCross'), rsiI = find('rsi'), macdI = find('macd'), bbI = find('bollinger');
  const t1bits = [];
  if (emaI.reading !== null) {
    t1bits.push(R.t1Ema({
      above: a.price > emaI.value.ema50,
      spread: emaI.value.ema50 > emaI.value.ema200 ? 'up' : 'down',
    }));
  }
  if (rsiI.reading !== null) t1bits.push(R.t1Rsi({ v: rsiI.value, zone: rsiI.zone }));
  if (macdI.reading !== null) t1bits.push(R.t1Macd({ dir: dirOf(macdI.reading) }));
  if (bbI.reading !== null) t1bits.push(R.t1Bb({ pctB: bbI.value.pctB }));
  if (t1bits.length) paras.push(R.t1Head() + ' ' + t1bits.join(' '));

  // tier 2 — squeeze state visibly reshapes the paragraph
  const kamaI = find('kama'), lagI = find('laguerre'), sqI = find('squeeze');
  const t2bits = [];
  if (kamaI.reading !== null || lagI.reading !== null) {
    let s = '';
    if (kamaI.reading !== null) s += R.t2Kama({ dir: dirOf(kamaI.reading) });
    if (lagI.reading !== null) s += R.t2Lag({ v: lagI.value });
    else if (s) s += '.';
    if (s) t2bits.push(s);
  }
  if (sqI.reading !== null) {
    t2bits.push(sqI.value.on ? R.t2SqueezeOn() : R.t2SqueezeOff({ dir: dirOf(sqI.reading) }));
  }
  if (t2bits.length) paras.push(R.t2Head() + ' ' + t2bits.join(' '));

  // tier 3 — one narrative per asset class
  const t3 = a.tiers.t3.composite;
  let t3text;
  if (t3.reading === null) {
    t3text = R.t3Na({ reason: t3.reason === 'volume-unavailable' ? 'volume' : 'history' });
  } else if (t3.id === 't3forex') {
    const det = t3.detail;
    t3text = R.t3Forex({
      sup: det.nearestSupport, res: det.nearestResistance, d,
      lrsiAgree: Math.sign((det.laguerre - 0.5)) === Math.sign(t3.reading) || Math.abs(t3.reading) <= 0.15,
      dir: dirOf(t3.reading),
    });
  } else if (t3.id === 't3crypto') {
    const det = t3.detail;
    t3text = R.t3Crypto({ cmf: det.cmf, z: det.vwapZ, phase: det.volatilityPhase, stretched: Math.abs(det.vwapZ) > 2.5 });
  } else {
    const det = t3.detail;
    t3text = R.t3Commodity({
      adxV: det.adx, dirWord: det.plusDi - det.minusDi > 2 ? 'up' : det.minusDi - det.plusDi > 2 ? 'down' : 'flat',
      pct: det.atrPercentile, damped: det.atrPercentile > 0.85, c2c: !series.meta.ohlc,
    });
  }
  paras.push(R.t3Head() + ' ' + t3text);

  // sentiment + fusion
  paras.push(a.sentimentIncluded
    ? R.sentAvail({ score: a.sentiment.score, n: a.sentiment.perHeadline.length })
    : R.sentNa());
  const wu = a.weightsUsed || {};
  const redistributed = ['t1', 't2', 't3'].some((k) =>
    Math.abs((wu[k] ?? 0) - { t1: 0.2, t2: 0.3, t3: 0.5 }[k]) > 0.001);
  paras.push(R.fusion({ score: a.compositeTechnical, w: wu, redistributed }));

  // caveats — every disclosure the cards make, restated as prose
  const cav = [];
  if (inst.id === 'GOLD') cav.push(R.cavGold());
  if (inst.id === 'SILVER') cav.push(R.cavSilver());
  if (inst.source === 'frankfurter') cav.push(R.cavForex());
  if (!series.meta.live) cav.push(R.cavFallback());
  const nameKey = {
    emaCross: 'indEmaCross', rsi: 'indRsi', macd: 'indMacd', bollinger: 'indBollinger',
    kama: 'indKama', laguerre: 'indLaguerre', squeeze: 'indSqueeze', cmf: 'indCmf',
    t3forex: 'indT3forex', t3crypto: 'indT3crypto', t3commodity: 'indT3commodity',
  };
  const naNames = a.indicators.filter((i) => i.state === 'na')
    .map((i) => t(lang, nameKey[i.id] || i.id));
  if (naNames.length) cav.push(R.cavNa({ names: naNames }));
  if (cav.length) paras.push(R.cavHead() + ' ' + cav.join(' '));

  paras.push(R.close());
  return { title: R.title(), paragraphs: paras };
}
