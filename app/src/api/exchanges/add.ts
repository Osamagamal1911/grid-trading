import { ExchangeCode } from "@opentrader/types";
import { hasEnvCredentials } from "@opentrader/exchanges";
import { logger } from "@opentrader/logger";
import type { CommandResult } from "../../types.js";
import { createDaemonRpcClient } from "../../daemon-rpc.js";

type Options = {
  config: string;
  /**
   * Exchange name.
   */
  name: string | null;
  /**
   * Exchange label.
   */
  label: string;
  code: ExchangeCode;
  key: string;
  secret: string;
  password: string | null;
  /**
   * Is demo account?
   */
  demo: boolean;
  /**
   * Is paper account?
   */
  paper: boolean;
};


export async function addExchangeAccount(options: Options): Promise<CommandResult> {
  const daemonRpc = createDaemonRpcClient();
  // alphaGrid S3 (D19): env wins — never persist CLI-passed Binance secrets when env vars exist.
  const useEnvSecrets = options.code === ExchangeCode.BINANCE && hasEnvCredentials();
  if (useEnvSecrets) {
    logger.info("Binance secrets provided via environment — storing metadata only, no secrets in DB.");
  }
  await daemonRpc.exchangeAccount.create.mutate({
    name: options.name || options.label,
    label: options.label,
    exchangeCode: options.code,
    apiKey: useEnvSecrets ? "" : options.key,
    secretKey: useEnvSecrets ? "" : options.secret,
    password: useEnvSecrets ? "" : options.password,
    isDemoAccount: options.demo,
    isPaperAccount: options.paper,
  });

  return {
    result: "Exchange account added successfully.",
  };
}
