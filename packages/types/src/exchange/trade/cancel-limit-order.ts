export type ICancelLimitOrderRequest = {
  /**
   * e.g. ADA/USDT
   */
  symbol: string;
  /**
   * Order ID provided by the exchange
   */
  orderId: string;
  /**
   * alphaGrid S10 (D48): set for conditional (algo) orders on venues that
   * segregate them (Binance futures) — routes lookup/cancel to the algo endpoint.
   */
  stop?: boolean;
};

export interface ICancelLimitOrderResponse {
  /**
   * Exchange-supplied Order ID
   */
  orderId: string;
}
