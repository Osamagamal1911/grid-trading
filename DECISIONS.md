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
