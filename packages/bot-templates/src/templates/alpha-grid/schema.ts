/**
 * alphaGrid S5 — settings schema (BUILD_PROMPT.md §4.1/§4.1b).
 *
 * What: the zod schema that auto-generates the dashboard deploy form
 * (via `getStrategies` → `zodToJsonSchema`), the inferred `AlphaGridSettings`
 * type, the conditional-rule validator, risk warnings, and warmup math.
 *
 * Why separate validator (D31): `BotTemplate.schema` must stay a plain ZodObject
 * (type + dashboard `isZodObject` gate) — `.refine/.superRefine/.transform` return
 * ZodEffects and would break compilation AND empty the settings form. All
 * conditional rules therefore live in `validateAlphaGridSettings()`, enforced at
 * bot/backtest startup (S7/S9, fail loud).
 */

import { z } from "zod";
import type { IBotConfiguration } from "@opentrader/bot-processor";
import { barSizeDurationMap } from "@opentrader/tools";
import type { BarSize } from "@opentrader/types";

export const ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS = 3000;
/** Closes of atrTimeframe the warmup guarantees: 15 seed ATR(14) + 5 buffer. */
export const ALPHA_GRID_ATR_SEED_CANDLES = 20;
/** Order-count safety cap (D30): a typo must never place thousands of orders. */
export const ALPHA_GRID_MAX_LEVELS = 100;
/** Hot-loop guard (D30). */
export const ALPHA_GRID_MIN_POLL_INTERVAL_MS = 1000;

export const alphaGridSchema = z.object({
  symbol: z.string().trim().min(1).default("AKEUSDT").describe("Futures symbol, e.g. AKEUSDT"),
  direction: z
    .enum(["long", "short", "auto"])
    .default("auto")
    .describe("long / short / auto (first fill decides per cycle)"),
  gridMode: z.enum(["atr", "manual"]).default("atr").describe("atr (auto spacing) / manual (fixed range)"),
  manualHighPrice: z.number().positive().optional().describe("Required when gridMode=manual: range top"),
  manualLowPrice: z.number().positive().optional().describe("Required when gridMode=manual: range bottom"),
  nLevels: z
    .number()
    .int()
    .min(1)
    .max(ALPHA_GRID_MAX_LEVELS)
    .default(8)
    .describe("Grid levels per side"),
  atrMultiplier: z.number().positive().default(0.5).describe("Level spacing = atrMultiplier × ATR(14)"),
  atrTimeframe: z.string().min(1).default("1h").describe("Timeframe for ATR (1m/5m/15m/1h/4h/1d/1w/1M/3M)"),
  volumePerLevel: z.number().positive().describe("Base-asset quantity per grid level (required)"),
  tpPct: z.number().positive().default(3.0).describe("Take-profit, % ROI on margin (required if useTakeProfit)"),
  stopLossPct: z
    .number()
    .positive()
    .default(20.0)
    .describe("Stop-loss, % ROI loss on UNREALIZED PnL (required if useStopLoss)"),
  stopOrderType: z.enum(["market", "limit"]).default("market").describe("market (recommended) / limit"),
  leverage: z.number().int().min(1).default(1).describe("Futures leverage (recommend 1–3)"),
  pollIntervalMs: z
    .number()
    .int()
    .min(ALPHA_GRID_MIN_POLL_INTERVAL_MS)
    .default(ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS)
    .describe("Supervisor poll interval in ms"),
  useTrailing: z.boolean().default(true).describe("Pump-capture: trail the grid on sustained moves"),
  trailingShiftLevels: z.number().int().min(1).default(2).describe("Grid levels per trailing step"),
  useTakeProfit: z.boolean().default(true).describe("Maintain the ROI-based TP order (off = ride-the-trend, riskier)"),
  useStopLoss: z.boolean().default(true).describe("Enable the unrealized-PnL stop-loss (both layers)"),
  useExchangeStopOrder: z
    .boolean()
    .default(true)
    .describe("Layer 1: pre-placed exchange-side stop (off = supervisor poll only)"),
});

export type AlphaGridSettings = z.infer<typeof alphaGridSchema>;

/** Bot configuration for the alphaGrid template (settings + framework fields). */
export type AlphaGridBotConfig = IBotConfiguration<AlphaGridSettings>;

function isValidTimeframe(value: unknown): value is BarSize {
  return typeof value === "string" && value in barSizeDurationMap;
}

/**
 * Enforce the §4.1b conditional rules + finiteness (D31).
 * Returns a list of human-readable violations; empty = valid.
 * Rules: manual prices required (and high > low) iff gridMode=manual;
 * stopLossPct finite-positive iff useStopLoss; tpPct finite-positive iff
 * useTakeProfit; atrTimeframe must be a known BarSize; Infinity/NaN rejected
 * everywhere (`.positive()` alone lets Infinity through).
 */
export function validateAlphaGridSettings(settings: unknown): string[] {
  const errors: string[] = [];
  if (typeof settings !== "object" || settings === null) {
    return ["settings must be an object"];
  }
  const s = settings as Partial<Record<keyof AlphaGridSettings, unknown>>;

  const finitePositive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;

  if (s.gridMode === "manual") {
    if (!finitePositive(s.manualHighPrice)) {
      errors.push("manualHighPrice is required and must be a finite positive number when gridMode=manual");
    }
    if (!finitePositive(s.manualLowPrice)) {
      errors.push("manualLowPrice is required and must be a finite positive number when gridMode=manual");
    }
    if (
      finitePositive(s.manualHighPrice) &&
      finitePositive(s.manualLowPrice) &&
      (s.manualHighPrice as number) <= (s.manualLowPrice as number)
    ) {
      errors.push("manualHighPrice must exceed manualLowPrice");
    }
  }

  if (s.useStopLoss === true && !finitePositive(s.stopLossPct)) {
    errors.push("stopLossPct is required and must be a finite positive number when useStopLoss=true");
  }
  if (s.useTakeProfit === true && !finitePositive(s.tpPct)) {
    errors.push("tpPct is required and must be a finite positive number when useTakeProfit=true");
  }

  if (!finitePositive(s.volumePerLevel)) {
    errors.push("volumePerLevel is required and must be a finite positive number");
  }
  if (!finitePositive(s.atrMultiplier)) {
    errors.push("atrMultiplier must be a finite positive number");
  }
  if (!isValidTimeframe(s.atrTimeframe)) {
    errors.push(
      `atrTimeframe must be one of ${Object.keys(barSizeDurationMap).join(", ")} (got ${String(s.atrTimeframe)})`,
    );
  }

  return errors;
}

export interface AlphaGridToggles {
  useStopLoss: boolean;
  useTakeProfit: boolean;
  useExchangeStopOrder: boolean;
}

/**
 * UI-renderable risk warnings for the current toggle combination (§4.1b).
 * S7/S8 log these at startup; an empty array = fully protected.
 */
export function getAlphaGridRiskWarnings(toggles: AlphaGridToggles): string[] {
  const warnings: string[] = [];
  if (!toggles.useStopLoss) {
    warnings.push(
      "CRITICAL: useStopLoss=false — the bot runs with NO stop-loss. The supervisor never force-closes; a bleeding position can ride to liquidation. Use only with constant supervision.",
    );
  } else if (!toggles.useExchangeStopOrder) {
    warnings.push(
      "NOTICE: useExchangeStopOrder=false — no exchange-side stop order. The supervisor poll is the only protection; it cannot survive the bot process dying.",
    );
  }
  if (!toggles.useTakeProfit) {
    warnings.push(
      'WARNING: useTakeProfit=false — "ride the trend" mode. A cycle ends only via stop-loss or manual stop; unrealized gains can fully revert. Higher risk.',
    );
  }
  return warnings;
}

/**
 * Warmup history (1m-candle count) guaranteeing ALPHA_GRID_ATR_SEED_CANDLES
 * closes of the ATR timeframe — same minute-math as upstream dca `requiredHistory`.
 * @throws on unknown atrTimeframe (fail loud, never silently under-warm).
 */
export function alphaGridRequiredHistoryMinutes(atrTimeframe: string): number {
  if (!isValidTimeframe(atrTimeframe)) {
    throw new Error(
      `alphaGrid: unknown atrTimeframe "${atrTimeframe}" — expected one of ${Object.keys(barSizeDurationMap).join(", ")}.`,
    );
  }
  const atrMs = barSizeDurationMap[atrTimeframe];
  return Math.max(
    ALPHA_GRID_ATR_SEED_CANDLES,
    Math.ceil((ALPHA_GRID_ATR_SEED_CANDLES * atrMs) / 60000),
  );
}
