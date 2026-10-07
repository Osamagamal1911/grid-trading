# STEPS.md — alphaGrid build plan (numbered steps with acceptance criteria)

Spec source of truth: BUILD_PROMPT.md. A step is marked done ONLY when ALL its
acceptance criteria pass. Work on ONE step at a time; do not start S(n+1) until
S(n) is done. Steps S1–S9 build toward milestones M1 (S1–S7) and M2 (S8–S9);
M3/M4 are live-ops steps executed by the human.

Milestone map: M1 = S1+S2+S3+S4+S5+S6+S7 · M2 = S8+S9 · M3 = S10 · M4 = out of scope.

---

## S1 — Repo setup + git workflow + toolchain

Scope: fork/import OpenTrader `dev` code, remotes (`origin` = human fork, `upstream` =
Open-Trader/opentrader), long-lived branch `feature/alphaGrid`, `.gitignore` secrets coverage,
living docs skeleton (this file + BUILD_PROMPT.md). Install Node ~22.12 + pnpm 10.12.1.

Acceptance criteria:

- [ ] `git remote -v` shows `origin` = human fork and `upstream` = Open-Trader/opentrader.
- [ ] All work is on `feature/alphaGrid`; nothing committed to `dev`/`main`/`master`.
- [ ] `.gitignore` covers: `exchanges.json5`, `.env`, `*.sqlite*`, `klines/`, `*.log`,
      `*.key`, `*.pem`, `node_modules/`, build artifacts.
- [ ] `pnpm install` completes; `moon run :typecheck` (or `pnpm typecheck`) passes on the
      untouched upstream tree; baseline `vitest` run recorded in HANDOFF.md.
- [ ] Branch pushed to `origin` (`git push -u origin feature/alphaGrid`).

Status: DONE (branch ✅, docs ✅, upstream import ✅ `90f601c2`, remotes ✅, Node 22.12.0 +
pnpm 10.12.1 user-local ✅, `pnpm install` ✅, baseline recorded ✅ — all 13 `packages/*`
typecheck green, `tools:test` 75/75, `indicators:test` 15/15; only pre-existing `app/` 4-error
failure remains, out of scope — see DECISIONS.md D17/D18).

## S2 — Bootstrap docs (DECISIONS.md, HANDOFF.md, ALPHAGRID.md skeleton)

Scope: seed DECISIONS.md with spec-recorded design decisions + framework conflicts found
during code inspection; initial HANDOFF.md; ALPHAGRID.md skeleton. No strategy code.

Acceptance criteria:

- [ ] DECISIONS.md contains: unrealized-only stop, local PnL computation, mark-price triggers,
      env-based keys, every-feature-a-toggle, plus each §8.6/§4 conflict vs framework reality.
- [ ] HANDOFF.md contains: date, session id, completed/in-progress/next/blockers, traps.
- [ ] ALPHAGRID.md skeleton exists with the §6-mandated sections (even if TBD).
- [ ] No `.ts` strategy code added or changed in this step.

Status: DONE (criteria verifiably met; status corrected from stale IN PROGRESS — see DECISIONS.md D21).

## S3 — Safe credentials (env-based keys, M1)

Scope: replace upstream plaintext credential storage (`exchanges.sample.json5` /
`IExchangeCredentials` file+DB flow) with env-var loading (`BINANCE_API_KEY`,
`BINANCE_API_SECRET`). Trading-permission-only assumption documented; testnet/paper default.

Acceptance criteria:

- [ ] Exchange credentials load from `BINANCE_API_KEY` / `BINANCE_API_SECRET` env vars;
      no new code path reads a secret from DB/file.
- [ ] `grep -rni "apiKey\|secretKey\|BINANCE_API" --include="*.ts" packages/` shows no secret
      written to DB/files/logs; sample configs contain placeholders only.
- [ ] Default exchange configuration is testnet/paper; no live-trading path is the default.
- [ ] Existing test suite still green; new unit test covers env-loading (incl. missing-var error).

Status: DONE (env loader `packages/exchanges/src/env-credentials.ts` + 18 unit tests green;
`ExchangeProvider.fromEnv()` + env-wins substitution in `fromAccount` (in-memory only);
CLI sync + `exchanges add/update` store BLANK secrets when env present; debug logs redacted;
defaults testnet/paper; testnet read-only verified (futures balance via env path ✅);
grep audit recorded in HANDOFF; app typecheck still exactly the 4 pre-existing errors —
see DECISIONS.md D19/D20/D23).

## S4 — Core math module + unit tests (M1, §4.2)

Scope: single source of truth module for `marginUsed`, `unrealizedROI%`, `tpPrice`
(LONG/SHORT), `slPrice` (LONG/SHORT), ATR-spacing and buy/sell level generation, with
tickSize/stepSize rounding from market data (never hardcoded decimals). Used later by
live AND backtest.

Acceptance criteria:

- [ ] Formulas match §4.2 exactly, incl. SHORT-side sign correctness
      (`signedQty < 0` yields correct profit/loss sign).
- [ ] Unit tests: LONG TP/SL, SHORT TP/SL, ROI sign on both sides, averaging across fills,
      rounding to tick/step sizes, zero/edge inputs. All green.
- [ ] Module has docstring header (what/why/key formulas). No `exchange.ccxt` usage.

Status: TODO.

## S5 — Settings schema + template registration (M1, §4.1/§4.1b)

Scope: zod schema with all §4.1 fields/defaults/validation rules
(manual prices iff `gridMode="manual"`; `stopLossPct` iff `useStopLoss`; `tpPct` iff
`useTakeProfit`); `displayName = "Alpha Grid"`, `hidden = false`; `runPolicy = { onInterval: true }`,
`interval = pollIntervalMs`; registration in `bot-templates` index so the dashboard lists it.

Acceptance criteria:

- [ ] alphaGrid appears in the dashboard strategy list with the full auto-generated settings form.
- [ ] Validation rules enforced by the schema (negative tests for each rule).
- [ ] `direction × gridMode × all toggles` matrix: every combination constructs without error;
      at least one unit test per combination (M1 requirement from §4.1b).
- [ ] `useStopLoss=false` surfaces the no-stop-loss warning path (log + state flag the UI can render).
- [ ] Existing templates (grid, grid-bot, dca, rsi) untouched.

Status: TODO.

## S6 — ATR indicator (M1, §4.1/§4.2)

Scope: implement ATR(14) in `packages/indicators` (Wilder's smoothing) + timeframe candle
aggregation hookup for `atrTimeframe`; unit tests vs hand-computed values.

Acceptance criteria:

- [ ] `ATR(14)` matches reference values on a fixture series (tolerance documented).
- [ ] Works through the strategy's candle subscription for `atrTimeframe` (default `1h`).
- [ ] `levelSpacing = atrMultiplier × ATR` wired into grid construction; manual mode bypasses ATR.

Status: TODO.

## S7 — Strategy core: state machine + trailing + TP sync (M1, §4.3)

Scope: FLAT → arm sides per `direction` → first-fill sets direction (auto) + cancel opposite →
average-in (≤ nLevels fills) → recompute `avgEntry` after EVERY fill → re-sync ONE reduceOnly TP
order → trailing redraw (pump-capture) when `useTrailing` → TP-filled closes cycle → manual stop
path. Local fill tracking (`fills[]`, `avgEntry`, `totalQty`) only; ONLY `IExchange` methods used,
never `exchange.ccxt`.

Acceptance criteria:

- [ ] Unit tests (mock IExchange): first-fill direction lock, opposite-side cancel, averaging math,
      TP re-sync after each fill (idempotent, no churn), trailing shift up (LONG) / down (SHORT),
      `useTrailing=false` idles out-of-range, `useTakeProfit=false` ends cycles only via stop/manual,
      one-position-cycle invariant.
- [ ] Leverage from settings is actually sent/applied on the exchange (dkalenov lesson (b));
      test asserts the call, not just a log line.
- [ ] Full test suite green.

Status: TODO.

## S8 — Two-layer unrealized stop (M1+M3, §4.4)

Scope: Layer 1 — cancel + re-place exchange-side stop after every fill
(`reduceOnly: true`, mark-price trigger basis, `stopOrderType` market default with
`slPrice×(1∓0.02)` limit offset); Layer 2 — supervisor poll every `pollIntervalMs`
recomputes local `unrealizedROI%`, force-closes (cancel all → market-close reduceOnly →
`control.stop()` + alert) when `≤ −stopLossPct`, re-syncs drifted TP/SL orders.

Acceptance criteria:

- [ ] Framework gap closed: `IPlaceStopOrderRequest` extended (or params plumbed) with
      `reduceOnly` + mark-price trigger; CCXT `createStopOrder` extras pass them through
      (smallest viable adjustment, documented in DECISIONS.md).
- [ ] Tests: stop re-placed after each fill from CURRENT avgEntry; never a deploy-time fixed price;
      supervisor force-close triggers on unrealized ROI only (a passing test proves realized/total
      PnL alone never triggers it); `useStopLoss=true + useExchangeStopOrder=false` leaves Layer 1
      off and Layer 2 active.
- [ ] Paper-trading limitation documented: upstream `PaperExchange.placeStopOrder` throws
      ("not supported") — Layer 2 is the only protection in paper; M3 kill-test runs on
      Binance testnet (real exchange adapter), not the paper simulator.

Status: TODO.

## S9 — Backtest parity + AKEUSDT report (M2, §4.5)

Scope: `MemoryExchange` simulated stop fills (candle low/high range-crossing of `slPrice`,
mark-price approximation, commission + slippage); honesty metrics (total return, max drawdown,
win rate, cycles, liquidations); run AKEUSDT 1h with
`stopLossPct=40, leverage=1, nLevels=8, atrMultiplier=0.5`; write report.

Acceptance criteria:

- [ ] Backtest runs alphaGrid end-to-end on AKEUSDT 1h candles with the exact M2 settings.
- [ ] Report records: total return %, max drawdown %, win rate, cycles, stop-outs, fees paid.
- [ ] Sanity checks pass: every stop-out shows unrealized ROI ≈ −40% at trigger; no stop
      triggered on total-PnL (asserted in code, not eyeballed).
- [ ] Strategy code path identical in live/paper/backtest (local fills + mark price; no `ccxt` in logic).
- [ ] Tag `alphaGrid-m1` (on S8 green) and `alphaGrid-m2` (on S9 green); PR
      `feature/alphaGrid → dev` inside the human's fork opened only after human approval.

Status: TODO.

## S10 — Paper/testnet operation (M3, human-executed)

Scope: deploy alphaGrid on Binance testnet, 48h+ soak, dashboard shows live
realized/unrealized per bot; kill-process mid-position stop-survival test.

Acceptance criteria:

- [ ] 48h+ run on Binance testnet with dashboard live realized/unrealized visible.
- [ ] Local process killed mid-position → exchange-side stop order still present on testnet.
- [ ] Findings appended to ALPHAGRID.md (recommended settings per volatility regime).

Status: TODO (out of scope for build sessions; human runs it).

---

## Change log (append; check off criteria in place, never rewrite history)

- 2026-10-07: S1/S2 bootstrapped (first session, muse-spark). S1 partial: branch created, docs
  in progress; upstream import blocked on S1-Q1 (fork target repo decision).
- 2026-10-07: S1-Q1 answered (import into grid-trading, D15); upstream `dev` @ `8b8e245` merged
  (`90f601c2`); S2 done (`6f36c1d`). S1 remaining: toolchain + baseline test runs.
- 2026-10-07: S1 DONE (session 2, muse-spark). Toolchain: user-local Node v22.12.0 + pnpm 10.12.1
  (D17). Baseline on untouched tree: `pnpm install` ✅; direct `tsc --noEmit` green in all 13
  `packages/*` (incl. `db` — earlier `order.entity` errors were a missing-`/dts` cascade);
  `app:typecheck` 4 pre-existing errors (out of scope); `tools:test` 75/75, `indicators:test`
  15/15, `bot-templates:test` no files (expected). Full detail: DECISIONS.md D18.
- 2026-10-07: S2 DONE + S3 DONE (session 3, muse-spark). S3: env-first credential layer
  (D19–D20, D23); `exchanges:test` 18/18, `tools:test` 75/75, `indicators:test` 15/15;
  `exchanges` typecheck clean; `app` still exactly the 4 pre-existing errors. Project initialized:
  local `.env` (gitignored) + `prisma:migrate` ✅ (dev.db seeded). Testnet read-only verified:
  futures balance via S3 env path ✅ (spot-vision -2015 expected — futures-testnet keys).
