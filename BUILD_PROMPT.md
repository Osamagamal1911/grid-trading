# BUILD PROMPT — "alphaGrid": Unrealized-Stop Futures Grid Strategy (OpenTrader Fork)

This file is the source of truth for the alphaGrid build. HANDOFF.md never overrides it.
Language of code, comments, and commit messages: English.

## 1. Objective

Fork the open-source project OpenTrader (https://github.com/Open-Trader/opentrader, default branch dev)
and add a new grid trading strategy template called alphaGrid with these differentiating features:

- Works on Binance USD-M Futures (long / short / auto direction).
- Stop-loss triggers on unrealized PnL only (NOT on total PnL like Binance's in-platform bots).
- Two-layer stop protection: a pre-placed exchange-side stop order (primary) + a 3-second supervisor poll (backup).
- Grid spacing adaptive to volatility (ATR) with a manual fixed-range override.
- Fully manageable from OpenTrader's existing dashboard (deploy form auto-generated from the settings schema) and
  fully backtestable in OpenTrader's built-in backtester.
- Target user hunts high-volatility Binance Alpha / futures-only altcoins (e.g. AKEUSDT, AINUSDT, BTWUSDT):
  violent pumps followed by long bleeds. Position sizes are small per coin; capital preservation matters more than
  maximizing win rate.
- Validated user setup (2026-10-07, LOBSTERUSDT): trailing long grid, 10x isolated, 6 grids turned $10.60
  margin into +$5.56 (+52.46%) in ~8h by riding a pump to the top of the range — only 5 matched trades, i.e. the
  profit came from the leveraged directional move + trailing, NOT from grid oscillation. The system must therefore
  support pump-capture mode: trailing grids that follow sustained moves, with the unrealized stop as the safety
  net when the coin dumps instead of pumping.

## 2. Reference material (read before coding)

OpenTrader repo, branch dev — especially:

- `packages/bot-templates/src/templates/grid-bot.ts` + `grid.ts` (existing grid templates)
- `packages/bot-processor/src/types/bot/bot-template.type.ts` (BotTemplate interface: runPolicy, watchers,
  interval, zod schema, displayName, hidden)
- `packages/bot-processor/src/types/bot/bot-context.type.ts` (TBotContext: exchange, control, config, state)
- `packages/bot-processor/src/bot-control.ts` (control.stop(), smart-trade helpers)
- `packages/types/src/exchange/trade/place-stop-order.ts` (IPlaceStopOrderRequest: type: "limit" | "market",
  stopPrice, price?, side, quantity, reduceOnly-capable)
- `packages/exchanges/src/types/exchange.interface.ts` (IExchange — use ONLY these methods in strategy code)
- `packages/backtesting/src/` (MarketSimulator, MemoryExchange — backtest replays candles through a
  simulated exchange)
- `packages/indicators/src/` (indicators package — ATR must come from here)
- `packages/tools/src/grid/` (calcGridLines, computeGridLevelsFromCurrentAssetPrice — reuse where sensible)

Strategy logic reference (mechanics to mirror, NOT to copy-paste):

- https://github.com/dkalenov/trading_strategies → grid_trading_binance_futures/
  (direction-by-first-fill, averaging, single ROI-based TP for the whole position, ROI-based stop-loss).

Binance USD-M Futures docs (via CCXT): stop orders trigger on mark price; use reduceOnly on exit orders;
assume one-way position mode.

## 3. NON-NEGOTIABLE SAFETY CONSTRAINTS

- Never write, log, or commit API keys/secrets. API credentials must be read from environment variables
  (BINANCE_API_KEY, BINANCE_API_SECRET) — do NOT store them in plaintext in the DB/file as the upstream
  project does. If you touch upstream credential storage, replace it with env-based loading.
- The strategy must assume the API key has trading permission only, withdrawals DISABLED.
- Default to testnet / paper trading. No live-trading code path may be the default.
- Every order that closes a position MUST be reduceOnly.
- Stop/TP trigger basis must be mark price, never last price (protection against wick hunts).
- One position cycle at a time per symbol. Isolated margin recommended; document it.

## 4. Strategy specification — alphaGrid

### 4.1 Settings schema (zod — this auto-generates the dashboard deploy form)

| Setting | Type | Default | Description |
|---|---|---|---|
| symbol | string | "AKEUSDT" | Futures symbol |
| direction | enum | "auto" | "long" / "short" / "auto" (first fill decides per cycle) |
| gridMode | enum | "atr" | "atr" (auto) / "manual" (fixed range) |
| manualHighPrice / manualLowPrice | number? | — | Required when gridMode="manual" |
| nLevels | int | 8 | Grid levels per side |
| atrMultiplier | number | 0.5 | Level spacing = atrMultiplier × ATR(14) |
| atrTimeframe | string | "1h" | Timeframe for ATR |
| volumePerLevel | number | — (required) | Base-asset quantity per grid level |
| tpPct | number | 3.0 | Take-profit, % ROI on margin used |
| stopLossPct | number | 40.0 | Stop-loss, % ROI loss on margin used, computed on UNREALIZED PnL only |
| stopOrderType | enum | "market" | "market" (recommended) / "limit" |
| leverage | int | 1 | Futures leverage (recommend 1–3) |
| pollIntervalMs | int | 3000 | Supervisor poll interval |
| useTrailing | bool | true | Pump-capture: in LONG mode, when mark price exceeds grid top, shift the whole grid up by trailingShiftLevels and redraw; mirrored for SHORT |
| trailingShiftLevels | int | 2 | Grid levels to shift on each trailing step (used only if useTrailing=true) |
| useTakeProfit | bool | true | Maintain the ROI-based TP order for the whole position |
| useStopLoss | bool | true | Enable the unrealized-PnL stop-loss (both layers below) |
| useExchangeStopOrder | bool | true | Layer 1: pre-placed exchange-side stop order (used only if useStopLoss=true) |

#### 4.1b Feature toggles — interaction matrix (every feature independently on/off)

- useTrailing=false → classic fixed grid; price leaving the range idles the bot (no shifting).
- useTakeProfit=false → no TP order; a cycle ends only via stop-loss, trailing-stop, or manual stop
  ("ride the trend" mode — higher risk, document it).
- useStopLoss=false → no stop orders at all and the supervisor never force-closes; the poll still
  updates the dashboard. The UI must show a clear warning when the bot runs with no stop-loss.
- useStopLoss=true, useExchangeStopOrder=false → Layer 1 off; the 3-second supervisor poll is the
  only protection (useful when the exchange doesn't support the needed stop order type).
- direction × gridMode × all toggles must compose without errors; each combination must be covered by
  at least one unit test in M1.
- Validation rules: manualHighPrice/manualLowPrice required iff gridMode="manual";
  stopLossPct required iff useStopLoss=true; tpPct required iff useTakeProfit=true.
- displayName = "Alpha Grid", hidden = false (must appear in the dashboard strategy list).

### 4.2 Core math (single source of truth — one module, used by live AND backtest)

```text
// marginUsed      = |avgEntry × totalQty| / leverage
// unrealizedROI%  = (markPrice − avgEntry) × signedQty / marginUsed × 100
//                   (positive = profit; for SHORT, signedQty < 0 so the formula still works)
// tpPrice   LONG  = avgEntry + avgEntry × tpPct / (100 × leverage)
// tpPrice   SHORT = avgEntry − avgEntry × tpPct / (100 × leverage)
// slPrice   LONG  = avgEntry − avgEntry × stopLossPct / (100 × leverage)
// slPrice   SHORT = avgEntry + avgEntry × stopLossPct / (100 × leverage)
// levelSpacing    = atrMultiplier × ATR(14, atrTimeframe)   [atr mode]
// buyLevel[i]    = centerPrice × (1 − i × spacingPct/100),  i = 1..nLevels
// sellLevel[i]   = centerPrice × (1 + i × spacingPct/100),  i = 1..nLevels
```

Round all prices/quantities to the symbol's real tickSize/stepSize (from exchange info / CCXT market data),
never to a hardcoded decimal count.

### 4.3 State machine

```text
FLAT
 ├─ draw grid: nLevels buy-limits below + nLevels sell-limits above centerPrice
 ├─ (direction=long: only buy side armed; short: only sell side armed; auto: both armed)
 │
 ├─ first fill sets direction (auto mode); cancel the opposite side's resting orders immediately
 ├─ keep same-side orders live → position averages in (up to nLevels fills)
 ├─ after EVERY fill: recompute avgEntry, re-sync ONE TP order for the whole position (reduceOnly),
 │   recompute slPrice from the CURRENT avgEntry and re-place the exchange-side stop order
 │
 ├─ trailing (pump-capture, only if `useTrailing=true`): if direction=LONG and markPrice > gridTop → cancel all resting orders,
 │   shift grid up by trailingShiftLevels, redraw around new center (keeps riding the pump instead of idling
 │   at the top); mirrored for SHORT when markPrice < gridBottom
 ├─ TP filled  → close cycle → back to FLAT → redraw grid around current price
 ├─ SL hit     → cancel all orders, close remainder if any, STOP the bot (control.stop()), alert
 └─ manual stop → cancel all, close position, stop
```

### 4.4 The two-layer unrealized stop (the key feature)

Layer 1 — exchange-side (primary protection, survives our server dying):

- After every fill (and on position open), compute slPrice from §4.2.
- Cancel the previous stop order, place a new one: `placeStopOrder({ type: stopOrderType, side: opposite of
  position, quantity: full position size, stopPrice: slPrice, price: stopOrderType==="limit" ? slPrice×(1∓0.02)
  : undefined, reduceOnly: true })`, trigger basis = mark price.
- Recommend stopOrderType="market" in docs: a stop-limit can fail to fill in a gap — exactly when you need it.

Layer 2 — supervisor poll (backup + dashboard freshness):

- runPolicy = { onInterval: true }, interval = pollIntervalMs (default 3000).
- Each tick: recompute unrealizedROI% locally from tracked fills (see §4.5); if ≤ −stopLossPct:
  cancel all orders → market-close remainder (reduceOnly) → control.stop() → log + alert.
- The poll also re-syncs TP/SL orders if they drift from the computed values (idempotent, no churn).

Precedent — dkalenov's own fix (2026-10-07, candle_pattern_strategy, Bybit): the author just
shipped exactly this Layer-1 pattern: SL+TP are pushed to Bybit's /v5/position/trading-stop endpoint
immediately after each entry fills, so the exchange enforces them even if the bot process dies. His own
admission is the reason this section exists: previously the live bot closed positions only on the next
opposite signal while ~99.7% of backtest trades closed via SL/TP — "the live bot's actual behavior had
essentially nothing in common with what was backtested." Two lessons baked into this spec:
(a) every risk control the backtest assumes (stops, TP) MUST be registered on the exchange in live code,
not just simulated in backtest (§4.5 parity); (b) verify leverage is actually sent to the exchange —
dkalenov's bot previously only printed --leverage and never applied it, so accounts silently kept
whatever leverage was configured manually. Note: this fix is in his candle-pattern strategy; his
grid_trading_binance_futures reference (the logic we mirror) still uses poll-based stops — our Layer 1
goes one step further than the reference.

### 4.5 Backtest parity (CRITICAL)

- The backtester uses a simulated MemoryExchange. The strategy MUST NOT call exchange.ccxt.* directly
  for position/PnL data (it will break in backtest).
- Track fills locally in bot state (fills[], avgEntry, totalQty); compute unrealizedROI% purely from
  these + the current mark price, identically in live, paper, and backtest.
- Simulated stop-order fills in backtest: fill when candle low/high crosses slPrice (use mark-price
  approximation = candle close is NOT enough; check range crossing), apply configured commission + slippage.
- Backtest must reproduce the dkalenov-style honesty: report total return, max drawdown, win rate, cycles,
  and liquidations — no cherry-picking.

### 4.6 What NOT to do

- Do NOT modify the existing grid, grid-bot, dca, rsi templates (additive change only).
- Do NOT call exchange.ccxt inside strategy logic (ok in one-off setup scripts only).
- Do NOT assume hedge mode; one-way positions only.
- Do NOT place the stop as a fixed price at deploy time and forget it — it MUST be re-synced after every fill.
- Do NOT use last-price triggers anywhere.

## 5. Milestones & acceptance criteria

- M1 — Strategy + safe credentials
  - [ ] Fork builds cleanly (pnpm install, typecheck, existing tests pass).
  - [ ] alphaGrid appears in the dashboard strategy list with the full settings form.
  - [ ] API keys load from env vars; no key/secret is written to DB, files, or logs (verify by grep).
  - [ ] Unit tests for §4.2 math, including SHORT-side sign correctness and rounding.
- M2 — Backtest on AKEUSDT
  - [ ] opentrader backtest (or equivalent) runs alphaGrid on AKEUSDT 1h candles with
    stopLossPct=40, leverage=1, nLevels=8, atrMultiplier=0.5.
  - [ ] Report: total return %, max drawdown %, win rate, cycles, number of stop-outs, fees paid.
  - [ ] Sanity checks: every stop-out shows unrealized ≈ −40% ROI at trigger; no stop triggers on total-PnL.
- M3 — Paper/testnet
  - [ ] Runs 48h+ on Binance testnet with the dashboard showing live realized/unrealized per bot.
  - [ ] Kill the local process mid-position → the exchange-side stop order must still exist on the testnet exchange.
- M4 — Live (human decision, tiny size) — out of scope for this prompt; do not enable by default.

## 6. Deliverables

- Forked repo with the alphaGrid template + tests (M1).
- Backtest report for AKEUSDT with the M2 settings (M2).
- A short ALPHAGRID.md doc: how it works, the two-layer stop design, recommended settings per
  volatility regime, and the security model (env keys, no-withdrawal keys, IP whitelist, sub-account).
- List every assumption you had to make where the spec was ambiguous (explicit list, no silent choices).
- STEPS.md: the build broken into numbered steps (S1, S2, …), each with its own acceptance criteria.
  A step is marked done ONLY when its criteria pass.
- DECISIONS.md: append-only log — every non-trivial decision with date, what was decided, why, and
  which alternatives were rejected.
- HANDOFF.md: living handoff file, updated at the END of every AI session (see §8).

## 7. Working agreement

- Ask before any irreversible action. Testnet/paper only unless the human explicitly approves otherwise.
- If any part of this spec conflicts with the OpenTrader framework's actual behavior (verify in code, don't
  assume), report the conflict and propose the smallest viable adjustment — don't silently redesign.
- This strategy handles real money when live: optimize for correctness and auditability over cleverness.
  Boring, well-tested code wins.

## 8. Multi-AI continuity protocol (handoff between sessions/models)

### 8.1 Session start (mandatory, in this order)

1. Read BUILD_PROMPT.md (this file) — the spec is the source of truth; HANDOFF.md never overrides it.
2. Read HANDOFF.md — latest state: done, in-progress, next steps, blockers.
3. Read DECISIONS.md — do NOT re-litigate settled decisions. If you disagree, propose an alternative
   with reasoning and log it; never silently change a recorded decision.
4. Read STEPS.md — pick the next unchecked step whose dependencies are complete.
5. State your plan for THIS session (which steps, which files you'll touch). If the session is
   interactive, wait for human approval; if non-interactive, proceed with the smallest scope that
   completes the step.

### 8.2 During the session

- Work on ONE step at a time. Do not start S(n+1) until S(n)'s acceptance criteria pass.
- Every new module gets a docstring header: what it does, why it exists, key formulas it implements.
- Every assumption or judgment call → append to DECISIONS.md immediately, not at the end.
- Run the relevant tests after every change. Never end a session with the repo in a failing state —
  or document exactly what fails and why in HANDOFF.md.

### 8.3 Session end (mandatory)

Update HANDOFF.md with:

- Date + model/session identifier.
- Completed this session (files changed, tests run and their results).
- In progress: exact state — what works, what's half-done, where you stopped.
- Next steps: concrete and ordered.
- Blockers / open questions for the human.
- Anything the next AI must NOT redo, plus traps to avoid.
- Then commit: alphaGrid: <step-id> <short description>.

### 8.4 Living file inventory

| File | Purpose | Updated |
|---|---|---|
| BUILD_PROMPT.md | This spec — source of truth | Rarely (spec changes only) |
| STEPS.md | Numbered build steps + acceptance criteria | When steps are added/completed |
| DECISIONS.md | Append-only decision log | Every decision, immediately |
| HANDOFF.md | Latest session handoff | End of EVERY session |
| ALPHAGRID.md | User-facing documentation | As the strategy evolves |

### 8.5 First session bootstrap

The very first AI session must create STEPS.md (breaking M1–M4 from §5 into numbered sub-steps S1…Sn,
each with acceptance criteria), DECISIONS.md (seeded with the design decisions already recorded in this
spec: unrealized-only stop, local PnL computation, mark-price triggers, env-based keys, every-feature-a-toggle),
and an initial HANDOFF.md — before writing any strategy code.

### 8.6 Git workflow (mandatory for every session)

Setup (first session only):

- Fork Open-Trader/opentrader (branch dev) to the human's GitHub account.
- Clone the fork; add an upstream remote pointing at Open-Trader/opentrader.
- Create the long-lived feature branch feature/alphaGrid. **All work happens here — never commit
  directly to dev/main.**
- Commits:
  - Atomic: one step (or sub-step) per commit. Message format:
    `alphaGrid: <S-id> <short description>` (e.g. alphaGrid: S4 unrealized-ROI math + unit tests).
  - Every commit must keep the test suite green (or document the exact failure + why in HANDOFF.md).
  - Before every commit run git status + git diff --cached and verify NONE of these are staged:
    API keys/secrets, exchanges.json5, .env, *.key, *.pem, database files that may hold
    credentials, node_modules/, build artifacts.
  - First session must extend .gitignore to cover: exchanges.json5, .env, *.sqlite*,
    klines/, *.log.
- Syncing:
  - Start of each session: git fetch upstream; if upstream dev moved, rebase feature/alphaGrid
    onto it (default; document if you choose merge instead in DECISIONS.md). Never force-push
    except git push --force-with-lease on your own fork branch when a rebase requires it.
  - Push ONLY to origin (the human's fork). Never push to upstream.
- Milestones & review:
  - Tag each completed milestone with an annotated tag: alphaGrid-m1, alphaGrid-m2, … (one-line summary).
  - When M1 is fully green, open a PR feature/alphaGrid → dev inside the human's fork (not upstream)
    and merge only after human approval.
- End of session:
  - git push origin feature/alphaGrid (plus tags) at the end of EVERY session, so the next AI —
    possibly on another machine/model — can git pull and continue. The HANDOFF.md update from §8.3
    must be committed and pushed too. Never leave pushed work uncommitted or committed work unpushed.
