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

import type { TBotContext } from "@opentrader/bot-processor";
import { logger } from "@opentrader/logger";
import type { IExchange } from "@opentrader/exchanges";
import type { BarSize, IGetLimitOrderResponse, IOpenOrder, OrderSide } from "@opentrader/types";
import { atr, IndicatorError, latestAtrValue } from "@opentrader/indicators";
import {
  buildGridLevels,
  computeAtrLevelSpacing,
  computeManualCenterPrice,
  computeManualLevelSpacing,
  computePositionFromFills,
  computeTakeProfitPrice,
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

export type AlphaGridTrackedOrderKind = "grid" | "tp";

export interface AlphaGridTrackedOrder {
  orderId: string;
  kind: AlphaGridTrackedOrderKind;
  side: OrderSide;
  price: number;
  quantity: number;
  /** Executed qty already accounted (partials accumulate across ticks). */
  filledSoFar: number;
  /** Executed value already accounted (exact partial pricing). */
  filledValueSoFar: number;
}

export interface AlphaGridRuntimeState {
  version: 1;
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
  noStopLossAck: boolean;
  idleOutOfRange: boolean;
  cycleCount: number;
}

type Yielded = Promise<unknown>;
// NextType is `any` (like upstream templates): the runner feeds resolved values
// back in, which no static type can express. Yields are always exchange promises.
type StratGen<T = void> = Generator<Yielded, T, any>;

const STATE_VERSION = 1;

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
    yield exchange.cancelLimitOrder({ symbol: marketId, orderId: target.orderId });
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
 * (grid → entries + direction lock; TP → position reduction), drop canceled,
 * refuse foreign orders.
 */
function* reconcileOrders(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openById = new Map(openOrders.map((o) => [o.exchangeOrderId, o]));
  const wasFlat = state.direction === null;

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
      if (delta) accountExecution(state, tracked, delta);
      continue;
    }
    // Missing from open → resolve once via fetch. Account any remainder, then
    // drop only terminal orders (a still-open order here is a race — keep it).
    const fetched: IGetLimitOrderResponse = yield exchange.getLimitOrder({ symbol: marketId, orderId: tracked.orderId });
    const delta = executionDelta(fetched.quantityExecuted, fetched.volumeExecuted, tracked, fetched.filledPrice);
    if (delta) accountExecution(state, tracked, delta);
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
    state.fills.push({ price: delta.execPrice, quantity: delta.execQty, side: fillSide });
    state.totalQty += delta.execQty;
    logger.info(
      `[AlphaGrid] Grid fill: ${tracked.side} ${delta.execQty} @ ${delta.execPrice} (position ${state.totalQty}).`,
    );
    if (state.direction === null) {
      state.direction = fillSide;
      logger.info(`[AlphaGrid] Direction locked: ${fillSide} (first fill). Canceling opposite side.`);
    }
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

/** Draw missing grid levels (fresh grid or holes from external cancels). */
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

  const levels = buildGridLevels(layout.center, layout.spacing, settings.nLevels, state.tickSize);
  state.centerPrice = layout.center;
  state.levelSpacing = layout.spacing;
  state.gridTop = levels.gridTop;
  state.gridBottom = levels.gridBottom;

  const trackedPrices = new Set(state.orders.filter((o) => o.kind === "grid").map((o) => `${o.side}@${o.price}`));
  const sides = armedSides(settings, state.direction);
  for (const side of sides) {
    const prices = side === "buy" ? levels.buyLevels : levels.sellLevels;
    for (const price of prices) {
      if (trackedPrices.has(`${side}@${price}`)) continue;
      const quantity = roundQuantityToStep(settings.volumePerLevel, state.stepSize);
      if (quantity <= 0) {
        throw new Error(`alphaGrid: volumePerLevel ${settings.volumePerLevel} rounds to 0 at step ${state.stepSize}.`);
      }
      if (state.minCost !== null && quantity * price < state.minCost) {
        throw new Error(
          `alphaGrid: level notional ${quantity * price} below exchange minimum ${state.minCost} — raise volumePerLevel.`,
        );
      }
      const placed = yield exchange.placeLimitOrder({ symbol: marketId, side, quantity, price });
      state.orders.push({ orderId: placed.orderId, kind: "grid", side, price, quantity, filledSoFar: 0, filledValueSoFar: 0 });
    }
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
  const placed = yield exchange.placeLimitOrder({ symbol: marketId, side, quantity: tpQty, price: tpPrice, reduceOnly: true });
  state.orders.push({ orderId: placed.orderId, kind: "tp", side, price: tpPrice, quantity: tpQty, filledSoFar: 0, filledValueSoFar: 0 });
  state.tpOrderId = placed.orderId;
  logger.info(`[AlphaGrid] TP synced: ${side} ${tpQty} @ ${tpPrice} (avg ${position.avgEntry}).`);
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
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, (o) => o.kind === "grid");
  state.direction = null;
  state.fills = [];
  state.totalQty = 0;
  state.tpOrderId = null;
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
  const levels = buildGridLevels(newCenter, state.levelSpacing, settings.nLevels, state.tickSize);
  state.centerPrice = newCenter;
  state.gridTop = levels.gridTop;
  state.gridBottom = levels.gridBottom;

  const side = directionToGridSide(state.direction);
  const prices = side === "buy" ? levels.buyLevels : levels.sellLevels;
  for (const price of prices) {
    const quantity = roundQuantityToStep(settings.volumePerLevel, state.stepSize);
    if (quantity <= 0) {
      throw new Error(`alphaGrid: volumePerLevel ${settings.volumePerLevel} rounds to 0 at step ${state.stepSize}.`);
    }
    const placed = yield exchange.placeLimitOrder({ symbol: marketId, side, quantity, price });
    state.orders.push({ orderId: placed.orderId, kind: "grid", side, price, quantity, filledSoFar: 0, filledValueSoFar: 0 });
  }
  logger.info(`[AlphaGrid] Trailed ${state.direction} ${shifts} block(s): center ${newCenter}.`);
}

/** Manual stop (framework stop command): reconcile, cancel tracked, market-close remainder, clear. */
function* flattenPosition(
  exchange: IExchange,
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  // Reconcile first: a fill may have landed since the last tick (else the close qty is wrong).
  yield* reconcileOrders(exchange, marketId, settings, state);

  const openOrders: IOpenOrder[] = yield exchange.getOpenOrders({ symbol: marketId });
  const openIds = new Set(openOrders.map((o) => o.exchangeOrderId));
  yield* cancelTrackedOrders(exchange, marketId, state, openIds, () => true);

  if (state.direction !== null && state.totalQty > 0) {
    const qty = roundQuantityToStep(state.totalQty, state.stepSize);
    if (qty <= 0) {
      throw new Error(`alphaGrid: cannot flatten dust position ${state.totalQty} — manual recovery needed.`);
    }
    yield exchange.placeMarketOrder({
      symbol: marketId,
      side: directionToExitSide(state.direction),
      quantity: qty,
      reduceOnly: true,
    });
    logger.info(`[AlphaGrid] Flattened ${state.direction} ${qty} via market (manual stop).`);
  }

  state.direction = null;
  state.fills = [];
  state.totalQty = 0;
  state.tpOrderId = null;
  state.idleOutOfRange = false;
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
  marketId: string,
  settings: AlphaGridSettings,
  state: AlphaGridRuntimeState,
): StratGen {
  const { markPrice } = yield exchange.getMarkPrice({ symbol: marketId });
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(`alphaGrid: invalid mark price ${markPrice} for ${marketId}.`);
  }

  yield* reconcileOrders(exchange, marketId, settings, state);

  // TP fully executed → close cycle (fresh FLAT grid), nothing else this tick.
  if (state.direction !== null && state.totalQty <= 0) {
    yield* closeCycle(exchange, marketId, settings, state, markPrice);
    return;
  }

  yield* syncTakeProfitOrder(exchange, marketId, settings, state);
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
    yield* flattenPosition(ctx.exchange, marketId, settings, state);
    return;
  }
  if (ctx.onStart) {
    yield* handleStart(ctx.exchange, marketId, settings, state);
  }
  yield* handleTick(ctx.exchange, marketId, settings, state);
}
