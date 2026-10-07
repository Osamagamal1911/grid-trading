import type { OrderSide } from "./common/enums.js";

export interface IPlaceMarketOrderRequest {
  /**
   * Instrument ID, e.g `BTC/USDT`.
   */
  symbol: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
  side: OrderSide;
  /**
   * Quantity to buy or sell.
   */
  quantity: number;
  /**
   * alphaGrid S7 (D35): close-only flag, forwarded to the exchange when true.
   * Every order that reduces/closes a position MUST set this (spec §3).
   */
  reduceOnly?: boolean;
}

export interface IPlaceMarketOrderResponse {
  /**
   * Order ID.
   */
  orderId: string;
  /**
   * Client-supplied order ID
   */
  clientOrderId?: string;
}
