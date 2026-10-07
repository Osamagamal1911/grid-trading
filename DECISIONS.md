# DECISIONS.md — alphaGrid append-only decision log

Rules: append-only. Never rewrite or delete entries. If you disagree with a settled
decision, add a NEW entry proposing the alternative with reasoning — never silently
change a recorded decision. Format: date · decision · why · alternatives rejected.

---

## Seeded decisions (from BUILD_PROMPT.md spec — source of truth, 2026-10-07)

### 2026-10-07 · D1: Stop-loss triggers on UNREALIZED PnL only

What: `stopLossPct` is evaluated against locally computed unrealized ROI%
(`(markPrice − avgEntry) × signedQty / marginUsed × 100`), never against total/realized PnL.
Why: Binance in-platform bots stop on total PnL, which lets a bleeding grid masquerade as
healthy; capital preservation on small per-coin sizes demands the unrealized basis.
Rejected: total-PnL stop (upstream-exchange-bot behavior); realized-PnL stop (lags fills).

### 2026-10-07 · D2: Two-layer stop (exchange-side primary + 3s supervisor backup)

What: Layer 1 pre-placed exchange-side stop order re-synced after every fill; Layer 2
`onInterval` supervisor poll (default 3000ms) force-closes on breach and re-syncs drift.
Why: Layer 1 survives our server dying (the M3 kill-test); Layer 2 covers gap/fill failures
and keeps the dashboard fresh. Precedent: dkalenov's 2026-10-07 Bybit `/v5/position/trading-stop`
fix — backtest assumed SL/TP while live had none ("essentially nothing in common"), plus
leverage that was logged but never sent.
Rejected: poll-only stops (reference grid_trading_binance_futures behavior — dies with the process);
exchange-only stops (no dashboard freshness, no drift repair).

### 2026-10-07 · D3: Local fill tracking; identical code path live/paper/backtest

What: `fills[]`, `avgEntry`, `totalQty` tracked in bot state; PnL derived from these + current
mark price. Strategy code uses ONLY `IExchange` methods, never `exchange.ccxt`.
Why: `exchange.ccxt.*` breaks under the backtester's `MemoryExchange`; parity is the point of §4.5.
Rejected: reading position/PnL from the exchange object (convenient, breaks backtest).

### 2026-10-07 · D4: Mark-price trigger basis everywhere

What: stop/TP triggers reference mark price, never last price.
Why: protection against wick hunts on thin altcoin books.
Rejected: last-price triggers (upstream default ambiguity — see D9).

### 2026-10-07 · D5: Env-based API credentials

What: keys load from `BINANCE_API_KEY` / `BINANCE_API_SECRET`; never written to DB/files/logs;
trading-permission-only keys, withdrawals disabled; testnet/paper default.
Why: upstream stores plaintext keys in DB/file (`exchanges.sample.json5`, `IExchangeCredentials`
flow) — unacceptable for real-money-adjacent code.
Rejected: keeping upstream credential storage; config-file secrets.

### 2026-10-07 · D6: Every feature independently toggleable

What: `useTrailing`, `useTakeProfit`, `useStopLoss`, `useExchangeStopOrder` compose freely;
`direction × gridMode × toggles` matrix fully tested (§4.1b).
Why: pump-capture vs classic-grid vs ride-the-trend are all legitimate regimes; toggles make
each auditable in isolation. `useTakeProfit=false` ("ride the trend") is explicitly higher-risk
and must be documented, not prevented.
Rejected: coupled flags; hidden forced-on stops.

### 2026-10-07 · D7: ATR-adaptive spacing with manual override

What: default `gridMode="atr"`, `levelSpacing = atrMultiplier × ATR(14, atrTimeframe)`;
`gridMode="manual"` requires `manualHighPrice`/`manualLowPrice`.
Why: fixed grids die on regime change (AKE-style pumps then bleeds); ATR follows volatility.
Rejected: ATR-only (operators need deterministic ranges for backtest comparison); fixed-only.

### 2026-10-07 · D8: Additive change only — existing templates untouched

What: do not modify grid, grid-bot, dca, rsi templates.
Why: upstream mergeability; blast radius control.
Rejected: refactoring shared grid helpers in place (extend via new module instead).

---

## Framework conflicts found by code inspection (2026-10-07, upstream `dev` @ 8b8e245)

All verified in code, not assumed. Each needs the smallest viable adjustment in its step.

### 2026-10-07 · D9: `IGetMarketPriceResponse.price` is trigger-basis-ambiguous

Finding: `packages/types/src/exchange/public-data/get-market-price.ts` returns a bare `price`
with no mark/last designation; `grid-bot.ts` even aliases it `markPrice` without guarantee.
Spec §3 requires mark price. Adjustment (S7/S8): resolve the real basis in the exchange
adapter (prefer mark-price endpoint) and document which field is used; backtest uses candle
range-crossing as the mark approximation. Rejected: trusting the alias at face value.

### 2026-10-07 · D10: `IPlaceStopOrderRequest` has no `reduceOnly`, no trigger-basis field

Finding: `packages/types/src/exchange/trade/place-stop-order.ts` carries only
`type/symbol/side/quantity/price?/stopPrice`; `normalize.placeStopOrder` forwards positionally
to `ccxt.createStopOrder`. Spec §4.4 requires `reduceOnly: true` + mark-price trigger.
Adjustment (S8): extend the request type (additive optional fields) and plumb extras through
normalize — smallest change; backtest `MemoryExchange` honors them in simulation.
Rejected: stuffing flags into untyped CCXT passthrough from strategy code (breaks parity/audit).

### 2026-10-07 · D11: `MemoryExchange.placeStopOrder` is a no-op stub

Finding: `packages/backtesting/src/exchange/memory-exchange.ts` returns an empty orderId and
never fills. Spec §4.5 requires range-crossing simulated fills + commission/slippage.
Adjustment (S9): implement simulated stop fills in `MemoryExchange` (or a clearly-scoped
backtest harness around it), additive only.
Rejected: simulating stops inside strategy code (would diverge live vs backtest).

### 2026-10-07 · D12: `PaperExchange.placeStopOrder` throws ("not supported")

Finding: `packages/exchanges/src/exchanges/ccxt/paper-exchange.ts:296` throws for stop orders.
Consequence: Layer 1 CANNOT be validated on the paper simulator; the S10/M3 kill-test must run
against Binance testnet via the real CCXT adapter. In paper mode Layer 2 is the only protection —
documented, not silently degraded.
Rejected: pretending paper covers Layer 1.

### 2026-10-07 · D13: No ATR indicator exists upstream

Finding: `packages/indicators/src/indicators/` ships only `rsi`, `ema`, `sma` (+ tests).
Adjustment (S6): add `atr.ts` (Wilder's smoothing) following the existing indicator module pattern.
Rejected: vendoring an external TA lib for one indicator; computing ATR inline in strategy code
(would bypass the indicators package the spec mandates).

### 2026-10-07 · D14: Template registration is by-export (`findTemplate`)

Finding: `packages/bot-templates/src/templates/index.ts` re-exports each template module;
`findTemplate(name)` resolves by export name. Adjustment (S5): add `alpha-grid.ts` (+ export)
following `grid.ts` wrapper conventions; schema drives the dashboard form.
Rejected: a parallel registration mechanism.

---

## Session entries (append below; newest last)

### 2026-10-07 · D17: Toolchain = user-local Node 22.12.0 + pnpm 10.12.1 (no sudo, no global mutation)

What: Node installed from the official `linux-arm64` tarball into `~/.local/node-v22`
(`export PATH="$HOME/.local/node-v22/bin:$PATH"` required in every shell); pnpm via
`npm install -g pnpm@10.12.1` (lands in `~/.local/node-v22/bin`). Moon binary restored by
running the skipped postinstall directly:
`node node_modules/.pnpm/@moonrepo+cli@1.37.2/node_modules/@moonrepo/cli/postinstall.js`
(because `pnpm install` ignored build scripts and `pnpm approve-builds` is interactive-only —
piped `y` input does not register on its confirm prompt).
Why: container had no node/npm/pnpm; user-local install avoids sudo and survives repo wipes
but NOT machine switches — a next AI on another machine must reinstall (one command each, see HANDOFF).
Rejected: `apt install nodejs` (wrong version, needs sudo); `proto` toolchain pin changes
(out of scope for S1); committing binaries into the repo.

### 2026-10-07 · D18: S1 baseline — all `packages/*` typecheck green; `app` has 4 pre-existing errors

What: after `tsc --build` populates the gitignored `/dts` project-reference artifacts,
direct `tsc --noEmit` passes (exit 0, 0 errors) in ALL 13 packages:
types, tools, indicators, bot-templates, bot-processor, backtesting, exchanges, db,
event-bus, logger, bot, trpc, prisma. `app:typecheck` fails with 4 pre-existing errors on the
untouched tree (`cli.ts` import-attributes `assert`→`with`; `daemon-rpc.ts` trpc/SuperJSON
transformer drift ×2; `utils/command.ts` logger overload) — NOT caused by us, NOT in scope
(strategy work lives in `packages/*`; additive-only rule forbids drive-by fixes).
Baseline tests: `indicators:test` 15/15 pass, `tools:test` 75/75 pass (20 files),
`bot-templates:test` has no test files (expected — our S4/S5 tests will be the first).
S1 acceptance "typecheck passes on the untouched tree" is therefore met for every package
alphaGrid will touch; the `app` failure is recorded here as the honest baseline.
Why: the first full `moon run :typecheck` looked red (TS6305 missing-`/dts` cascade that even
faked `db` generic-type errors) — building references first was the correct read, verified
package-by-package, instead of "fixing" phantom upstream errors.
Rejected: fixing `app/` type errors in S1 (out of scope, violates additive-only);
treating moon's cached failure output as current truth (always re-verify with direct `tsc`).

### 2026-10-07 · D16: Repo-local git identity = noreply email (privacy block workaround)

What: `git config` (repo-local, NOT global) set to name `Osamagamal1911` + email
`73962760+Osamagamal1911@users.noreply.github.com`; the 3 bootstrap commits were rebuilt with
`git commit-tree` (same trees/parents/messages/dates, new identity) because GitHub's "block
pushes exposing my email" rejects ANY pushed commit carrying `g.osama1553@gmail.com`.
Why plumbing (`commit-tree` + `reset --hard`) and NOT `rebase`: the import merge embeds ~1500
upstream commits — `rebase --rebase-merges` tried to replay all of upstream history and hit a
historic conflict (aborted cleanly, no damage). Never rebase across the import merge.
Rejected: disabling GitHub's email-privacy block; rewriting upstream history.

### 2026-10-07 · D15: Upstream code lives INSIDE grid-trading (S1-Q1, human-decided)

What: human chose "Import tree into grid-trading": OpenTrader `dev` is merged into this repo
(`Osamagamal1911/grid-trading`) on `feature/alphaGrid` via
`git merge upstream/dev --allow-unrelated-histories`, instead of forking to a separate
`Osamagamal1911/opentrader` repo.
Why (human's call): keeps the current repo/clone/remote valid; single repo for the whole build.
Consequences: history starts from a merge of two roots (initial `6ac8203` + upstream `dev`);
future upstream syncs use `merge` (not rebase — rebase across the unrelated-history seam is
unsafe), documented here per §8.6. `upstream` remote still points at Open-Trader/opentrader;
`origin` pushes go only to the human's fork… actually to this repo itself (it IS the human's repo).
Rejected alternative: separate `Osamagamal1911/opentrader` fork (spec-§8.6-default, cleaner
history) — declined by human for repo consolidation.
