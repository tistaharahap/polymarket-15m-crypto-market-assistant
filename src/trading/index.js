import {
  ClobClient,
  OrderType,
  Side,
  Chain,
  AssetType
} from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { TRADING_CONFIG as config } from "./config.js";
import { formatError, logger } from "./logger.js";

/**
 * NOTE:
 * - This module is copied/adapted from the multipoly repo trading utilities.
 * - It does NOT execute any trading by itself.
 * - Callers must explicitly invoke functions.
 * - Gated by TRADING_ENABLED=true.
 */

/** @typedef {{client: any, address: string, funderAddress: string, creds: any}} ClobContext */

let clobContextPromise = null;
let warnedMissingKey = false;

const normalizeAddress = (value) => String(value).trim();
const truncate = (value, max = 500) => (value.length > max ? `${value.slice(0, max)}...` : value);

async function initClobContext() {
  if (!config.privateKey) {
    throw new Error("POLY_PRIVATE_KEY is required for trading");
  }

  const signer = new Wallet(config.privateKey);
  const funderAddress = config.funderAddress ? normalizeAddress(config.funderAddress) : signer.address;
  const signatureType = config.signatureType;

  logger.info("Trading signer:", signer.address);
  logger.info("Trading funder:", funderAddress);
  if (signatureType !== undefined) logger.info("Trading signature type:", signatureType);
  logger.info("Trading use server time:", config.useServerTime ? "true" : "false");

  const seedClient = new ClobClient(
    config.clobApi,
    Chain.POLYGON,
    signer,
    undefined,
    signatureType,
    funderAddress,
    undefined,
    config.useServerTime
  );

  const nonce = Math.floor(Date.now() / 1000);
  let creds;
  try {
    creds = await seedClient.createOrDeriveApiKey(nonce);
  } catch (err) {
    logger.warn("createOrDeriveApiKey failed, attempting derive:", formatError(err));
    creds = await seedClient.deriveApiKey(nonce);
  }

  const client = new ClobClient(
    config.clobApi,
    Chain.POLYGON,
    signer,
    creds,
    signatureType,
    funderAddress,
    undefined,
    config.useServerTime
  );

  logger.info("CLOB client ready for", funderAddress);
  return { client, address: signer.address, funderAddress, creds };
}

export async function getClobContext() {
  if (!config.enabled) return null;

  if (!config.privateKey) {
    if (!warnedMissingKey) {
      logger.warn("TRADING_ENABLED set but POLY_PRIVATE_KEY is missing");
      warnedMissingKey = true;
    }
    return null;
  }

  warnedMissingKey = false;

  if (!clobContextPromise) {
    clobContextPromise = initClobContext();
  }

  try {
    return await clobContextPromise;
  } catch (err) {
    logger.error("Failed to init CLOB client:", formatError(err));
    clobContextPromise = null;
    return null;
  }
}

export async function placeLimitOrder(opts) {
  const ctx = await getClobContext();
  if (!ctx) {
    if (opts?.returnError) return { orderId: "", status: "", error: "missing clob context" };
    return null;
  }

  const { tokenId, price, size, side } = opts;
  const orderType = opts?.orderType;

  let tickSize = opts?.tickSize ?? null;
  let negRisk = opts?.negRisk ?? null;

  if (tickSize === null || negRisk === null) {
    try {
      tickSize = await ctx.client.getTickSize(tokenId);
      negRisk = await ctx.client.getNegRisk(tokenId);
    } catch (err) {
      const message = formatError(err);
      logger.warn("Failed to fetch order metadata token=%s side=%s: %s", tokenId, side, message);
      if (opts?.returnError) return { orderId: "", status: "", error: `metadata fetch failed: ${message}` };
      return null;
    }
  }

  logger.info(
    "Submitting order token=%s side=%s price=%s size=%s orderType=%s negRisk=%s",
    tokenId,
    side,
    price,
    size,
    orderType ?? OrderType.GTC,
    negRisk
  );

  let response;
  try {
    response = await ctx.client.createAndPostOrder(
      { tokenID: tokenId, price, size, side },
      { tickSize, negRisk },
      orderType ?? OrderType.GTC,
      undefined,
      opts?.postOnly
    );
  } catch (err) {
    const message = formatError(err);
    logger.error(
      "createAndPostOrder FAILED token=%s side=%s price=%s size=%s negRisk=%s: %s",
      tokenId,
      side,
      price,
      size,
      negRisk,
      message
    );
    if (opts?.returnError) return { orderId: "", status: "", error: message };
    return null;
  }

  const orderId = response?.orderID ?? response?.orderId ?? "";
  const status = response?.status ?? "";

  if (!orderId) {
    logger.warn(
      "Order response missing orderId token=%s side=%s response=%s",
      tokenId,
      side,
      JSON.stringify(response)
    );
    if (opts?.returnError) {
      const responseText = truncate(JSON.stringify(response ?? {}));
      return { orderId: "", status, error: `missing orderId in response: ${responseText}` };
    }
    return null;
  }

  logger.info(
    "Order submitted orderId=%s status=%s token=%s side=%s price=%s size=%s",
    orderId,
    status,
    tokenId,
    side,
    price,
    size
  );

  return { orderId, status };
}

export async function placeMarketOrder(opts) {
  const ctx = await getClobContext();
  if (!ctx) {
    if (opts?.returnError) return { orderId: "", status: "", error: "missing clob context" };
    return null;
  }

  const { tokenId, amount, side } = opts;
  const orderType = opts?.orderType;
  const price = opts?.price;

  let tickSize = opts?.tickSize ?? null;
  let negRisk = opts?.negRisk ?? null;

  if (tickSize === null || negRisk === null) {
    try {
      tickSize = await ctx.client.getTickSize(tokenId);
      negRisk = await ctx.client.getNegRisk(tokenId);
    } catch (err) {
      const message = formatError(err);
      logger.warn("Failed to fetch market order metadata token=%s side=%s: %s", tokenId, side, message);
      if (opts?.returnError) return { orderId: "", status: "", error: `metadata fetch failed: ${message}` };
      return null;
    }
  }

  logger.info(
    "Submitting MARKET order token=%s side=%s amount=%s orderType=%s negRisk=%s",
    tokenId,
    side,
    amount,
    orderType ?? OrderType.FOK,
    negRisk
  );

  let response;
  try {
    response = await ctx.client.createAndPostMarketOrder(
      { tokenID: tokenId, amount, side, price },
      { tickSize, negRisk },
      orderType ?? OrderType.FOK
    );
  } catch (err) {
    const message = formatError(err);
    logger.error(
      "createAndPostMarketOrder FAILED token=%s side=%s amount=%s negRisk=%s: %s",
      tokenId,
      side,
      amount,
      negRisk,
      message
    );
    if (opts?.returnError) return { orderId: "", status: "", error: message };
    return null;
  }

  const orderId = response?.orderID ?? response?.orderId ?? "";
  const status = response?.status ?? "";

  if (!orderId) {
    logger.warn(
      "Market order response missing orderId token=%s side=%s response=%s",
      tokenId,
      side,
      JSON.stringify(response)
    );
    if (opts?.returnError) {
      const responseText = truncate(JSON.stringify(response ?? {}));
      return { orderId: "", status, error: `missing orderId in response: ${responseText}` };
    }
    return null;
  }

  logger.info("Market order submitted orderId=%s status=%s token=%s side=%s amount=%s", orderId, status, tokenId, side, amount);
  return { orderId, status };
}

export async function fetchOrder(orderId) {
  const ctx = await getClobContext();
  if (!ctx) return null;
  try {
    return await ctx.client.getOrder(orderId);
  } catch (err) {
    logger.warn("Failed to fetch order %s: %s", orderId, formatError(err));
    return null;
  }
}

export async function cancelOrder(orderId) {
  const ctx = await getClobContext();
  if (!ctx) return false;
  try {
    await ctx.client.cancelOrder({ orderID: orderId });
    logger.info("Canceled order", orderId);
    return true;
  } catch (err) {
    logger.warn("Failed to cancel order %s: %s", orderId, formatError(err));
    return false;
  }
}

export async function fetchCollateralBalance(ctx) {
  const clob = ctx ?? (await getClobContext());
  if (!clob) return null;

  let res;
  try {
    res = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (err) {
    logger.error("Failed to fetch collateral balance:", formatError(err));
    return null;
  }

  const balance = Number(res.balance ?? 0);
  const allowance = Number(res.allowance ?? 0);
  const available = Math.min(Number.isFinite(balance) ? balance : 0, Number.isFinite(allowance) ? allowance : 0);
  return { balance, allowance, available };
}

export async function getUserWsAuth(ctx) {
  const clob = ctx ?? (await getClobContext());
  if (!clob) return null;
  return {
    apiKey: clob.creds.key,
    secret: clob.creds.secret,
    passphrase: clob.creds.passphrase
  };
}

export { Side, OrderType };
