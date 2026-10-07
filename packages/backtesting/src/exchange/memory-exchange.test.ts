/**
 * alphaGrid S9 — unit tests for the MemoryExchange order-book simulation.
 *
 * Range-crossing fills (wicks trigger), stop fills with slippage, commission,
 * fill journal, candle history, tick/min-cost guards, immediate market fills.
 */
import { describe, expect, it } from "vitest";
import type { ICandlestick } from "@opentrader/types";
import { ExchangeCode } from "@opentrader/types";
import { MarketSimulator } from "../market-simulator.js";
import { MemoryExchange } from "./memory-exchange.js";

const SYMBOL = "AKE/USDT:USDT";

function candle(high: number, low: number, close: number, timestamp = 1): ICandlestick {
  return { open: close, high, low, close, volume: 10, timestamp };
}

function simExchange() {
  const sim = new MarketSimulator();
  return new MemoryExchange(sim, {
    exchangeCode: ExchangeCode.BINANCE,
    tickSize: 0.01,
    stepSize: 1,
    minCost: 5,
    costs: { makerBps: 2, takerBps: 5, slippageBps: 0 },
  });
}

describe("MemoryExchange simulation", () => {
  it("fills resting limit buys on wick touches (range, not close)", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 99.5)); // seed current
    const { orderId } = await exchange.placeLimitOrder({ symbol: SYMBOL, side: "buy", quantity: 10, price: 95 });

    // Close stays above, wick touches → fills (close-only logic would miss this).
    exchange.processCandle(candle(100, 94, 99));
    const fetched = await exchange.getLimitOrder({ symbol: SYMBOL, orderId });
    expect(fetched.status).toBe("filled");
    expect(fetched.quantityExecuted).toBe(10);
    expect(fetched.filledPrice).toBe(95); // maker rests at limit
    expect((await exchange.getOpenOrders({ symbol: SYMBOL })).length).toBe(0);
  });

  it("leaves untouched limits open; cancels by id", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 99.5));
    const { orderId } = await exchange.placeLimitOrder({ symbol: SYMBOL, side: "buy", quantity: 10, price: 90 });
    exchange.processCandle(candle(100, 95, 99));
    expect((await exchange.getOpenOrders({ symbol: SYMBOL })).length).toBe(1);
    await exchange.cancelLimitOrder({ symbol: SYMBOL, orderId });
    expect((await exchange.getOpenOrders({ symbol: SYMBOL })).length).toBe(0);
    const closed = await exchange.getClosedOrders({ symbol: SYMBOL });
    expect(closed[0]?.status).toBe("canceled");
  });

  it("fills stop-market on range cross with taker fee (slippage 0 here)", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 99.5));
    const { orderId } = await exchange.placeStopOrder({
      symbol: SYMBOL,
      side: "sell",
      quantity: 10,
      type: "market",
      stopPrice: 95,
      reduceOnly: true,
      triggerBasis: "mark",
    });
    exchange.processCandle(candle(99, 94, 98)); // low 94 crosses 95
    const fetched = await exchange.getLimitOrder({ symbol: SYMBOL, orderId });
    expect(fetched.status).toBe("filled");
    expect(fetched.filledPrice).toBe(95);
    expect(exchange.fillJournal.length).toBe(1);
    expect(exchange.fillJournal[0]?.fee).toBeCloseTo(95 * 10 * 0.0005, 10); // taker 5bps
  });

  it("applies adverse slippage to taker fills", async () => {
    const sim = new MarketSimulator();
    const exchange = new MemoryExchange(sim, {
      tickSize: 0.01,
      stepSize: 1,
      costs: { makerBps: 0, takerBps: 0, slippageBps: 100 }, // 1% adverse
    });
    exchange.processCandle(candle(100, 99, 99.5));
    await exchange.placeMarketOrder({ symbol: SYMBOL, side: "buy", quantity: 10 });
    // Buy pays up: close 99.5 × 1.01.
    expect(exchange.fillJournal[0]?.price).toBeCloseTo(99.5 * 1.01, 10);
  });

  it("stop-limit survives when the limit is unreachable (honest gap-miss)", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 99.5));
    const { orderId } = await exchange.placeStopOrder({
      symbol: SYMBOL,
      side: "sell",
      quantity: 10,
      type: "limit",
      stopPrice: 95,
      price: 90, // limit below the candle range → gap-miss
      reduceOnly: true,
      triggerBasis: "mark",
    });
    exchange.processCandle(candle(96, 94, 95)); // crosses stop 95, never reaches limit 90
    const fetched = await exchange.getLimitOrder({ symbol: SYMBOL, orderId });
    expect(fetched.status).toBe("open");
  });

  it("serves candle history for ATR warmup", async () => {
    const exchange = simExchange();
    for (let i = 0; i < 10; i += 1) {
      exchange.processCandle(candle(100 + i, 99 + i, 99.5 + i, i));
    }
    const last5 = await exchange.getCandlesticks({ symbol: SYMBOL, limit: 5 });
    expect(last5.length).toBe(5);
    expect(last5[4]?.close).toBe(99.5 + 9);
  });

  it("rejects tick/step/min-cost violations like a live venue", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 99.5));
    await expect(
      exchange.placeLimitOrder({ symbol: SYMBOL, side: "buy", quantity: 10, price: 95.005 }),
    ).rejects.toThrow(/tick/);
    await expect(
      exchange.placeLimitOrder({ symbol: SYMBOL, side: "buy", quantity: 0.5, price: 95 }),
    ).rejects.toThrow(/tick|step/);
    await expect(
      exchange.placeLimitOrder({ symbol: SYMBOL, side: "buy", quantity: 1, price: 0.05 }),
    ).rejects.toThrow(/minimum/);
  });

  it("getMarkPrice tracks the current candle close", async () => {
    const exchange = simExchange();
    exchange.processCandle(candle(100, 99, 98.5));
    expect((await exchange.getMarkPrice({ symbol: SYMBOL })).markPrice).toBe(98.5);
  });
});
