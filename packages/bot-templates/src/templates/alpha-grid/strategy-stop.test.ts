/**
 * alphaGrid S8 — two-layer unrealized stop tests (mock IExchange, no network).
 *
 * Layer 1: stop re-placed from CURRENT avgEntry after every fill (never a fixed
 * deploy price), reduceOnly + mark trigger, limit-offset pricing, no churn.
 * Layer 2: supervisor force-closes on UNREALIZED ROI breach (fake-timer throttle),
 * ignores realized/total PnL, stops the bot. Stop-hit and TP-complete interplay.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { computeStopLossPrice } from "@opentrader/tools";
import {
  MockAlphaGridExchange,
  baseSettings,
  buyIds,
  runTick,
  sellIds,
} from "./strategy.test-utils.js";

afterEach(() => {
  vi.useRealTimers();
});

async function longPosition(stopOrderType: string = "market") {
  const exchange = new MockAlphaGridExchange();
  const settings = baseSettings({ stopOrderType });
  const state: Record<string, unknown> = {};
  await runTick(exchange, settings, state, "start");
  exchange.fillOrder(buyIds(exchange)[0], 90);
  await runTick(exchange, settings, state);
  return { exchange, settings, state };
}

function stopId(exchange: MockAlphaGridExchange): string {
  const stops = exchange.stopOrders;
  expect(stops.length).toBe(1);
  return stops[stops.length - 1]?.orderId as string;
}

describe("Layer 1 — exchange-side stop", () => {
  it("places a reduceOnly mark-trigger stop from the current avgEntry after the first fill", async () => {
    const { exchange, state } = await longPosition();

    expect(exchange.stopOrders.length).toBe(1);
    const params = exchange.stopOrders[0]?.params as Record<string, unknown>;
    expect(params).toMatchObject({
      type: "market",
      side: "sell",
      quantity: 1,
      stopPrice: computeStopLossPrice(90, 40, 1, "long", 0.01), // 54
      reduceOnly: true,
      triggerBasis: "mark",
    });
    expect((state as unknown as { stopOrderId: string }).stopOrderId).toBe(stopId(exchange));
  });

  it("re-syncs the stop from the CURRENT avgEntry after every fill (never a fixed price)", async () => {
    const { exchange, settings, state } = await longPosition();
    const firstStop = stopId(exchange);

    exchange.fillOrder(buyIds(exchange)[0], 80);
    await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(exchange.stopOrders.length).toBe(2);
    expect(exchange.callsTo("cancelLimitOrder").map((c) => (c as { orderId: string }).orderId)).toContain(firstStop);
    const params = exchange.stopOrders[1]?.params as Record<string, unknown>;
    expect(params.stopPrice).toBe(computeStopLossPrice(85, 40, 1, "long", 0.01)); // avg 85 → 51
    expect(params.quantity).toBe(2);
  });

  it("prices stop-limit offsets (LONG −2%) and does not churn when in sync", async () => {
    const { exchange, settings, state } = await longPosition("limit");
    const params = exchange.stopOrders[0]?.params as Record<string, unknown>;
    expect(params.type).toBe("limit");
    expect(params.price).toBeCloseTo(54 * 0.98, 10);

    const places = exchange.callsTo("placeStopOrder").length;
    await runTick(exchange, settings, state as unknown as Record<string, unknown>);
    expect(exchange.callsTo("placeStopOrder").length).toBe(places);
  });

  it("skips Layer 1 below exchange minimum (D42) — supervisor still guards", async () => {
    // Fake clock FIRST (S8 pattern): mixing real-timer setup with fake-timer asserts
    // jumps the clock backward and the throttle skips forever.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const exchange = new MockAlphaGridExchange();
      exchange.symbol.minCost = 60; // entries pass ($90), −40% stops ($54) do not
      const settings = baseSettings();
      const state: Record<string, unknown> = {};
      await runTick(exchange, settings, state, "start");
      exchange.fillOrder(buyIds(exchange)[0], 90);
      const { state: s } = await runTick(exchange, settings, state);

      expect(s.direction).toBe("long");
      expect(exchange.stopOrders.length).toBe(0); // skipped, not forced
      expect(s.stopDownReason).toBe("min-notional");

      // Supervisor still protects the unsupervised position.
      exchange.markPrice = 50;
      vi.advanceTimersByTime(3000);
      const { control } = await runTick(exchange, settings, state);
      expect(control.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-places Layer 1 when placeable again (restart re-reads venue info)", async () => {
    const exchange = new MockAlphaGridExchange();
    exchange.symbol.minCost = 60;
    const settings = baseSettings();
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, state);
    expect((state as unknown as { stopDownReason: string }).stopDownReason).toBe("min-notional");

    exchange.symbol.minCost = null; // venue info changes; restart re-reads it
    await runTick(exchange, settings, state, "start");
    const s = state as unknown as { stopDownReason: string };
    expect(s.stopDownReason).toBe(null);
    expect(exchange.stopOrders.length).toBe(1);
  });

  it("degrades (not bricks) when stop placement throws — retries, supervisor guards (D48)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const exchange = new MockAlphaGridExchange();
      exchange.failPlaceStop = new Error("venue exploded");
      const settings = baseSettings();
      const state: Record<string, unknown> = {};
      await runTick(exchange, settings, state, "start");
      exchange.fillOrder(buyIds(exchange)[0], 90);
      // Tick SUCCEEDS despite the venue error: fill recorded, TP placed, flag set.
      const { state: s } = await runTick(exchange, settings, state);
      expect(s.direction).toBe("long");
      expect(s.totalQty).toBe(1);
      expect(s.stopDownReason).toBe("placement-failed");
      expect(s.tpOrderId).not.toBe(null);

      // Recovery: venue heals → stop placed, flag cleared, no duplicate TP.
      exchange.failPlaceStop = null;
      const tpCount = exchange.callsTo("placeLimitOrder").length;
      await runTick(exchange, settings, state);
      expect(exchange.stopOrders.length).toBe(1);
      expect((s as unknown as { stopDownReason: null }).stopDownReason).toBe(null);
      expect(exchange.callsTo("placeLimitOrder").length).toBe(tpCount); // TP untouched (no churn)

      // And the degraded position still stops via supervisor on breach.
      exchange.markPrice = 50;
      vi.advanceTimersByTime(3000);
      const { control } = await runTick(exchange, settings, state);
      expect(control.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TP placement failure degrades the TP only — stop still placed, tick succeeds (D48)", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings();
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.failPlaceLimit = new Error("TP venue exploded");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    // Grid fills record fine; TP placement fails → warn-flag, tick succeeds, stop placed.
    const { state: s } = await runTick(exchange, settings, state);
    expect(s.direction).toBe("long");
    expect(s.tpUnplaceable).toBe(true);
    expect(s.tpOrderId).toBe(null);
    expect(exchange.stopOrders.length).toBe(1);

    // Recovery: TP placed on the next tick, flag cleared.
    exchange.failPlaceLimit = null;
    await runTick(exchange, settings, state);
    expect(s.tpUnplaceable).toBe(false);
    expect(s.tpOrderId).not.toBe(null);
  });

  it("Layer-1-off still protects via supervisor (useExchangeStopOrder=false)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const exchange = new MockAlphaGridExchange();
      const settings = baseSettings({ useExchangeStopOrder: false });
      const state: Record<string, unknown> = {};
      await runTick(exchange, settings, state, "start");
      exchange.fillOrder(buyIds(exchange)[0], 90);
      await runTick(exchange, settings, state);

      expect(exchange.stopOrders.length).toBe(0); // Layer 1 off …

      exchange.markPrice = 50; // −44.4% unrealized
      vi.advanceTimersByTime(3000);
      const { control } = await runTick(exchange, settings, state);

      expect(control.stop).toHaveBeenCalledTimes(1); // … supervisor closes anyway
      expect((state as unknown as { direction: null }).direction).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Layer 2 — supervisor", () => {
  it("force-closes on unrealized breach: cancel all → market-close reduceOnly → control.stop()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { exchange, settings, state } = await longPosition();
      exchange.markPrice = 50; // (50−90)/90 = −44.4% ≤ −40%
      vi.advanceTimersByTime(3000);
      const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

      expect(control.stop).toHaveBeenCalledTimes(1);
      const closes = exchange.callsTo("placeMarketOrder") as { side: string; quantity: number; reduceOnly: boolean }[];
      expect(closes).toEqual([{ symbol: "AKE/USDT:USDT", side: "sell", quantity: 1, reduceOnly: true }]);
      expect(s.direction).toBe(null);
      expect(s.totalQty).toBe(0);
      expect([...exchange.openOrders.values()].length).toBe(0); // grids + TP + stop all gone
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on unrealized loss DESPITE lifetime realized profit (never total-PnL)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      // Cycle 1: profitable TP close (lifetime realized > 0).
      const exchange = new MockAlphaGridExchange();
      const settings = baseSettings();
      const state: Record<string, unknown> = {};
      await runTick(exchange, settings, state, "start");
      exchange.fillOrder(buyIds(exchange)[0], 90);
      await runTick(exchange, settings, state);
      exchange.fillOrder((state as unknown as { tpOrderId: string }).tpOrderId, 92.7); // TP
      await runTick(exchange, settings, state);
      expect((state as unknown as { cycleCount: number }).cycleCount).toBe(1);

      // Cycle 2: same setup, price bleeds past the stop.
      exchange.fillOrder(buyIds(exchange)[0], 90);
      await runTick(exchange, settings, state);
      exchange.markPrice = 50;
      vi.advanceTimersByTime(3000);
      const { control } = await runTick(exchange, settings, state);

      expect(control.stop).toHaveBeenCalledTimes(1); // prior profit did NOT offset
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds above the stop (no premature close)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { exchange, settings, state } = await longPosition();
      exchange.markPrice = 80; // −11.1% — a normal drawdown, not a stop
      vi.advanceTimersByTime(3000);
      const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

      expect(control.stop).not.toHaveBeenCalled();
      expect(s.totalQty).toBe(1);
      expect(s.direction).toBe("long");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles to pollIntervalMs (no evaluation before cadence)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { exchange, settings, state } = await longPosition();
      exchange.markPrice = 50; // breaching, but…
      vi.advanceTimersByTime(1000); // …only 1s since the last evaluation
      const { control } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

      expect(control.stop).not.toHaveBeenCalled();
      expect((state as unknown as { totalQty: number }).totalQty).toBe(1);

      vi.advanceTimersByTime(2500); // 3.5s total → due
      const second = await runTick(exchange, settings, state as unknown as Record<string, unknown>);
      expect(second.control.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never force-closes with useStopLoss=false, however deep the bleed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const exchange = new MockAlphaGridExchange();
      const settings = baseSettings({ useStopLoss: false, useTakeProfit: false });
      const state: Record<string, unknown> = {};
      await runTick(exchange, settings, state, "start");
      exchange.fillOrder(buyIds(exchange)[0], 90);
      await runTick(exchange, settings, state);

      exchange.markPrice = 10; // −88.9% — catastrophic, but unprotected by choice
      vi.advanceTimersByTime(30000);
      const { control, state: s } = await runTick(exchange, settings, state);

      expect(control.stop).not.toHaveBeenCalled();
      expect(s.totalQty).toBe(1); // still riding
      expect(exchange.stopOrders.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stop-hit / TP-complete interplay", () => {
  it("exchange stop fill → cancel rest, clear, control.stop() (no fresh grid)", async () => {
    const { exchange, settings, state } = await longPosition();
    exchange.fillOrder(stopId(exchange), 54);
    const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(control.stop).toHaveBeenCalledTimes(1);
    expect(s.direction).toBe(null);
    expect(s.totalQty).toBe(0);
    expect([...exchange.openOrders.values()].length).toBe(0); // TP + grids canceled
    expect(buyIds(exchange).length).toBe(0); // no redraw — bot is stopped
  });

  it("stop-hit wins over a same-tick TP fill (stop the bot, do not redraw)", async () => {
    const { exchange, settings, state } = await longPosition();
    exchange.fillOrder((state as unknown as { tpOrderId: string }).tpOrderId, 92.7); // TP…
    exchange.fillOrder(stopId(exchange), 54); // …and stop (gap through both)
    const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(control.stop).toHaveBeenCalledTimes(1);
    expect(s.direction).toBe(null);
    expect(buyIds(exchange).length).toBe(0);
    expect(s.cycleCount).toBe(0); // not a TP cycle
  });

  it("TP-complete cancels the orphan stop and redraws (no control.stop)", async () => {
    const { exchange, settings, state } = await longPosition();
    const stop = stopId(exchange);
    exchange.fillOrder((state as unknown as { tpOrderId: string }).tpOrderId, 92.7); // TP only
    const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(control.stop).not.toHaveBeenCalled();
    expect(
      exchange.callsTo("cancelLimitOrder").map((c) => (c as { orderId: string }).orderId),
    ).toContain(stop);
    expect(s.cycleCount).toBe(1);
    expect(buyIds(exchange).length).toBe(3); // fresh grid, no stop sniping it
    expect(sellIds(exchange).length).toBe(3);
  });

  it("manual stop cancels the Layer-1 stop and never calls control.stop()", async () => {
    const { exchange, settings, state } = await longPosition();
    const stop = stopId(exchange);
    const { control, state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>, "stop");

    expect(control.stop).not.toHaveBeenCalled();
    expect(
      exchange.callsTo("cancelLimitOrder").map((c) => (c as { orderId: string }).orderId),
    ).toContain(stop);
    expect(s.direction).toBe(null);
  });
});
