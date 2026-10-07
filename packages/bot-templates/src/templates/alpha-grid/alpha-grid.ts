import type { TBotContext } from "@opentrader/bot-processor";
import {
  ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS,
  alphaGridRequiredHistoryMinutes,
  alphaGridSchema,
  type AlphaGridBotConfig,
  type AlphaGridSettings,
} from "./schema.js";
import { alphaGridStrategy } from "./strategy.js";

/**
 * alphaGrid — "Alpha Grid" futures grid with an unrealized-PnL two-layer stop.
 *
 * Template registration (schema, display, run policy); the §4.3 state machine
 * lives in strategy.ts (S7) and runs here.
 */
export function* alphaGrid(ctx: TBotContext<AlphaGridBotConfig>) {
  yield* alphaGridStrategy(ctx);
}

alphaGrid.displayName = "Alpha Grid";
alphaGrid.description =
  "Binance USD-M futures grid with ATR-adaptive spacing (or fixed manual range), pump-capture trailing, and a two-layer stop-loss on UNREALIZED PnL: a pre-placed exchange-side stop order plus a supervisor poll. Works long / short / auto (first fill decides).";
alphaGrid.hidden = false;
alphaGrid.schema = alphaGridSchema;
alphaGrid.runPolicy = {
  onInterval: true,
};
// Static template tick (== default pollIntervalMs). Per-bot pollIntervalMs values are
// honored by throttle inside the S8 supervisor (D30) — upstream has no per-bot interval.
alphaGrid.interval = ALPHA_GRID_DEFAULT_POLL_INTERVAL_MS;
// Warmup: enough 1m candles to seed ATR(14) on the configured atrTimeframe (D30).
alphaGrid.requiredHistory = (botConfig: AlphaGridBotConfig) => {
  const raw = botConfig.settings as unknown;
  const settings =
    typeof raw === "string" ? (JSON.parse(raw) as Partial<AlphaGridSettings>) : (raw as Partial<AlphaGridSettings>);
  return alphaGridRequiredHistoryMinutes(settings.atrTimeframe ?? "1h");
};
