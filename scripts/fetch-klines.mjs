#!/usr/bin/env node
/**
 * Fetch Binance USD-M futures klines into klines/ (gitignored raw data).
 * Public endpoint, no auth. Reproducible backtest input (see BACKTEST_AKEUSDT.md).
 *
 * Usage: node scripts/fetch-klines.mjs AKEUSDT 1h 2026-01-01T00:00:00Z klines/AKEUSDT-1h.json
 */
const [symbol, interval, startIso, outPath] = process.argv.slice(2);
if (!symbol || !interval || !startIso || !outPath) {
  console.error("Usage: node scripts/fetch-klines.mjs SYMBOL INTERVAL START_ISO OUT_PATH");
  process.exit(1);
}

const startTime = Date.parse(startIso);
if (!Number.isFinite(startTime)) {
  console.error(`Bad START_ISO: ${startIso}`);
  process.exit(1);
}

const all = [];
let cursor = startTime;
const endTime = Date.now();
while (cursor < endTime) {
  const url =
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}` +
    `&startTime=${cursor}&limit=1500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const k of batch) {
    all.push({
      timestamp: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    });
  }
  const lastClose = batch[batch.length - 1][6];
  cursor = lastClose + 1;
  if (batch.length < 1500) break;
  await new Promise((r) => setTimeout(r, 250)); // rate-limit courtesy
}

const { mkdirSync, writeFileSync } = await import("node:fs");
const { dirname } = await import("node:path");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(all));
console.log(`Wrote ${all.length} ${interval} candles for ${symbol} → ${outPath}`);
if (all.length > 0) {
  console.log(`Range: ${new Date(all[0].timestamp).toISOString()} .. ${new Date(all[all.length - 1].timestamp).toISOString()}`);
}
