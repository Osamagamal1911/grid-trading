import { App } from "@opentrader/bot";
import { getSettings } from "../../utils/settings.js";

/**
 * alphaGrid S10 (D49): ccxt's WS client can throw async NetworkErrors from event-emitter
 * paths (e.g. testnet user-data stream closes) that NO try/catch covers — an uncaught
 * throw kills the whole daemon, including unrelated bots. Survive network-class failures
 * (the polling watcher + per-bot REST reconcile continue); anything else still crashes
 * loudly. Narrow by construction: name + message fingerprint, never blanket suppression.
 */
process.on("uncaughtException", (err: unknown) => {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  const isWsNetworkFailure =
    name === "NetworkError" && /closed by remote server|connection (lost|closed|reset)|econnreset|etimedout/i.test(message);
  if (isWsNetworkFailure) {
    // eslint-disable-next-line no-console
    console.warn(`[daemon] Survived WS network failure (${message.slice(0, 160)}). Polling sync continues.`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[daemon] Fatal uncaught exception:", err);
  process.exit(1);
});

const { host, port } = getSettings();

const app = await App.create({
  server: {
    frontendDistPath: "../frontend",
    host,
    port,
  },
});

async function shutdown() {
  await app.shutdown();

  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
