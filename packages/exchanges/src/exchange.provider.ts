/**
 * Copyright 2024 bludnic
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Repository URL: https://github.com/bludnic/opentrader
 */
import type { ExchangeAccountWithCredentials } from "@opentrader/db";
import { ExchangeCode } from "@opentrader/types";
import { exchanges } from "./exchanges/index.js";
import type { IExchange } from "./types/index.js";
import { hasEnvCredentials, loadEnvCredentials } from "./env-credentials.js";
import type { EnvSource } from "./env-credentials.js";

type ExchangeAccountId = number;

/**
 * Class for storing and sharing the same Exchange instance.
 * The main reason of using that provider is to avoid rate limits
 * of the Exchange. This is caused by recreating the same instance of
 * Exchange, ending in additional requests to `fetchMarkets()`.
 */
export class ExchangeProvider {
  /**
   * Private exchanges that requires credentials.
   */
  private privateExchanges: Partial<Record<ExchangeAccountId, IExchange>> = {};
  /**
   * Public exchanges. Allowed to access only public endpoints.
   */
  private publicExchanges: Partial<Record<ExchangeCode, IExchange>> = {};
  /**
   * Demo public exchanges.
   */
  private demoPublicExchanges: Partial<Record<ExchangeCode, IExchange>> = {};

  fromAccount(exchangeAccount: ExchangeAccountWithCredentials, env: EnvSource = process.env): IExchange {
    const { id, exchangeCode, credentials } = exchangeAccount;

    // Return cached if instance available
    const cachedExchange = this.privateExchanges[id];
    if (cachedExchange) {
      // console.log(
      //   `🔌 ExchangeProvider: Reused cached private instance of ${exchangeAccount.exchangeCode}: ${exchangeAccount.name} (#${exchangeAccount.id})`,
      // );
      return cachedExchange;
    }

    // alphaGrid S3 (D19/D20): when Binance env credentials are present they WIN
    // over stored values. Substitution is in-memory only — secrets are never
    // persisted. Env-absent behavior is byte-identical to upstream.
    // The `env` param defaults to process.env; tests inject fakes (hermetic).
    const effectiveCredentials =
      exchangeCode === ExchangeCode.BINANCE && hasEnvCredentials(env)
        ? { ...loadEnvCredentials(env), password: "" }
        : credentials;

    // Create new exchange instance
    const newExchange = exchanges[exchangeCode as ExchangeCode](
      {
        ...effectiveCredentials,
        code: effectiveCredentials.code as ExchangeCode,
        password: effectiveCredentials.password ?? "",
      },
      effectiveCredentials.isDemoAccount,
    );

    this.privateExchanges[id] = newExchange; // cache it

    // console.debug(
    //   `ExchangeProvider: Created a new private instance of ${exchangeAccount.exchangeCode}: ${exchangeAccount.name} (ID: ${exchangeAccount.id})`,
    // );

    return newExchange;
  }

  /**
   * alphaGrid S3 (D19/D20): build a Binance exchange directly from env vars
   * (`BINANCE_API_KEY` / `BINANCE_API_SECRET`, testnet by default).
   * Programmatic entry point for alphaGrid runtime, scripts, and S10 testnet runs.
   * Returns a FRESH instance on every call (no cache) — callers must reuse the
   * returned instance instead of calling this in a hot path (rate limits).
   * @throws when required env vars are missing (see `loadEnvCredentials`).
   */
  fromEnv(env: EnvSource = process.env): IExchange {
    const credentials = loadEnvCredentials(env);

    return exchanges[credentials.code](
      {
        ...credentials,
        password: credentials.password ?? "",
      },
      credentials.isDemoAccount,
    );
  }

  fromCode(exchangeCode: ExchangeCode, isDemo: boolean) {
    // Return cached if instance available
    const cachedExchange = isDemo ? this.demoPublicExchanges[exchangeCode] : this.publicExchanges[exchangeCode];
    if (cachedExchange) {
      // console.log(
      //   `🔌 ExchangeProvider: Reused cached public instance of ${exchangeCode}`,
      // );
      return cachedExchange;
    }

    // Create new exchange instance
    const newExchange = exchanges[exchangeCode](undefined, isDemo);

    if (isDemo) {
      this.demoPublicExchanges[exchangeCode] = newExchange;
    } else {
      this.publicExchanges[exchangeCode] = newExchange;
    }

    // console.debug(
    //   `ExchangeProvider: Created a new public instance of ${exchangeCode}`,
    // );

    return newExchange;
  }

  removeByAccountId(id: ExchangeAccountId) {
    const exchange = this.privateExchanges[id];
    if (!exchange) {
      console.warn(`⚠️ Unable to remove private exchange instance: No exchange found with ID "${id}".`);
      return;
    }

    void exchange.destroy();
    delete this.privateExchanges[id];

    // console.log(
    //   `ExchangeProvider: Removed private instance of ${exchange.exchangeCode} (ID: ${id})`,
    // );
  }
}

export const exchangeProvider = new ExchangeProvider();
