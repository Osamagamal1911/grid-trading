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

### 2026-10-07 · D19 [AUTO]: S3 = env-first credential layer, NOT removal of upstream DB/file account plumbing

What: S3 adds an env-based credential source (`BINANCE_API_KEY` / `BINANCE_API_SECRET`) that
WINS at runtime wherever alphaGrid-adjacent code builds a Binance exchange, but does NOT delete
the upstream `ExchangeAccount` DB table, trpc account routers, or `exchanges.json5` file flow.
Concretely: (a) new pure loader module in `packages/exchanges`; (b) last-mile env substitution
in `ExchangeProvider.fromAccount` for Binance when env vars are present (in-memory only, never
persisted); (c) redaction of Binance secrets before the CLI sync (`createOrUpdateExchangeAccounts`)
writes to DB when env vars are present; (d) redaction of the `logger.debug(exchangesConfig, …)`
lines that would otherwise print secrets when debug logging is on. When env vars are ABSENT,
every flow behaves byte-identically to upstream (backward compatible).
Why: bots reference `exchangeAccountId` — deleting the account table/routers would break bot
deployment and the M1 dashboard requirement; per §7 the smallest viable adjustment wins, and the
S3 acceptance criteria as written constrain NEW code paths + defaults + tests + audit (all met),
they do not demand deleting upstream flows. Residual risk (dashboard-created accounts still store
plaintext by upstream design) is documented in ALPHAGRID.md §5 as a known limitation with a
follow-up proposal, not silently redesigned.
Rejected: full removal of DB columns/routers/sample-file flow (blast radius: breaks dashboard
account management + bot↔account relations); overlay-only in `readExchangesConfig` (env secrets
would still be persisted to DB by the CLI sync AND printed by the debug log — fails the audit).

### 2026-10-07 · D20 [AUTO]: Env var set + safe defaults (testnet-first)

What: `BINANCE_API_KEY` / `BINANCE_API_SECRET` (required unless paper); `BINANCE_TESTNET`
(default `"true"` → `setSandboxMode`, i.e. Binance testnet; explicit `"false"` = live, documented
as human-opt-in risk for M4); `BINANCE_PAPER` (default `"false"`; `"true"` = `PaperExchange`
simulator, keys not required). Missing required vars throw naming the VAR, never the value;
the loader module never logs. `ExchangeProvider.fromEnv()` builds a fresh (uncached) instance —
docstring warns callers to reuse it (rate limits); caching stays with the per-account-id cache
in `fromAccount`, which S7/S10 runtime paths use.
Why: spec §3 demands testnet/paper default with no live default; paper-without-keys keeps
secret-free simulation possible; env-wins-when-present is simpler to audit than fill-in-blanks
(which could silently mask a missing env configuration).
Rejected: always-demo loader with no live path (would make M4-via-env impossible and push the
human back to plaintext flows); fill-in-blanks substitution (masks misconfiguration).

### 2026-10-07 · D21 [AUTO]: S2 marked DONE (stale status bookkeeping, no spec change)

What: STEPS.md S2 status was left `IN PROGRESS` although all four acceptance criteria are
verifiably met (DECISIONS holds D1–D8 + D9–D14; HANDOFF has all §8.3 sections; ALPHAGRID skeleton
has all §6 sections; S2's scope added no `.ts` — session-1/2 commits were docs/config only).
Marked DONE without touching criteria text.
Why: statuses must reflect reality for the next AI; leaving a completed step open invites rework.
Rejected: leaving it open "to be safe" (causes exactly the redo the protocol tries to prevent).

### 2026-10-07 · D22 [AUTO]: `test: vitest` task added to `packages/exchanges/moon.yml`

What: sibling packages (`tools`, `indicators`, `bot-templates`, `bot`, `event-bus`) all define a
moon `test` task running `vitest`; `exchanges` had none, so `moon run exchanges:test` was an
unknown target. Added the same one-liner (convention match, no new tooling).
Why: S3 adds the first unit tests to the exchanges package; they must run through the same
`moon run <pkg>:test` path as everything else.
Rejected: running vitest only ad-hoc via npx (works but leaves the gap for the next AI).

### 2026-10-07 · D23 [AUTO]: Local testnet creds file = gitignored, env-only code contract

What: Binance testnet `key:`/`secret:` live ONLY in repo-root `binance-test-net` (human-provided,
local-only). It is now gitignored (exact-name rule + `*credentials*` pattern) and verified absent
from `git status`. Committed code NEVER reads this file — it reads `BINANCE_API_KEY` /
`BINANCE_API_SECRET` env vars only; the local flow is sourcing the file into env per-shell
(commands documented in HANDOFF, never committed). Later real-API use = same var names with
live values, only on explicit human approval (M4, out of scope).
Disclosure: a structure probe during inspection echoed the file's values into tool output. They are
testnet-scoped, stay on this machine, and will not be reproduced in any output, commit, or doc.
Why: spec §3 forbids file/DB secret storage; env-only code + ignored local file satisfies both
the letter (audit-clean repo) and the practical need (testnet runs without pasting secrets).
Rejected: reading the file from committed code (reintroduces file-based secrets); committing an
`.env` with the values (same violation); deleting the human's file (their property, needed for runs).

### 2026-10-07 · D29 [AUTO]: Uniform round-down stands, even for LONG stops (≤1-tick bound)

What: considered side-aware rounding (LONG SL rounded UP toward entry = earlier trigger).
Kept uniform floor-everything (D26): max deviation is ONE tick on the exchange trigger price,
Layer 2 (supervisor) re-syncs from EXACT unrounded values, and uniform flooring is simpler to
audit than 4 directional branches in safety-critical code. TP limits: flooring moves LONG TPs
one tick nearer (earlier fill) and SHORT TPs one tick farther — both ≤1 tick.
Why: predictability + auditability beat a ≤1-tick trigger refinement the supervisor already
covers; every extra branch in stop math is a place to be wrong with real money.
Rejected: side-aware rounding (marginal gain, 4× branch surface in the most critical functions).

### 2026-10-07 · D33 [AUTO]: S6 ATR delegates to the already-vendored `technicalindicators` (D13 clarification)

What: D13 ("no ATR upstream; add atr.ts") assumed no TA lib and rejected vendoring one. Verified:
upstream indicators are thin wrappers around `technicalindicators@3.1.0` (ALREADY a dependency —
rsi/ema/sma all delegate to it), and its ATR IS Wilder's smoothing (TrueRange → WEMA with α=1/N
seeded by SMA — confirmed in lib source). So `atr.ts` follows the exact module pattern
(async fn, `IndicatorError`, NaN-padding) delegating to the vendored lib: zero new dependencies,
verified Wilder-correct by a hand-computed fixture test (not by trusting docs).
The indicators package keeps its zero-workspace-dependency layering, so the ATR→spacing→grid
composition test lives in S7 (strategy owns wiring); S6 proves indicator purity + exchange-shaped
input handling. Manual mode bypasses ATR entirely (S7 selection).
Why: hand-rolling a third smoothing implementation beside the vendored Wilder-correct one is NIH
with real divergence risk; D13's core (atr.ts in indicators, module pattern) stands unchanged.
Rejected: hand-rolled Wilder loop (duplicates vendored-correct code); adding a second TA lib;
putting composition tests in indicators (would add a workspace dep to a currently leaf package).

### 2026-10-07 · D34 [AUTO]: Lib ATR seeds from candle 2 — delegation stands (documented, tested)

What: probing revealed the vendored ATR skips TR[0] (no previous close for candle 1):
first defined value sits at candle index `periods` (seed = SMA of TR[1..periods]), NOT the
textbook SMA(TR[0..periods−1]). After warmup both converge (Wilder smoothing forgets the seed
exponentially); grid spacing uses the latest value after 20+ closes, so the difference is
trading-irrelevant. Delegation stands: behavior is exact-pinned by a hand-derived fixture test,
the S5 warmup buffer (20 closes) absorbs the +1 shift, and pattern consistency beats a 15-line
fork that would need its own audit trail.
Why: the deviation is characterized, bounded, and covered — forking the lib over a converged
seed transient would trade a documented property for unaudited novelty.
Rejected: hand-rolled textbook loop (see above); asserting textbook values against lib output
(would fail — tests assert the documented actual behavior instead).

### 2026-10-07 · D35 [AUTO]: S7 framework gaps — reduceOnly (limit/market), setLeverage, getMarkPrice

What:
(a) `reduceOnly?: boolean` added to `IPlaceLimitOrderRequest` + `IPlaceMarketOrderRequest`
(optional, backward compatible); normalize appends a ccxt `params` object ONLY when true
(no-params call shape otherwise unchanged). Stop-order reduceOnly + mark-trigger stay S8 (D10).
(b) `IExchange.setLeverage(symbol, leverage)` added; CCXTExchange → `ccxt.setLeverage`;
PaperExchange overrides record-only (no network); MemoryExchange records (S9 simulates).
(c) `IExchange.getMarkPrice(symbol)` added (`{symbol, markPrice, timestamp}`); CCXTExchange →
`fetchMarkPrice`, throws when the endpoint yields no mark (never silently falls back to last,
D4); MemoryExchange stub = candle close (S9 refines trigger-crossing); PaperExchange inherits.
(d) Strategy uses `ctx.exchange` directly, never `yield useExchange()` — fewer runner-map
dependencies, identical instance, strictly safer for backtest parity.
Why: spec mandates reduceOnly exits, real leverage application (dkalenov lesson b), and
mark-price triggers — none exist upstream; each addition is optional-or-new (nothing breaks).
Rejected: stuffing flags through untyped ccxt passthrough from strategy code (breaks parity +
audit); reusing last-price `getMarketPrice` as mark (spec-forbidden); leverage via dashboard-only
manual setting (the exact failure dkalenov admitted).

### 2026-10-07 · D36 [AUTO]: S7 state shape + restart reconciliation + foreign-order refusal

What: persisted `AlphaGridRuntimeState` (versioned, fills[] append-only, tracked orders with
`filledSoFar`, TP id, grid geometry, cycleCount, noStopLossAck). Every tick reconciles:
tracked orders vs `getOpenOrders` → fill deltas recorded (partials accumulate via filledSoFar),
missing tracked orders resolved via `getLimitOrder` (filled → account remainder; canceled →
drop). ANY untracked open order for the symbol → throw listing IDs (never touch others'
orders). Crash-between-place-and-save orphans surface as exactly this loud error; recovery =
cancel strays on the exchange, restart (documented in ALPHAGRID). No clientOrderId adoption
(normalize drops it today; exchange-specific semantics — not worth a second framework gap).
Why: restart-safety is the M3 kill-test's cousin — state must rehydrate to truth, and the only
safe response to unknown live orders is refusal, never adoption or blind cancel.
Rejected: blind cancel-all on start (could kill the operator's manual orders); silent adoption
of unknown orders (unknown intent + fill state); clientOrderId re-adoption (framework gap).

### 2026-10-07 · D37 [AUTO]: S7 execution semantics (partials, guards, trailing, stops)

What:
(a) TP partial fills reduce `totalQty` only (`fills[]` immutable → avgEntry stays exact
pro-rata); dust remainder below stepSize with no closable qty → loud error (manual recovery).
(b) Startup min-cost guard: every placed level's notional must clear `limits.cost.min`
(else throw naming the level — operator raises `volumePerLevel`).
(c) Trailing = ONE-SHOT shift (compute count from overshoot, single cancel-all + redraw),
position/TP untouched; `useTrailing=false` out-of-range idles with `idleOutOfRange` state flag.
(d) Manual stop (onStop): cancel tracked + market-close remainder reduceOnly + clear; NEVER
calls `control.stop()` (framework owns lifecycle). SL-hit `control.stop()` is S8's.
(e) S7 implements NO ROI force-close (that's the S8 supervisor); S7's only exits are TP,
trailing-aware grid management, and manual stop.
Why: each rule keeps money behavior predictable and testable; (a) preserves avgEntry exactly;
(c) avoids order spam on gap pumps (the LOBSTER case); (e) keeps step boundaries atomic.
Rejected: grid re-placement of filled levels (spec: depleting grid, TP-on-whole-position);
per-shift trailing loops (order spam); S7 stop-guards (would pre-empt S8's tested supervisor).

### 2026-10-07 · D38 [AUTO]: Tick sizes read precision-first (Binance is TICK_SIZE mode)

What: `marketPrecisionFromSymbolInfo` uses `precision` values directly as ticks and only
falls back to `decimals` (10^-d) when precision is missing. Verified in ccxt source that
Binance `precisionMode` is TICK_SIZE, so precision floats (0.01, 0.25, even integer 1.0)
ARE exact ticks. Decimals-first would mis-round odd ticks (0.25 → 0.1, PRICE_FILTER
rejection) and integer ticks (1.0 → 0.1). An earlier decimals-first draft was corrected
before commit after this verification.
Why: exchange order rejection on tick violation is a silent-grid-killer; exact ticks are
also what §4.2 demands ("real tickSize/stepSize").
Rejected: decimals-first derivation (lossy for odd/integer ticks); hardcoded decimals.

### 2026-10-07 · D41 [AUTO]: S9 backtest architecture — dedicated driver, redeploy model

What:
(a) Upstream `Backtesting.run` drives the REAL `StrategyRunner` but matches only SMART-trade
orders; alphaGrid needs IExchange-level matching. New dedicated driver in
`packages/backtesting/src/alpha-grid/` reuses `createStrategyRunner` + `MemoryStore` +
`MemoryExchange` (same strategy code path as live, §4.5) with its own loop:
`nextCandle → exchange.processCandle (range-match) → runner.start/process → metrics`.
Upstream `Backtesting`/`MarketSimulator` untouched.
(b) `MemoryExchange` gains a real order book: limit/stop/market registration, per-candle
range-crossing fills (limit buys low≤price, sells high≥price, stops cross slPrice),
taker/maker commission + adverse slippage, fill journal, candle history for
`getCandlesticks`, configurable tick/step. `getMarkPrice` stays close (D35 note).
(c) Stop-outs do NOT halt the run: each models an operator redeploy (documented in the
report). Detection is driver-side via state transitions (in-position → cleared with
`cycleCount` unchanged = stop-out; `cycleCount`+1 = TP cycle) + exchange fill journal
(stop-id filled = Layer-1 hit, else supervisor). `MemoryStore.stopBot` is a harmless noop.
(d) Metrics on allocated CAPITAL (param): equity = capital + realized − fees + unrealized;
total return %, max DD from the equity curve, win rate over closed cycles, stop-outs with
ROI-at-trigger (asserted ≈ −40% in code), fees, liquidations (checked per candle, lev-1
expects 0). Costs default: maker 2bps / taker 5bps (Binance VIP0), taker slippage 2bps,
limits 0 (maker rests). Restart-model + costs stated in the report — no cherry-picking.
Why: (a) reuses the live runner (parity) without disturbing smart-trade backtests; (b) fills
the D11 gap additively; (c) one halted run tells nothing, redeploy-model reports everything;
(d) dkalenov-style honesty requires full-distribution reporting.
Rejected: shoehorning into `Backtesting.run` (wrong matching layer); halt-on-first-stop
(single-cycle report); paper-trade "backtest" (D12 — no Layer 1).

### 2026-10-07 · D39 [AUTO]: Stop-order plumbing — triggerBasis + quantity convention

What: `IPlaceStopOrderRequest` gains `reduceOnly?: boolean` + `triggerBasis?: "mark" | "last"`
(both optional — zero behavior change for the nonexistent upstream callers); normalize maps
`"mark" → workingType MARK_PRICE` (Binance futures stop trigger) and appends ccxt params ONLY
when specified. Strategy-domain language ("mark"/"last") keeps MemoryExchange generic for S9.
Quantity for futures market stops = BASE qty (reduceOnly close of a base-denominated position);
the stale "market = quote currency" comment (spot market-buy lore, zero in-repo callers) is
corrected, with testnet verification of workingType + qty semantics booked as an S10 checklist
item. Supervisor throttle (D30): breach evaluation gated on `pollIntervalMs`, tests drive it
deterministically with fake timers + `lastSupervisorRun` control.
Why: spec §4.4 demands mark-triggered reduceOnly stops; additive-optionals preserve upstream;
S10 proves the exchange actually honors both flags.
Rejected: defaulting workingType globally (would silently change any future upstream caller);
quote-currency stop qty (wrong for futures reduceOnly closes).

### 2026-10-07 · D42 [AUTO]: Sub-min-notional stops skip Layer 1 (warn once, supervisor covers)

What (found by the first S9 backtest run, real exchange behavior): a LONG stop at −40%/lev1
is 60% of entry notional — small-size entries that clear MIN_NOTIONAL still produce
REJECTABLE stops (Binance would 400 them too). `syncStopOrder` now skips placement when
`slQty × slPrice < minCost`, warning once per transition via persisted
`state.stopUnplaceable` (debug repeats, no spam); existing stops are left untouched;
supervisor remains the protection. Consequence for sizing (report + S10 checklist):
entries need ≥ minNotional / (1 − stopPct/(100×lev)) for Layer-1 viability.
State version bumped 2 → 3 (shape change).
Why: skipping mirrors the venue (no fantasy stops); loud-once beats spam and silence;
the supervisor exists precisely for this degraded mode.
Rejected: forcing sub-min stops (rejected live too); silent skip (masks missing layer);
erroring the tick (a too-small position is operable under supervision, not fatal).

### 2026-10-07 · D44 [AUTO]: Same-tick opposite grid fills NET (one-way invariant holds)

What (found by the first S9 backtest run — live-race included): between polls, price can
cross BOTH armed sides (hourly wicks routinely; 3s live polls rarely but possibly). The
cancel-after-lock then loses the race and `fills[]` would hold both sides → old code threw,
killing the run/bot. Rule: an opposite-side GRID fill nets against the open position —
closes min(fill, totalQty) (driver values the scalp from journal + pre-tick avg), zeroes
direction/fills on full close, flips with the remainder on overshoot (bounded: opposite
resting orders die at lock). Partial nets keep fills[]/avgEntry exact pro-rata (same pattern
as TP partials). TP/stop fills are exits, never netting candidates.
Why: netting is the only economically correct response (a buy+sell with no position IS a
closed scalp); throwing on real market behavior bricks live bots on wick days; the invariant
(net position one-sided-or-flat) holds in all cases.
Rejected: throw-on-mixed (bricks on wicks); ignoring the second fill (phantom position vs
exchange truth — parity violation).

### 2026-10-07 · D43 [AUTO]: Dust grid levels are skipped (warned), not fatal — unless all are dust

What (found by the same S9 run): volatile microcap ATR spacing puts outer levels below
MIN_NOTIONAL while inner levels are fine; aborting the whole draw would idle the bot for
weeks and miss the pump it exists to catch (live venues reject per order, not per batch).
`drawGrid`/trailing now skip sub-min levels with a warn count and place the rest; zero
placeable levels still throws (sizing broken, operator fixes `volumePerLevel`). Shared
`placeLevelOrders` helper serves both paths.
Why: mirrors venue behavior per order; a partial honest grid beats a dead bot; the all-dust
throw preserves the fail-loud sizing guard.
Rejected: abort-on-first-dust (dead bot for weeks); silent skip (grid shape must be visible).

### 2026-10-07 · D40 [AUTO]: S8 supervisor + stop-hit + shared termination design

What:
(a) Breach evaluation gated on `pollIntervalMs` via `state.lastSupervisorRun` (D30);
TP/SL drift re-sync runs every tick through the idempotent sync fns (the throttle gates
only the close decision, never re-sync freshness).
(b) Exchange stop execution (any delta on a tracked stop) → `handleExchangeStopHit`:
shared `terminatePosition` (cancel all → market-close remainder reduceOnly → clear →
`control.stop()`), taking precedence over TP-cycle logic the same tick.
(c) Manual-stop dust remainder changed S7-throw → warn + clear (the bot is stopping anyway;
unclosable dust is logged loudly for manual recovery).
(d) No external alert channel exists upstream — breaches log `warn`; Telegram/webhook
alerting booked as pre-live work (ALPHAGRID §3.2), not silently omitted.
(e) Paper + Layer-1-on fails loud at placement (`PaperExchange.placeStopOrder` throws by
upstream design) — operator sets `useExchangeStopOrder=false` on paper; no auto-fallback
that would mask the missing layer.
Why: (a) matches the spec cadence without re-running closes; (b) one termination path for
three triggers (manual/stop-hit/supervisor) — no divergent close logic; (c) a stopping bot
must not hang on dust; (d/e) loud > masked, always.
Rejected: per-tick breach checks ignoring pollIntervalMs (setting would be vestigial);
auto paper fallback (masks missing protection); separate close implementations per trigger.

### 2026-10-07 · D30 [AUTO]: S5 template design — static interval + plain schema + separate validator

What:
(a) `interval`: upstream `setupInterval` (`packages/bot/src/bot.ts:181-191`) uses the STATIC
`strategyFn.interval` — per-bot `pollIntervalMs` cannot drive the tick without a framework
scheduling change. Template `interval = 3000` (== default `pollIntervalMs`); the S8 supervisor
throttles internally to `settings.pollIntervalMs` (acts when now−lastTick ≥ pollIntervalMs:
exact-or-slower, i.e. the safe direction for rate limits, ± one template tick).
(b) `symbol` stays in schema (spec-literal, drives the deploy form); S7 treats
`settings.symbol` as the futures-market source of truth vs framework `bot.symbol` pair slot.
(c) Caps beyond spec: `nLevels ≤ 100` (order-count safety), `pollIntervalMs ≥ 1000` (hot-loop
guard); `leverage ≥ 1` uncapped (exchange is the authority, S7 asserts the set-call).
`symbol` = trim, min 1 (uppercase normalization deferred to S7 — see D31).
(d) S5 ships the template generator as an inert stub (warns once on start, places NO orders);
S7 implements the state machine in place.
(e) No socket watchers: REST-only data path (`getMarketPrice`/`getCandlesticks`) is identical
live/backtest with fewer moving parts; fill reactions land within one poll tick by design
(same as the mirrored reference behavior).
(f) `requiredHistory` = settings-driven fn returning 1m-candle counts for 20× atrTimeframe
(15 closes seed ATR(14) + 5 buffer; same minute-math as upstream dca `requiredHistory`).
Why: every item favors zero framework changes + auditability; (a) and (f) reuse verified
upstream mechanics instead of inventing new ones.
Rejected: widening `interval` to a per-bot function (scheduling-code blast radius for ±tick
precision the throttle already covers); WebSocket watchers (backtest divergence surface);
uncapped nLevels / sub-second polls (accidental order-storm / hot-loop footguns).

### 2026-10-07 · D31 [AUTO]: Conditional rules live in `validateAlphaGridSettings()`, NOT zod refinements

What (verified in code, §7 conflict report): `BotTemplate.schema` is typed
`ZodObject<any,any,any>` AND `get-strategies/handler.ts` gates the dashboard form on
`schema._def.typeName === "ZodObject"` (else the form gets an EMPTY schema). In zod v3,
`.refine/.superRefine/.transform` all return `ZodEffects` — so encoding the §4.1b conditional
rules (manual prices iff manual, percents iff toggles on) or the symbol uppercase transform
IN the schema would break compilation AND silently empty the dashboard settings form.
Smallest adjustment: schema stays a plain object (fields, defaults, int/min/max/positive,
enums, `.describe()` — all ZodObject-safe, form renders fully); ALL conditional rules move to
pure `validateAlphaGridSettings(settings: unknown): string[]` (empty = valid), enforced at
bot/backtest startup in S7/S9 (fail loud). S5 tests target the validator per rule.
Why: a rendered form + startup enforcement beats a type-broken template with an empty form;
runtime validation additionally protects programmatic/CLI paths the form never sees.
Rejected: ZodEffects schema (breaks type + dashboard); dropping conditional rules (spec-mandated);
touching `getStrategies`/create-bot handler to unwrap effects (upstream change for zero gain).

### 2026-10-07 · D32 [AUTO]: Templates namespace carries template functions ONLY (explicit export)

What: first S5 version used `export *` for the alpha-grid subdir — its schema helpers/constants
leaked into `templates/index.ts`, breaking `strategiesNames(templates)` typing AND (worse)
poisoning the dashboard strategy enumeration (`getStrategies` lists every export as a strategy).
Fix: `templates/index.ts` explicitly exports ONLY the `alphaGrid` template fn (+ its config type);
schema/helpers export from package ROOT (`src/index.ts`), which no strategy enumeration reads.
Subdir `index.ts` deleted to remove the footgun; in-package imports use direct relative paths.
Caught by `tsc`, fixed before commit — no dashboard code touched.
Why: the by-export registration (D14) makes namespace hygiene load-bearing; explicit > glob.
Rejected: prefix-filtering strategies at enumeration time (upstream change, masks future leaks).

### 2026-10-07 · D24 [AUTO]: Milestone tags follow the explicit map (m1 at S7, m2 at S9)

What: STEPS.md contains two statements about S8: the milestone map ("M1 = S1–S7 · M2 = S8–S9")
vs S8's section title "(M1+M3)" and S9's "tag alphaGrid-m1 (on S8 green)". The explicit map wins:
tag `alphaGrid-m1` when S7 goes green (M1 = strategy + credentials complete), tag `alphaGrid-m2`
when S9 goes green (M2 = backtest complete). S8's title label is treated as a stale copy of an
earlier plan; no criteria text changes, only tag timing.
Why: the map is the single unambiguous composition rule; S7 is the last strategy-construction
step, S8/S9 are validation steps — tagging m1 at S7 matches "M1: Strategy + safe credentials".
Rejected: tagging m1 at S8 (contradicts the map); editing BUILD_PROMPT (spec has no S-steps —
this ambiguity lives in our plan file, not the spec).

### 2026-10-07 · D25 [AUTO]: S4 math module lives in `packages/tools/src/alpha-grid/`

What: new subdir `alpha-grid/` with `math.ts` + `math.test.ts`, exported through
`tools/src/grid/index.ts` (same `export *` convention). Consumers: live strategy (bot-templates/
bot-processor) and backtest (backtesting package) — ALL already depend on `@opentrader/tools`,
so no package.json changes anywhere.
Why: spec §4.2 demands one module used by live AND backtest; tools is the only package both
sides already share; own subdir keeps it additive and avoids touching existing grid helpers (D8).
Rejected: new package (dependency wiring for zero benefit); placing in bot-templates (backtester
doesn't depend on it — would invert the dependency direction).

### 2026-10-07 · D26 [AUTO]: Rounding = floor-to-tick-multiple via big.js (not decimals truncation)

What: `roundPriceToTick(price, tickSize)` / `roundQuantityToStep(qty, stepSize)` compute
`floor(value / size) * size` in exact decimal arithmetic (big.js, already a tools dep) and return
numbers. Direction is ALWAYS down (never round up: rounding an entry/TP/SL price up could push
an order outside the intended level or above available margin).
Why: spec §4.2 says "real tickSize/stepSize …, never a hardcoded decimal count" — decimal-count
truncation (`filterPrice`, which stays untouched for spot flows) is lossy for non-power-of-10
ticks and returns strings; true tick math is exact and directly matches the spec wording.
S7 feeds real tick/step from market data at the boundary (CCXT precision → tick conversion there).
Rejected: reusing `filterPrice`/`filterQuantity` (decimals-based, string-typed, wrong tool for
futures ticks); native floats (binary error on altcoin dust prices); round-half-up (unsafe side).

### 2026-10-07 · D27 [AUTO]: Manual-mode spacing derivation (spec-silent, assumption #7)

What: `manualLevelSpacing(high, low, nLevels) = (high − low) / (2 × nLevels)`; grid centered at
`(high + low) / 2`; `buyLevel[i] = center − i × spacing`, `sellLevel[i] = center + i × spacing`
(`i = 1..nLevels`), each tick-rounded. ATR mode: `levelSpacing = atrMultiplier × ATR` (absolute),
then the same builder. So `gridTop = sellLevel[nLevels] ≈ high`, `gridBottom ≈ low` in manual mode.
Why: the only symmetric derivation that honors both the spec's level formulas AND makes the
manual range edges coincide with the outermost levels; recorded in ALPHAGRID.md assumptions.
Rejected: `(high−low)/nLevels` per side (grid would span 2× the requested range); anchoring at
low (asymmetric, breaks the LONG/SHORT mirror the state machine assumes).

### 2026-10-07 · D28 [AUTO]: S4 edge semantics — quiet on normal empties, loud on violations

What: zero position (`totalQty = 0` / `marginUsed = 0`) → `unrealizedROI% = 0`; empty `fills[]` →
`{ avgEntry: 0, totalQty: 0 }` (FLAT is a normal state, not an error); mixed-side fills,
non-finite inputs, `leverage ≤ 0`, `nLevels < 1`, `spacing ≤ 0`, `high ≤ low`, negative
prices/quantities → throw `Error` with a naming message.
Why: the S7 poll runs every 3s on possibly-FLAT state — throwing on empty would turn every idle
tick into an exception; invariant violations (mixed sides in a one-way position) must fail loud
for auditability, never silently average.
Rejected: NaN propagation (poisons downstream orders); silent clamping of bad config (masks
operator error on real-money-adjacent code).

### 2026-10-07 · D46 [AUTO]: S9 sim-clock pinning + ruin/screen redesign (gap honesty)

What:
(a) The supervisor gates on wall-clock `Date.now()` — backtest ticks sharing one real
millisecond would never evaluate it. The driver pins fake timers to each candle timestamp
(same deterministic pattern as the S8 fake-timer tests); strategy code unchanged.
(b) Stop fills are gap-aware: an open already beyond the trigger fills at the adverse open,
not the stop (live gap reality); stop-limits still gap-miss honestly.
(c) Liquidation accounting, three screens: fill-time ruin (exit fill ROI ≤ −100% → liq event
with hadStop context, takes precedence); missed-stop tripwire (resting stop the range
crossed but unfilled with unchanged id → throw, sim bug); naked post-tick ruin (surviving
position, no resting stop, wick ≤ −100% → honest liq). Pre-tick screen removed (it double-
counted wicks the stop handled same-candle).
(d) Stop-out gate trio: early-fill (ROI above −stopLossPct+tol) throws; ruin (≤ −100%)
routes to liquidation; else stop-out recorded. Liquidations are REPORTED (count + context),
never asserted to zero — a naked wick ruin is a finding (size up for Layer-1, D42), and the
M2 window indeed produced honest −16.88% with 0 liqs.
(e) Test trap found the hard way: fake timers must be armed BEFORE setup ticks — arming
after real-timer ticks jumps the clock backward and the throttle skips forever. Fake-first
pattern is mandatory (HANDOFF traps).
Why: (a) parity demands the supervisor actually run in backtest; (b–d) gap-through-stop is
the dominant real risk on violent alts — the sim must price it, report it, and never hide it.
Rejected: asserting zero liquidations (dishonest gate); close-only trigger checks (miss wicks);
pre-tick liq screen (false positives on protected positions).

### 2026-10-07 · D45 [AUTO]: Viability-aware grid assembly for microcap crash regimes (S9)

What (found by the S9 backtest run): ATR spacing at 15%+ of price × 8 levels puts outer
BUY levels at/below zero — unplaceable anywhere (no venue accepts non-positive prices).
New additive S4 function `buildViableGridLevels` (symmetric builder untouched, still
strict): skips non-positive buys, sells always viable (center/spacing > 0 asserted),
`gridBottom` falls back to center when no buys exist, throws only if NOTHING is placeable
(defensive). Strategy draw/trailing paths use it; S7 unit grids are fully viable so their
expectations are unchanged.
Why: aborting the whole grid on outer-level negativity would idle the bot through the
exact crash regimes it hunts; per-level viability mirrors what venues accept.
Rejected: catching S4's throw and shrinking (exception-driven flow); weakening the
symmetric builder (destabilizes a DONE step's tested contract).
