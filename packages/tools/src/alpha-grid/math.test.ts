/**
 * alphaGrid S4 — unit tests for the §4.2 core math module.
 *
 * Strategy: exact-value tests for every formula (LONG + SHORT), property tests
 * anchoring TP/SL prices back to ROI% (a TP price MUST yield exactly +tpPct),
 * averaging across fills, tick/step rounding incl. odd ticks, and edge inputs.
 * All green is an S4 acceptance criterion.
 */
import { describe, expect, it } from "vitest";
import {
  buildGridLevels,
  computeAtrLevelSpacing,
  computeManualCenterPrice,
  computeManualLevelSpacing,
  computeMarginUsed,
  computePositionFromFills,
  computeStopLossPrice,
  computeTakeProfitPrice,
  computeUnrealizedRoiPct,
  roundPriceToTick,
  roundQuantityToStep,
} from "./math.js";

describe("computeMarginUsed", () => {
  it("margin = |entry × qty| / leverage", () => {
    expect(computeMarginUsed(100, 2, 10)).toBe(20);
    expect(computeMarginUsed(100, 2, 1)).toBe(200);
    expect(computeMarginUsed(0.5, 1000, 3)).toBeCloseTo(166.6666667, 4);
  });

  it("is side-agnostic (absolute value)", () => {
    expect(computeMarginUsed(100, 2, 10)).toBe(computeMarginUsed(100, 2, 10));
  });

  it("rejects bad leverage", () => {
    expect(() => computeMarginUsed(100, 1, 0)).toThrow();
    expect(() => computeMarginUsed(100, 1, -5)).toThrow();
  });
});

describe("computeUnrealizedRoiPct", () => {
  it("LONG: profit when mark > entry, loss when mark < entry", () => {
    // entry 100, qty 10, lev 1 → margin 1000. +10 price move = +100 PnL = +10%.
    expect(computeUnrealizedRoiPct(110, 100, "long", 10, 1)).toBe(10);
    expect(computeUnrealizedRoiPct(90, 100, "long", 10, 1)).toBe(-10);
  });

  it("SHORT: profit when mark < entry, loss when mark > entry (sign correctness)", () => {
    expect(computeUnrealizedRoiPct(90, 100, "short", 10, 1)).toBe(10);
    expect(computeUnrealizedRoiPct(110, 100, "short", 10, 1)).toBe(-10);
  });

  it("scales with leverage (same price move, 10x = 10x ROI)", () => {
    expect(computeUnrealizedRoiPct(110, 100, "long", 10, 10)).toBe(100);
    expect(computeUnrealizedRoiPct(99, 100, "short", 10, 10)).toBe(10);
  });

  it("zero position (FLAT) yields 0, not NaN", () => {
    expect(computeUnrealizedRoiPct(110, 100, "long", 0, 10)).toBe(0);
    expect(computeUnrealizedRoiPct(90, 100, "short", 0, 1)).toBe(0);
  });
});

describe("computeTakeProfitPrice", () => {
  it("LONG: entry + entry × tpPct / (100 × leverage)", () => {
    expect(computeTakeProfitPrice(100, 3, 1, "long", 0.01)).toBe(103);
    expect(computeTakeProfitPrice(100, 3, 10, "long", 0.01)).toBe(100.3);
  });

  it("SHORT: entry − entry × tpPct / (100 × leverage)", () => {
    expect(computeTakeProfitPrice(100, 3, 1, "short", 0.01)).toBe(97);
    expect(computeTakeProfitPrice(100, 3, 10, "short", 0.01)).toBe(99.7);
  });

  it("ROI at the (exact) TP price is exactly +tpPct — both sides, lev 1 and 10", () => {
    for (const side of ["long", "short"] as const) {
      for (const leverage of [1, 3, 10]) {
        const tp = computeTakeProfitPrice(100, 3, leverage, side, 1e-10);
        expect(computeUnrealizedRoiPct(tp, 100, side, 5, leverage)).toBeCloseTo(3, 6);
      }
    }
  });
});

describe("computeStopLossPrice", () => {
  it("LONG: entry − entry × stopLossPct / (100 × leverage)", () => {
    expect(computeStopLossPrice(100, 40, 1, "long", 0.01)).toBe(60);
    expect(computeStopLossPrice(100, 40, 10, "long", 0.01)).toBe(96);
  });

  it("SHORT: entry + entry × stopLossPct / (100 × leverage)", () => {
    expect(computeStopLossPrice(100, 40, 1, "short", 0.01)).toBe(140);
    expect(computeStopLossPrice(100, 40, 10, "short", 0.01)).toBe(104);
  });

  it("ROI at the (exact) SL price is exactly −stopLossPct — both sides, lev 1 and 10", () => {
    for (const side of ["long", "short"] as const) {
      for (const leverage of [1, 3, 10]) {
        const sl = computeStopLossPrice(100, 40, leverage, side, 1e-10);
        expect(computeUnrealizedRoiPct(sl, 100, side, 5, leverage)).toBeCloseTo(-40, 6);
      }
    }
  });
});

describe("computePositionFromFills", () => {
  it("averages across fills (volume-weighted)", () => {
    const pos = computePositionFromFills([
      { price: 100, quantity: 1, side: "long" },
      { price: 110, quantity: 1, side: "long" },
    ]);
    expect(pos.avgEntry).toBe(105);
    expect(pos.totalQty).toBe(2);
    expect(pos.side).toBe("long");
  });

  it("weights by quantity (3 fills, uneven)", () => {
    const pos = computePositionFromFills([
      { price: 100, quantity: 1, side: "short" },
      { price: 90, quantity: 2, side: "short" },
      { price: 95, quantity: 1, side: "short" },
    ]);
    // (100 + 180 + 95) / 4 = 93.75
    expect(pos.avgEntry).toBe(93.75);
    expect(pos.totalQty).toBe(4);
    expect(pos.side).toBe("short");
  });

  it("single fill = that price/qty; empty fills = FLAT zeros", () => {
    const one = computePositionFromFills([{ price: 42.5, quantity: 7, side: "long" }]);
    expect(one).toEqual({ avgEntry: 42.5, totalQty: 7, side: "long" });

    expect(computePositionFromFills([])).toEqual({ avgEntry: 0, totalQty: 0, side: null });
  });

  it("averaging + ROI compose: averaged position ROI is exact", () => {
    const pos = computePositionFromFills([
      { price: 100, quantity: 1, side: "long" },
      { price: 110, quantity: 1, side: "long" },
    ]);
    // avg 105, qty 2, lev 1 → margin 210. mark 115.5 → PnL 21 → 10%.
    expect(computeUnrealizedRoiPct(115.5, pos.avgEntry, "long", pos.totalQty, 1)).toBe(10);
  });

  it("rejects mixed-side fills, zero/negative fills, bad side", () => {
    expect(() =>
      computePositionFromFills([
        { price: 100, quantity: 1, side: "long" },
        { price: 100, quantity: 1, side: "short" },
      ]),
    ).toThrow();
    expect(() => computePositionFromFills([{ price: 100, quantity: 0, side: "long" }])).toThrow();
    expect(() => computePositionFromFills([{ price: -5, quantity: 1, side: "long" }])).toThrow();
  });
});

describe("tick/step rounding (D26: always down, exact decimals)", () => {
  it("floors to power-of-10 ticks, never up", () => {
    expect(roundPriceToTick(123.456, 0.01)).toBe(123.45);
    expect(roundPriceToTick(123.459, 0.01)).toBe(123.45);
    expect(roundPriceToTick(100, 0.01)).toBe(100);
  });

  it("handles non-power-of-10 ticks exactly (no float dust)", () => {
    expect(roundPriceToTick(10.4, 0.25)).toBe(10.25);
    expect(roundPriceToTick(0.3, 0.25)).toBe(0.25);
    expect(roundPriceToTick(7, 2)).toBe(6);
  });

  it("handles altcoin-dust ticks", () => {
    expect(roundPriceToTick(0.000012349, 0.0000001)).toBe(0.0000123);
    expect(roundQuantityToStep(123.456789, 0.001)).toBe(123.456);
    expect(roundQuantityToStep(0.0009999, 0.001)).toBe(0);
  });

  it("zero quantity is allowed (no order); negatives and zero sizes throw", () => {
    expect(roundQuantityToStep(0, 0.001)).toBe(0);
    expect(() => roundQuantityToStep(-1, 0.001)).toThrow();
    expect(() => roundPriceToTick(100, 0)).toThrow();
    expect(() => roundPriceToTick(-100, 0.01)).toThrow();
    expect(() => roundPriceToTick(Number.NaN, 0.01)).toThrow();
  });
});

describe("grid spacing + levels", () => {
  it("ATR spacing = multiplier × ATR", () => {
    expect(computeAtrLevelSpacing(20, 0.5)).toBe(10);
    expect(computeAtrLevelSpacing(0, 0.5)).toBe(0);
    expect(() => computeAtrLevelSpacing(-1, 0.5)).toThrow();
  });

  it("manual spacing centers the range: edges coincide with outer levels (D27)", () => {
    expect(computeManualLevelSpacing(130, 70, 3)).toBe(10);
    expect(computeManualCenterPrice(130, 70)).toBe(100);
    expect(() => computeManualLevelSpacing(70, 130, 3)).toThrow();
    expect(() => computeManualLevelSpacing(100, 100, 3)).toThrow();
  });

  it("builds nLevels per side per the spec formulas (i = 1..nLevels)", () => {
    const grid = buildGridLevels(100, 10, 3, 0.01);
    expect(grid.buyLevels).toEqual([90, 80, 70]);
    expect(grid.sellLevels).toEqual([110, 120, 130]);
    expect(grid.gridTop).toBe(130);
    expect(grid.gridBottom).toBe(70);
  });

  it("matches the spec spacingPct form: center × (1 ∓ i × pct/100)", () => {
    // spacing 2 on center 100 == spacingPct 2.
    const grid = buildGridLevels(100, 2, 2, 0.01);
    expect(grid.buyLevels).toEqual([100 * (1 - (1 * 2) / 100), 100 * (1 - (2 * 2) / 100)]);
    expect(grid.sellLevels).toEqual([100 * (1 + (1 * 2) / 100), 100 * (1 + (2 * 2) / 100)]);
  });

  it("manual range maps onto the same builder (high/low become grid edges)", () => {
    const spacing = computeManualLevelSpacing(130, 70, 3);
    const center = computeManualCenterPrice(130, 70);
    const grid = buildGridLevels(center, spacing, 3, 0.01);
    expect(grid.gridTop).toBe(130);
    expect(grid.gridBottom).toBe(70);
  });

  it("tick-rounds levels down (level sits at or inside the exact line)", () => {
    const grid = buildGridLevels(100, 3, 1, 7);
    // exact lines: 97 / 103 → floored to tick 7: 91 / 98.
    expect(grid.buyLevels).toEqual([91]);
    expect(grid.sellLevels).toEqual([98]);
  });

  it("rejects degenerate grids", () => {
    expect(() => buildGridLevels(100, 0, 3, 0.01)).toThrow();
    expect(() => buildGridLevels(100, 10, 0, 0.01)).toThrow();
    expect(() => buildGridLevels(5, 10, 3, 0.01)).toThrow(); // buy level ≤ 0
  });
});
