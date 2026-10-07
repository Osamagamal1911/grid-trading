/**
 * alphaGrid S7 — strategy core: §4.3 state machine + trailing + TP sync (BUILD_PROMPT.md).
 *
 * What: FLAT → arm sides → first-fill direction lock (+ cancel opposite) → average in
 * (≤ nLevels fills, avgEntry recomputed after EVERY fill) → ONE reduceOnly TP order
 * re-synced after every fill → trailing redraw on pumps (S5 useTrailing) → TP-filled
 * closes the cycle → FLAT redraw. Manual stop flattens. Local fill tracking only
 * (`fills[]`, `totalQty`); ONLY `IExchange` methods, never `exchange.ccxt` (§4.5).
 *
 * Stops are S8's (this step implements NO ROI force-close, D37e); the exit-sync point
 * (`syncTakeProfitOrder`) is structured for S8's stop branch.
 */

import type { TBotContext, IBotControl } from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";
import type { IExchange } from "@opentrader/exchanges";
import type { BarSize, IGetLimitOrderResponse, IOpenOrder, OrderSide } from "@opentrader/types";
import { atr, IndicatorError, latestAtrValue } from "@opentrader/indicators";
import {
  buildViableGridLevels,
  computeAtrLevelSpacing,
  computeManualCenterPrice,
  computeManualLevelSpacing,
  computePositionFromFills,
  computeStopLossPrice,
  computeTakeProfitPrice,
  computeUnrealizedRoiPct,
  roundQuantityToStep,
  type AlphaGridFill,
  type AlphaGridSide,
} from "@opentrader/tools";
import {
  alphaGridSchema,
  getAlphaGridRiskWarnings,
  validateAlphaGridSettings,
  type AlphaGridBotConfig,
  type AlphaGridSettings,
} from "./schema.js";
import {
  marketPrecisionFromSymbolInfo,
  normalizeAlphaGridSymbol,
  toFuturesMarketId,
} from "./market.js";

export type AlphaGridTrackedOrderKind = "grid" | "tp" | "stop";

export interface AlphaGridTrackedOrder {
  orderId: string;
  kind: AlphaGridTrackedOrderKind;
  side: OrderSide;
  price: number;
  quantity: number;
  /** Stop-limit offset price (kind "stop" + stopOrderType limit only). */
  limitPrice?: number;
  /** Executed qty already accounted (partials accumulate across ticks). */
  filledSoFar: number;
  /** Executed value already accounted (exact partial pricing). */
  filledValueSoFar: number;
}

export interface AlphaGridRuntimeState {
  version: 4;
  initialized: boolean;
  marketId: string;
  tickSize: number;
  stepSize: number;
  minQty: number | null;
  minCost: number | null;
  centerPrice: number;
  levelSpacing: number;
  gridTop: number;
  gridBottom: number;
  /** Locked direction (null = FLAT / auto-undecided). Invariant: set ⟺ totalQty > 0. */
  direction: AlphaGridSide | null;
  /** Entry fills, append-only (exits decrement totalQty, never touch fills). */
  fills: AlphaGridFill[];
  /** Remaining position size (Σ entries − Σ exit executions). */
  totalQty: number;
  orders: AlphaGridTrackedOrder[];
  tpOrderId: string | null;
  /** Layer-1 exchange-side stop order id (S8; null when disabled/absent). */
  stopOrderId: string | null;
  /** Why Layer 1 is down, if so: min-notional skip (D42) vs placement failure (D48). Warn per reason. */
  stopDownReason: "min-notional" | "placement-failed" | null;
  /** True while TP placement keeps failing — warn once per transition, position rides (D48). */
  tpUnplaceable: boolean;
  /** Last supervisor evaluation, ms epoch (D30 throttle). */
  lastSupervisorRun: number;
  noStopLossAck: boolean;
  idleOutOfRange: boolean;
  cycleCount: number;
}

type Yielded = Promise<unknown>;
// NextType is `any` (like upstream templates): the runner feeds resolved values
// back in, which no static type can express. Yields are always exchange promises.
type StratGen<T = void> = Generator<Yielded, T, any>;

const STATE_VERSION = 4;

function freshState(marketId: string): AlphaGridRuntimeState {
  return {
    version: STATE_VERSION,
    initialized: true,
    marketId,
    tickSize: 0,
    stepSize: 0,
    minQty: null,
    minCost: null,
    centerPrice: 0,
    levelSpacing: 0,
    gridTop: 0,
    gridBottom: 0,
    direction: null,
    fills: [],
    totalQty: 0,
    orders: [],
    tpOrderId: null,
    stopOrderId: null,
    stopDownReason: null,
    tpUnplaceable: false,
    lastSupervisorRun: 0,
    noStopLossAck: false,
    idleOutOfRange: false,
    cycleCount: 0,
  };
}

/** Parse + validate settings every run (fail fast on corrupt edits). */
export function readAlphaGridSettings(rawSettings: unknown): AlphaGridSettings {
  const raw = typeof rawSettings === "string" ? (JSON.parse(rawSettings) as unknown) : rawSettings;
  const parsed = alphaGridSchema.parse(raw);
  const violations = validateAlphaGridSettings(parsed);
  if (violations.length > 0) {
    throw new Error(`alphaGrid: invalid settings: ${violations.join("; ")}`);
  }
  return parsed;
}

/** Rehydrate persisted state (restart-safe); reset on market change or version skew.
 *
 * CRITICAL: always mutates and returns the SAME object reference — the runner
 * persists exactly the object it passed in (`updateState(botState)`), so a fresh
 * copy would silently lose every mutation (caught by tests, would brick live state).
 */
export function ensureAlphaGridState(rawState: unknown, marketId: string): AlphaGridRuntimeState {
  const s = rawState as Partial<AlphaGridRuntimeState> | null | undefined;
  const prevMarket = s !== null && typeof s === "object" ? (s as Partial<AlphaGridRuntimeState>).marketId : undefined;
  const valid =
    s !== null &&
    typeof s === "object" &&
    s.version === STATE_VERSION &&
    s.initialized === true &&
    s.marketId === marketId &&
    Array.isArray(s.orders) &&
    Array.isArray(s.fills);
  if (valid) {
    return s as AlphaGridRuntimeState;
  }
  if (prevMarket !== undefined && prevMarket !== marketId) {
    logger.warn(`[AlphaGrid] Market changed (${prevMarket} → ${marketId}) — resetting runtime state.`);
  }
  const base = (s !== null && typeof s === "object" ? s : {}) as Record<string, unknown>;
  for (const key of Object.keys(base)) {
    delete base[key];
  }
  return Object.assign(base, freshState(marketId)) as AlphaGridRuntimeState;
}

function sideToDirection(side: OrderSide): AlphaGridSide {
  if (side === "buy") return "long";
  if (side === "sell") return "short";
  throw new Error(`alphaGrid: unexpected order side "${side}".`);
}

function directionToGridSide(direction: AlphaGridSide): OrderSide {
  return direction === "long" ? "buy" : "sell";
}

function directionToExitSide(direction: AlphaGridSide): OrderSide {
  return direction === "long" ? "sell" : "buy";
}

/** Remove tracked orders by predicate (used after cancels). */
function untrackOrders(state: AlphaGridRuntimeState, orderIds: Set<string>): void {
  state.orders = state.orders.filter((o) => !orderIds.has(o.orderId));
  if (state.tpOrderId !== null && orderIds.has(state.tpOrderId)) {
    state.tpOrderId = null;
  }
  if (state.stopOrderId !== null && orderIds.has(state.stopOrderId)) {
    state.stopOrderId = null;
  }
}

function* cancelTrackedOrders(
  exchange: IExchange,
  marketId: string,
  state: AlphaGridRuntimeState,
  openIds: Set<string>,
  predicate: (o: AlphaGridTrackedOrder) => boolean,
): StratGen {
  const targets = state.orders.filter((o) => predicate(o) && openIds.has(o.orderId));
  for (const target of targets) {
    // Stops live on the algo endpoint (D48) — route explicitly, like lookups.
    yield exchange.cancelLimitOrder({ symbol: marketId, orderId: target.orderId, stop: target.kind === "stop" });
  }
  untrackOrders(state, new Set(targets.map((t) => t.orderId)));
}

interface ExecutionDelta {
  execQty: number;
  execPrice: number;
}

/** Exact partial-fill accounting from cumulative executed qty/value. */
function executionDelta(
  cumulativeQty: number,
  cumulativeValue: number,
  tracked: AlphaGridTrackedOrder,
  fallbackPrice: number | null,
): ExecutionDelta | null {
  const execQty = cumulativeQty - tracked.filledSoFar;
  if (execQty <= 0) return null;
  const valueDelta = cumulativeValue - tracked.filledValueSoFar;
  const execPrice = valueDelta > 0 ? valueDelta / execQty : (fallbackPrice ?? tracked.price);
  if (!Number.isFinite(execPrice) || execPrice <= 0) {
    throw new Error(`alphaGrid: non-positive execution price for order ${tracked.orderId}.`);
  }
  return { execQty, execPrice };
}

/**
 * Reconcile tracked orders against the exchange (D36): record fill deltas
 * (grid → entries + direction lock; TP/stop → position reduction), drop canceled,
 * refuse foreign orders. Returns true when an exchange stop-hit stopped the bot
 * (caller must return immediately).
 */
function* reconcileOrders(
  exchange: IExchange,
  control: IBotControl,
  marketId: string,
  state: AlphaGridRuntimeState,
): StratGen<boolean> {
  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openById = new Map(openOrders.map((o) => [o.exchangeOrderId, o]));
  const wasFlat = state.direction === null;
  let stopExecuted = false;

  const foreign = openOrders.filter((o) => !state.orders.some((t) => t.orderId === o.exchangeOrderId));
  if (foreign.length > 0) {
    throw new Error(
      `alphaGrid: refusing to run with ${foreign.length} untracked open order(s) for ${marketId} ` +
        `(${foreign.map((o) => o.exchangeOrderId).join(", ")}). Cancel them on the exchange, then restart.`,
    );
  }

  for (const tracked of state.orders) {
    const open = openById.get(tracked.orderId);
    if (open) {
      const delta = executionDelta(open.quantityExecuted, open.volumeExecuted, tracked, null);
      if (delta) {
        accountExecution(state, tracked, delta);
        if (tracked.kind === "stop") stopExecuted = true;
      }
      continue;
    }
    // Missing from open → resolve once via fetch. Account any remainder, then
    // drop only terminal orders (a still-open order here is a race — keep it).
    // Stops resolve through the algo endpoint (D48).
    const fetched: IGetLimitOrderResponse = yield exchange.getLimitOrder({
      symbol: marketId,
      orderId: tracked.orderId,
      stop: tracked.kind === "stop",
    });
    const delta = executionDelta(fetched.quantityExecuted, fetched.volumeExecuted, tracked, fetched.filledPrice);
    if (delta) {
      accountExecution(state, tracked, delta);
      if (tracked.kind === "stop") stopExecuted = true;
    }
    if (fetched.status === "filled" || fetched.status === "canceled") {
      untrackOrders(state, new Set([tracked.orderId]));
    }
  }

  // First fill locked the direction above → cancel the opposite resting side now
  // (openIds snapshot is pre-fill; refresh to avoid canceling just-filled orders).
  if (wasFlat && state.direction !== null) {
    const freshOpen: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
    yield* cancelOppositeSide(
      exchange,
      marketId,
      state,
      new Set(freshOpen.map((o) => o.exchangeOrderId)),
      state.direction,
    );
  }

  // Exchange-side stop executed → the position is gone (or dust): cancel the rest,
  // close any remainder, clear, and STOP the bot (spec §4.3). Takes precedence
  // over TP-cycle logic below.
  if (stopExecuted) {
    yield* handleExchangeStopHit(exchange, control, marketId, state);
    return true;
  }
  return false;
}

/** Apply one execution delta: grid fills average in (+ lock); TP executions reduce. */
function accountExecution(
  state: AlphaGridRuntimeState,
  tracked: AlphaGridTrackedOrder,
  delta: ExecutionDelta,
): void {
  tracked.filledSoFar += delta.execQty;
  tracked.filledValueSoFar += delta.execQty * delta.execPrice;

  if (tracked.kind === "grid") {
    const fillSide = sideToDirection(tracked.side);
    if (state.direction === null) {
      state.fills.push({ price: delta.execPrice, quantity: delta.execQty, side: fillSide });
      state.totalQty += delta.execQty;
      state.direction = fillSide;
      logger.info(`[AlphaGrid] Direction locked: ${fillSide} (first fill). Canceling opposite side.`);
    } else if (fillSide !== state.direction) {
      // Raced opposite fill (both sides crossed between polls, D44): net it.
      const closeQty = Math.min(delta.execQty, state.totalQty);
      state.totalQty -= closeQty;
      logger.info(
        `[AlphaGrid] Opposite grid fill netted: ${tracked.side} ${delta.execQty} @ ${delta.execPrice} closed ${closeQty} of ${state.direction} position (remaining ${state.totalQty}).`,
      );
      if (state.totalQty <= 0) {
        state.totalQty = 0;
        state.direction = null;
        state.fills = [];
      }
      const excess = delta.execQty - closeQty;
      if (excess > 0) {
        state.fills.push({ price: delta.execPrice, quantity: excess, side: fillSide });
        state.totalQty += excess;
        state.direction = fillSide;
        logger.info(`[AlphaGrid] Net flip: new ${fillSide} position ${excess}.`);
      }
    } else {
      state.fills.push({ price: delta.execPrice, quantity: delta.execQty, side: fillSide });
      state.totalQty += delta.execQty;
      logger.info(
        `[AlphaGrid] Grid fill: ${tracked.side} ${delta.execQty} @ ${delta.execPrice} (position ${state.totalQty}).`,
      );
    }
  } else if (tracked.kind === "stop") {
    // Exchange-side stop executed: the exchange closed (part of) the position.
    state.totalQty -= delta.execQty;
    if (state.totalQty < 0) state.totalQty = 0;
    logger.warn(`[AlphaGrid] Exchange STOP executed ${delta.execQty} @ ${delta.execPrice} (remaining ${state.totalQty}).`);
  } else {
    state.totalQty -= delta.execQty;
    if (state.totalQty < 0) state.totalQty = 0;
    logger.info(`[AlphaGrid] TP executed ${delta.execQty} @ ${delta.execPrice} (remaining ${state.totalQty}).`);
  }
}

/** Cancel resting grid orders of the side opposite to the locked direction. */
function* cancelOppositeSide(
  exchange: IExchange,
  marketId: string,
  state: AlphaGridRuntimeState,
  openIds: Set<string>,
  direction: AlphaGridSide,
): StratGen {
  const opposite: OrderSide = direction === "long" ? "sell" : "buy";
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, (o) => o.kind === "grid" && o.side === opposite);
}

function* currentSpacing(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  markPrice: number,
): StratGen<{ spacing: number; center: number } | null> {
  if (settings.gridMode === "manual") {
    return {
      spacing: computeManualLevelSpacing(settings.manualHighPrice as number, settings.manualLowPrice as number, settings.nLevels),
      center: computeManualCenterPrice(settings.manualHighPrice as number, settings.manualLowPrice as number),
    };
  }
  // ATR mode needs on-the-wire candles (settings.atrTimeframe pre-validated by readAlphaGridSettings).
  const candles = yield exchange.getCandlesticks({ symbol: marketId, bar: settings.atrTimeframe as BarSize, limit: 30 });
  const values = yield atr({ periods: 14 }, candles);
  const atrValue = latestAtrValue(values);
  return { spacing: computeAtrLevelSpacing(atrValue, settings.atrMultiplier), center: markPrice };
}

function armedSides(settings: AlphaGridSettings, direction: AlphaGridSide | null): OrderSide[] {
  const locked = direction ?? (settings.direction === "auto" ? null : (settings.direction as AlphaGridSide));
  if (locked === "long") return ["buy"];
  if (locked === "short") return ["sell"];
  return ["buy", "sell"];
}

/**
 * Place grid levels for one side, skipping sub-min-notional dust (D43).
 * Returns the count placed this call; warns on skips (one line per call, no spam).
 */
function* placeLevelOrders(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
  side: OrderSide,
  prices: number[],
): StratGen<number> {
  const quantity = roundQuantityToStep(settings.volumePerLevel, state.stepSize);
  if (quantity <= 0) {
    throw new Error(`alphaGrid: volumePerLevel ${settings.volumePerLevel} rounds to 0 at step ${state.stepSize}.`);
  }
  let placed = 0;
  let skipped = 0;
  for (const price of prices) {
    if (state.minCost !== null && quantity * price < state.minCost) {
      skipped += 1;
      continue;
    }
    const order = yield exchange.placeLimitOrder({ symbol: marketId, side, quantity, price });
    state.orders.push({ orderId: order.orderId, kind: "grid", side, price, quantity, filledSoFar: 0, filledValueSoFar: 0 });
    placed += 1;
  }
  if (skipped > 0) {
    logger.warn(`[AlphaGrid] Skipped ${skipped} sub-min-notional ${side} level(s); placed ${placed}.`);
  }
  return placed;
}
function* drawGrid(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
  markPrice: number,
): StratGen<boolean> {
  let layout: { spacing: number; center: number } | null = null;
  try {
    layout = yield* currentSpacing(exchange, marketId, settings, markPrice);
  } catch (err) {
    // Insufficient ATR history → wait for more closes (never grid without spacing).
    // Anything else (auth, network, bad market) propagates — fail loud.
    if (!(err instanceof IndicatorError)) throw err;
    logger.warn(`[AlphaGrid] No ATR yet (${err.message}) — waiting for data.`);
    return false;
  }
  if (!layout) return false;

  const levels = buildViableGridLevels(layout.center, layout.spacing, settings.nLevels, state.tickSize);
  state.centerPrice = layout.center;
  state.levelSpacing = layout.spacing;
  state.gridTop = levels.gridTop;
  state.gridBottom = levels.gridBottom;

  const trackedPrices = new Set(state.orders.filter((o) => o.kind === "grid").map((o) => `${o.side}@${o.price}`));
  const sides = armedSides(settings, state.direction);
  for (const side of sides) {
    const prices = (side === "buy" ? levels.buyLevels : levels.sellLevels).filter(
      (price) => !trackedPrices.has(`${side}@${price}`),
    );
    yield* placeLevelOrders(exchange, marketId, settings, state, side, prices);
  }
  if (!state.orders.some((o) => o.kind === "grid")) {
    throw new Error(
      `alphaGrid: no grid level clears the exchange minimum ${state.minCost} — raise volumePerLevel.`,
    );
  }
  logger.info(`[AlphaGrid] Grid drawn: center ${layout.center}, spacing ${layout.spacing}, sides ${sides.join("+")}.`);
  return true;
}

/** Re-sync the single reduceOnly TP order for the whole position (idempotent, no churn). */
function* syncTakeProfitOrder(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  if (!settings.useTakeProfit || state.direction === null || state.totalQty <= 0) return;

  const position = computePositionFromFills(state.fills);
  const tpPrice = computeTakeProfitPrice(position.avgEntry, settings.tpPct, settings.leverage, state.direction, state.tickSize);
  const tpQty = roundQuantityToStep(state.totalQty, state.stepSize);
  if (tpQty <= 0) {
    throw new Error(`alphaGrid: remaining position ${state.totalQty} rounds to 0 at step ${state.stepSize} — manual recovery needed.`);
  }
  const side = directionToExitSide(state.direction);

  const existing = state.orders.find((o) => o.orderId === state.tpOrderId);
  if (existing && existing.price === tpPrice && existing.quantity === tpQty) {
    return; // in sync — no churn.
  }
  if (existing) {
    yield exchange.cancelLimitOrder({ symbol: marketId, orderId: existing.orderId });
    untrackOrders(state, new Set([existing.orderId]));
  }
  // D48: a failing TP placement must degrade (warn + ride under stop protection),
  // never brick the tick and discard reconcile progress. Retried next tick.
  try {
    const placed = yield exchange.placeLimitOrder({ symbol: marketId, side, quantity: tpQty, price: tpPrice, reduceOnly: true });
    state.orders.push({ orderId: placed.orderId, kind: "tp", side, price: tpPrice, quantity: tpQty, filledSoFar: 0, filledValueSoFar: 0 });
    state.tpOrderId = placed.orderId;
    if (state.tpUnplaceable) {
      state.tpUnplaceable = false;
      logger.info(`[AlphaGrid] TP placeable again — resumed.`);
    }
    logger.info(`[AlphaGrid] TP synced: ${side} ${tpQty} @ ${tpPrice} (avg ${position.avgEntry}).`);
  } catch (err) {
    if (!state.tpUnplaceable) {
      state.tpUnplaceable = true;
      logger.warn(`[AlphaGrid] TP placement failed (${(err as Error).message}) — riding without TP under stop protection; retrying.`);
    } else {
      logger.debug(`[AlphaGrid] TP placement still failing — riding without TP.`);
    }
  }
}

/**
 * Layer 1 — exchange-side unrealized stop (S8, spec §4.4): cancel + re-place from the
 * CURRENT avgEntry after every fill (never a deploy-time fixed price). Mark-price
 * trigger, reduceOnly, market default (stop-limit gets a ±2% offset price).
 * Disabled entirely unless useStopLoss && useExchangeStopOrder.
 */
function* syncStopOrder(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  if (!settings.useStopLoss || !settings.useExchangeStopOrder) {
    return;
  }
  if (state.direction === null || state.totalQty <= 0) return;

  const position = computePositionFromFills(state.fills);
  const slPrice = computeStopLossPrice(
    position.avgEntry,
    settings.stopLossPct,
    settings.leverage,
    state.direction,
    state.tickSize,
  );
  const slQty = roundQuantityToStep(state.totalQty, state.stepSize);
  if (slQty <= 0) {
    throw new Error(`alphaGrid: remaining position ${state.totalQty} rounds to 0 at step ${state.stepSize} — manual recovery needed.`);
  }
  const side = directionToExitSide(state.direction);

  // D42: a stop below exchange minimum is unplaceable (live venues reject it too).
  // Skip loudly-once per reason; the supervisor remains the protection. Existing stops stay.
  if (state.minCost !== null && slQty * slPrice < state.minCost) {
    if (state.stopDownReason !== "min-notional") {
      state.stopDownReason = "min-notional";
      logger.warn(
        `[AlphaGrid] Layer-1 stop unplaceable (notional ${slQty * slPrice} < minimum ${state.minCost}) — supervisor-only protection. Raise volumePerLevel (need ≥ minNotional / (1 − stopPct/(100×lev))).`,
      );
    } else {
      logger.debug(`[AlphaGrid] Layer-1 stop still unplaceable — supervisor-only.`);
    }
    return;
  }
  if (state.stopDownReason === "min-notional") {
    state.stopDownReason = null;
    logger.info(`[AlphaGrid] Layer-1 stop placeable again — resuming exchange-side protection.`);
  }

  const existing = state.orders.find((o) => o.orderId === state.stopOrderId);
  const limitPrice =
    settings.stopOrderType === "limit"
      ? state.direction === "long"
        ? slPrice * 0.98
        : slPrice * 1.02
      : undefined;
  const matches =
    existing !== undefined &&
    existing.price === slPrice &&
    existing.quantity === slQty &&
    existing.limitPrice === limitPrice;
  if (matches) return; // in sync — no churn.

  if (existing) {
    yield exchange.cancelLimitOrder({ symbol: marketId, orderId: existing.orderId, stop: true });
    untrackOrders(state, new Set([existing.orderId]));
  }
  // D48: a failing stop placement must degrade to supervisor-only (warn + continue),
  // never brick the tick and discard reconcile progress. Retried next tick.
  try {
    const placed = yield exchange.placeStopOrder({
      type: settings.stopOrderType,
      symbol: marketId,
      side,
      quantity: slQty,
      stopPrice: slPrice,
      price: limitPrice,
      reduceOnly: true,
      triggerBasis: "mark",
    });
    state.orders.push({ orderId: placed.orderId, kind: "stop", side, price: slPrice, quantity: slQty, limitPrice, filledSoFar: 0, filledValueSoFar: 0 });
    state.stopOrderId = placed.orderId;
    if (state.stopDownReason !== null) {
      state.stopDownReason = null;
      logger.info(`[AlphaGrid] Layer-1 stop placeable again — resuming exchange-side protection.`);
    }
    logger.info(`[AlphaGrid] Stop synced (L1): ${side} ${slQty} @ ${slPrice} [${settings.stopOrderType}/mark].`);
  } catch (err) {
    if (state.stopDownReason !== "placement-failed") {
      state.stopDownReason = "placement-failed";
      logger.warn(`[AlphaGrid] Layer-1 stop placement failed (${(err as Error).message}) — supervisor-only protection; retrying.`);
    } else {
      logger.debug(`[AlphaGrid] Layer-1 stop placement still failing — supervisor-only.`);
    }
  }
}

/**
 * Layer 2 — supervisor (S8, spec §4.4): throttled by pollIntervalMs (D30), evaluates
 * UNREALIZED ROI% only (never realized/total — the Binance-bot differentiator),
 * force-closes on breach: cancel all → market-close remainder reduceOnly → control.stop().
 * TP/SL drift re-sync happens every tick via the idempotent sync fns above.
 */
function* supervisorBlock(
  exchange: IExchange,
  control: IBotControl,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
  markPrice: number,
): StratGen<boolean> {
  if (!settings.useStopLoss || state.direction === null || state.totalQty <= 0) {
    return false;
  }
  const now = Date.now();
  if (now - state.lastSupervisorRun < settings.pollIntervalMs) {
    return false; // throttled — evaluated on cadence, never faster than configured.
  }
  state.lastSupervisorRun = now;

  const roi = computeUnrealizedRoiPct(markPrice, computePositionFromFills(state.fills).avgEntry, state.direction, state.totalQty, settings.leverage);
  if (roi > -settings.stopLossPct) {
    return false;
  }
  logger.warn(
    `[AlphaGrid] Supervisor stop-loss: unrealized ROI ${roi.toFixed(2)}% ≤ −${settings.stopLossPct}% — force-closing.`,
  );
  yield* terminatePosition(exchange, control, marketId, state, {
    stopBot: true,
    reason: `Supervisor stop-loss hit (unrealized ${roi.toFixed(2)}%) — position closed, bot stopped.`,
  });
  return true;
}

/** TP fully executed → close cycle → FLAT → redraw around current mark. */
function* closeCycle(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
  markPrice: number,
): StratGen {
  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openIds = new Set(openOrders.map((o) => o.exchangeOrderId));
  // Grids AND any orphan stop (a live stop would snipe the fresh grid).
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, (o) => o.kind === "grid" || o.kind === "stop");
  state.direction = null;
  state.fills = [];
  state.totalQty = 0;
  state.tpOrderId = null;
  state.stopOrderId = null;
  state.cycleCount += 1;
  logger.info(`[AlphaGrid] Cycle #${state.cycleCount} complete (TP) — redrawing FLAT grid.`);
  yield* drawGrid(exchange, marketId, settings, state, markPrice);
}

/**
 * Pump-capture trailing (S5 useTrailing): price beyond the grid edge shifts the whole
 * grid one-shot by whole shift-blocks; position and TP are untouched (D37c).
 */
function* maybeTrail(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
  markPrice: number,
): StratGen {
  if (!settings.useTrailing || state.direction === null || state.levelSpacing <= 0) {
    state.idleOutOfRange =
      state.direction === "long"
        ? markPrice > state.gridTop
        : state.direction === "short"
          ? markPrice < state.gridBottom
          : false;
    return;
  }
  state.idleOutOfRange = false;

  const block = settings.trailingShiftLevels * state.levelSpacing;
  let shifts = 0;
  if (state.direction === "long" && markPrice > state.gridTop) {
    shifts = Math.floor((markPrice - state.gridTop) / block) + 1;
  } else if (state.direction === "short" && markPrice < state.gridBottom) {
    shifts = Math.floor((state.gridBottom - markPrice) / block) + 1;
  }
  if (shifts < 1) return;
  if (shifts > 1000) {
    throw new Error(`alphaGrid: trailing shift ${shifts} blocks exceeds sanity cap (mark ${markPrice}).`);
  }

  const delta = (state.direction === "long" ? 1 : -1) * shifts * block;
  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openIds = new Set(openOrders.map((o) => o.exchangeOrderId));
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, (o) => o.kind === "grid");

  const newCenter = state.centerPrice + delta;
  const levels = buildViableGridLevels(newCenter, state.levelSpacing, settings.nLevels, state.tickSize);
  state.centerPrice = newCenter;
  state.gridTop = levels.gridTop;
  state.gridBottom = levels.gridBottom;

  const side = directionToGridSide(state.direction);
  const prices = side === "buy" ? levels.buyLevels : levels.sellLevels;
  const placed = yield* placeLevelOrders(exchange, marketId, settings, state, side, prices);
  if (placed === 0) {
    // Trailing into a dust regime: position stays stop/TP-managed (never hang the bot).
    logger.warn(`[AlphaGrid] Trailed to ${newCenter} but no level clears minimum ${state.minCost} — grid empty, stops/TP manage.`);
  }
  logger.info(`[AlphaGrid] Trailed ${state.direction} ${shifts} block(s): center ${newCenter}.`);
}

/**
 * Shared termination path: cancel every tracked open order, market-close any
 * remainder reduceOnly, clear position state. Optionally stops the bot.
 * Manual stops pass stopBot=false (framework owns lifecycle); stop-hits and
 * supervisor breaches pass stopBot=true (spec §4.3).
 */
function* terminatePosition(
  exchange: IExchange,
  control: IBotControl | null,
  marketId: string,
  state: AlphaGridRuntimeState,
  opts: { stopBot: boolean; reason: string },
): StratGen {
  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openIds = new Set(openOrders.map((o) => o.exchangeOrderId));
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, () => true);

  if (state.direction !== null && state.totalQty > 0) {
    const qty = roundQuantityToStep(state.totalQty, state.stepSize);
    if (qty <= 0) {
      logger.warn(`[AlphaGrid] Cannot market-close dust remainder ${state.totalQty} — manual recovery needed.`);
    } else {
      yield exchange.placeMarketOrder({
        symbol: marketId,
        side: directionToExitSide(state.direction),
        quantity: qty,
        reduceOnly: true,
      });
      logger.info(`[AlphaGrid] Market-closed ${state.direction} ${qty} (${opts.reason}).`);
    }
  }

  state.direction = null;
  state.fills = [];
  state.totalQty = 0;
  state.tpOrderId = null;
  state.stopOrderId = null;
  state.idleOutOfRange = false;

  logger.warn(`[AlphaGrid] ${opts.reason}`);
  if (opts.stopBot && control) {
    yield control.stop();
  }
}

/** Exchange stop-hit: position closed by the venue → terminate + stop the bot. */
function* handleExchangeStopHit(
  exchange: IExchange,
  control: IBotControl,
  marketId: string,
  state: AlphaGridRuntimeState,
): StratGen {
  yield* terminatePosition(exchange, control, marketId, state, {
    stopBot: true,
    reason: "Exchange-side stop hit — position closed, bot stopped. (No external alert channel exists upstream; watch the dashboard.)",
  });
}

/** Manual stop (framework stop command): reconcile, flatten, keep the bot lifecycle to the framework. */
function* flattenPosition(
  exchange: IExchange,
  control: IBotControl,
  marketId: string,
  state: AlphaGridRuntimeState,
): StratGen {
  // Reconcile first: a fill may have landed since the last tick (else the close qty is wrong).
  const stopHit = yield* reconcileOrders(exchange, control, marketId, state);
  if (stopHit) return; // stop-hit already terminated + stopped.
  yield* terminatePosition(exchange, null, marketId, state, { stopBot: false, reason: "Flattened (manual stop)." });
}

function* handleStart(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  const info = yield exchange.getSymbol({ currencyPair: marketId });
  const precision = marketPrecisionFromSymbolInfo(info);
  state.tickSize = precision.tickSize;
  state.stepSize = precision.stepSize;
  state.minQty = precision.minQty;
  state.minCost = precision.minCost;

  // dkalenov lesson (b): leverage is SENT to the exchange, not just logged.
  yield exchange.setLeverage(marketId, settings.leverage);
  logger.info(`[AlphaGrid] Started on ${marketId} (tick ${state.tickSize}, step ${state.stepSize}, leverage ${settings.leverage}x).`);

  for (const warning of getAlphaGridRiskWarnings(settings)) {
    logger.warn(`[AlphaGrid] ${warning}`);
  }
  state.noStopLossAck = !settings.useStopLoss;
}

function* handleTick(
  exchange: IExchange,
  control: IBotControl,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  const { markPrice } = yield exchange.getMarkPrice({ symbol: marketId });
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(`alphaGrid: invalid mark price ${markPrice} for ${marketId}.`);
  }

  const stopHit = yield* reconcileOrders(exchange, control, marketId, state);
  if (stopHit) return; // exchange stop-hit already terminated + stopped.

  // TP fully executed → close cycle (fresh FLAT grid), nothing else this tick.
  if (state.direction !== null && state.totalQty <= 0) {
    yield* closeCycle(exchange, marketId, settings, state, markPrice);
    return;
  }

  yield* syncTakeProfitOrder(exchange, marketId, settings, state);
  yield* syncStopOrder(exchange, marketId, settings, state);

  const breached = yield* supervisorBlock(exchange, control, marketId, settings, state, markPrice);
  if (breached) return; // supervisor force-closed + stopped.

  yield* maybeTrail(exchange, marketId, settings, state, markPrice);

  if (state.direction === null && !state.orders.some((o) => o.kind === "grid")) {
    yield* drawGrid(exchange, marketId, settings, state, markPrice);
  }
}

/**
 * alphaGrid strategy entry (wired into the template in alpha-grid.ts).
 * Uses ctx.exchange directly (D35d); mutates ctx.state (persisted by the runner).
 */
export function* alphaGridStrategy(ctx: TBotContext<AlphaGridBotConfig>): StratGen {
  const settings = readAlphaGridSettings(ctx.config.settings);
  const marketId = toFuturesMarketId(normalizeAlphaGridSymbol(settings.symbol));
  const state = ensureAlphaGridState(ctx.state, marketId);

  if (ctx.onStop) {
    yield* flattenPosition(ctx.exchange, ctx.control, marketId, state);
    return;
  }
  if (ctx.onStart) {
    yield* handleStart(ctx.exchange, marketId, settings, state);
  }
  yield* handleTick(ctx.exchange, ctx.control, marketId, settings, state);
}
