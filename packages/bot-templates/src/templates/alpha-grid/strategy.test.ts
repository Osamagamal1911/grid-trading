/**
 * alphaGrid S7 — strategy core tests (mock IExchange, no network).
 *
 * Each S7 acceptance criterion maps to tests below: direction lock, averaging +
 * TP re-sync (idempotent), trailing предусмот up/down + idle-off, ride-without-TP +
 * manual stop, one-position invariant, leverage actually sent, restart recovery,
 * foreign-order refusal, ATR/manual spacing paths, partial fills.
 */
import { describe, expect, it, vi } from "vitest";
import type { TBotContext } from "@opentrader/bot-processor";
import { computeAtrLevelSpacing, computeTakeProfitPrice } from "@opentrader/tools";
import { atr, latestAtrValue } from "@opentrader/indicators";
import { alphaGridStrategy, type AlphaGridRuntimeState } from "./strategy.js";
import type { AlphaGridBotConfig } from "./schema.js";
import { MockAlphaGridExchange, mockSideOrders } from "./strategy.test-utils.js";

const MARKET = "AKE/USDT:USDT";

function baseSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "AKEUSDT",
    direction: "auto",
    gridMode: "manual",
    manualHighPrice: 130,
    manualLowPrice: 70,
    nLevels: 3,
    volumePerLevel: 1,
    tpPct: 3,
    stopLossPct: 40,
    leverage: 1,
    useTrailing: true,
    useTakeProfit: true,
    useStopLoss: true,
    useExchangeStopOrder: true,
    ...overrides,
  };
}

interface Ctx {
  ctx: TBotContext<AlphaGridBotConfig>;
  control: { stop: ReturnType<typeof vi.fn> };
}

function makeCtx(
  exchange: MockAlphaGridExchange,
  settings: Record<string, unknown>,
  state: Record<string, unknown>,
  mode: "start" | "process" | "stop",
): Ctx {
  const control = { stop: vi.fn() };
  const ctx = {
    config: { id: 1, symbol: "AKEUSDT", settings },
    state,
    exchange,
    control,
    command: mode === "process" ? "process" : mode,
    onStart: mode === "start",
    onStop: mode === "stop",
    onProcess: mode === "process",
    market: { candles: [] },
    markets: {},
  } as unknown as TBotContext<AlphaGridBotConfig>;
  return { ctx, control };
}

async function drain(gen: Generator<Promise<unknown>, void, unknown>): Promise<void> {
  let item = gen.next();
  while (!item.done) {
    if (!(item.value instanceof Promise)) {
      throw new Error("strategy yielded a non-promise effect (only exchange promises allowed)");
    }
    item = gen.next(await item.value);
  }
}

async function runTick(
  exchange: MockAlphaGridExchange,
  settings: Record<string, unknown>,
  state: Record<string, unknown>,
  mode: "start" | "process" | "stop" = "process",
): Promise<{ state: AlphaGridRuntimeState; control: { stop: ReturnType<typeof vi.fn> } }> {
  const { ctx, control } = makeCtx(exchange, settings, state, mode);
  await drain(alphaGridStrategy(ctx));
  return { state: state as unknown as AlphaGridRuntimeState, control };
}

function buyIds(exchange: MockAlphaGridExchange): string[] {
  return mockSideOrders(exchange, "buy").map((o) => o.exchangeOrderId);
}

function sellIds(exchange: MockAlphaGridExchange): string[] {
  return mockSideOrders(exchange, "sell").map((o) => o.exchangeOrderId);
}

function walkCandles(count: number, start = 100): { high: number; low: number; close: number }[] {
  const out: { high: number; low: number; close: number }[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const drift = ((i * 37) % 11) - 5;
    const close = Math.max(1, price + drift * 0.4);
    out.push({ high: Math.max(price, close) + 0.8, low: Math.max(0.5, Math.min(price, close) - 0.8), close });
    price = close;
  }
  return out;
}

describe("startup", () => {
  it("draws both sides in auto mode and sends leverage (dkalenov lesson b)", async () => {
    const exchange = new MockAlphaGridExchange();
    const { state } = await runTick(exchange, baseSettings(), {}, "start");

    expect(buyIds(exchange).length).toBe(3);
    expect(sellIds(exchange).length).toBe(3);
    expect(exchange.setLeverageCalls).toEqual([{ symbol: MARKET, leverage: 1 }]);
    expect(state.marketId).toBe(MARKET);
    expect(state.tickSize).toBe(0.01);
    expect(state.direction).toBe(null);
    expect(state.gridTop).toBe(130);
    expect(state.gridBottom).toBe(70);
  });

  it("arms only buys in long mode, only sells in short mode", async () => {
    const longEx = new MockAlphaGridExchange();
    await runTick(longEx, baseSettings({ direction: "long" }), {}, "start");
    expect(buyIds(longEx).length).toBe(3);
    expect(sellIds(longEx).length).toBe(0);

    const shortEx = new MockAlphaGridExchange();
    await runTick(shortEx, baseSettings({ direction: "short" }), {}, "start");
    expect(buyIds(shortEx).length).toBe(0);
    expect(sellIds(shortEx).length).toBe(3);
  });

  it("sends custom leverage", async () => {
    const exchange = new MockAlphaGridExchange();
    await runTick(exchange, baseSettings({ leverage: 3 }), {}, "start");
    expect(exchange.setLeverageCalls).toEqual([{ symbol: MARKET, leverage: 3 }]);
  });

  it("rejects invalid settings loudly", async () => {
    const exchange = new MockAlphaGridExchange();
    await expect(runTick(exchange, baseSettings({ gridMode: "manual", manualHighPrice: undefined }), {}, "start")).rejects.toThrow(
      /manualHighPrice/,
    );
  });

  it("rejects below-minimum sizing loudly", async () => {
    const exchange = new MockAlphaGridExchange();
    exchange.symbol.minCost = 10000;
    await expect(runTick(exchange, baseSettings(), {}, "start")).rejects.toThrow(/volumePerLevel/);
  });

  it("flags unprotected runs for the UI", async () => {
    const exchange = new MockAlphaGridExchange();
    const { state } = await runTick(exchange, baseSettings({ useStopLoss: false }), {}, "start");
    expect(state.noStopLossAck).toBe(true);
  });

  it("refuses to run alongside foreign orders", async () => {
    const exchange = new MockAlphaGridExchange();
    const state: Record<string, unknown> = {};
    await runTick(exchange, baseSettings(), state, "start");
    exchange.injectForeignOrder({ exchangeOrderId: "someone-elses-order" });
    await expect(runTick(exchange, baseSettings(), state)).rejects.toThrow(/untracked open order/);
  });
});

describe("direction lock + averaging + TP sync", () => {
  async function longLocked() {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings();
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, state);
    return { exchange, settings, state: state as unknown as AlphaGridRuntimeState };
  }

  it("first fill locks long and cancels the opposite side", async () => {
    const { exchange, state } = await longLocked();

    expect(state.direction).toBe("long");
    expect(state.totalQty).toBe(1);
    expect(sellIds(exchange).length).toBe(1); // only the TP sell remains
    expect(buyIds(exchange).length).toBe(2);
    expect(exchange.callsTo("cancelLimitOrder").length).toBe(3); // the 3 auto-mode sells
  });

  it("first sell fill locks short (mirror)", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings();
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(sellIds(exchange)[0], 110);
    const { state: s } = await runTick(exchange, settings, state);

    expect(s.direction).toBe("short");
    // 2 grid sells remain; the only buy is the TP (short exits via buy).
    expect(sellIds(exchange).length).toBe(2);
    expect(buyIds(exchange).length).toBe(1);
    expect(buyIds(exchange)[0]).toBe(s.tpOrderId);
  });

  it("recomputes avgEntry after every fill and re-syncs ONE TP (reduceOnly)", async () => {
    const { exchange, settings, state } = await longLocked();
    const tpAfterFirst = sellIds(exchange);
    expect(tpAfterFirst.length).toBe(1);
    const firstTp = exchange.openOrders.get(tpAfterFirst[0]);
    expect(firstTp?.price).toBe(computeTakeProfitPrice(90, 3, 1, "long", 0.01)); // 92.7
    expect(exchange.reduceOnlyFlags.filter((f) => f.method === "placeLimitOrder" && f.value === true).length).toBe(1);

    exchange.fillOrder(buyIds(exchange)[0], 80);
    await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    const tpAfterSecond = sellIds(exchange);
    expect(tpAfterSecond.length).toBe(1); // still exactly ONE TP
    expect(tpAfterSecond[0]).not.toBe(tpAfterFirst[0]); // replaced (price moved)
    const secondTp = exchange.openOrders.get(tpAfterSecond[0]);
    expect(secondTp?.price).toBe(computeTakeProfitPrice(85, 3, 1, "long", 0.01)); // avg 85 → 87.55
  });

  it("is idempotent with no churn on quiet ticks", async () => {
    const { exchange, settings, state } = await longLocked();
    const places = exchange.callsTo("placeLimitOrder").length;
    const cancels = exchange.callsTo("cancelLimitOrder").length;
    const fetches = exchange.callsTo("getLimitOrder").length;

    await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(exchange.callsTo("placeLimitOrder").length).toBe(places);
    expect(exchange.callsTo("cancelLimitOrder").length).toBe(cancels);
    expect(exchange.callsTo("getLimitOrder").length).toBe(fetches);
  });

  it("accumulates partial fills exactly", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings();
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    const id = buyIds(exchange)[0];
    exchange.partialFill(id, 0.4, 90);
    await runTick(exchange, settings, state);
    exchange.partialFill(id, 1.0, 90);
    const { state: s } = await runTick(exchange, settings, state);

    expect(s.totalQty).toBe(1);
    expect(s.direction).toBe("long");
  });

  it("TP fill closes the cycle → FLAT → fresh grid", async () => {
    const { exchange, settings, state } = await longLocked();
    const tpId = sellIds(exchange)[0];
    exchange.fillOrder(tpId, 92.7);
    const placesBefore = exchange.callsTo("placeLimitOrder").length;
    const { state: s } = await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(s.direction).toBe(null);
    expect(s.totalQty).toBe(0);
    expect(s.fills).toEqual([]);
    expect(s.cycleCount).toBe(1);
    expect(buyIds(exchange).length).toBe(3); // fresh auto grid
    expect(sellIds(exchange).length).toBe(3);
    expect(exchange.callsTo("placeLimitOrder").length).toBeGreaterThan(placesBefore);
  });

  it("never opens the opposite side after lock (one-position invariant)", async () => {
    const { exchange, settings, state } = await longLocked();
    // Post-lock baseline: 3 initial sells + 1 TP sell placed so far.
    const sellsPlacedAtLock = exchange.callsTo("placeLimitOrder").filter((c) => (c as { side: string }).side === "sell").length;
    for (let i = 0; i < 3; i += 1) {
      await runTick(exchange, settings, state as unknown as Record<string, unknown>);
    }
    // No short entries after a long lock (TP already counted above).
    const placedSides = exchange.callsTo("placeLimitOrder").map((c) => (c as { side: string }).side);
    expect(placedSides.filter((s) => s === "sell").length).toBe(sellsPlacedAtLock);
  });
});

describe("trailing (pump-capture)", () => {
  async function longWithTp() {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings({ direction: "long" });
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, state);
    return { exchange, settings, state: state as unknown as AlphaGridRuntimeState };
  }

  it("shifts the grid up on pumps, keeps position + TP", async () => {
    const { exchange, settings, state } = await longWithTp();
    const tpId = sellIds(exchange)[0];
    const qtyBefore = state.totalQty;

    exchange.markPrice = 135; // above gridTop 130
    await runTick(exchange, settings, state as unknown as Record<string, unknown>);

    expect(state.centerPrice).toBe(120); // one 2-level block of 10
    expect(state.gridTop).toBe(150);
    expect(state.totalQty).toBe(qtyBefore); // position untouched
    expect(sellIds(exchange)).toEqual([tpId]); // TP untouched
    expect(buyIds(exchange).length).toBe(3);
  });

  it("shifts down on dumps for shorts (mirror)", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings({ direction: "short" });
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(sellIds(exchange)[0], 110);
    await runTick(exchange, settings, state);

    exchange.markPrice = 65; // below gridBottom 70
    await runTick(exchange, settings, state);

    const s = state as unknown as AlphaGridRuntimeState;
    expect(s.centerPrice).toBe(80);
    expect(s.gridBottom).toBe(50);
  });

  it("useTrailing=false idles out of range (classic grid)", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings({ direction: "long", useTrailing: false });
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, state);
    const places = exchange.callsTo("placeLimitOrder").length;

    exchange.markPrice = 135;
    const { state: s } = await runTick(exchange, settings, state);

    expect(exchange.callsTo("placeLimitOrder").length).toBe(places); // nothing redrawn
    expect(s.centerPrice).toBe(100);
    expect(s.idleOutOfRange).toBe(true);
    expect(s.totalQty).toBe(1); // position still managed
  });
});

describe("ride-without-TP + manual stop", () => {
  it("places no TP when disabled; manual stop market-closes reduceOnly", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings({ useTakeProfit: false, useStopLoss: false });
    const state: Record<string, unknown> = {};
    await runTick(exchange, settings, state, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, state);

    // No reduceOnly TP among limit placements (grid opens are not reduceOnly).
    expect(exchange.reduceOnlyFlags.filter((f) => f.value === true).length).toBe(0);
    expect((state as unknown as AlphaGridRuntimeState).totalQty).toBe(1);

    await runTick(exchange, settings, state, "stop");
    const closes = exchange.callsTo("placeMarketOrder") as { side: string; quantity: number; reduceOnly: boolean }[];
    expect(closes.length).toBe(1);
    expect(closes[0]).toMatchObject({ side: "sell", quantity: 1, reduceOnly: true });
    const s = state as unknown as AlphaGridRuntimeState;
    expect(s.direction).toBe(null);
    expect(s.totalQty).toBe(0);
  });
});

describe("restart recovery", () => {
  it("rehydrates from persisted state (JSON round-trip) without duplicating orders", async () => {
    const exchange = new MockAlphaGridExchange();
    const settings = baseSettings();
    const liveState: Record<string, unknown> = {};
    await runTick(exchange, settings, liveState, "start");
    exchange.fillOrder(buyIds(exchange)[0], 90);
    await runTick(exchange, settings, liveState);

    // Simulate process restart: state survives as JSON only; exchange keeps orders.
    const rehydrated = JSON.parse(JSON.stringify(liveState)) as Record<string, unknown>;
    const places = exchange.callsTo("placeLimitOrder").length;
    const { state: s } = await runTick(exchange, settings, rehydrated, "start");

    expect(exchange.callsTo("placeLimitOrder").length).toBe(places);
    expect(s.direction).toBe("long");
    expect(s.totalQty).toBe(1);
  });
});

describe("ATR spacing path", () => {
  it("derives spacing from ATR(14) × multiplier", async () => {
    const exchange = new MockAlphaGridExchange();
    exchange.candles = walkCandles(20);
    exchange.markPrice = 100;
    const settings = baseSettings({ gridMode: "atr" });
    const { state } = await runTick(exchange, settings, {}, "start");

    const values = await atr(
      { periods: 14 },
      exchange.candles.map((c, i) => ({ open: c.close, high: c.high, low: c.low, close: c.close, volume: 10, timestamp: i })),
    );
    const expected = computeAtrLevelSpacing(latestAtrValue(values), 0.5);
    expect(state.levelSpacing).toBe(expected);
    expect(buyIds(exchange).length).toBe(3);
    expect(sellIds(exchange).length).toBe(3);
  });

  it("waits (no orders, no throw) with insufficient ATR history", async () => {
    const exchange = new MockAlphaGridExchange();
    exchange.candles = walkCandles(5);
    const { state } = await runTick(exchange, baseSettings({ gridMode: "atr" }), {}, "start");

    expect(buyIds(exchange).length).toBe(0);
    expect(sellIds(exchange).length).toBe(0);
    expect(state.direction).toBe(null);
  });
});
