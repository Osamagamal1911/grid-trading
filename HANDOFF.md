# HANDOFF.md — alphaGrid living handoff (updated end of EVERY session)

Protocol: BUILD_PROMPT.md §8. This file is state, not spec — it never overrides BUILD_PROMPT.md.

---

## Session 3 — 2026-10-07 · muse-spark-1.3-free (OpenCode) · S3 env credentials + testnet init/verify

### Completed this session

- S3 DONE (all 4 acceptance criteria). Env-first credential layer:
  - NEW `packages/exchanges/src/env-credentials.ts` — `loadEnvCredentials` /
    `hasEnvCredentials` / `parseEnvBool` / `redactSecrets` / `redactExchangesSecrets`
    (pure, never logs, errors name the VAR never the value).
  - `ExchangeProvider.fromEnv()` (new) + env-wins substitution in `fromAccount`
    (in-memory only; added optional `env` param for hermetic tests; absent-env = legacy).
  - `app/src/utils/bot.ts`: CLI sync stores BLANK Binance secrets when env present.
  - `app/src/api/exchanges/add.ts` + `update.ts`: same rule for the CLI write path (found via audit).
  - `app/src/api/run-trading.ts` + `stop-command.ts`: debug logs print the redacted copy.
  - `packages/exchanges/moon.yml` + `vitest.config.ts` (new): first test task/config for the package.
  - `.env.example`, `exchanges.sample.json5` (comments only), `ALPHAGRID.md` §5 (security model filled).
- NEW `packages/exchanges/src/env-credentials.test.ts` — 18 tests green (env load, missing-var
  errors, testnet/paper defaults, redaction, fromEnv/fromAccount wiring, non-Binance isolation).
- Test suite: `exchanges:test` 18/18 ✅, `tools:test` 75/75 ✅, `indicators:test` 15/15 ✅;
  `exchanges` typecheck clean; `app` still exactly the 4 pre-existing baseline errors (zero new).
- Grep audit (`apiKey|secretKey|BINANCE_API` over `packages/` + `app/src`): only 4 classes —
  (1) generated prisma zod schemas (field names, no values); (2) pre-existing upstream
  trpc schemas/db computed field/CCXT passthrough (in-memory only, untouched — D19 limitation);
  (3) NEW S3 code (env-only reads + redaction); (4) samples = placeholders only.
  No secret VALUES in committed code. `binance-test-net`, `.env`, `dev.db` gitignored + unstaged.
- Project initialized per human request: local gitignored `.env` (secrets NOT stored in it —
  only `BINANCE_TESTNET/PAPER` toggles + source commands) → `prisma:migrate` ✅ (dev.db seeded).
- Testnet read-only verification (temp test, deleted after): `loadMarkets` ✅ + futures balance
  via the S3 env path ✅ — keys valid for Binance FUTURES testnet; NO orders placed.
  Spot-vision balance → -2015 is EXPECTED (futures-testnet keys don't cover spot; irrelevant).
- D19–D23 appended ([AUTO]); S2 marked DONE (stale status, D21); `.gitignore` covers `binance-test-net` (exact-name rule — a `*credentials*` glob was tried
  and reverted same session: it swallowed the legit `env-credentials*.ts` source files).
  Disclosure: a structure probe echoed the testnet key/secret into tool output once (D23) —
  testnet-scoped, local-only, never reproduced.
  key/secret into tool output once (D23) — testnet-scoped, local-only, never reproduced.

### Files created / modified (this session)

- Created: `packages/exchanges/src/env-credentials.ts`, `.../env-credentials.test.ts`,
  `packages/exchanges/vitest.config.ts`, `.env` (gitignored, local only).
- Modified: `packages/exchanges/src/exchange.provider.ts`, `.../src/index.ts`, `.../moon.yml`,
  `app/src/utils/bot.ts`, `app/src/api/run-trading.ts`, `app/src/api/stop-command.ts`,
  `app/src/api/exchanges/add.ts`, `app/src/api/exchanges/update.ts`,
  `.env.example`, `.gitignore`, `exchanges.sample.json5`,
  `STEPS.md`, `DECISIONS.md`, `HANDOFF.md`, `ALPHAGRID.md`.
- NEVER touched: `binance-test-net` content (read-only), existing grid/grid-bot/dca/rsi templates.

### In progress (exact state)

- S3 DONE, about to commit + push (see below). No strategy code yet (correct — S4 is next).
- Local testnet shell setup for the human/next AI (per shell, values stay local):
  `export BINANCE_API_KEY="$(sed -n 's/^key: //p' binance-test-net)"` and same for
  `BINANCE_API_SECRET`. Needs re-export in every new shell (or direnv, human's choice).

### Next steps (concrete, ordered)

1. Commit `alphaGrid: S3 env-based credentials + testnet init/verify`, push `origin/feature/alphaGrid`.
2. Start S4 (core math module + unit tests, §4.2) — pure, no exchange needed.
3. Then S5 → S6 → S7 → S8 → tag `alphaGrid-m1` → S9 → tag `alphaGrid-m2` → PR (human approval).

### Blockers / open questions for the human

- None for S4–S9 (all offline/testable without keys). For S10: futures-testnet keys verified
  for reads; first testnet ORDER will confirm trading permission then — if it fails with -2015,
  enable futures + IP-whitelist this machine on the testnet portal (or mint fresh futures keys).
- Residual upstream limitation (D19, also in ALPHAGRID.md §5): dashboard-created accounts still
  store plaintext by upstream design. Proposal after M2: secret-free dashboard accounts. No action now.

### What the next AI must NOT redo / traps to avoid

- Do NOT re-verify testnet with new scratch files unless keys change — result recorded above.
- Do NOT "fix" the spot-vision -2015 — expected, out of scope (futures-only strategy).
- Do NOT add secrets to `.env`/samples/docs — env exports only; check `git status` + staged diff
  for `binance-test-net`/`.env`/`dev.db` before EVERY commit (all must stay untracked/ignored).
- `tsc --build packages/exchanges` (or full `tsc --build`) is REQUIRED after changing
  `packages/*` before `app` typecheck sees new exports (project-reference `/dts` staleness).
- All Sessions-1/2 traps still apply (no `master` commits, no rebase across import merge,
  moon serves cached failures — re-verify with direct `tsc`).

### Commit

- `alphaGrid: S3 env-based credentials + testnet init/verify`, then `git push origin feature/alphaGrid`.

---

## Session 2 — 2026-10-07 · muse-spark-1.3-free (OpenCode) · S1 toolchain + baseline

### Completed this session

- Installed toolchain user-local (no sudo): Node v22.12.0 (`~/.local/node-v22`, ARM64 tarball)
  + pnpm 10.12.1; restored moon 1.37.2 binary via direct postinstall run (see D17 for why
  `approve-builds` couldn't be used non-interactively). `export PATH="$HOME/.local/node-v22/bin:$PATH"`
  required in every new shell on this machine.
- `pnpm install` ✅ (~18s, prisma generate ok).
- Baseline on untouched tree: direct `tsc --noEmit` green in ALL 13 `packages/*`
  (types/tools/indicators/bot-templates/bot-processor/backtesting/exchanges/db/event-bus/logger/bot/trpc/prisma).
  `app:typecheck` = 4 pre-existing errors (cli import-attributes, trpc transformer ×2, logger overload).
  `tools:test` 75/75 (20 files), `indicators:test` 15/15, `bot-templates:test` no files (expected).
- S1 marked DONE in STEPS.md (with the `app/` caveat); D17+D18 appended to DECISIONS.md.
- Key correction this session: the scary first `moon run :typecheck` failure (incl. fake `db`
  generic errors) was just missing `/dts` composite artifacts — `tsc --build` then per-package
  `tsc --noEmit` is the true baseline. Moon also serves stale CACHED failure output; always
  re-verify with direct `tsc` (D18).

### In progress (exact state)

- S1 DONE, committed + pushed (see commit below). No strategy code written (correct per §8.5 — S1/S2 are docs+setup).
- S3 (env credentials) is next. NOT STARTED.

### Next steps (concrete, ordered)

1. `git pull` on `feature/alphaGrid` (this session's commit is pushed).
2. Start S3: env-based `BINANCE_API_KEY`/`BINANCE_API_SECRET` loading; grep-audit; testnet/paper default; unit test for missing-var error.
3. Then S4 → S5 → S6 → S7 → S8 → tag `alphaGrid-m1` → S9 → tag `alphaGrid-m2` → PR (human approval).

### Blockers / open questions for the human

- None blocking. Note: toolchain lives in `~/.local/` on THIS machine only — if the next session
  runs elsewhere, reinstall Node 22.12 + pnpm 10.12.1 first (one-liners in D17).

### What the next AI must NOT redo / traps to avoid

- Do NOT "fix" `app/` type errors or `db` — `db` is green; `app` failures are pre-existing/out of scope.
- Do NOT trust `moon run :typecheck` red output at face value — build `/dts` first (`tsc --build`),
  then verify per-package with direct `tsc --noEmit`; moon caches failures.
- Do NOT run `pnpm approve-builds` expecting piped input to work — use the direct postinstall recipe in D17.
- All Session-1 traps still apply (no `master` commits, no secret staging, no rebase across import merge).

### Commit planned

- `alphaGrid: S1 toolchain + baseline typecheck/vitest` (STEPS/DECISIONS/HANDOFF only), then
  `git push origin feature/alphaGrid`.

---

## Session 1 — 2026-10-07 · muse-spark-1.3-free (OpenCode) · bootstrap session

### Completed this session

- (all previous items stand; branch pushed to `origin` as `feature/alphaGrid` ✅)
- Fixed GitHub email-privacy push rejection: repo-local noreply identity + rebuilt the 3 local
  commits via `commit-tree` (trees byte-identical, verified). See DECISIONS.md D16.

- Read the full build prompt (spec) + inspected upstream OpenTrader `dev` (@ `8b8e245`)
  read-only in `/tmp/opencode/opentrader` (templates, BotTemplate/TBotContext types,
  `IPlaceStopOrderRequest`, `IExchange`, `bot-control.ts`, indicators, tools/grid,
  backtesting `MemoryExchange`, credential flow). No upstream files modified.
- Created long-lived branch `feature/alphaGrid` (from `master` @ `6ac8203`).
- S1-Q1 ANSWERED: human chose "import tree into grid-trading" (DECISIONS.md D15).
- Merged `upstream/dev` @ `8b8e245` with `--allow-unrelated-histories` (commit `90f601c2`):
  conflicts only in `README.md` (→ upstream) and `.gitignore` (→ union of upstream +
  alphaGrid secrets coverage). Staged-tree secret scan: only `*.sample.json5` placeholders;
  `packages/prisma/.env` is an upstream-tracked symlink to `../../.env` (no secret content);
  no root `.env` exists. Remotes: `origin` = Osamagamal1911/grid-trading,
  `upstream` = Open-Trader/opentrader.
- Environment note: `node`/`pnpm` NOT installed in this container — S1 toolchain setup pending,
  so `pnpm install` / typecheck / baseline vitest could NOT run yet (deferred, not skipped).
- Wrote bootstrap docs (this session, before any strategy code per §8.5):
  - `BUILD_PROMPT.md` — spec saved verbatim as source of truth.
  - `STEPS.md` — M1–M4 broken into S1…S10, each with acceptance criteria + status.
  - `DECISIONS.md` — seeded D1–D8 (spec decisions) + D9–D14 (framework conflicts verified in code).
  - `HANDOFF.md` — this file.
  - `ALPHAGRID.md` — skeleton with §6-mandated sections.
  - `.gitignore` — extended per §8.6.
- Environment note: `node`/`pnpm` NOT installed in this container — S1 toolchain setup pending.

### In progress (exact state)

- S1 mostly done: branch ✅, docs ✅ committed, upstream import ✅ merged, remotes ✅.
  REMAINING for S1: Node ~22.12 + pnpm 10.12.1 install, `pnpm install`, baseline typecheck +
  vitest recorded, `git push -u origin feature/alphaGrid` (pending — pushed at session end).
- S2 done (docs committed as `6f36c1d`).
- Verified framework facts (see DECISIONS.md D9–D14); all `alphaGrid/*.ts` implementation: NOT STARTED.

### Next steps (concrete, ordered)

1. Push `feature/alphaGrid` to `origin` (session end) — next AI: `git pull` and continue.
2. Provision toolchain (Node ~22.12 + pnpm 10.12.1) → `pnpm install` → record baseline
   `typecheck` + `vitest` in HANDOFF → S1 fully done.
3. Start S3 (env credentials). Then S4 → S5 → S6 → S7 → S8 → tag `alphaGrid-m1` →
   S9 → tag `alphaGrid-m2` → PR (human approval).

### Blockers / open questions for the human

- **S1-Q1 (fork target): ANSWERED 2026-10-07** — human chose "Import tree into grid-trading":
  OpenTrader `dev` merged into this repo on `feature/alphaGrid` (see DECISIONS.md D15).
  Future upstream syncs use `merge`, not rebase.
- Node/pnpm missing in container: confirm who provisions the toolchain (human on dev machine vs
  install here) before S1 acceptance can pass.

### What the next AI must NOT redo / traps to avoid

- Do NOT re-inspect upstream `dev` structure from scratch — findings are in DECISIONS.md D9–D14
  with file paths. Re-verify only if upstream `dev` moved (then `git fetch upstream` + rebase).
- Do NOT write strategy `.ts` code before S1/S2 are committed (spec §8.5 ordering).
- Do NOT commit to `master`; ALL work on `feature/alphaGrid`.
- Do NOT stage: `exchanges.json5`, `.env`, `*.key`, `*.pem`, sqlite/db files, `node_modules/`,
  build artifacts — check `git status` + `git diff --cached` before every commit.
- Git identity: repo-local noreply email is configured (D16). NEVER `rebase --rebase-merges`
  across the S1 import merge — it replays ~1500 upstream commits. For identity-only rewrites of
  OUR commits use `git commit-tree` plumbing (recipe in shell history / D16).
- Do NOT trust `getMarketPrice().price` as mark price (D9), do NOT assume `placeStopOrder`
  supports `reduceOnly` today (D10), do NOT expect `MemoryExchange`/`PaperExchange` stops to
  work (D11/D12) — each has a planned step.
- Upstream inspection clone lives at `/tmp/opencode/opentrader` (ephemeral) — re-clone if missing.

### Commit planned

- `alphaGrid: S1/S2 bootstrap docs + git workflow` (BUILD_PROMPT/STEPS/DECISIONS/HANDOFF/
  ALPHAGRID/.gitignore on `feature/alphaGrid`), then `git push -u origin feature/alphaGrid`.
