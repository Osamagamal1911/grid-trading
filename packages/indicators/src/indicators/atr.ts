/**
 * alphaGrid S6 — Average True Range (Wilder's smoothing) for volatility-adaptive grids.
 *
 * What: ATR(14) over atrTimeframe candles; `levelSpacing = atrMultiplier × ATR`
 * (spec §4.2). Follows the existing indicator module pattern (async fn,
 * `IndicatorError`, NaN-padding) and delegates smoothing to the already-vendored
 * `technicalindicators` lib, whose ATR is TrueRange → WEMA(α=1/N, SMA-seeded) —
 * i.e. Wilder's definition, verified by the hand-computed fixture test (D33).
 *
 * Why ATR: fixed grids die on regime change (AKE-style pumps then bleeds); ATR
 * makes level spacing follow realized volatility. Manual mode bypasses this
 * entirely (S7 selection); backtest feeds the same fn candle data (§4.5 parity).
 *
 * Seeding note (D34): with no previous close, candle 1 yields no TR — the first
 * defined value sits at candle index `periods` (seed = SMA of TR[1..periods]).
 * After the 20-close warmup this converges with textbook seeding; grid spacing
 * always uses the latest value, so the transient is irrelevant.
 */

import type { ICandlestick } from "@opentrader/types";
import { ATR } from "technicalindicators";
import { IndicatorError } from "../utils/indicator.error.js";

type AtrParams = {
  periods: number;
};

/**
 * Calculate the Average True Range for a given set of candles.
 *
 * @param params - ATR parameters ({ periods }: 14 per spec §4.2)
 * @param candles - oldest-first candles (as returned by `getCandlesticks`)
 * @returns ATR values aligned with input: leading NaNs where history is
 * insufficient, then Wilder-smoothed values. Never shorter/longer than input.
 */
export async function atr(params: AtrParams, candles: ICandlestick[]): Promise<number[]> {
  if (params.periods < 1) {
    throw new IndicatorError("ATR requires at least 1 period", "ATR");
  }

  if (candles.length < 1) {
    throw new IndicatorError("No candles provided for ATR", "ATR");
  }

  const atrValues = ATR.calculate({
    period: params.periods,
    high: candles.map((candle) => candle.high),
    low: candles.map((candle) => candle.low),
    close: candles.map((candle) => candle.close),
  });
  const emptyAtrValues = new Array<number>(candles.length - atrValues.length).fill(NaN);

  return [...emptyAtrValues, ...atrValues];
}

/**
 * Latest defined ATR value (current volatility regime for grid spacing).
 *
 * @throws IndicatorError when no value is defined yet (history < periods).
 * S7 treats this as "wait for more closes" — never grid without spacing.
 */
export function latestAtrValue(values: number[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && !Number.isNaN(value)) {
      return value;
    }
  }

  throw new IndicatorError("Not enough candles to compute ATR", "ATR");
}
