/**
 * alphaGrid S7 (D35): mark-price query. Stop/TP triggers MUST reference mark
 * price, never last price (spec §3, wick-hunt protection) — `getMarketPrice`
 * returns last-price upstream (D9), so the strategy uses this method instead.
 */

export interface IGetMarkPriceRequest {
  /**
   * e.g. AKE/USDT:USDT (Binance USD-M futures market ID).
   */
  symbol: string;
}

export interface IGetMarkPriceResponse {
  symbol: string;
  /**
   * Current mark price (exchange mark-price endpoint, never last price).
   */
  markPrice: number;
  /**
   * Unix timestamp in milliseconds.
   */
  timestamp: number;
}
