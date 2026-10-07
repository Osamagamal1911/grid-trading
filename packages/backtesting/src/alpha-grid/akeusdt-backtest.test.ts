/**
 * alphaGrid S9 — AKEUSDT 1h backtest runner (M2).
 *
 * Loads klines (gitignored raw data, see scripts/fetch-klines.mjs), runs the
 * driver with the exact M2 settings, enforces the sanity gates (the driver
 * throws on violation), and writes BACKTEST_AKEUSDT.md (the M2 deliverable).
 *
 * M2 settings: stopLossPct=40, leverage=1, nLevels=8, atrMultiplier=0.5.
 * Sized for the window (documented in the report): volumePerLevel=1100 AKE
 * (entries ≥ $8.34 keep −40%/lev1 stops above the $5 min-notional — D42),
 * capital=$2000 (covers max margin at the spike peak).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ICandlestick } from "@opentrader/types";
import { runAlphaGridBacktest } from "./backtest-driver.js";
import { formatBacktestMarkdown } from "./backtest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KLINES = join(HERE, "../../../../klines/AKEUSDT-1h.json");
const REPORT = join(HERE, "../../../../BACKTEST_AKEUSDT.md");
const WINDOW_START = Date.parse("2026-09-01T00:00:00Z");

describe("alphaGrid AKEUSDT 1h backtest (M2)", () => {
  it("runs end-to-end, passes sanity gates, and writes the report", async () => {
    const all: ICandlestick[] = JSON.parse(readFileSync(KLINES, "utf-8"));
    const candles = all.filter((c) => c.timestamp >= WINDOW_START);
    expect(candles.length).toBeGreaterThan(500);

    const report = await runAlphaGridBacktest(candles, {
      symbol: "AKEUSDT",
      settings: {
        symbol: "AKEUSDT",
        direction: "auto",
        gridMode: "atr",
        nLevels: 8,
        atrMultiplier: 0.5,
        atrTimeframe: "1h",
        volumePerLevel: 1100,
        tpPct: 3.0,
        stopLossPct: 40.0,
        stopOrderType: "market",
        leverage: 1,
        pollIntervalMs: 3000,
        useTrailing: true,
        trailingShiftLevels: 2,
        useTakeProfit: true,
        useStopLoss: true,
        useExchangeStopOrder: true,
      },
      capital: 2000,
      tickSize: 0.000001,
      stepSize: 1,
      minCost: 5,
    });

    // Report-shape gates (driver already threw on any sanity violation).
    expect(report.closedCycles).toBeGreaterThanOrEqual(3);
    expect(report.stopOuts.length).toBeGreaterThanOrEqual(1);
    expect(report.liquidations).toBe(report.liquidationEvents.length); // reported, never hidden
    expect(report.totalFees).toBeGreaterThan(0);
    expect(report.winRate).toBeGreaterThanOrEqual(0);
    expect(report.winRate).toBeLessThanOrEqual(1);
    for (const stop of report.stopOuts) {
      // Never early (at/beyond the stop level); gaps may push beyond −40 (honest).
      expect(stop.roiAtTriggerPct).toBeLessThanOrEqual(-40 + 1.0);
    }

    writeFileSync(REPORT, formatBacktestMarkdown(report));
  }, 240000);
});
