# ALPHAGRID.md — alphaGrid user documentation (living doc, §6 deliverable)

> Status: SKELETON (bootstrap session 2026-10-07). Sections fill in as S3–S10 land.
> Spec source of truth: BUILD_PROMPT.md. Assumptions list lives at the bottom.

## 1. What alphaGrid is + fresh-machine runbook

alphaGrid is a Binance USD-M **futures** grid bot: ATR-adaptive (or fixed manual) grid,
first-fill direction lock, averaging with a single ROI take-profit, pump-capture trailing,
and a **two-layer stop on unrealized PnL only** (exchange-side stop + supervisor poll).
Testnet-first, env-only secrets, one position cycle per symbol.

### Runbook: clone → running testnet bot (no tribal knowledge)

Prerequisites: `git`, `curl`, internet. No sudo, no Docker, no global installs.
(Replaces the S1 manual toolchain notes; automated by `scripts/setup.sh`.)

```bash
# 0. Clone (all work lives on feature/alphaGrid — never dev/main/master)
git clone https://github.com/Osamagamal1911/grid-trading.git
cd grid-trading
git checkout feature/alphaGrid

# 1. Toolchain + deps + build + local DB (idempotent, ~2–5 min first run)
./scripts/setup.sh
export PATH="$HOME/.local/node-v22/bin:$PATH"   # every new shell (or add to .bashrc)

# 2. Testnet keys (human, 2 min, testnet ONLY — never mainnet keys here)
#    Mint at testnet.binancefuture.com → API Management → Generate HMAC API Key
#    (trading permission; futures testnet needs no IP whitelist).
#    Values below stay in YOUR shell only — never in files, chat, or commits.
export BINANCE_API_KEY="<paste-testnet-key>"
export BINANCE_API_SECRET="<paste-testnet-secret>"

# 3. Local configs from samples (both gitignored; samples carry placeholders only)
cp config.alphagrid.sample.json5 config.json5       # tune volumePerLevel for YOUR coin
cp exchanges.alphagrid.sample.json5 exchanges.json5 # TESTNET entry, isDemoAccount: true

# 4. Boot daemon (detached: survives shell exit; foreground `up` dies on pipe-close)
./bin/cli.sh up -d

# 5. Deploy (creates/updates the TESTNET account with BLANK secrets + starts the bot)
./bin/cli.sh trade alphaGrid            # expect: "Bot ... started succesfully"

# 6. Operate
./bin/cli.sh stop                        # manual stop: cancel-all + reduceOnly close
./bin/cli.sh down                        # stop the daemon (SIGTERM → graceful)
./bin/cli.sh down --force                # last resort: SIGKILL (then clear ~/.opentrader/pid)
```

Watch it work (dashboard UI is a private repo — same data sources instead):

- DB bot state: `packages/prisma` → query `bot` row (`direction/fills/orders/tpOrderId/
  stopOrderId/cycleCount`) + `botLog` tick stream (see HANDOFF S10 for the exact queries).
- Testnet venue truth: open orders / positions on testnet.binancefuture.com → Futures
  wallet → Positions, or the read-only observer pattern in HANDOFF S10.
- Daemon log: `~/.opentrader/log.log` (`[AlphaGrid] ...` lines: fills, TP/STOP syncs,
  trailing shifts, supervisor actions).

What `setup.sh` does NOT do: fetch klines (only needed for backtests:
`node scripts/fetch-klines.mjs AKEUSDT 1h <START_ISO> klines/AKEUSDT-1h.json`),
mint keys (human, step 2), choose sizing (edit `config.json5`), or run the 48h soak (S10).

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

Unlike Binance in-platform bots (which stop on TOTAL PnL — realized + unrealized, letting a
bleeding grid hide behind banked gains), alphaGrid stops on UNREALIZED ROI% of the CURRENT
position only: `(mark − avgEntry) × signedQty / margin × 100`, recomputed from local fills.
Prior cycles' profits never offset a bleeding position (tested).

### 3.1 Layer 1 — exchange-side stop order (primary)

- After EVERY fill (and on position open), the stop is canceled and re-placed from the CURRENT
  `avgEntry` — never a fixed deploy-time price. Full position size, `reduceOnly`, mark-price
  trigger (`MARK_PRICE`, never last price).
- `stopOrderType="market"` (default, recommended): fills through gaps. `"limit"` gets a ±2%
  offset price (LONG −2%) but can miss in a gap — exactly when you need it.
- Survives our server dying (the M3 kill-test). Verified on testnet in S10 (workingType +
  quantity semantics checklist).
- `useExchangeStopOrder=false`: Layer 1 off (paper simulator can't hold stops — D12);
  the supervisor below is the only protection.

### 3.2 Layer 2 — supervisor poll (backup + dashboard)

- Every `pollIntervalMs` (default 3000ms; template tick is the cadence floor): recompute
  unrealized ROI% locally; if ≤ −`stopLossPct`: cancel all → market-close remainder
  (`reduceOnly`) → `control.stop()` → warn. TP/SL drift re-syncs idempotently every tick.
- Covers gap-through-stop and stop-fill failures the exchange layer can miss.
- Limitation: no external alert channel exists upstream — breaches log loudly (warn) for now;
  wire Telegram/webhook alerting before live use.

### 3.3 Why unrealized PnL, not total PnL

Because total-PnL stops let one banked winner subsidize a slow bleed into liquidation —
exactly the failure mode on small per-coin sizes. The supervisor's close condition reads
only current-position inputs (mark, avgEntry, qty, leverage); a unit test proves a
profitable closed cycle does not prevent the next bleeding position from stopping.

## 4. Recommended settings per volatility regime

M2 evidence (AKEUSDT 1h, 2026-09-01→10-07, lev 1, auto, full-protection defaults):
−16.88% on $2000 with 94.23% win rate — 98 small TP wins (+3% ROI) outweighed by 6
−40% stop-outs on averaged-down (large) positions. The grid-trader's curse, faithfully
reproduced: averaging concentrates size into losers. Full report: BACKTEST_AKEUSDT.md.

| Regime | leverage | nLevels | atrMultiplier | tpPct | stopLossPct | notes |
|---|---|---|---|---|---|---|
| Calm range (untested) | 1–2 | 8 | 0.5 | 3.0 | 20.0 | Defaults; validate on data first |
| High-volatility Alpha listing (M2-measured at 40%) | 1 | 8 | 0.5 | 3.0 | 40.0 | Loses to bleed at lev 1 — see above |
| Pump-capture (LOBSTERUSDT 2026-10-07: +52.46% in ~8h) | 10, isolated | 6 | trailing on | n/a (TP rode) | unrealized stop as net | Profit came from the leveraged directional move + trailing, NOT oscillation |

Conservative defaults first; leverage is the dominant risk knob (a 10x LOBSTER-style run
needs the unrealized stop sized accordingly). Backtest YOUR coin/window before deploying.

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

- Same strategy code as live (local fills + mark price; MemoryExchange simulates the venue).
- Metrics are full-distribution: total return on allocated capital, max drawdown from the
  equity curve (incl. unrealized), win rate over ALL closed cycles (TP + stops + netted),
  every stop-out listed with unrealized ROI at trigger, fees, liquidations with context.
- Sanity is asserted in code, not eyeballed: stops never fire early, crossed-but-unfilled
  resting stops throw, TP cycles must net positive, liquidations are reported with
  gap-through vs naked context. A green backtest run means all gates held.
- Stop-outs do NOT halt the run: each models an operator redeploy. A 94% win rate can
  still lose money (M2: −16.88%) — read total return first, win rate second.

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
16. (S7/S8) Unclosable dust: TP/SL placement below stepSize throws (fix sizing); terminal-close
    dust remainder warns + clears so a stopping bot never hangs (D37a/D40c).

## 9. Testnet validation (S10, 2026-10-07 — mechanics proven, 48h soak open)

- Deployed via CLI on Binance futures testnet (AKEUSDT, manual ±1–3% grids, 200 AKE/level
  ≈ $5.4–16 max notional, lev 1): grid draws exact, fills → direction lock → averaging
  (long 400 @ 0.0272698) → TP sync (sell 400 @ 0.0280878, reduceOnly) → **Layer-1 algo stop
  (sell 400 @ STOP 0.0163618, reduceOnly, MARK_PRICE) — all logged with exact values.**
- **Kill test PASSED**: `kill -9` mid-position → algo stop + TP + grids all present on
  testnet afterwards (Layer 1 survives process death — the key M3 criterion).
- Graceful shutdown / manual stop: cancel-all (incl. algo stop via `{stop: true}` routing)
  + reduceOnly market-close of the full position (observed 400-lot close on tape).
- Venue realities baked in from this session: stops live on the Algo API only (−4120
  otherwise; ccxt ≥4.5 required); testnet WS user-data is dead (daemon survives via guard,
  polling covers sync); size entries ≥ minNotional/(1−stopPct/lev) or Layer 1 can't exist.
- Dashboard UI is a private repo (not here): live per-bot state verified queryable in DB
  (direction/fills/orders/TP/stop/geometry/cycles) + botLog tick stream — same data source.
- OPEN: 48h+ soak wall-clock (human runs/observes); re-run kill test on a supervisor-stop
  path (this session killed a healthy position — stop-hit/supervisor-terminate paths are
  unit-covered, live-proven pending).
17. (S8) Breach evaluation throttled to pollIntervalMs; re-sync runs every tick (D40a).
18. (S8) No alert channel upstream — breaches log warn; external alerting is pre-live work.
19. (S8) Futures market-stop quantity = BASE qty (stale quote-currency comment corrected — D39).
20. (S10) Binance conditional stops exist ONLY on the Algo Order API (−4120 elsewhere);
    ccxt ≥4.5 routes automatically; cancels/lookups need `{stop: true}` (D48, live-proven).
21. (S10) Testnet spot WS is dead; daemon survives WS 1008s via a scoped guard while polling
    covers sync (D49). Stale pid files block restarts after `kill -9` (clear + prefer SIGTERM).
22. (S10) Manual-stop flatten and kill-survival proven live; supervisor/stop-hit terminate
    paths are unit-covered, live-proven pending a 48h soak event.
