/**
 * alphaGrid S3 — unit tests for env-based Binance credentials.
 *
 * Covers STEPS.md S3 acceptance: env loading incl. missing-var errors, safe
 * (testnet/paper) defaults, secret redaction for logs, and the
 * `ExchangeProvider` env-wins wiring. All hermetic: explicit env fakes only,
 * no `process.env` mutation, no network (exchange constructors are offline).
 */
import { describe, expect, it } from "vitest";
import { ExchangeCode } from "@opentrader/types";
import type { ExchangeAccountWithCredentials } from "@opentrader/db";
import {
  BINANCE_API_KEY_VAR,
  BINANCE_API_SECRET_VAR,
  hasEnvCredentials,
  loadEnvCredentials,
  parseEnvBool,
  redactExchangesSecrets,
  redactSecrets,
} from "./env-credentials.js";
import type { EnvSource } from "./env-credentials.js";
import { exchangeProvider } from "./exchange.provider.js";

const TEST_KEY = "test-api-key-canary";
const TEST_SECRET = "test-secret-canary";

function testnetEnv(overrides: EnvSource = {}): EnvSource {
  return {
    [BINANCE_API_KEY_VAR]: TEST_KEY,
    [BINANCE_API_SECRET_VAR]: TEST_SECRET,
    ...overrides,
  };
}

function fakeAccount(id: number, exchangeCode: string, credentials: object) {
  return {
    id,
    exchangeCode,
    credentials,
  } as unknown as ExchangeAccountWithCredentials;
}

describe("parseEnvBool", () => {
  it("returns the fallback for unset, empty, or unrecognized values", () => {
    expect(parseEnvBool(undefined, true)).toBe(true);
    expect(parseEnvBool(undefined, false)).toBe(false);
    expect(parseEnvBool("", true)).toBe(true);
    expect(parseEnvBool("  ", false)).toBe(false);
    expect(parseEnvBool("maybe", true)).toBe(true);
    expect(parseEnvBool("maybe", false)).toBe(false);
  });

  it("parses truthy values case-insensitively", () => {
    for (const raw of ["1", "true", "TRUE", " True ", "yes", "YES"]) {
      expect(parseEnvBool(raw, false)).toBe(true);
    }
  });

  it("parses falsy values case-insensitively", () => {
    for (const raw of ["0", "false", "FALSE", " False ", "no", "NO"]) {
      expect(parseEnvBool(raw, true)).toBe(false);
    }
  });
});

describe("hasEnvCredentials", () => {
  it("is true only when both vars are present and non-blank", () => {
    expect(hasEnvCredentials(testnetEnv())).toBe(true);
    expect(hasEnvCredentials({})).toBe(false);
    expect(hasEnvCredentials({ [BINANCE_API_KEY_VAR]: TEST_KEY })).toBe(false);
    expect(hasEnvCredentials({ [BINANCE_API_SECRET_VAR]: TEST_SECRET })).toBe(false);
    expect(
      hasEnvCredentials({ [BINANCE_API_KEY_VAR]: "   ", [BINANCE_API_SECRET_VAR]: TEST_SECRET }),
    ).toBe(false);
  });
});

describe("loadEnvCredentials", () => {
  it("loads Binance credentials with safe defaults (testnet, not paper)", () => {
    const creds = loadEnvCredentials(testnetEnv());

    expect(creds.code).toBe(ExchangeCode.BINANCE);
    expect(creds.apiKey).toBe(TEST_KEY);
    expect(creds.secretKey).toBe(TEST_SECRET);
    expect(creds.password).toBe("");
    expect(creds.isDemoAccount).toBe(true); // testnet default — never live by default
    expect(creds.isPaperAccount).toBe(false);
  });

  it("trims surrounding whitespace from key and secret", () => {
    const creds = loadEnvCredentials(
      testnetEnv({ [BINANCE_API_KEY_VAR]: "  padded-key  " }),
    );

    expect(creds.apiKey).toBe("padded-key");
  });

  it("throws naming BINANCE_API_KEY when the key is missing (value never in message)", () => {
    expect(() => loadEnvCredentials({ [BINANCE_API_SECRET_VAR]: TEST_SECRET })).toThrow(
      BINANCE_API_KEY_VAR,
    );

    try {
      loadEnvCredentials({ [BINANCE_API_SECRET_VAR]: TEST_SECRET });
      expect.unreachable("must throw on missing key");
    } catch (err) {
      expect((err as Error).message).toContain(BINANCE_API_KEY_VAR);
      expect((err as Error).message).not.toContain(TEST_SECRET);
    }
  });

  it("throws naming BINANCE_API_SECRET when the secret is missing (value never in message)", () => {
    try {
      loadEnvCredentials({ [BINANCE_API_KEY_VAR]: TEST_KEY });
      expect.unreachable("must throw on missing secret");
    } catch (err) {
      expect((err as Error).message).toContain(BINANCE_API_SECRET_VAR);
      expect((err as Error).message).not.toContain(TEST_KEY);
    }
  });

  it("paper mode requires no keys (secret-free simulation)", () => {
    const creds = loadEnvCredentials({ BINANCE_PAPER: "true" });

    expect(creds.isPaperAccount).toBe(true);
    expect(creds.apiKey).toBe("");
    expect(creds.secretKey).toBe("");
  });

  it("explicit BINANCE_TESTNET=false opts into live (documented human opt-in)", () => {
    const creds = loadEnvCredentials(testnetEnv({ BINANCE_TESTNET: "false" }));

    expect(creds.isDemoAccount).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("masks secret fields, preserves the rest, and does not mutate the input", () => {
    const entry = { name: "Main", apiKey: "k", secretKey: "s", password: "p", isDemoAccount: true };
    const redacted = redactSecrets(entry);

    expect(redacted.apiKey).not.toBe("k");
    expect(redacted.secretKey).not.toBe("s");
    expect(redacted.password).not.toBe("p");
    expect(redacted.name).toBe("Main");
    expect(redacted.isDemoAccount).toBe(true);
    expect(entry.apiKey).toBe("k"); // input untouched
  });

  it("masks every entry of an exchanges-config record", () => {
    const config = {
      MAIN: { name: "Main", apiKey: "k1", secretKey: "s1", exchangeCode: "BINANCE" },
      ALT: { name: "Alt", apiKey: "k2", secretKey: "s2", exchangeCode: "BYBIT" },
    };

    const redacted = redactExchangesSecrets(config);

    expect(redacted.MAIN.apiKey).not.toBe("k1");
    expect(redacted.ALT.secretKey).not.toBe("s2");
    expect(redacted.MAIN.exchangeCode).toBe("BINANCE");
    expect(config.MAIN.apiKey).toBe("k1"); // input untouched
  });
});

describe("ExchangeProvider.fromEnv", () => {
  it("builds a Binance testnet (demo) exchange from env", () => {
    const exchange = exchangeProvider.fromEnv(testnetEnv());

    expect(exchange.exchangeCode).toBe(ExchangeCode.BINANCE);
    expect(exchange.isDemo).toBe(true);
    expect(exchange.isPaper).toBe(false);
    expect(exchange.ccxt.apiKey).toBe(TEST_KEY);
  });

  it("builds a paper exchange without keys", () => {
    const exchange = exchangeProvider.fromEnv({ BINANCE_PAPER: "true" });

    expect(exchange.isPaper).toBe(true);
  });

  it("throws on missing vars (never a half-authenticated instance)", () => {
    expect(() => exchangeProvider.fromEnv({})).toThrow(BINANCE_API_KEY_VAR);
  });
});

describe("ExchangeProvider.fromAccount env substitution", () => {
  const dbCreds = {
    code: ExchangeCode.BINANCE,
    apiKey: "db-stored-key",
    secretKey: "db-stored-secret",
    password: "",
    isDemoAccount: false,
    isPaperAccount: false,
  };

  it("env wins over stored values for Binance when env vars are present (in-memory only)", () => {
    const exchange = exchangeProvider.fromAccount(fakeAccount(9101, "BINANCE", dbCreds), testnetEnv());

    expect(exchange.ccxt.apiKey).toBe(TEST_KEY);
    expect(exchange.ccxt.apiKey).not.toBe("db-stored-key");
    expect(exchange.isDemo).toBe(true); // env default (testnet), not the stored `false`
  });

  it("falls back to stored values when env vars are absent (legacy behavior)", () => {
    const exchange = exchangeProvider.fromAccount(fakeAccount(9102, "BINANCE", dbCreds), {});

    expect(exchange.ccxt.apiKey).toBe("db-stored-key");
    expect(exchange.isDemo).toBe(false);
  });

  it("never substitutes for non-Binance accounts, even with env set", () => {
    const bybitCreds = { ...dbCreds, code: ExchangeCode.BYBIT };
    const exchange = exchangeProvider.fromAccount(fakeAccount(9103, "BYBIT", bybitCreds), testnetEnv());

    expect(exchange.exchangeCode).toBe(ExchangeCode.BYBIT);
    expect(exchange.ccxt.apiKey).toBe("db-stored-key");
  });
});
