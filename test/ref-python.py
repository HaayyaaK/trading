# pandas-ta reference comparison (dev-only). Reads test/mine.json produced by
# indicators-ref-test.mjs and compares my JS outputs against pandas_ta.
#
# Comparison policy: recursive indicators (RSI/ATR/ADX via Wilder RMA, KAMA,
# EMA-based MACD) are seeded differently across libraries — pandas-ta seeds RMA
# with plain EWM weighting from bar 0 and seeds KAMA at literal 0, while this
# project (like TA-Lib / technicalindicators) seeds with the SMA of the first
# window (KAMA: with the first close). Early bars therefore legitimately differ
# and the honest check is tail convergence: the last 100 bars must agree to a
# tight tolerance. Non-recursive indicators (SMA-based BB, CMF, EMA after
# convergence) are compared across the whole overlap.
import json, sys, math
from pathlib import Path
import pandas as pd
import pandas_ta as ta

mine = json.loads((Path(__file__).parent / "mine.json").read_text())
df = pd.DataFrame(mine["candles"], columns=["t", "open", "high", "low", "close", "volume"])

failures = 0

def tail_cmp(name, mine_arr, ref_series, tol, n=100, note=""):
    global failures
    m = [x for x in mine_arr if x is not None][-n:]
    r = [x for x in ref_series.dropna().tolist()][-n:]
    k = min(len(m), len(r))
    if k < n * 0.8:
        print(f"FAIL  {name} - only {k} comparable pts"); failures += 1; return
    maxdiff = max(abs(a - b) for a, b in zip(m[-k:], r[-k:]))
    ok = maxdiff <= tol
    print(f"{'PASS' if ok else 'FAIL'}  {name} - last {k} bars, maxDiff={maxdiff:.2e} (tol {tol}) {note}")
    if not ok: failures += 1

full = lambda name, mine_arr, ref, tol, note="": tail_cmp(name, mine_arr, ref, tol, n=470, note=note)

full("EMA(50)        vs pandas_ta", mine["ema50"], ta.ema(df.close, length=50), 1e-6)
bb = ta.bbands(df.close, length=20, std=2, ddof=0)
full("BB upper       vs pandas_ta (ddof=0)", mine["bbUpper"], bb.iloc[:, 2], 1e-6)
full("BB lower       vs pandas_ta (ddof=0)", mine["bbLower"], bb.iloc[:, 0], 1e-6)
full("CMF(20)        vs pandas_ta", mine["cmf20"], ta.cmf(df.high, df.low, df.close, df.volume, length=20), 1e-6)

tail_cmp("RSI(14) tail   vs pandas_ta", mine["rsi14"], ta.rsi(df.close, length=14), 1e-6,
         note="(seeding differs in warmup, converges)")
tail_cmp("MACD line tail vs pandas_ta", mine["macdLine"], ta.macd(df.close, fast=12, slow=26, signal=9).iloc[:, 0], 1e-6)
tail_cmp("ATR(14) tail   vs pandas_ta", mine["atr14"], ta.atr(df.high, df.low, df.close, length=14), 1e-6)
tail_cmp("ADX(14) tail   vs pandas_ta", mine["adx14"], ta.adx(df.high, df.low, df.close, length=14).iloc[:, 0], 1e-6)
tail_cmp("KAMA tail      vs pandas_ta", mine["kama"], ta.kama(df.close, length=10, fast=2, slow=30), 1e-4,
         note="(pandas-ta seeds KAMA at 0, mine at first close; tails converge)")

# Squeeze reference, composed from pandas-ta primitives with pinned conventions:
# BB(20,2, population stdev — Bollinger's definition, ddof=0) fully inside
# KC(20, 1.5x SMA-of-TR). NOTE: stock ta.squeeze() internally uses bbands with
# its code-default ddof=1 (its own docstring says 0) — that convention mismatch,
# not formula error, is why the stock comparison below sits at ~97%.
bb0 = ta.bbands(df.close, length=20, std=2, ddof=0, mamode="sma")
kc = ta.kc(df.high, df.low, df.close, length=20, scalar=1.5, mamode="sma", tr=True)
ref_on = (bb0.iloc[:, 2] < kc.iloc[:, 2]) & (bb0.iloc[:, 0] > kc.iloc[:, 0])
pairs = [(a, bool(b)) for a, b in zip(mine["squeezeOn"], ref_on.tolist()) if a is not None]
agree = sum(1 for a, b in pairs if a == b)
ok = bool(pairs) and agree == len(pairs)
print(f"{'PASS' if ok else 'FAIL'}  Squeeze ON/OFF vs pandas_ta bbands(ddof=0)+kc - {agree}/{len(pairs)} bars agree")
failures += 0 if ok else 1

sq = ta.squeeze(df.high, df.low, df.close, bb_length=20, bb_std=2, kc_length=20, kc_scalar=1.5, use_tr=True)
pairs2 = [(a, bool(b)) for a, b in zip(mine["squeezeOn"], sq["SQZ_ON"].tolist()) if a is not None]
agree2 = sum(1 for a, b in pairs2 if a == b)
print(f"INFO  Squeeze vs stock ta.squeeze() - {agree2}/{len(pairs2)} agree (expected <100%: ddof=1 quirk)")

print(f"\n{failures} FAILURES" if failures else "\nall pandas-ta checks passed")
sys.exit(1 if failures else 0)
