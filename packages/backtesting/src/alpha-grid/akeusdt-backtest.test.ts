/**
 * alphaGrid S9 + Session-5 sweep — AKEUSDT 1h backtest runner (M2 record + sweep).
 *
 * Loads klines (gitignored raw data, see scripts/fetch-klines.mjs), runs the
 * driver on each config below, enforces the sanity gates (the driver throws on
 * violation), and writes BACKTEST_AKEUSDT.md with ALL runs appended as history
 * (the 40% M2 record is never overwritten).
 *
 * M2 record: stopLossPct=40, leverage=1, nLevels=8, atrMultiplier=0.5.
 * Sweep (Session 5, new 20% default): stopLossPct=20 × trailing OFF / ON.
 * Sized for the window (documented in the report): volumePerLevel=1100 AKE,
 * capital=$2000 (covers max margin at the spike peak).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ICandlestick } from "@opentrader/types";
import { runAlphaGridBacktest, type AlphaGridBacktestReport } from "./backtest-driver.js";
import { formatBacktestMarkdown } from "./backtest-report.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KLINES = join(HERE, "../../../../klines/AKEUSDT-1h.json");
const REPORT = join(HERE, "../../../../BACKTEST_AKEUSDT.md");
const WINDOW_START = Date.parse("2026-09-01T00:00:00Z");

interface SweepConfig {
  title: string;
  stopLossPct: number;
  useTrailing: boolean;
  minCycles: number;
  minStops: number;
}

const CONFIGS: SweepConfig[] = [
  // M2 historical record — gates as accepted.
  { title: "M2 record (40% stop, trailing ON)", stopLossPct: 40, useTrailing: true, minCycles: 3, minStops: 1 },
  // Session-5 sweep at the new 20% default.
  { title: "Sweep A — 20% stop, trailing OFF", stopLossPct: 20, useTrailing: false, minCycles: 3, minStops: 0 },
  { title: "Sweep B — 20% stop, trailing ON", stopLossPct: 20, useTrailing: true, minCycles: 3, minStops: 0 },
];

describe("alphaGrid AKEUSDT 1h backtest (M2 record + 20% sweep)", () => {
  it("runs end-to-end, passes sanity gates, and writes the report", async () => {
    const all: ICandlestick[] = JSON.parse(readFileSync(KLINES, "utf-8"));
    const candles = all.filter((c) => c.timestamp >= WINDOW_START);
    expect(candles.length).toBeGreaterThan(500);

    const sections: { title: string; report: AlphaGridBacktestReport }[] = [];
    for (const cfg of CONFIGS) {
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
          stopLossPct: cfg.stopLossPct,
          stopOrderType: "market",
          leverage: 1,
          pollIntervalMs: 3000,
          useTrailing: cfg.useTrailing,
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
      expect(report.closedCycles).toBeGreaterThanOrEqual(cfg.minCycles);
      expect(report.stopOuts.length).toBeGreaterThanOrEqual(cfg.minStops);
      expect(report.liquidations).toBe(report.liquidationEvents.length); // reported, never hidden
      expect(report.totalFees).toBeGreaterThan(0);
      expect(report.winRate).toBeGreaterThanOrEqual(0);
      expect(report.winRate).toBeLessThanOrEqual(1);
      for (const stop of report.stopOuts) {
        // Never early (at/beyond the stop level); gaps may push beyond it (honest).
        expect(stop.roiAtTriggerPct).toBeLessThanOrEqual(-cfg.stopLossPct + 1.0);
      }
      sections.push({ title: cfg.title, report });
    }

    writeFileSync(REPORT, sections.map((s) => formatBacktestMarkdown(s.report, s.title)).join("\n\n---\n\n"));
  }, 240000);
});
