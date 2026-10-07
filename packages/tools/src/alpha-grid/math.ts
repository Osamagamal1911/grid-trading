/**
 * alphaGrid S4 — core math, single source of truth (BUILD_PROMPT.md §4.2).
 *
 * What: every formula the strategy uses — position averaging, margin, unrealized
 * ROI%, take-profit / stop-loss prices, ATR & manual grid spacing, grid level
 * construction, tick/step rounding. Used identically by live, paper, and backtest
 * (backtest parity, §4.5); strategy code MUST call these, never re-derive them.
 *
 * Why one module: the dkalenov post-mortem (spec §4.4) showed live-vs-backtest
 * divergence kills real money. A single audited implementation removes that class
 * of bug by construction.
 *
 * Key formulas (exactly as specified):
 *   marginUsed      = |avgEntry × totalQty| / leverage
 *   unrealizedROI%  = (markPrice − avgEntry) × signedQty / marginUsed × 100
 *   tpPrice   LONG  = avgEntry + avgEntry × tpPct / (100 × leverage)
 *   tpPrice   SHORT = avgEntry − avgEntry × tpPct / (100 × leverage)
 *   slPrice   LONG  = avgEntry − avgEntry × stopLossPct / (100 × leverage)
 *   slPrice   SHORT = avgEntry + avgEntry × stopLossPct / (100 × leverage)
 *   levelSpacing    = atrMultiplier × ATR(14)                       [atr mode]
 *   manualSpacing   = (manualHighPrice − manualLowPrice) / (2 × nLevels)  [manual, D27]
 *   buyLevel[i]     = centerPrice − i × levelSpacing,  i = 1..nLevels
 *   sellLevel[i]    = centerPrice + i × levelSpacing,  i = 1..nLevels
 * (the buy/sell forms are algebraically identical to the spec's spacingPct forms;
 * absolute spacing avoids a redundant percent round-trip — verified by test).
 *
 * Safety notes: no `exchange.ccxt` usage (pure math only); all decimal work in
 * big.js (exact, no binary-float dust); rounding is ALWAYS down (D26, D29);
 * empty positions yield ROI 0 (FLAT is normal); invariant violations throw (D28).
 */

import Big from "big.js";

export type AlphaGridSide = "long" | "short";

export interface AlphaGridFill {
  price: number;
  quantity: number;
  side: AlphaGridSide;
}

export interface AlphaGridPosition {
  avgEntry: number;
  totalQty: number;
  side: AlphaGridSide | null;
}

export interface AlphaGridLevels {
  /** Buy levels below center, index 0 = nearest to center. */
  buyLevels: number[];
  /** Sell levels above center, index 0 = nearest to center. */
  sellLevels: number[];
  /** Outermost sell level (trailing trigger for LONG, D27). */
  gridTop: number;
  /** Outermost buy level (trailing trigger for SHORT, D27). */
  gridBottom: number;
}

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`alphaGrid math: \`${name}\` must be a finite number, got ${value}.`);
  }
}

function assertPositiveNumber(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value <= 0) {
    throw new Error(`alphaGrid math: \`${name}\` must be > 0, got ${value}.`);
  }
}

function assertNonNegativeNumber(name: string, value: number): void {
  assertFiniteNumber(name, value);
  if (value < 0) {
    throw new Error(`alphaGrid math: \`${name}\` must be >= 0, got ${value}.`);
  }
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`alphaGrid math: \`${name}\` must be a positive integer, got ${value}.`);
  }
}

function assertSide(side: string): asserts side is AlphaGridSide {
  if (side !== "long" && side !== "short") {
    throw new Error(`alphaGrid math: \`side\` must be "long" | "short", got ${String(side)}.`);
  }
}

/**
 * Weighted-average entry from fills. Empty fills = FLAT ({ avgEntry: 0, totalQty: 0 }).
 * @throws on mixed-side fills (one-way positions only) or non-positive fill price/quantity.
 */
export function computePositionFromFills(fills: AlphaGridFill[]): AlphaGridPosition {
  if (fills.length === 0) {
    return { avgEntry: 0, totalQty: 0, side: null };
  }

  const side = fills[0].side;
  assertSide(side);

  let cost = new Big(0);
  let totalQty = new Big(0);
  for (const fill of fills) {
    assertSide(fill.side);
    if (fill.side !== side) {
      throw new Error(
        "alphaGrid math: mixed-side fills in one position (one-way positions only).",
      );
    }
    assertPositiveNumber("fill.price", fill.price);
    assertPositiveNumber("fill.quantity", fill.quantity);
    cost = cost.plus(new Big(fill.price).mul(fill.quantity));
    totalQty = totalQty.plus(fill.quantity);
  }

  return {
    avgEntry: Number(cost.div(totalQty).toString()),
    totalQty: Number(totalQty.toString()),
    side,
  };
}

/**
 * marginUsed = |avgEntry × totalQty| / leverage.
 */
export function computeMarginUsed(avgEntry: number, totalQty: number, leverage: number): number {
  assertNonNegativeNumber("avgEntry", avgEntry);
  assertNonNegativeNumber("totalQty", totalQty);
  assertPositiveNumber("leverage", leverage);

  return Number(new Big(avgEntry).mul(totalQty).abs().div(leverage).toString());
}

/**
 * unrealizedROI% = (markPrice − avgEntry) × signedQty / marginUsed × 100.
 * signedQty is +totalQty for LONG, −totalQty for SHORT (same formula, correct sign).
 * Zero position (margin 0) → 0: FLAT has no unrealized PnL.
 */
export function computeUnrealizedRoiPct(
  markPrice: number,
  avgEntry: number,
  side: AlphaGridSide,
  totalQty: number,
  leverage: number,
): number {
  assertFiniteNumber("markPrice", markPrice);
  assertSide(side);
  const marginUsed = computeMarginUsed(avgEntry, totalQty, leverage);
  if (marginUsed === 0) {
    return 0;
  }

  const signedQty = side === "long" ? new Big(totalQty) : new Big(totalQty).neg();
  const roi = new Big(markPrice).minus(avgEntry).mul(signedQty).div(marginUsed).mul(100);
  return Number(roi.toString());
}

/**
 * tpPrice LONG  = avgEntry + avgEntry × tpPct / (100 × leverage)
 * tpPrice SHORT = avgEntry − avgEntry × tpPct / (100 × leverage)
 * Tick-rounded (D26). At this price the position ROI is exactly +tpPct (tested).
 */
export function computeTakeProfitPrice(
  avgEntry: number,
  tpPct: number,
  leverage: number,
  side: AlphaGridSide,
  tickSize: number,
): number {
  assertPositiveNumber("avgEntry", avgEntry);
  assertPositiveNumber("tpPct", tpPct);
  assertPositiveNumber("leverage", leverage);
  assertSide(side);

  const offset = new Big(avgEntry).mul(tpPct).div(100).div(leverage);
  const exact = side === "long" ? new Big(avgEntry).plus(offset) : new Big(avgEntry).minus(offset);
  const price = Number(exact.toString());
  if (price <= 0) {
    throw new Error(`alphaGrid math: computed TP price is not positive (${price}).`);
  }
  return roundPriceToTick(price, tickSize);
}

/**
 * slPrice LONG  = avgEntry − avgEntry × stopLossPct / (100 × leverage)
 * slPrice SHORT = avgEntry + avgEntry × stopLossPct / (100 × leverage)
 * Tick-rounded (D26). At this price the position ROI is exactly −stopLossPct (tested).
 */
export function computeStopLossPrice(
  avgEntry: number,
  stopLossPct: number,
  leverage: number,
  side: AlphaGridSide,
  tickSize: number,
): number {
  assertPositiveNumber("avgEntry", avgEntry);
  assertPositiveNumber("stopLossPct", stopLossPct);
  assertPositiveNumber("leverage", leverage);
  assertSide(side);

  const offset = new Big(avgEntry).mul(stopLossPct).div(100).div(leverage);
  const exact = side === "long" ? new Big(avgEntry).minus(offset) : new Big(avgEntry).plus(offset);
  const price = Number(exact.toString());
  if (price <= 0) {
    throw new Error(`alphaGrid math: computed SL price is not positive (${price}).`);
  }
  return roundPriceToTick(price, tickSize);
}

/**
 * levelSpacing = atrMultiplier × ATR (absolute price units, atr mode).
 */
export function computeAtrLevelSpacing(atrValue: number, atrMultiplier: number): number {
  assertNonNegativeNumber("atrValue", atrValue);
  assertPositiveNumber("atrMultiplier", atrMultiplier);

  return Number(new Big(atrValue).mul(atrMultiplier).toString());
}

/**
 * Manual-mode spacing (D27): (high − low) / (2 × nLevels), centered at (high + low) / 2,
 * so the outermost levels coincide with the requested range edges.
 */
export function computeManualLevelSpacing(
  manualHighPrice: number,
  manualLowPrice: number,
  nLevels: number,
): number {
  assertFiniteNumber("manualHighPrice", manualHighPrice);
  assertFiniteNumber("manualLowPrice", manualLowPrice);
  assertPositiveInt("nLevels", nLevels);
  if (manualHighPrice <= manualLowPrice) {
    throw new Error(
      `alphaGrid math: \`manualHighPrice\` (${manualHighPrice}) must exceed \`manualLowPrice\` (${manualLowPrice}).`,
    );
  }

  return Number(new Big(manualHighPrice).minus(manualLowPrice).div(2).div(nLevels).toString());
}

/** Center of a manual range: (high + low) / 2. */
export function computeManualCenterPrice(manualHighPrice: number, manualLowPrice: number): number {
  assertFiniteNumber("manualHighPrice", manualHighPrice);
  assertFiniteNumber("manualLowPrice", manualLowPrice);
  if (manualHighPrice <= manualLowPrice) {
    throw new Error(
      `alphaGrid math: \`manualHighPrice\` (${manualHighPrice}) must exceed \`manualLowPrice\` (${manualLowPrice}).`,
    );
  }

  return Number(new Big(manualHighPrice).plus(manualLowPrice).div(2).toString());
}

/**
 * Build nLevels buy limits below + nLevels sell limits above centerPrice.
 * buyLevel[i] = center − i × spacing, sellLevel[i] = center + i × spacing (i = 1..nLevels),
 * each tick-rounded down. Index 0 of each array is the level nearest the center.
 * @throws when any level would be non-positive (misconfiguration, fail loud).
 */
export function buildGridLevels(
  centerPrice: number,
  levelSpacing: number,
  nLevels: number,
  tickSize: number,
): AlphaGridLevels {
  assertPositiveNumber("centerPrice", centerPrice);
  assertPositiveNumber("levelSpacing", levelSpacing);
  assertPositiveInt("nLevels", nLevels);
  assertPositiveNumber("tickSize", tickSize);

  const center = new Big(centerPrice);
  const spacing = new Big(levelSpacing);

  const buyLevels: number[] = [];
  const sellLevels: number[] = [];
  for (let i = 1; i <= nLevels; i += 1) {
    const buy = Number(center.minus(spacing.mul(i)).toString());
    const sell = Number(center.plus(spacing.mul(i)).toString());
    if (buy <= 0 || sell <= 0) {
      throw new Error(
        `alphaGrid math: grid level ${i}/${nLevels} is not positive (center ${centerPrice}, spacing ${levelSpacing}).`,
      );
    }
    buyLevels.push(roundPriceToTick(buy, tickSize));
    sellLevels.push(roundPriceToTick(sell, tickSize));
  }

  return {
    buyLevels,
    sellLevels,
    gridTop: sellLevels[sellLevels.length - 1],
    gridBottom: buyLevels[buyLevels.length - 1],
  };
}

/**
 * Floor a price to the tick multiple: floor(price / tickSize) × tickSize (D26).
 * Exact decimal arithmetic — safe for altcoin dust ticks. Always rounds DOWN.
 */
export function roundPriceToTick(price: number, tickSize: number): number {
  assertPositiveNumber("price", price);
  assertPositiveNumber("tickSize", tickSize);

  const rounded = new Big(price).div(tickSize).round(0, Big.roundDown).mul(tickSize);
  return Number(rounded.toString());
}

/**
 * Floor a quantity to the step multiple: floor(qty / stepSize) × stepSize (D26).
 * Zero is allowed (means "no order"); negatives throw.
 */
export function roundQuantityToStep(quantity: number, stepSize: number): number {
  assertNonNegativeNumber("quantity", quantity);
  assertPositiveNumber("stepSize", stepSize);

  const rounded = new Big(quantity).div(stepSize).round(0, Big.roundDown).mul(stepSize);
  return Number(rounded.toString());
}
