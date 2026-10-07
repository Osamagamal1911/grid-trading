import type { IExchange } from "@opentrader/exchanges";
import type {
  IAccountAsset,
  IGetTradingFeeRatesRequest,
  IGetTradingFeeRatesResponse,
  IGetCandlesticksRequest,
  ICandlestick,
  IGetMarketPriceRequest,
  IGetMarketPriceResponse,
  IGetMarkPriceRequest,
  IGetMarkPriceResponse,
  ICancelLimitOrderRequest,
  ICancelLimitOrderResponse,
  IPlaceOrderRequest,
  IPlaceOrderResponse,
  IPlaceLimitOrderRequest,
  IPlaceLimitOrderResponse,
  IPlaceMarketOrderRequest,
  IPlaceMarketOrderResponse,
  IPlaceStopOrderRequest,
  IPlaceStopOrderResponse,
  IGetLimitOrderRequest,
  IGetLimitOrderResponse,
  IGetOpenOrdersRequest,
  IGetOpenOrdersResponse,
  IGetClosedOrdersRequest,
  IGetClosedOrdersResponse,
  IOpenOrder,
  IGetSymbolInfoRequest,
  ISymbolInfo,
  IWatchOrdersRequest,
  IWatchOrdersResponse,
  IWatchCandlesRequest,
  IWatchCandlesResponse,
  ITrade,
  IOrderbook,
  ITicker,
} from "@opentrader/types";
import { ExchangeCode } from "@opentrader/types";
import type { MarketSimulator } from "../market-simulator.js";

/**
 * alphaGrid S9 — order-book simulation additions (D11/D41).
 *
 * Limit/stop/market orders rest in an in-memory book and match per candle on
 * RANGE crossing (candle low/high — a close-only check would miss wick triggers).
 * Taker/maker commission + adverse slippage apply per fill; every execution lands
 * in `fillJournal` with its fee. Pre-existing stub behaviors are preserved when
 * the exchange is constructed without options (upstream smart-trade backtests).
 */

export interface SimulatedFill {
  orderId: string;
  kind: "limit" | "market" | "stop";
  side: "buy" | "sell";
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}

export interface BacktestCosts {
  /** Per-side bps on resting limit fills (Binance VIP0 maker). */
  makerBps: number;
  /** Per-side bps on market/stop fills (Binance VIP0 taker). */
  takerBps: number;
  /** Adverse bps on taker fills (limits rest at their price: 0 slippage). */
  slippageBps: number;
}

export interface MemoryExchangeSimOptions {
  exchangeCode?: ExchangeCode;
  tickSize?: number;
  stepSize?: number;
  minCost?: number | null;
  costs?: Partial<BacktestCosts>;
}

type SimOrderKind = "limit" | "market" | "stop";

interface SimOrder {
  orderId: string;
  kind: SimOrderKind;
  stopType?: "limit" | "market";
  side: "buy" | "sell";
  symbol: string;
  /** Limit price (limit orders) or stop-limit offset (stop-limit). */
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  filledQty: number;
  filledValue: number;
  status: "open" | "filled" | "canceled";
  reduceOnly?: boolean;
  createdAt: number;
}

const DEFAULT_COSTS: BacktestCosts = {
  makerBps: 2, // Binance VIP0 maker 0.02%
  takerBps: 5, // Binance VIP0 taker 0.05%
  slippageBps: 2, // adverse, taker fills only
};

export class MemoryExchange implements IExchange {
  ccxt = {} as any;
  exchangeCode: ExchangeCode = ExchangeCode.OKX;
  isPaper = false;
  isDemo = false;

  /** Executed fills in order (exchange-side truth for metrics; S9). */
  public fillJournal: SimulatedFill[] = [];
  /** Cumulative simulated commission paid (S9). */
  public totalSimFees = 0;

  private simOrders = new Map<string, SimOrder>();
  private candleHistory: ICandlestick[] = [];
  private orderSeq = 0;
  private simTickSize: number | null = null;
  private simStepSize: number | null = null;
  private simMinCost: number | null = null;
  private simCosts: BacktestCosts = { ...DEFAULT_COSTS };

  /**
   * @internal
   */
  constructor(
    private marketSimulator: MarketSimulator,
    simOptions: MemoryExchangeSimOptions = {},
  ) {
    if (simOptions.exchangeCode !== undefined) {
      this.exchangeCode = simOptions.exchangeCode;
    }
    if (simOptions.tickSize !== undefined) this.simTickSize = simOptions.tickSize;
    if (simOptions.stepSize !== undefined) this.simStepSize = simOptions.stepSize;
    if (simOptions.minCost !== undefined) this.simMinCost = simOptions.minCost;
    if (simOptions.costs !== undefined) this.simCosts = { ...DEFAULT_COSTS, ...simOptions.costs };
  }

  /**
   * alphaGrid S9: advance the simulation to a candle — sets it current and matches
   * all resting orders against its RANGE (low/high crossing, D41). Orders placed
   * by the strategy tick afterwards match from the NEXT candle (live causality).
   */
  processCandle(candle: ICandlestick): void {
    this.candleHistory.push(candle);
    this.marketSimulator.nextCandle(candle);
    this.matchOrders(candle);
  }

  private nextOrderId(prefix: string): string {
    this.orderSeq += 1;
    return `sim-${prefix}-${this.orderSeq}`;
  }

  private applySlippage(price: number, side: "buy" | "sell"): number {
    const slip = this.simCosts.slippageBps / 10000;
    return side === "buy" ? price * (1 + slip) : price * (1 - slip);
  }

  private execute(order: SimOrder, price: number, rateBps: number, timestamp: number, slip: boolean): void {
    const execPrice = slip ? this.applySlippage(price, order.side) : price;
    const fee = execPrice * order.quantity * (rateBps / 10000);
    order.filledQty = order.quantity;
    order.filledValue = execPrice * order.quantity;
    order.status = "filled";
    this.totalSimFees += fee;
    this.fillJournal.push({
      orderId: order.orderId,
      kind: order.kind,
      side: order.side,
      price: execPrice,
      quantity: order.quantity,
      fee,
      timestamp,
    });
  }

  /** Range-crossing match for every resting order (S9 honesty: wicks trigger). */
  private matchOrders(candle: ICandlestick): void {
    for (const order of this.simOrders.values()) {
      if (order.status !== "open") continue;
      if (order.kind === "limit" && order.price !== null) {
        if (order.side === "buy" && candle.low <= order.price) {
          this.execute(order, order.price, this.simCosts.makerBps, candle.timestamp, false);
        } else if (order.side === "sell" && candle.high >= order.price) {
          this.execute(order, order.price, this.simCosts.makerBps, candle.timestamp, false);
        }
      } else if (order.kind === "stop" && order.stopPrice !== null) {
        const crossed =
          order.side === "sell" ? candle.low <= order.stopPrice : candle.high >= order.stopPrice;
        if (!crossed) continue;
        if (order.stopType === "limit" && order.price !== null) {
          // Stop-limit: trigger crossed, but the limit must also be reachable this
          // candle — otherwise the order survives (honest gap-miss modeling, D29 note).
          const reachable = order.side === "sell" ? candle.low <= order.price : candle.high >= order.price;
          if (!reachable) continue;
          this.execute(order, order.price, this.simCosts.takerBps, candle.timestamp, false);
        } else {
          // Stop-market: gap-aware fill — an open already beyond the trigger means
          // the market gapped over it (fill at the adverse open, not the stop).
          const gapped =
            order.side === "sell" ? candle.open < order.stopPrice : candle.open > order.stopPrice;
          this.execute(order, gapped ? candle.open : order.stopPrice, this.simCosts.takerBps, candle.timestamp, true);
        }
      }
    }
  }

  private assertTickAligned(price: number, quantity: number): void {
    // Live exchanges reject PRICE_FILTER/LOT_SIZE violations — so does the sim,
    // but only when configured (upstream stub behavior otherwise preserved).
    if (this.simTickSize === null || this.simStepSize === null) return;
    const priceSteps = price / this.simTickSize;
    const qtySteps = quantity / this.simStepSize;
    if (Math.abs(priceSteps - Math.round(priceSteps)) > 1e-6 || Math.abs(qtySteps - Math.round(qtySteps)) > 1e-6) {
      throw new Error(
        `MemoryExchange: order price ${price} / qty ${quantity} violates tick ${this.simTickSize} / step ${this.simStepSize}.`,
      );
    }
    if (this.simMinCost !== null && price * quantity < this.simMinCost - 1e-9) {
      throw new Error(
        `MemoryExchange: order notional ${price * quantity} below minimum ${this.simMinCost}.`,
      );
    }
  }

  private toOpenOrder(order: SimOrder): IOpenOrder {
    return {
      symbol: order.symbol,
      exchangeOrderId: order.orderId,
      clientOrderId: undefined,
      side: order.side,
      quantity: order.quantity,
      quantityExecuted: order.filledQty,
      volume: (order.price ?? order.stopPrice ?? 0) * order.quantity,
      volumeExecuted: order.filledValue,
      price: order.price ?? order.stopPrice ?? 0,
      filledPrice: null,
      lastTradeTimestamp: 0,
      status: "open",
      fee: 0,
      createdAt: order.createdAt,
    };
  }

  private findOrder(orderId: string): SimOrder {
    const order = this.simOrders.get(orderId);
    if (!order) throw new Error(`MemoryExchange: unknown order ${orderId}.`);
    return order;
  }

  async destroy() {}

  async loadMarkets() {
    return {};
  }

  async accountAssets(): Promise<IAccountAsset[]> {
    return [];
  }

  async getLimitOrder(data: IGetLimitOrderRequest): Promise<IGetLimitOrderResponse> {
    const order = this.findOrder(data.orderId);
    return {
      symbol: order.symbol,
      exchangeOrderId: order.orderId,
      clientOrderId: undefined,
      price: order.price ?? order.stopPrice ?? 0,
      quantity: order.quantity,
      quantityExecuted: order.filledQty,
      volume: (order.price ?? order.stopPrice ?? 0) * order.quantity,
      volumeExecuted: order.filledValue,
      side: order.side,
      status: order.status === "open" ? "open" : order.status === "filled" ? "filled" : "canceled",
      fee: 0,
      createdAt: order.createdAt,
      lastTradeTimestamp: 0,
      filledPrice: order.filledQty > 0 ? order.filledValue / order.filledQty : null,
    };
  }

  async placeOrder(_body: IPlaceOrderRequest): Promise<IPlaceOrderResponse> {
    return {
      orderId: "",
      clientOrderId: "",
    };
  }

  async placeLimitOrder(body: IPlaceLimitOrderRequest): Promise<IPlaceLimitOrderResponse> {
    this.assertTickAligned(body.price, body.quantity);
    const orderId = this.nextOrderId("limit");
    this.simOrders.set(orderId, {
      orderId,
      kind: "limit",
      side: body.side,
      symbol: body.symbol,
      price: body.price,
      stopPrice: null,
      quantity: body.quantity,
      filledQty: 0,
      filledValue: 0,
      status: "open",
      reduceOnly: body.reduceOnly,
      createdAt: Date.now(),
    });
    return {
      orderId,
      clientOrderId: body.clientOrderId,
    };
  }

  async placeMarketOrder(body: IPlaceMarketOrderRequest): Promise<IPlaceMarketOrderResponse> {
    // Market orders execute immediately at the current candle close (± slippage).
    const candle = this.marketSimulator.currentCandle;
    const orderId = this.nextOrderId("market");
    const order: SimOrder = {
      orderId,
      kind: "market",
      side: body.side,
      symbol: body.symbol,
      price: null,
      stopPrice: null,
      quantity: body.quantity,
      filledQty: 0,
      filledValue: 0,
      status: "open",
      reduceOnly: body.reduceOnly,
      createdAt: Date.now(),
    };
    this.simOrders.set(orderId, order);
    this.execute(order, candle.close, this.simCosts.takerBps, candle.timestamp, true);
    return {
      orderId,
      clientOrderId: body.clientOrderId,
    };
  }

  async placeStopOrder(body: IPlaceStopOrderRequest): Promise<IPlaceStopOrderResponse> {
    this.assertTickAligned(body.stopPrice, body.quantity);
    const orderId = this.nextOrderId("stop");
    this.simOrders.set(orderId, {
      orderId,
      kind: "stop",
      stopType: body.type,
      side: body.side,
      symbol: body.symbol,
      price: body.price ?? null,
      stopPrice: body.stopPrice,
      quantity: body.quantity,
      filledQty: 0,
      filledValue: 0,
      status: "open",
      reduceOnly: body.reduceOnly,
      createdAt: Date.now(),
    });
    return {
      orderId,
      clientOrderId: undefined,
    };
  }

  async cancelLimitOrder(body: ICancelLimitOrderRequest): Promise<ICancelLimitOrderResponse> {
    const order = this.findOrder(body.orderId);
    if (order.status !== "open") {
      throw new Error(`MemoryExchange: cannot cancel ${order.status} order ${body.orderId}.`);
    }
    order.status = "canceled";
    return {
      orderId: body.orderId,
    };
  }

  async getTicker(symbol: string): Promise<ITicker> {
    const candlestick = this.marketSimulator.currentCandle;
    const assetPrice = candlestick.close;

    return {
      symbol,
      bid: assetPrice,
      ask: assetPrice,
      last: assetPrice,
      baseVolume: 0,
      quoteVolume: 0,
      timestamp: this.marketSimulator.currentCandle.timestamp,
    };
  }

  async getOrderbook(symbol: string): Promise<IOrderbook> {
    return {
      symbol,
      timestamp: Date.now(),
      bids: [],
      asks: [],
    };
  }

  async getMarketPrice(params: IGetMarketPriceRequest): Promise<IGetMarketPriceResponse> {
    const candlestick = this.marketSimulator.currentCandle;
    const assetPrice = candlestick.close;
    const { symbol } = params;

    return {
      symbol,
      price: assetPrice,
      timestamp: 0,
    };
  }

  /**
   * alphaGrid S7 (D35): backtest mark-price approximation = current candle close.
   * Candle RANGE-crossing (not close) drives stop/TP trigger simulation in S9 —
   * this point query exists so strategy code never branches live-vs-backtest.
   */
  async getMarkPrice(params: IGetMarkPriceRequest): Promise<IGetMarkPriceResponse> {
    const candlestick = this.marketSimulator.currentCandle;

    return {
      symbol: params.symbol,
      markPrice: candlestick.close,
      timestamp: candlestick.timestamp,
    };
  }

  /**
   * alphaGrid S7 (D35): record-only leverage for the backtester (S9 reports it).
   */
  public appliedLeverage: { symbol: string; leverage: number } | null = null;

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error(`alphaGrid: leverage must be a positive integer, got ${leverage}.`);
    }
    this.appliedLeverage = { symbol, leverage };
  }

  async getCandlesticks(params: IGetCandlesticksRequest): Promise<ICandlestick[]> {
    // History available so far (S9): the strategy's ATR warmup reads through this.
    const limit = params.limit ?? this.candleHistory.length;
    return this.candleHistory.slice(-limit);
  }

  async getTradingFeeRates(_params: IGetTradingFeeRatesRequest): Promise<IGetTradingFeeRatesResponse> {
    return {
      makerFee: 0,
      takerFee: 0,
    };
  }

  async getSymbol(params: IGetSymbolInfoRequest): Promise<ISymbolInfo> {
    // Configured sim precision when provided (S9); legacy stub values otherwise.
    const tickSize = this.simTickSize ?? 0.01;
    const stepSize = this.simStepSize ?? 1;
    const decimalsPrice = Math.max(0, Math.round(-Math.log10(tickSize)));
    const decimalsAmount = Math.max(0, Math.round(-Math.log10(stepSize)));
    return {
      symbolId: `${this.exchangeCode}:${params.currencyPair}`,
      currencyPair: params.currencyPair,
      exchangeCode: this.exchangeCode,
      exchangeSymbolId: params.currencyPair.replace("/", ""),
      baseCurrency: params.currencyPair.split("/")[0] ?? "",
      quoteCurrency: "USDT",
      filters: {
        precision: {
          amount: stepSize,
          price: tickSize,
        },
        decimals: {
          amount: decimalsAmount,
          price: decimalsPrice,
        },
        limits: {
          amount: {
            min: stepSize,
            max: 100000000,
          },
          cost: {
            min: this.simMinCost ?? 0.01,
            max: 100000000,
          },
          leverage: {
            min: 1,
            max: 100,
          },
          price: {
            min: tickSize,
            max: 100000000,
          },
        },
      },
    };
  }

  async getSymbols(): Promise<ISymbolInfo[]> {
    return [];
  }

  async getOpenOrders(params: IGetOpenOrdersRequest) {
    return [...this.simOrders.values()]
      .filter((o) => o.status === "open" && o.symbol === params.symbol)
      .map((o) => this.toOpenOrder(o));
  }

  async getClosedOrders(params: IGetClosedOrdersRequest) {
    return [...this.simOrders.values()]
      .filter(
        (o): o is SimOrder & { status: "filled" | "canceled" } =>
          o.status !== "open" && o.symbol === params.symbol,
      )
      .map((o) => ({
        ...this.toOpenOrder(o),
        filledPrice: o.filledQty > 0 ? o.filledValue / o.filledQty : null,
        status: o.status,
      }));
  }

  async watchOrders(_params?: IWatchOrdersRequest): Promise<IWatchOrdersResponse> {
    throw new Error("Not implemented. Backtesting doesn't require this method.");
  }

  async watchCandles(_params?: IWatchCandlesRequest): Promise<IWatchCandlesResponse> {
    throw new Error("Not implemented. Backtesting doesn't require this method.");
  }

  async watchTrades(): Promise<ITrade[]> {
    throw new Error("Not implemented. Backtesting doesn't require this method.");
  }

  async watchOrderbook(): Promise<IOrderbook> {
    throw new Error("Not implemented. Backtesting doesn't require this method.");
  }

  async watchTicker(): Promise<ITicker> {
    throw new Error("Not implemented. Backtesting doesn't require this method.");
  }
}
