/**
 * alphaGrid S5 — tests for settings schema, validator, warnings, warmup, registration.
 *
 * §4.1b matrix: direction × gridMode × 4 toggles = 96 combinations, each its own
 * test case (parse + validate). Plus negative tests for every validation rule,
 * risk-warning combinations, requiredHistory math, and template registry props.
 */
import { describe, expect, it } from "vitest";
import { findTemplate } from "../../index.js";
import {
  ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS,
  alphaGridRequiredHistoryMinutes,
  alphaGridSchema,
  getAlphaGridRiskWarnings,
  validateAlphaGridSettings,
  type AlphaGridSettings,
} from "./schema.js";
import { alphaGrid } from "./alpha-grid.js";

const directions = ["long", "short", "auto"] as const;
const gridModes = ["atr", "manual"] as const;
const bools = [true, false];

interface MatrixCombo {
  direction: (typeof directions)[number];
  gridMode: (typeof gridModes)[number];
  useTrailing: boolean;
  useTakeProfit: boolean;
  useStopLoss: boolean;
  useExchangeStopOrder: boolean;
}

const combos: MatrixCombo[] = [];
for (const direction of directions) {
  for (const gridMode of gridModes) {
    for (const useTrailing of bools) {
      for (const useTakeProfit of bools) {
        for (const useStopLoss of bools) {
          for (const useExchangeStopOrder of bools) {
            combos.push({ direction, gridMode, useTrailing, useTakeProfit, useStopLoss, useExchangeStopOrder });
          }
        }
      }
    }
  }
}

function settingsFor(combo: MatrixCombo): Record<string, unknown> {
  return {
    ...combo,
    volumePerLevel: 1,
    ...(combo.gridMode === "manual" ? { manualHighPrice: 130, manualLowPrice: 70 } : {}),
  };
}

describe("§4.1b interaction matrix (96 combinations)", () => {
  it("covers all 96 direction × gridMode × toggle combinations", () => {
    expect(combos.length).toBe(96);
  });
  it.each(combos)("combo %# (%j) parses with defaults applied", (combo) => {
    const parsed = alphaGridSchema.parse(settingsFor(combo));
    expect(parsed.direction).toBe(combo.direction);
    expect(parsed.gridMode).toBe(combo.gridMode);
    expect(parsed.symbol).toBe("AKEUSDT");
    expect(parsed.nLevels).toBe(8);
  });

  it.each(combos)("combo %# (%j) passes conditional validation", (combo) => {
    const parsed = alphaGridSchema.parse(settingsFor(combo));
    expect(validateAlphaGridSettings(parsed)).toEqual([]);
  });
});

describe("spec defaults (§4.1)", () => {
  it("applies every documented default", () => {
    const parsed: AlphaGridSettings = alphaGridSchema.parse({ volumePerLevel: 0.5 });
    expect(parsed).toMatchObject({
      symbol: "AKEUSDT",
      direction: "auto",
      gridMode: "atr",
      nLevels: 8,
      atrMultiplier: 0.5,
      atrTimeframe: "1h",
      volumePerLevel: 0.5,
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
    });
  });
});

describe("schema-level rejection (plain ZodObject, dashboard-safe)", () => {
  it("requires volumePerLevel (no default)", () => {
    expect(() => alphaGridSchema.parse({})).toThrow();
  });

  it("rejects out-of-range numerics", () => {
    const base = { volumePerLevel: 1 };
    expect(() => alphaGridSchema.parse({ ...base, nLevels: 0 })).toThrow();
    expect(() => alphaGridSchema.parse({ ...base, nLevels: 101 })).toThrow();
    expect(() => alphaGridSchema.parse({ ...base, leverage: 0 })).toThrow();
    expect(() => alphaGridSchema.parse({ ...base, pollIntervalMs: 999 })).toThrow();
    expect(() => alphaGridSchema.parse({ ...base, symbol: "" })).toThrow();
    expect(() => alphaGridSchema.parse({ ...base, direction: "sideways" })).toThrow();
  });

  it("schema stays a plain ZodObject (dashboard form gate, D31)", () => {
    expect((alphaGridSchema as unknown as { _def: { typeName: string } })._def.typeName).toBe("ZodObject");
  });
});

describe("validateAlphaGridSettings conditional rules (§4.1b)", () => {
  const validBase = () =>
    alphaGridSchema.parse({ volumePerLevel: 1, gridMode: "manual", manualHighPrice: 130, manualLowPrice: 70 });

  it("manual mode requires both prices and high > low", () => {
    expect(validateAlphaGridSettings(alphaGridSchema.parse({ volumePerLevel: 1 }))).toEqual([]);
    expect(
      validateAlphaGridSettings({ ...validBase(), manualHighPrice: undefined }),
    ).not.toEqual([]);
    expect(validateAlphaGridSettings({ ...validBase(), manualLowPrice: undefined })).not.toEqual([]);
    expect(
      validateAlphaGridSettings({ ...validBase(), manualHighPrice: 70, manualLowPrice: 130 }),
    ).toContain("manualHighPrice must exceed manualLowPrice");
  });

  it("percents must be finite-positive when their toggle is on, ignored when off", () => {
    expect(
      validateAlphaGridSettings({ ...validBase(), stopLossPct: Number.POSITIVE_INFINITY }),
    ).not.toEqual([]);
    expect(validateAlphaGridSettings({ ...validBase(), tpPct: Number.NaN })).not.toEqual([]);
    // Toggle off: stale values are don't-care (lenient deploy UX, D30/D31).
    expect(validateAlphaGridSettings({ ...validBase(), useStopLoss: false })).toEqual([]);
    expect(
      validateAlphaGridSettings({ ...validBase(), useTakeProfit: false, tpPct: -99 }),
    ).toEqual([]);
  });

  it("rejects unknown atrTimeframe and non-positive volume/multiplier", () => {
    expect(validateAlphaGridSettings({ ...validBase(), atrTimeframe: "60m" })).not.toEqual([]);
    expect(validateAlphaGridSettings({ ...validBase(), volumePerLevel: 0 })).not.toEqual([]);
    expect(validateAlphaGridSettings("not-an-object")).not.toEqual([]);
  });
});

describe("getAlphaGridRiskWarnings", () => {
  const allOn = { useStopLoss: true, useTakeProfit: true, useExchangeStopOrder: true };

  it("fully protected = no warnings", () => {
    expect(getAlphaGridRiskWarnings(allOn)).toEqual([]);
  });

  it("no stop-loss = CRITICAL; no TP = WARNING; supervisor-only = NOTICE", () => {
    const noStop = getAlphaGridRiskWarnings({ ...allOn, useStopLoss: false });
    expect(noStop.length).toBe(1);
    expect(noStop[0]).toMatch(/CRITICAL/);

    const noTp = getAlphaGridRiskWarnings({ ...allOn, useTakeProfit: false });
    expect(noTp.length).toBe(1);
    expect(noTp[0]).toMatch(/WARNING/);

    const supervisoryOnly = getAlphaGridRiskWarnings({ ...allOn, useExchangeStopOrder: false });
    expect(supervisoryOnly.length).toBe(1);
    expect(supervisoryOnly[0]).toMatch(/NOTICE/);

    const allOff = getAlphaGridRiskWarnings({ useStopLoss: false, useTakeProfit: false, useExchangeStopOrder: false });
    expect(allOff.length).toBe(2); // CRITICAL + WARNING
  });
});

describe("alphaGridRequiredHistoryMinutes", () => {
  it("covers 20 closes of the ATR timeframe in 1m candles", () => {
    expect(alphaGridRequiredHistoryMinutes("1m")).toBe(20);
    expect(alphaGridRequiredHistoryMinutes("5m")).toBe(100);
    expect(alphaGridRequiredHistoryMinutes("1h")).toBe(1200);
    expect(alphaGridRequiredHistoryMinutes("1d")).toBe(28800);
  });

  it("throws on unknown timeframes", () => {
    expect(() => alphaGridRequiredHistoryMinutes("60m")).toThrow();
  });
});

describe("template registration (dashboard list, D14)", () => {
  it("resolves by export name with display props", () => {
    const template = findTemplate("alphaGrid");
    expect(template.displayName).toBe("Alpha Grid");
    expect(template.hidden).toBe(false);
    expect(template.runPolicy).toEqual({ onInterval: true });
    expect(template.interval).toBe(ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS);
    expect(template.schema).toBe(alphaGridSchema);
  });

  it("requiredHistory derives from settings (object and JSON-string forms)", () => {
    const requiredHistory = alphaGrid.requiredHistory as unknown as (cfg: {
      settings: unknown;
    }) => number;
    expect(requiredHistory({ settings: { atrTimeframe: "5m" } })).toBe(100);
    expect(requiredHistory({ settings: JSON.stringify({ atrTimeframe: "1h" }) })).toBe(1200);
  });
});
