/**
 * alphaGrid S7/S8 — unit tests for order-params plumbing (D35/D39).
 *
 * Proves `reduceOnly` (+ stop `workingType`) reach the exact ccxt argument slots,
 * and that omission keeps the legacy call shape byte-identical (no upstream change).
 */
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

describe("reduceOnly / trigger plumbing", () => {
  it("limit orders: no flag → legacy 4-tuple; flag → params appended", () => {
    expect(
      normalize.placeLimitOrder.request({ symbol: "S", side: "sell", quantity: 1, price: 2 }),
    ).toEqual(["S", "sell", 1, 2]);
    expect(
      normalize.placeLimitOrder.request({ symbol: "S", side: "sell", quantity: 1, price: 2, reduceOnly: true }),
    ).toEqual(["S", "sell", 1, 2, { reduceOnly: true }]);
  });

  it("market orders: no flag → legacy 3-tuple; flag → params appended", () => {
    expect(normalize.placeMarketOrder.request({ symbol: "S", side: "sell", quantity: 1 })).toEqual([
      "S",
      "sell",
      1,
    ]);
    expect(
      normalize.placeMarketOrder.request({ symbol: "S", side: "sell", quantity: 1, reduceOnly: true }),
    ).toEqual(["S", "sell", 1, undefined, { reduceOnly: true }]);
  });

  it("stop orders: no flags → legacy 6-tuple", () => {
    expect(
      normalize.placeStopOrder.request({ symbol: "S", side: "sell", quantity: 1, type: "market", stopPrice: 90 }),
    ).toEqual(["S", "market", "sell", 1, undefined, 90]);
    expect(
      normalize.placeStopOrder.request({ symbol: "S", side: "sell", quantity: 1, type: "limit", stopPrice: 90, price: 89 }),
    ).toEqual(["S", "limit", "sell", 1, 89, 90]);
  });

  it("stop orders: mark basis → MARK_PRICE, reduceOnly forwarded", () => {
    expect(
      normalize.placeStopOrder.request({
        symbol: "S",
        side: "sell",
        quantity: 1,
        type: "market",
        stopPrice: 90,
        reduceOnly: true,
        triggerBasis: "mark",
      }),
    ).toEqual(["S", "market", "sell", 1, undefined, 90, { reduceOnly: true, workingType: "MARK_PRICE" }]);
    expect(
      normalize.placeStopOrder.request({
        symbol: "S",
        side: "buy",
        quantity: 1,
        type: "limit",
        stopPrice: 110,
        price: 112,
        triggerBasis: "last",
      }),
    ).toEqual(["S", "limit", "buy", 1, 112, 110, { workingType: "CONTRACT_PRICE" }]);
  });
});
