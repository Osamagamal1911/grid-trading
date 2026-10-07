/**
 * alphaGrid S7 — futures-market plumbing (BUILD_PROMPT.md §4.1/§4.2 boundaries).
 *
 * What: converts operator-facing settings into exchange-facing market data —
 * futures market IDs, tick/step sizes from symbol info. Pure functions (no
 * `exchange.ccxt`), unit-tested here; the strategy (strategy.ts) and the S9
 * backtest share them.
 *
 * Why separate from tools/alpha-grid/math.ts: that module is §4.2 pure math;
 * this is exchange-convention plumbing (USDT-M IDs, precision modes).
 */

import type { ISymbolInfo } from "@opentrader/types";

export interface AlphaGridMarketPrecision {
  tickSize: number;
  stepSize: number;
  minQty: number | null;
  minCost: number | null;
}

/**
 * Canonicalize an operator symbol ("akeusdt" → "AKEUSDT"). Uppercase normalization
 * lives here (not the zod schema — transforms would break the dashboard form, D31).
 */
export function normalizeAlphaGridSymbol(symbol: unknown): string {
  if (typeof symbol !== "string" || symbol.trim() === "") {
    throw new Error("alphaGrid: symbol must be a non-empty string.");
  }
  return symbol.trim().toUpperCase();
}

/**
 * Operator symbol → CCXT unified futures market ID ("AKEUSDT" → "AKE/USDT:USDT").
 * USDT-M only (spec §1/§4.6); anything else fails loud.
 */
export function toFuturesMarketId(symbol: string): string {
  const normalized = normalizeAlphaGridSymbol(symbol);
  if (!normalized.endsWith("USDT")) {
    throw new Error(`alphaGrid: only USDT-M futures are supported (got "${symbol}").`);
  }
  const base = normalized.slice(0, -"USDT".length);
  if (base === "") {
    throw new Error(`alphaGrid: empty base currency in symbol "${symbol}".`);
  }
  return `${base}/USDT:USDT`;
}

function precisionToTickSize(precision: number | undefined, field: string): number {
  if (precision === undefined) {
    throw new Error(`alphaGrid: no tick info for ${field} (decimals and precision both missing).`);
  }
  if (!Number.isFinite(precision) || precision <= 0) {
    throw new Error(`alphaGrid: invalid precision for ${field} (${precision}).`);
  }
  return precision;
}

/**
 * Real tick/step sizes from symbol info (spec §4.2: never hardcoded decimals).
 *
 * Binance uses TICK_SIZE precision mode, so `precision` values ARE tick sizes
 * (0.01, 0.25, even integer ticks like 1) — used directly and exactly (D38).
 * `decimals` is only a fallback when precision is missing (some exchanges);
 * an integer "1" can mean tick-1.0 or 1-decimal-place, so decimals-first would
 * mis-round odd ticks (0.25 → 0.1) and trip exchange PRICE_FILTER rejections.
 */
export function marketPrecisionFromSymbolInfo(info: ISymbolInfo): AlphaGridMarketPrecision {
  const decimals = info.filters?.decimals;
  const precision = info.filters?.precision;

  const tickSize =
    precision?.price !== undefined
      ? precisionToTickSize(precision.price, "price")
      : decimals?.price !== undefined
        ? Math.pow(10, -decimals.price)
        : precisionToTickSize(undefined, "price");
  const stepSize =
    precision?.amount !== undefined
      ? precisionToTickSize(precision.amount, "amount")
      : decimals?.amount !== undefined
        ? Math.pow(10, -decimals.amount)
        : precisionToTickSize(undefined, "amount");

  if (!(tickSize > 0) || !(stepSize > 0) || !Number.isFinite(tickSize) || !Number.isFinite(stepSize)) {
    throw new Error(`alphaGrid: unresolvable tick/step sizes for ${info.symbolId}.`);
  }

  return {
    tickSize,
    stepSize,
    minQty: info.filters?.limits?.amount?.min ?? null,
    minCost: info.filters?.limits?.cost?.min ?? null,
  };
}
