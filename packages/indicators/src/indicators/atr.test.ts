/**
 * alphaGrid S6 — tests for Wilder ATR.
 *
 * Correctness anchors: (1) hand-computed Wilder values on a tiny fixture
 * (independent of any library), (2) agreement with an independent inline Wilder
 * implementation on a deterministic random walk, (3) module-pattern behavior
 * (NaN padding, errors, latest-value helper) and exchange-shaped input.
 */
import { describe, it, expect } from "vitest";
import type { ICandlestick } from "@opentrader/types";

import { atr, latestAtrValue } from "./atr.js";

function candle(
  open: number,
  high: number,
  low: number,
  close: number,
  timestamp = 1_700_000_000_000,
): ICandlestick {
  return { open, high, low, close, volume: 100, timestamp };
}

/**
 * Hand-computed Wilder ATR(3) fixture (D34 seeding: TR[0] skipped — no prev close).
 * TR[1..]: [2, 2.5, 3, 1.5, 2.5]; seed = (2+2.5+3)/3 = 2.5 at index 3;
 * then (prev×2 + TR)/3 → 2.1666667, 2.2777778.
 */
const wilderCandles: ICandlestick[] = [
  candle(9, 10, 8, 9),
  candle(10, 11, 9, 10),
  candle(10, 12, 9.5, 11),
  candle(11, 11, 8, 8.5),
  candle(8.5, 10, 9, 9.5),
  candle(9.5, 12, 10, 11.5),
];
const expectedAtr3 = [Number.NaN, Number.NaN, Number.NaN, 2.5, 2.1666667, 2.2777778];

/** Deterministic PRNG (mulberry32) — stable fixtures, no flakiness. */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent Wilder ATR (test-only, no library) for cross-checking. Same D34
 * seeding as the implementation (TR[0] skipped) — agrees on smoothing math. */
function wilderAtr(
  highs: number[],
  lows: number[],
  closes: number[],
  periods: number,
): number[] {
  const trs = highs.map((high, i) => {
    if (i === 0) return Number.NaN;
    const prevClose = closes[i - 1] as number;
    const low = lows[i] as number;
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  });
  const out: number[] = new Array(highs.length).fill(Number.NaN);
  const seed = trs.slice(1, periods + 1);
  if (seed.some((v) => v === undefined || Number.isNaN(v as number)) || seed.length < periods) return out;
  let prev = (seed as number[]).reduce((a, b) => a + b, 0) / periods;
  out[periods] = prev;
  for (let i = periods + 1; i < trs.length; i += 1) {
    prev = (prev * (periods - 1) + (trs[i] as number)) / periods;
    out[i] = prev;
  }
  return out;
}

function randomWalkCandles(count: number, seed: number): ICandlestick[] {
  const rand = mulberry32(seed);
  const candles: ICandlestick[] = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const drift = (rand() - 0.48) * 4;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rand() * 2;
    const low = Math.max(0.5, Math.min(open, close) - rand() * 2);
    candles.push(candle(open, high, low, close, 1_700_000_000_000 + i * 3_600_000));
    price = close;
  }
  return candles;
}

describe("atr", () => {
  it("matches hand-computed Wilder ATR(3) values", async () => {
    const result = await atr({ periods: 3 }, wilderCandles);

    expect(result.length).toBe(wilderCandles.length);
    expect(result.slice(0, 3).every(Number.isNaN)).toBe(true);
    for (let i = 3; i < result.length; i += 1) {
      expect(result[i]).toBeCloseTo(expectedAtr3[i] as number, 6);
    }
  });

  it("agrees with an independent Wilder implementation on a 30-candle walk", async () => {
    const candles = randomWalkCandles(30, 42);
    const result = await atr({ periods: 14 }, candles);
    const expected = wilderAtr(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
      14,
    );

    expect(result.length).toBe(candles.length);
    for (let i = 0; i < result.length; i += 1) {
      if (Number.isNaN(expected[i] as number)) {
        expect(result[i]).toBeNaN();
      } else {
        expect(result[i]).toBeCloseTo(expected[i] as number, 9);
      }
    }
  });

  it("pads `periods` leading NaNs and keeps input length (D34 seeding)", async () => {
    const candles = randomWalkCandles(20, 7);
    const result = await atr({ periods: 14 }, candles);

    expect(result.length).toBe(20);
    expect(result.slice(0, 14).every(Number.isNaN)).toBe(true);
    expect(result.slice(14).every((v) => !Number.isNaN(v) && v > 0)).toBe(true);
  });

  it("is deterministic", async () => {
    const candles = randomWalkCandles(25, 99);
    expect(await atr({ periods: 14 }, candles)).toEqual(await atr({ periods: 14 }, candles));
  });

  it("throws on bad periods or empty input", async () => {
    const candles = randomWalkCandles(20, 1);
    await expect(atr({ periods: 0 }, candles)).rejects.toThrow("ATR requires at least 1 period");
    await expect(atr({ periods: 14 }, [])).rejects.toThrow("No candles provided for ATR");
  });

  it("consumes exchange-shaped candle feeds (getCandlesticks parity)", async () => {
    // Same shape the strategy receives from `exchange.getCandlesticks`.
    const fetch1hCandles = async (): Promise<ICandlestick[]> => randomWalkCandles(20, 5);
    const result = await atr({ periods: 14 }, await fetch1hCandles());

    expect(result.length).toBe(20);
    expect(latestAtrValue(result)).toBeGreaterThan(0);
  });
});

describe("latestAtrValue", () => {
  it("returns the last defined value, skipping padding", async () => {
    const result = await atr({ periods: 14 }, randomWalkCandles(20, 3));
    expect(latestAtrValue(result)).toBe(result[result.length - 1]);
    expect(latestAtrValue([...result, Number.NaN, Number.NaN])).toBe(result[result.length - 1]);
  });

  it("throws when history is insufficient", () => {
    expect(() => latestAtrValue([])).toThrow("Not enough candles to compute ATR");
    expect(() => latestAtrValue([Number.NaN, Number.NaN])).toThrow("Not enough candles");
  });
});
