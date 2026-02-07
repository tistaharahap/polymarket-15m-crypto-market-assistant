#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

function loadEnvFile(path) {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // ignore missing env files
  }
}

loadEnvFile(join(projectRoot, ".env.tsz"));
loadEnvFile(join(projectRoot, ".env.local"));

const { computeSnapshot } = await import("../src/web/snapshot.js");
const {
  getClobContext,
  fetchCollateralBalance,
  fetchConditionalBalance,
  placeLimitOrder
} = await import("../src/trading/index.js");
const { TRADING_CONFIG } = await import("../src/trading/config.js");

function requireEnv() {
  if (!TRADING_CONFIG.enabled) {
    throw new Error("TRADING_ENABLED=false; enable trading before running this test script.");
  }
  if (!TRADING_CONFIG.privateKey) {
    throw new Error("POLY_PRIVATE_KEY is missing; set it before running this test script.");
  }
}

function parseOutcomeTokens(tokens) {
  const upTokenId = tokens?.upTokenId ?? null;
  const downTokenId = tokens?.downTokenId ?? null;
  if (!upTokenId || !downTokenId) {
    throw new Error("Could not resolve Up/Down token IDs from snapshot.");
  }
  return { upTokenId, downTokenId };
}

async function main() {
  requireEnv();

  console.log("=== TSZ Trade Smoke Test ===");
  console.log("Using CLOB:", TRADING_CONFIG.clobApi);

  console.log("\n[1] Fetch current BTC 15m market snapshot");
  const snapshot = await computeSnapshot({ asset: "btc" });
  if (!snapshot?.polymarket?.ok) {
    throw new Error("Snapshot did not return an active BTC 15m market.");
  }
  const { marketSlug, tokens } = snapshot.polymarket;
  const { upTokenId, downTokenId } = parseOutcomeTokens(tokens);
  console.log("Market:", marketSlug);
  console.log("Up token:", upTokenId);
  console.log("Down token:", downTokenId);

  console.log("\n[2] Initialize CLOB context");
  const ctx = await getClobContext();
  if (!ctx) throw new Error("Failed to initialize CLOB context.");
  console.log("Funder:", ctx.funderAddress);

  console.log("\n[3] Check collateral + conditional balances");
  const collateral = await fetchCollateralBalance(ctx);
  const upCond = await fetchConditionalBalance(upTokenId, ctx);
  const downCond = await fetchConditionalBalance(downTokenId, ctx);
  console.log("Collateral:", collateral);
  console.log("Up conditional:", upCond);
  console.log("Down conditional:", downCond);

  console.log("\n[4] Place small BUY order (Up token)");
  const testPrice = 0.5; // arbitrary test price
  const testSize = 5; // minimum shares
  const buyResult = await placeLimitOrder({
    tokenId: upTokenId,
    price: testPrice,
    size: testSize,
    side: "BUY",
    orderType: "GTC",
    returnError: true
  });
  console.log("BUY result:", buyResult);

  console.log("\n[5] Place small SELL order (Up token, if available)\n");
  if (upCond?.available && upCond.available >= testSize) {
    const sellResult = await placeLimitOrder({
      tokenId: upTokenId,
      price: testPrice,
      size: Math.min(testSize, upCond.available),
      side: "SELL",
      orderType: "GTC",
      returnError: true
    });
    console.log("SELL result:", sellResult);
  } else {
    console.log("No available Up position to sell; skipping SELL test.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Test failed:", err?.message ?? err);
  process.exit(1);
});
