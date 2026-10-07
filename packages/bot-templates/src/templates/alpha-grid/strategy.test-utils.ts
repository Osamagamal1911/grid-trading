/**
 * alphaGrid S7/S8 test mock — scriptable in-memory IExchange.
 *
 * What: implements the FULL IExchange surface used by the strategy against
 * operator-controlled order books (no network, fully deterministic). Tests move
 * orders between open/closed to simulate fills; every mutating call is logged
 * for no-churn / reduceOnly / leverage assertions.
 *
 * Why a hand mock (not MemoryExchange): pinpoints exact fill sequences per test;
 * MemoryExchange grows its own simulation in S9.
 */

import { vi } from "vitest";
import type { TBotContext } from "@opentrader/bot-processor";
import type { IExchange } from "@opentrader/exchanges";
import type {
  ExchangeCode,
  IClosedOrder,
  IGetClosedOrdersResponse,
  IGetLimitOrderResponse,
  IGetMarkPriceResponse,
  IGetOpenOrdersResponse,
  IGetSymbolInfoRequest,
  IOpenOrder,
  ISymbolInfo,
  IPlaceLimitOrderRequest,
  IPlaceLimitOrderResponse,
  IPlaceMarketOrderRequest,
  IPlaceMarketOrderResponse,
  IPlaceStopOrderResponse,
  OrderSide,
} from "@opentrader/types";
import { alphaGridStrategy, type AlphaGridRuntimeState } from "./strategy.js";
import type { AlphaGridBotConfig } from "./schema.js";

export interface MockAlphaGridSymbol {
  tickSize: number;
  stepSize: number;
  minCost: number | null;
}

export class MockAlphaGridExchange implements IExchange {
  isPaper = false;
  isDemo = true;
  ccxt = {} as never;
  exchangeCode: ExchangeCode = "BINANCE";

  openOrders = new Map<string, IOpenOrder>();
  closedOrders = new Map<string, IClosedOrder>();
  markPrice = 100;
  candles: { high: number; low: number; close: number }[] = [];
  symbol: MockAlphaGridSymbol = { tickSize: 0.01, stepSize: 0.001, minCost: null };

  calls: { method: string; args: unknown }[] = [];
  setLeverageCalls: { symbol: string; leverage: number }[] = [];
  reduceOnlyFlags: { method: string; value: boolean | undefined }[] = [];
  private seq = 0;

  private log(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** Simulate an exchange-side fill (full): move to closed/filled at price. */
  fillOrder(orderId: string, filledPrice: number): void {
    const open = this.openOrders.get(orderId);
    if (!open) throw new Error(`MockAlphaGridExchange: no open order ${orderId}`);
    this.openOrders.delete(orderId);
    this.closedOrders.set(orderId, {
      ...open,
      quantityExecuted: open.quantity,
      volumeExecuted: open.quantity * filledPrice,
      filledPrice,
      status: "filled",
    });
  }

  /** Simulate a partial execution (stays open with cumulative totals). */
  partialFill(orderId: string, cumulativeQty: number, avgPrice: number): void {
    const open = this.openOrders.get(orderId);
    if (!open) throw new Error(`MockAlphaGridExchange: no open order ${orderId}`);
    open.quantityExecuted = cumulativeQty;
    open.volumeExecuted = cumulativeQty * avgPrice;
  }

  /** Simulate an external cancel. */
  cancelExternally(orderId: string): void {
    const open = this.openOrders.get(orderId);
    if (!open) throw new Error(`MockAlphaGridExchange: no open order ${orderId}`);
    this.openOrders.delete(orderId);
    this.closedOrders.set(orderId, { ...open, status: "canceled" });
  }

  /** Inject a FOREIGN order (strategy must refuse to run). */
  injectForeignOrder(order: Partial<IOpenOrder> & { exchangeOrderId: string }): void {
    this.openOrders.set(order.exchangeOrderId, {
      clientOrderId: undefined,
      symbol: "AKE/USDT:USDT",
      side: "buy",
      quantity: 1,
      quantityExecuted: 0,
      volume: 0,
      volumeExecuted: 0,
      price: 1,
      filledPrice: null,
      lastTradeTimestamp: 0,
      status: "open",
      fee: 0,
      createdAt: 0,
      ...order,
    } as IOpenOrder);
  }

  async destroy(): Promise<void> {}
  async loadMarkets(): Promise<Record<string, never>> {
    return {};
  }
  async accountAssets(): Promise<[]> {
    return [];
  }

  async getLimitOrder(params: { symbol: string; orderId: string }): Promise<IGetLimitOrderResponse> {
    this.log("getLimitOrder", params);
    const open = this.openOrders.get(params.orderId);
    if (open) {
      return { ...open, status: "open" };
    }
    const closed = this.closedOrders.get(params.orderId);
    if (!closed) throw new Error(`MockAlphaGridExchange: unknown order ${params.orderId}`);
    return { ...closed };
  }

  async placeLimitOrder(params: IPlaceLimitOrderRequest): Promise<IPlaceLimitOrderResponse> {
    this.log("placeLimitOrder", params);
    this.reduceOnlyFlags.push({ method: "placeLimitOrder", value: params.reduceOnly });
    this.seq += 1;
    const orderId = `mock-limit-${this.seq}`;
    this.openOrders.set(orderId, {
      exchangeOrderId: orderId,
      clientOrderId: params.clientOrderId,
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      quantityExecuted: 0,
      volume: params.quantity * params.price,
      volumeExecuted: 0,
      price: params.price,
      filledPrice: null,
      lastTradeTimestamp: 0,
      status: "open",
      fee: 0,
      createdAt: Date.now(),
    });
    return { orderId, clientOrderId: params.clientOrderId };
  }

  async placeMarketOrder(params: IPlaceMarketOrderRequest): Promise<IPlaceMarketOrderResponse> {
    this.log("placeMarketOrder", params);
    this.reduceOnlyFlags.push({ method: "placeMarketOrder", value: params.reduceOnly });
    this.seq += 1;
    return { orderId: `mock-market-${this.seq}` };
  }

  async placeOrder(): Promise<never> {
    throw new Error("MockAlphaGridExchange: placeOrder not expected");
  }

  /** Simulated conditional stop (S8): tracked as an open order until filled/canceled. */
  stopOrders: { orderId: string; params: Record<string, unknown> }[] = [];

  async placeStopOrder(params: {
    symbol: string;
    side: OrderSide;
    quantity: number;
    type: string;
    stopPrice: number;
    price?: number;
    reduceOnly?: boolean;
    triggerBasis?: string;
  }): Promise<IPlaceStopOrderResponse> {
    this.log("placeStopOrder", params);
    this.reduceOnlyFlags.push({ method: "placeStopOrder", value: params.reduceOnly });
    this.seq += 1;
    const orderId = `mock-stop-${this.seq}`;
    this.stopOrders.push({ orderId, params: { ...params } });
    this.openOrders.set(orderId, {
      exchangeOrderId: orderId,
      clientOrderId: undefined,
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      quantityExecuted: 0,
      volume: params.quantity * params.stopPrice,
      volumeExecuted: 0,
      price: params.stopPrice,
      filledPrice: null,
      lastTradeTimestamp: 0,
      status: "open",
      fee: 0,
      createdAt: Date.now(),
    });
    return { orderId };
  }

  async cancelLimitOrder(params: { symbol: string; orderId: string }): Promise<{ orderId: string }> {
    this.log("cancelLimitOrder", params);
    const open = this.openOrders.get(params.orderId);
    if (!open) throw new Error(`MockAlphaGridExchange: cancel of unknown order ${params.orderId}`);
    this.openOrders.delete(params.orderId);
    this.closedOrders.set(params.orderId, { ...open, status: "canceled" });
    return { orderId: params.orderId };
  }

  async getOpenOrders(params: { symbol: string }): Promise<IGetOpenOrdersResponse> {
    this.log("getOpenOrders", params);
    return [...this.openOrders.values()].filter((o) => o.symbol === params.symbol);
  }

  async getClosedOrders(params: { symbol: string }): Promise<IGetClosedOrdersResponse> {
    this.log("getClosedOrders", params);
    return [...this.closedOrders.values()].filter((o) => o.symbol === params.symbol);
  }

  async getTicker(symbol: string): Promise<never> {
    this.log("getTicker", symbol);
    throw new Error("MockAlphaGridExchange: getTicker not expected");
  }

  async getMarketPrice(params: { symbol: string }): Promise<{ symbol: string; price: number; timestamp: number }> {
    this.log("getMarketPrice", params);
    return { symbol: params.symbol, price: this.markPrice, timestamp: Date.now() };
  }

  async getMarkPrice(params: { symbol: string }): Promise<IGetMarkPriceResponse> {
    this.log("getMarkPrice", params);
    return { symbol: params.symbol, markPrice: this.markPrice, timestamp: Date.now() };
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.log("setLeverage", { symbol, leverage });
    this.setLeverageCalls.push({ symbol, leverage });
  }

  async getCandlesticks(params: { symbol: string; bar?: string; limit?: number }): Promise<
    { open: number; high: number; low: number; close: number; volume: number; timestamp: number }[]
  > {
    this.log("getCandlesticks", params);
    const limit = params.limit ?? this.candles.length;
    return this.candles.slice(-limit).map((c, i) => ({
      open: c.close,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: 10,
      timestamp: i,
    }));
  }

  async getSymbol(params: IGetSymbolInfoRequest): Promise<ISymbolInfo> {
    this.log("getSymbol", params);
    const decimalsPrice = Math.max(0, Math.round(-Math.log10(this.symbol.tickSize)));
    const decimalsAmount = Math.max(0, Math.round(-Math.log10(this.symbol.stepSize)));
    return {
      symbolId: `BINANCE:${params.currencyPair}`,
      currencyPair: params.currencyPair,
      exchangeCode: "BINANCE",
      exchangeSymbolId: params.currencyPair.replace("/", "").replace(":USDT", ""),
      baseCurrency: "AKE",
      quoteCurrency: "USDT",
      filters: {
        precision: { amount: this.symbol.stepSize, price: this.symbol.tickSize },
        decimals: { amount: decimalsAmount, price: decimalsPrice },
        limits: {
          amount: { min: 0.001 },
          cost: this.symbol.minCost === null ? undefined : { min: this.symbol.minCost },
        },
      },
    } as ISymbolInfo;
  }

  async getSymbols(): Promise<ISymbolInfo[]> {
    return [];
  }

  async getTradingFeeRates(): Promise<{ makerFee: number; takerFee: number }> {
    return { makerFee: 0, takerFee: 0 };
  }

  async watchOrders(): Promise<never> {
    throw new Error("MockAlphaGridExchange: watchOrders not expected");
  }
  async watchCandles(): Promise<never> {
    throw new Error("MockAlphaGridExchange: watchCandles not expected");
  }
  async watchTrades(): Promise<never> {
    throw new Error("MockAlphaGridExchange: watchTrades not expected");
  }
  async getOrderbook(): Promise<never> {
    throw new Error("MockAlphaGridExchange: getOrderbook not expected");
  }
  async watchOrderbook(): Promise<never> {
    throw new Error("MockAlphaGridExchange: watchOrderbook not expected");
  }
  async watchTicker(): Promise<never> {
    throw new Error("MockAlphaGridExchange: watchTicker not expected");
  }
}

export function mockSideOrders(
  exchange: MockAlphaGridExchange,
  side: OrderSide,
): { exchangeOrderId: string; price: number }[] {
  return [...exchange.openOrders.values()]
    .filter((o) => o.side === side)
    .map((o) => ({ exchangeOrderId: o.exchangeOrderId, price: o.price }));
}

/* ------------------------------------------------------------------ */
/* Shared deterministic harness (S7 + S8 suites).                      */
/* ------------------------------------------------------------------ */

export const MARKET = "AKE/USDT:USDT";

export function baseSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

export interface TestCtx {
  ctx: TBotContext<AlphaGridBotConfig>;
  control: { stop: ReturnType<typeof vi.fn> };
}

export function makeCtx(
  exchange: MockAlphaGridExchange,
  settings: Record<string, unknown>,
  state: Record<string, unknown>,
  mode: "start" | "process" | "stop",
): TestCtx {
  const control = { stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
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

export async function drain(gen: Generator<Promise<unknown>, void, unknown>): Promise<void> {
  let item = gen.next();
  while (!item.done) {
    if (!(item.value instanceof Promise)) {
      throw new Error("strategy yielded a non-promise effect (only exchange promises allowed)");
    }
    item = gen.next(await item.value);
  }
}

export async function runTick(
  exchange: MockAlphaGridExchange,
  settings: Record<string, unknown>,
  state: Record<string, unknown>,
  mode: "start" | "process" | "stop" = "process",
): Promise<{ state: AlphaGridRuntimeState; control: { stop: ReturnType<typeof vi.fn> } }> {
  const { ctx, control } = makeCtx(exchange, settings, state, mode);
  await drain(alphaGridStrategy(ctx));
  return { state: state as unknown as AlphaGridRuntimeState, control };
}

export function buyIds(exchange: MockAlphaGridExchange): string[] {
  return mockSideOrders(exchange, "buy").map((o) => o.exchangeOrderId);
}

export function sellIds(exchange: MockAlphaGridExchange): string[] {
  return mockSideOrders(exchange, "sell").map((o) => o.exchangeOrderId);
}

export function walkCandles(count: number, start = 100): { high: number; low: number; close: number }[] {
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
