# ALPHAGRID.md — alphaGrid user documentation (living doc, §6 deliverable)

> Status: SKELETON (bootstrap session 2026-10-07). Sections fill in as S3–S10 land.
> Spec source of truth: BUILD_PROMPT.md. Assumptions list lives at the bottom.

## 1. What alphaGrid is

(TBD — one paragraph: Binance USD-M futures grid with unrealized-PnL stop, ATR spacing,
pump-capture trailing. Filled in S5/S7.)

## 2. How it works

Live strategy: `packages/bot-templates/src/templates/alpha-grid/strategy.ts` (S7).
Identical code path in backtest (local fills + mark price, no `ccxt` in logic).

### 2.1 Grid construction (ATR vs manual)

- ATR mode (default): last 30 `atrTimeframe` candles → ATR(14) → spacing =
  `atrMultiplier × ATR`; grid centered on current mark price. Insufficient history:
  no orders until 15+ closes (waits, never guesses).
- Manual mode: spacing = `(high−low)/(2×nLevels)`, centered at `(high+low)/2`, so the
  outermost levels coincide with the range edges (assumption §8.7).
- `nLevels` buy limits below + `nLevels` sell limits above (armed side only once locked);
  all prices floored to the real tick, quantities to the real step (§8.8).

### 2.2 Direction modes (long / short / auto + first-fill lock)

- `long`: only buys armed. `short`: only sells armed. `auto`: both armed.
- First fill locks direction; opposite resting orders canceled immediately. One position
  cycle per symbol, one-way mode (assumption §8.1).
- `settings.symbol` (e.g. AKEUSDT → `AKE/USDT:USDT`) is the market source of truth.

### 2.3 Position averaging + single TP for the whole position

- Fills append to `fills[]`; `avgEntry` recomputed after EVERY fill (S4 math).
- Exactly ONE reduceOnly TP limit for the whole position at the ROI TP price,
  re-placed whenever avgEntry/qty drift (idempotent — no churn when in sync).
- Grid levels are NOT replaced after filling (depleting grid, ≤ nLevels fills);
  profit comes from the ROI TP, not oscillation. TP fill → cycle closes → FLAT redraw.
- Partial fills accumulate exactly (executed value-weighted); TP partials reduce the
  remainder pro-rata (avgEntry stays exact).

### 2.4 Trailing / pump-capture mode

- LONG + mark above grid top (SHORT mirrored below bottom): one-shot shift of the whole
  grid by whole `trailingShiftLevels` blocks; position and TP untouched — keeps riding
  pumps instead of idling at the top (validated 2026-10-07 LOBSTERUSDT setup: 10x, 6 grids,
  +52.46% in ~8h came from the directional move + trailing, not oscillation).
- `useTrailing=false`: classic fixed grid; out-of-range idles with a UI-visible flag.

## 3. The two-layer unrealized stop (key feature)

### 3.1 Layer 1 — exchange-side stop order (primary)

(TBD — S8. Document `stopOrderType="market"` recommendation and why stop-limit can gap-fail.)

### 3.2 Layer 2 — supervisor poll (backup + dashboard)

(TBD — S8. Default 3000ms; force-close sequence; drift re-sync.)

### 3.3 Why unrealized PnL, not total PnL

(TBD — contrast with Binance in-platform bots.)

## 4. Recommended settings per volatility regime

(TBD — S9/S10. Table: calm / normal / high-volatility (Alpha listings) ×
leverage 1–3, nLevels, atrMultiplier, tpPct, stopLossPct. Conservative defaults first.)

| Regime | leverage | nLevels | atrMultiplier | tpPct | stopLossPct | notes |
|---|---|---|---|---|---|---|
| TBD | | | | | | |

## 5. Security model

- **Env-only secrets (S3).** Binance credentials load ONLY from `BINANCE_API_KEY` /
  `BINANCE_API_SECRET`. When set, they win over any stored values via in-memory substitution
  in `ExchangeProvider.fromAccount` / `fromEnv` (`packages/exchanges/src/env-credentials.ts`);
  secrets are never written to DB, files, or logs (debug logs print a redacted copy).
  The CLI sync stores metadata with BLANK secrets when env vars are present.
- **Testnet/paper default.** `BINANCE_TESTNET=true` (default) → Binance testnet (sandbox mode);
  `BINANCE_PAPER=true` → local simulator, no keys needed. Live (`BINANCE_TESTNET=false`) is an
  explicit human opt-in only (M4, out of scope for automated sessions).
- **Key hygiene.** Trading-permission-only API key; withdrawals DISABLED; IP whitelist;
  sub-account recommended. Local testnet values live in the gitignored `binance-test-net` file
  (never committed); per-shell export commands are in `.env.example`.
- Testnet/paper is the default; live requires explicit human approval. (S10/M4 out of scope.)
- Every closing order is `reduceOnly`; one-way position mode; isolated margin recommended.
- **Known upstream limitation (not silently redesigned).** Dashboard-created exchange accounts
  still store plaintext secrets by upstream design (`ExchangeAccount` table, trpc account routers).
  For alphaGrid, prefer env-based/testnet accounts. Follow-up proposal: migrate dashboard account
  creation to secret-free (reference-by-env) storage — tracked for after M2, requires human approval
  (touches schema + routers + UI).

## 6. Feature toggles and their risks

- `useTrailing=false` → classic fixed grid; out-of-range idles.
- `useTakeProfit=false` → "ride the trend"; cycle ends only via stop/trailing-stop/manual — HIGHER RISK.
- `useStopLoss=false` → NO protection; UI warning shown; supervisor never force-closes.
- `useStopLoss=true, useExchangeStopOrder=false` → supervisor poll is the only protection.

## 7. Backtest honesty (what the report means)

(TBD — S9: total return, max drawdown, win rate, cycles, liquidations; unrealized ≈ −40% audit.)

## 8. Assumptions (explicit list — no silent choices)

1. (bootstrap) One-way position mode assumed; hedge mode unsupported. — spec §4.6.
2. (bootstrap) Mark-price trigger basis assumed available via CCXT/exchange; upstream response type
   is ambiguous (DECISIONS.md D9) — adapter resolution pending S7/S8.
3. (bootstrap) `reduceOnly` + mark-trigger plumbable through `createStopOrder` extras (D10) —
   implementation pending S8.
4. (bootstrap) Backtest mark-price approximation = candle range-crossing (D11) — pending S9.
5. (bootstrap) Paper simulator cannot validate Layer 1 (D12) — M3 kill-test needs Binance testnet.
6. (more added as S3–S10 land)
7. (S4) Manual-mode grid spacing = (high−low)/(2×nLevels) centered at (high+low)/2 (D27) —
   spec gives the level formulas but not the spacing derivation; outer levels coincide with range edges.
8. (S4) All exchange prices floor to tick multiples, quantities to step multiples (D26/D29);
   max deviation one tick on triggers; supervisor re-syncs from exact values.
9. (S4) Zero position → ROI 0%; empty fills → FLAT zeros; mixed-side fills and bad config throw (D28).
10. (S5) Template tick is static 3000ms; per-bot pollIntervalMs honored by supervisor throttle (D30).
11. (S5) Conditional validation enforced at startup by `validateAlphaGridSettings`, not in zod
    (ZodEffects would break the dashboard form gate — D31). `symbol` stays raw in schema;
    uppercase normalization at use (S7).
12. (S5) nLevels ≤ 100, pollIntervalMs ≥ 1000 (operator-error guards); leverage uncapped
    (exchange is the authority); no socket watchers — REST-only data path for live/backtest parity.
13. (S6) Vendored ATR seeds from candle 2 (no TR without prev close); first value at index
    `periods`; 20-close warmup covers it. Spacing uses the latest value only.
14. (S7) Ticks read precision-first (Binance TICK_SIZE mode verified in ccxt source — D38).
15. (S7) Restart with untracked open orders for the symbol = loud refusal (never adopt or
    blind-cancel others' orders); crash orphans recover by manual cancel + restart (D36).
16. (S7) Unfillable dust (remainder below stepSize) = loud error for manual recovery (D37a).
