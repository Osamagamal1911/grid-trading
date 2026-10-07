import type { OrderSide } from "./common/enums.js";

export interface IPlaceStopOrderRequest {
  type: "limit" | "market";
  /**
   * Instrument ID, e.g `ADA/USDT`.
   */
  symbol: string;
  side: OrderSide;
  /**
   * Quantity to buy or sell, in BASE currency (futures reduceOnly closes).
   * (An older comment claimed quote currency for market stops — that is spot
   * market-buy lore; futures STOP_MARKET closes base-denominated positions.)
   */
  quantity: number;
  /**
   * Order price.
   */
  price?: number;
  stopPrice: number;
  /**
   * alphaGrid S8 (D39): close-only flag, forwarded to the exchange when true.
   * Every order that reduces/closes a position MUST set this (spec §3).
   */
  reduceOnly?: boolean;
  /**
   * alphaGrid S8 (D39): stop trigger basis. `"mark"` maps to the exchange's
   * mark-price trigger (Binance `MARK_PRICE`); omitted = exchange default.
   * alphaGrid ALWAYS passes `"mark"` (spec §3, wick-hunt protection).
   */
  triggerBasis?: "mark" | "last";
}

export interface IPlaceStopOrderResponse {
  /**
   * Order ID.
   */
  orderId: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
}
