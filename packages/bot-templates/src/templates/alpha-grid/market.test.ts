/**
 * alphaGrid S7 — tests for futures-market plumbing (pure functions).
 */
import { describe, expect, it } from "vitest";
import type { ISymbolInfo } from "@opentrader/types";
import {
  marketPrecisionFromSymbolInfo,
  normalizeAlphaGridSymbol,
  toFuturesMarketId,
} from "./market.js";

function symbolInfo(overrides: Partial<ISymbolInfo["filters"]> = {}): ISymbolInfo {
  return {
    symbolId: "BINANCE:AKE/USDT",
    currencyPair: "AKE/USDT:USDT",
    exchangeCode: "BINANCE",
    exchangeSymbolId: "AKEUSDT",
    baseCurrency: "AKE",
    quoteCurrency: "USDT",
    filters: {
      precision: { amount: 0.001, price: 0.01 },
      decimals: { amount: 3, price: 2 },
      limits: { amount: { min: 1 }, cost: { min: 5 } },
      ...overrides,
    },
  } as ISymbolInfo;
}

describe("normalizeAlphaGridSymbol", () => {
  it("trims and uppercases", () => {
    expect(normalizeAlphaGridSymbol("  akeusdt ")).toBe("AKEUSDT");
  });

  it("rejects empty/non-string", () => {
    expect(() => normalizeAlphaGridSymbol("")).toThrow();
    expect(() => normalizeAlphaGridSymbol(undefined)).toThrow();
  });
});

describe("toFuturesMarketId", () => {
  it("maps USDT symbols to unified futures IDs", () => {
    expect(toFuturesMarketId("AKEUSDT")).toBe("AKE/USDT:USDT");
    expect(toFuturesMarketId("akeusdt")).toBe("AKE/USDT:USDT");
  });

  it("refuses non-USDT-M symbols (one-way USDT-M only)", () => {
    expect(() => toFuturesMarketId("BTCUSDC")).toThrow();
    expect(() => toFuturesMarketId("USDT")).toThrow();
  });
});

describe("marketPrecisionFromSymbolInfo", () => {
  it("derives tick/step from decimals (exact, unambiguous)", () => {
    expect(marketPrecisionFromSymbolInfo(symbolInfo())).toEqual({
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 1,
      minCost: 5,
    });
  });

  it("uses precision ticks directly when decimals are missing (TICK_SIZE mode)", () => {
    const info = symbolInfo({ decimals: {}, precision: { amount: 1, price: 0.25 } });
    // Integer 1 = tick 1.0 here (not 0.1); odd tick 0.25 exact — decimals-first
    // would mis-round both (D38).
    expect(marketPrecisionFromSymbolInfo(info)).toEqual({
      tickSize: 0.25,
      stepSize: 1,
      minQty: 1,
      minCost: 5,
    });
  });

  it("nulls missing limits and throws on unresolvable ticks", () => {
    const noLimits = symbolInfo({ limits: {} });
    expect(marketPrecisionFromSymbolInfo(noLimits).minQty).toBe(null);
    expect(marketPrecisionFromSymbolInfo(noLimits).minCost).toBe(null);

    const noTicks = symbolInfo({ decimals: {}, precision: {} });
    expect(() => marketPrecisionFromSymbolInfo(noTicks)).toThrow();
  });
});
