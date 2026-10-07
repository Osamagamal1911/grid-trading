# HANDOFF.md — alphaGrid living handoff (updated end of EVERY session)

Protocol: BUILD_PROMPT.md §8. This file is state, not spec — it never overrides BUILD_PROMPT.md.

---

## Session 1 — 2026-10-07 · muse-spark-1.3-free (OpenCode) · bootstrap session

### Completed this session

- Read the full build prompt (spec) + inspected upstream OpenTrader `dev` (@ `8b8e245`)
  read-only in `/tmp/opencode/opentrader` (templates, BotTemplate/TBotContext types,
  `IPlaceStopOrderRequest`, `IExchange`, `bot-control.ts`, indicators, tools/grid,
  backtesting `MemoryExchange`, credential flow). No upstream files modified.
- Created long-lived branch `feature/alphaGrid` (from `master` @ `6ac8203`).
- Wrote bootstrap docs (this session, before any strategy code per §8.5):
  - `BUILD_PROMPT.md` — spec saved verbatim as source of truth.
  - `STEPS.md` — M1–M4 broken into S1…S10, each with acceptance criteria + status.
  - `DECISIONS.md` — seeded D1–D8 (spec decisions) + D9–D14 (framework conflicts verified in code).
  - `HANDOFF.md` — this file.
  - `ALPHAGRID.md` — skeleton with §6-mandated sections.
  - `.gitignore` — extended per §8.6.
- Environment note: `node`/`pnpm` NOT installed in this container — S1 toolchain setup pending.

### In progress (exact state)

- S1 partial: branch ✅, docs ~✅ (pending commit+push), upstream import ❌ (blocked on S1-Q1).
- S2 partial: docs written, not yet committed.
- Verified framework facts (see DECISIONS.md D9–D14); all `alphaGrid/*.ts` implementation: NOT STARTED.

### Next steps (concrete, ordered)

1. Human answers S1-Q1 (fork-target repo decision — asked this session).
2. Import OpenTrader `dev` tree per the answer; add `upstream` remote; `pnpm install`.
3. Install Node ~22.12 + pnpm 10.12.1; record baseline `typecheck` + `vitest` in HANDOFF.
4. Commit + push bootstrap (`alphaGrid: S1/S2 bootstrap docs + git workflow`); start S3.
5. S3 → S4 → S5 → S6 → S7 → S8 → tag `alphaGrid-m1` → S9 → tag `alphaGrid-m2` → PR (human approval).

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
- Do NOT trust `getMarketPrice().price` as mark price (D9), do NOT assume `placeStopOrder`
  supports `reduceOnly` today (D10), do NOT expect `MemoryExchange`/`PaperExchange` stops to
  work (D11/D12) — each has a planned step.
- Upstream inspection clone lives at `/tmp/opencode/opentrader` (ephemeral) — re-clone if missing.

### Commit planned

- `alphaGrid: S1/S2 bootstrap docs + git workflow` (BUILD_PROMPT/STEPS/DECISIONS/HANDOFF/
  ALPHAGRID/.gitignore on `feature/alphaGrid`), then `git push -u origin feature/alphaGrid`.
