# ALPHAGRID.md — alphaGrid user documentation (living doc, §6 deliverable)

> Status: SKELETON (bootstrap session 2026-10-07). Sections fill in as S3–S10 land.
> Spec source of truth: BUILD_PROMPT.md. Assumptions list lives at the bottom.

## 1. What alphaGrid is

(TBD — one paragraph: Binance USD-M futures grid with unrealized-PnL stop, ATR spacing,
pump-capture trailing. Filled in S5/S7.)

## 2. How it works

### 2.1 Grid construction (ATR vs manual)

(TBD — S6/S7.)

### 2.2 Direction modes (long / short / auto + first-fill lock)

(TBD — S7.)

### 2.3 Position averaging + single TP for the whole position

(TBD — S7.)

### 2.4 Trailing / pump-capture mode

(TBD — S7. Include LOBSTERUSDT 2026-10-07 reference setup.)

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

- Keys from `BINANCE_API_KEY` / `BINANCE_API_SECRET` env vars only; never in DB/files/logs. (S3.)
- Trading-permission-only API key; withdrawals DISABLED; IP whitelist; sub-account recommended.
- Testnet/paper is the default; live requires explicit human approval. (S10/M4 out of scope.)
- Every closing order is `reduceOnly`; one-way position mode; isolated margin recommended.

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
