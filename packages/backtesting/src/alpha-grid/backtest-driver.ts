/**
 * alphaGrid S9 — backtest driver + honesty metrics (D41).
 *
 * What: replays 1h candles through the REAL StrategyRunner (same code path as
 * live, §4.5) with MemoryExchange order simulation. Restart-after-stop models an
 * operator redeploy per stop-out (documented, not hidden); every stop-out,
 * cycle, fee, and liquidation check is recorded and gated by assertions.
 *
 * Methodology (stated in the report, no cherry-picking): equity = capital +
 * realized price-PnL − fees + unrealized; cycles close via TP (win = net > 0)
 * or stop-outs (exchange-hit vs supervisor split by fill journal); an open
 * position at end-of-data is marked to close, never force-flattened.
 */

import { vi } from "vitest";
import { createStrategyRunner } from "@opentrader/bot-processor";
import type { IBotConfiguration } from "@opentrader/bot-processor";
import { alphaGrid, alphaGridSchema, type AlphaGridSettings } from "@opentrader/bot-templates";
import type { BotState } from "@opentrader/bot-processor";
import type { ICandlestick } from "@opentrader/types";
import { ExchangeCode } from "@opentrader/types";
import {
  computeMarginUsed,
  computePositionFromFills,
  computeUnrealizedRoiPct,
} from "@opentrader/tools";
import { MarketSimulator } from "../market-simulator.js";
import { MemoryExchange } from "../exchange/memory-exchange.js";
import { MemoryStore } from "../store/memory-store.js";

export interface AlphaGridBacktestCosts {
  makerBps: number;
  takerBps: number;
  slippageBps: number;
}

export interface AlphaGridBacktestConfig {
  symbol: string;
  settings: Record<string, unknown>;
  /** Allocated capital (equity denominator + margin headroom). */
  capital: number;
  tickSize: number;
  stepSize: number;
  minCost: number | null;
  costs?: Partial<AlphaGridBacktestCosts>;
  /** ROI-points tolerance around −stopLossPct for stop-out sanity (default 1.0). */
  stopRoiTolerancePct?: number;
}

export interface StopOutRecord {
  index: number;
  timestamp: number;
  kind: "exchange-hit" | "supervisor";
  roiAtTriggerPct: number;
  realizedNet: number;
}

export interface LiquidationRecord {
  index: number;
  timestamp: number;
  roiAtExtremePct: number;
  /** A Layer-1 stop was resting during the candle (gap-through vs naked). */
  hadStop: boolean;
}

export interface CycleRecord {
  kind: "tp" | "stop" | "netted";
  startIndex: number;
  endIndex: number;
  realizedNet: number;
  win: boolean;
}

export interface AlphaGridBacktestReport {
  symbol: string;
  settings: AlphaGridSettings;
  capital: number;
  candleCount: number;
  windowStart: string;
  windowEnd: string;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  maxMarginUsed: number;
  winRate: number;
  closedCycles: number;
  tpCycles: number;
  stopOuts: StopOutRecord[];
  cycles: CycleRecord[];
  totalFees: number;
  liquidations: number;
  liquidationEvents: LiquidationRecord[];
  openPosition: null | { direction: string; totalQty: number; avgEntry: number; unrealizedPct: number };
}

interface RuntimeStateShape {
  direction: "long" | "short" | null;
  fills: { price: number; quantity: number; side: "long" | "short" }[];
  totalQty: number;
  cycleCount: number;
  stopOrderId: string | null;
  tpOrderId: string | null;
  /** Resting Layer-1 stop price during the candle (null when none). */
  stopPrice: number | null;
}

function readRuntime(state: BotState): RuntimeStateShape {
  const s = state as unknown as Partial<RuntimeStateShape> & {
    orders?: { orderId: string; kind: string; price: number }[];
  };
  const stopOrderId = s.stopOrderId ?? null;
  const stopPrice =
    stopOrderId !== null
      ? (s.orders?.find((o) => o.orderId === stopOrderId)?.price ?? null)
      : null;
  return {
    direction: s.direction ?? null,
    fills: Array.isArray(s.fills) ? (s.fills as RuntimeStateShape["fills"]) : [],
    totalQty: typeof s.totalQty === "number" ? s.totalQty : 0,
    cycleCount: typeof s.cycleCount === "number" ? s.cycleCount : 0,
    stopOrderId,
    tpOrderId: s.tpOrderId ?? null,
    stopPrice,
  };
}

export async function runAlphaGridBacktest(
  candles: ICandlestick[],
  config: AlphaGridBacktestConfig,
): Promise<AlphaGridBacktestReport> {
  if (candles.length < 30) {
    throw new Error(`alphaGrid backtest: need ≥ 30 candles, got ${candles.length}.`);
  }
  const settings = alphaGridSchema.parse(config.settings) as AlphaGridSettings;
  const tolerance = config.stopRoiTolerancePct ?? 1.0;

  const marketSimulator = new MarketSimulator();
  const store = new MemoryStore(marketSimulator);
  const exchange = new MemoryExchange(marketSimulator, {
    exchangeCode: ExchangeCode.BINANCE,
    tickSize: config.tickSize,
    stepSize: config.stepSize,
    minCost: config.minCost,
    costs: config.costs,
  });
  const botConfig: IBotConfiguration<AlphaGridSettings> = {
    id: 0,
    symbol: `${config.symbol.slice(0, -4)}/USDT:USDT`,
    exchangeCode: ExchangeCode.BINANCE,
    settings,
    timeframe: "1h",
  };
  const runner = createStrategyRunner({
    store,
    exchange,
    additionalExchanges: [],
    botConfig,
    botTemplate: alphaGrid,
  });

  const state: BotState = {};
  let realized = 0;
  let feesPaid = 0;
  let journalCursor = 0;
  let realizedAtCycleStart = 0;
  let feesAtCycleStart = 0;
  let cycleStartIndex = 0;
  const cycles: CycleRecord[] = [];
  const stopOuts: StopOutRecord[] = [];
  let liquidations = 0;
  const liquidationEvents: LiquidationRecord[] = [];
  let maxMarginUsed = 0;
  let peak = config.capital;
  let maxDrawdownPct = 0;
  const equityCurve: number[] = [];

  // Sim-time honesty (D46): the supervisor gates on Date.now(), so pin the clock to
  // each candle — backtest ticks must not share one wall-clock millisecond.
  vi.useFakeTimers();
  try {
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index] as ICandlestick;
      vi.setSystemTime(candle.timestamp);
      exchange.processCandle(candle);

    const pre = readRuntime(state);
    const preAvg = pre.fills.length > 0 ? computePositionFromFills(pre.fills).avgEntry : 0;

    if (index === 0) {
      await runner.start(state);
    } else {
      await runner.process(state, undefined, { candle, candles: candles.slice(0, index + 1) });
    }

    // Account new executions (exchange-side truth) against the pre-tick position.
    const newFills = exchange.fillJournal.slice(journalCursor);
    journalCursor = exchange.fillJournal.length;
    for (const fill of newFills) {
      feesPaid += fill.fee;
      if (pre.direction !== null && pre.totalQty > 0) {
        const exitSide = pre.direction === "long" ? "sell" : "buy";
        if (fill.side === exitSide) {
          const dirSign = pre.direction === "long" ? 1 : -1;
          realized += (fill.price - preAvg) * fill.quantity * dirSign;
        }
        // Entry fills: price-PnL untouched (avg updates); fees accrue via feesPaid.
      }
    }

    const post = readRuntime(state);
    if (pre.direction !== null && pre.totalQty > 0) {
      const margin = computeMarginUsed(preAvg, pre.totalQty, settings.leverage);
      if (margin > maxMarginUsed) maxMarginUsed = margin;
    }

    // Cycle / stop-out / net-close detection via state transitions (D41c + D44).
    if (pre.direction !== null && post.direction === null) {
      const cycleRealizedNet = realized - realizedAtCycleStart - (feesPaid - feesAtCycleStart);
      if (post.cycleCount === pre.cycleCount + 1) {
        const win = cycleRealizedNet > 0;
        cycles.push({ kind: "tp", startIndex: cycleStartIndex, endIndex: index, realizedNet: cycleRealizedNet, win });
        if (!win) {
          throw new Error(
            `alphaGrid backtest sanity: TP cycle closed non-profitable (net ${cycleRealizedNet}). TP math broken.`,
          );
        }
      } else {
        // Cleared without a TP cycle: stop-out (stop/market exit fills present) or a
        // netted round-trip (grid fills only — both sides crossed one candle, D44).
        const exitFills = newFills.filter((f) => f.kind !== "limit" || f.orderId === pre.tpOrderId);
        if (exitFills.length > 0) {
          // Stop-out (exchange-hit vs supervisor via the fill journal). A fill at or
          // beyond the stop level is required (never early); ≤ −100% is ruin, not a stop.
          const stopFill = newFills.find((f) => f.orderId === pre.stopOrderId);
          const triggerPrice = stopFill ? stopFill.price : candle.close;
          const roi = computeUnrealizedRoiPct(triggerPrice, preAvg, pre.direction, pre.totalQty, settings.leverage);
          if (roi <= -100) {
            liquidations += 1;
            liquidationEvents.push({
              index,
              timestamp: candle.timestamp,
              roiAtExtremePct: roi,
              hadStop: stopFill !== undefined,
            });
            cycles.push({ kind: "stop", startIndex: cycleStartIndex, endIndex: index, realizedNet: cycleRealizedNet, win: false });
          } else {
            if (roi > -settings.stopLossPct + tolerance) {
              throw new Error(
                `alphaGrid backtest sanity: stop fired EARLY at ROI ${roi.toFixed(2)}% (stop −${settings.stopLossPct}%). Sim mismatch.`,
              );
            }
            stopOuts.push({
              index,
              timestamp: candle.timestamp,
              kind: stopFill ? "exchange-hit" : "supervisor",
              roiAtTriggerPct: roi,
              realizedNet: cycleRealizedNet,
            });
            cycles.push({ kind: "stop", startIndex: cycleStartIndex, endIndex: index, realizedNet: cycleRealizedNet, win: false });
          }
        } else {
          // Netted scalp: economically closed, no stop involved (win = net > 0).
          cycles.push({ kind: "netted", startIndex: cycleStartIndex, endIndex: index, realizedNet: cycleRealizedNet, win: cycleRealizedNet > 0 });
        }
      }
      realizedAtCycleStart = realized;
      feesAtCycleStart = feesPaid;
      cycleStartIndex = index;
    }

    // Post-tick protection audit on SURVIVING positions (D46 design):
    // a resting stop the range crossed must have filled (else the sim is wrong);
    // ruin without any resting stop is honest naked exposure.
    if (post.direction !== null && post.totalQty > 0) {
      const postAvg = computePositionFromFills(post.fills).avgEntry;
      const extreme = post.direction === "long" ? candle.low : candle.high;
      const extremeRoi = computeUnrealizedRoiPct(extreme, postAvg, post.direction, post.totalQty, settings.leverage);
      const stopCrossed =
        pre.stopPrice !== null && pre.stopOrderId !== null
          ? post.direction === "long"
            ? candle.low <= pre.stopPrice
            : candle.high >= pre.stopPrice
          : false;
      const stopFilled = newFills.some((f) => f.orderId === pre.stopOrderId);
      if (stopCrossed && !stopFilled && post.stopOrderId === pre.stopOrderId) {
        throw new Error(
          `alphaGrid backtest sanity: crossed stop ${pre.stopOrderId} @ ${pre.stopPrice} did not fill (candle #${index}). Sim mismatch.`,
        );
      }
      if (extremeRoi <= -100 && pre.stopOrderId === null) {
        liquidations += 1;
        liquidationEvents.push({ index, timestamp: candle.timestamp, roiAtExtremePct: extremeRoi, hadStop: false });
      }
    }

    const unrealized =
      post.direction !== null && post.totalQty > 0
        ? (computeUnrealizedRoiPct(
            candle.close,
            computePositionFromFills(post.fills).avgEntry,
            post.direction,
            post.totalQty,
            settings.leverage,
          ) /
            100) *
          computeMarginUsed(computePositionFromFills(post.fills).avgEntry, post.totalQty, settings.leverage)
        : 0;
    const equity = config.capital + realized - feesPaid + unrealized;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    }
  } finally {
    vi.useRealTimers();
  }

  // Liquidations are REPORTED (honest ruin accounting), never asserted away: a wick
  // through an unprotected position is a real finding, not a model bug.

  const finalEquity = equityCurve[equityCurve.length - 1] as number;
  const post = readRuntime(state);
  const tpCycles = cycles.filter((c) => c.kind === "tp").length;
  const closedCycles = cycles.length;
  const winningCycles = cycles.filter((c) => c.win).length;

  return {
    symbol: config.symbol,
    settings,
    capital: config.capital,
    candleCount: candles.length,
    windowStart: new Date(candles[0]?.timestamp as number).toISOString(),
    windowEnd: new Date(candles[candles.length - 1]?.timestamp as number).toISOString(),
    finalEquity,
    totalReturnPct: ((finalEquity - config.capital) / config.capital) * 100,
    maxDrawdownPct,
    maxMarginUsed,
    winRate: closedCycles > 0 ? winningCycles / closedCycles : 0,
    closedCycles,
    tpCycles,
    stopOuts,
    cycles,
    totalFees: feesPaid,
    liquidations,
    liquidationEvents,
    openPosition:
      post.direction !== null && post.totalQty > 0
        ? {
            direction: post.direction,
            totalQty: post.totalQty,
            avgEntry: computePositionFromFills(post.fills).avgEntry,
            unrealizedPct: computeUnrealizedRoiPct(
              candles[candles.length - 1]?.close as number,
              computePositionFromFills(post.fills).avgEntry,
              post.direction,
              post.totalQty,
              settings.leverage,
            ),
          }
        : null,
  };
}
