/**
 * alphaGrid S3 — env-based Binance credentials (single source of truth for secrets).
 *
 * What: resolves Binance USD-M Futures credentials EXCLUSIVELY from environment
 * variables. This module never reads secrets from DB/files and never logs them.
 * See BUILD_PROMPT.md §3 (safety constraints) and DECISIONS.md D5/D19/D20/D23.
 *
 * Contract:
 * - `BINANCE_API_KEY` / `BINANCE_API_SECRET` — required, unless paper mode.
 * - `BINANCE_TESTNET` — default "true" (Binance testnet via `setSandboxMode`).
 *   Explicit "false" opts into LIVE trading (human decision only, M4).
 * - `BINANCE_PAPER` — default "false". "true" selects the local `PaperExchange`
 *   simulator; no API keys required in that mode.
 * - Missing required vars throw an Error naming the VAR, never its value.
 * - `ExchangeProvider.fromAccount` substitutes these in-memory (never persisted);
 *   `redactExchangesSecrets` masks secrets for log lines.
 */

import { ExchangeCode } from "@opentrader/types";
import type { IExchangeCredentials } from "./types/index.js";

export const BINANCE_API_KEY_VAR = "BINANCE_API_KEY";
export const BINANCE_API_SECRET_VAR = "BINANCE_API_SECRET";
export const BINANCE_TESTNET_VAR = "BINANCE_TESTNET";
export const BINANCE_PAPER_VAR = "BINANCE_PAPER";

/** Minimal structural type for the env source (keeps the core pure + testable). */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse a boolean env var: unset/empty → fallback; 1/true/yes → true;
 * 0/false/no → false (case-insensitive, trimmed); anything else → fallback.
 */
export function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "") return fallback;
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return fallback;
}

/**
 * True when both Binance secret vars are present and non-blank.
 * Used as the "env wins" trigger — no secret VALUES are inspected or returned.
 */
export function hasEnvCredentials(env: EnvSource = process.env): boolean {
  const apiKey = env[BINANCE_API_KEY_VAR]?.trim() ?? "";
  const secretKey = env[BINANCE_API_SECRET_VAR]?.trim() ?? "";
  return apiKey !== "" && secretKey !== "";
}

/**
 * Load Binance credentials from the environment.
 * Testnet (sandbox) is the default; paper mode needs no keys.
 * @throws Error naming the missing VAR (never its value) when required vars are absent.
 */
export function loadEnvCredentials(env: EnvSource = process.env): IExchangeCredentials {
  const isPaperAccount = parseEnvBool(env[BINANCE_PAPER_VAR], false);
  const apiKey = env[BINANCE_API_KEY_VAR]?.trim() ?? "";
  const secretKey = env[BINANCE_API_SECRET_VAR]?.trim() ?? "";

  if (!isPaperAccount && apiKey === "") {
    throw new Error(
      `Missing required environment variable ${BINANCE_API_KEY_VAR}. ` +
        `Binance credentials must come from env vars, never from files/DB. ` +
        `Local testnet flow: export ${BINANCE_API_KEY_VAR} / ${BINANCE_API_SECRET_VAR} per shell.`,
    );
  }
  if (!isPaperAccount && secretKey === "") {
    throw new Error(
      `Missing required environment variable ${BINANCE_API_SECRET_VAR}. ` +
        `Binance credentials must come from env vars, never from files/DB. ` +
        `Local testnet flow: export ${BINANCE_API_KEY_VAR} / ${BINANCE_API_SECRET_VAR} per shell.`,
    );
  }

  return {
    code: ExchangeCode.BINANCE,
    apiKey,
    secretKey,
    password: "",
    isDemoAccount: parseEnvBool(env[BINANCE_TESTNET_VAR], true),
    isPaperAccount,
  };
}

type SecretCarrier = {
  apiKey?: unknown;
  secretKey?: unknown;
  password?: unknown;
};

const REDACTED = "***REDACTED***";

/**
 * Return a copy of one config entry with secret fields masked (for log lines).
 * Pure: never mutates the input, never logs.
 */
export function redactSecrets<T extends SecretCarrier>(entry: T): T {
  return {
    ...entry,
    apiKey: REDACTED,
    secretKey: REDACTED,
    password: REDACTED,
  };
}

/**
 * Return a copy of an exchanges-config record with every entry's secrets masked.
 * Use for `logger.debug(exchangesConfig, …)`-style lines so secret VALUES never
 * reach stdout/log files even when debug logging is enabled.
 */
export function redactExchangesSecrets<TRecord extends Record<string, SecretCarrier>>(
  config: TRecord,
): TRecord {
  const redactedEntries = Object.entries(config).map(([label, entry]) => [label, redactSecrets(entry)]);
  return Object.fromEntries(redactedEntries) as TRecord;
}
