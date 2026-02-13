import { CONFIG } from "../config";
import { applyGlobalProxyFromEnv } from "../net/proxy";
import {
  fetchMarketBySlug,
  fetchActiveMarkets,
  pickLatestLiveMarket
} from "../data/polymarket";

// SERVER SNAPSHOT (LIGHTWEIGHT)
//
// This endpoint is intentionally lightweight and does NOT call Binance.
// The client now owns all TA calculations (seed once via HTTP + WS, then compute locally).

const ASSETS = ["btc", "eth", "xrp", "sol"];

export function normalizeAsset(x) {
  const a = String(x ?? "").trim().toLowerCase();
  return ASSETS.includes(a) ? a : "btc";
}

export function slugPrefixForAsset(asset) {
  return `${String(asset).toLowerCase()}-updown-15m-`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function current15mStartTs(nowMs = Date.now()) {
  const s = Math.floor(nowMs / 1000);
  return Math.floor(s / 900) * 900;
}

// small per-asset cache across calls (avoid hammering Gamma)
const marketCacheByAsset = new Map();

async function fetchActiveMarketsBySlugPrefix({ slugPrefix, maxPages = 25 }) {
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * 200;
    const batch = await fetchActiveMarkets({ limit: 200, offset });
    if (!batch.length) break;

    for (const m of batch) {
      const slug = String(m?.slug ?? "").toLowerCase();
      if (slugPrefix && slug.startsWith(slugPrefix)) out.push(m);
    }

    if (out.length >= 20) break;
  }
  return out;
}

async function resolveCurrentUpdown15mMarket({ asset, nowMs = Date.now() }) {
  const cached = marketCacheByAsset.get(asset);
  if (cached?.market && nowMs - cached.fetchedAtMs < 2_000) {
    return cached.market;
  }

  // Fast path: interpolate the expected slug for the current 15m window.
  const ts = current15mStartTs(nowMs);
  const slug = `${asset}-updown-15m-${ts}`;
  const direct = await fetchMarketBySlug(slug);
  if (direct) {
    marketCacheByAsset.set(asset, { market: direct, fetchedAtMs: nowMs });
    return direct;
  }

  // Fallback: scan active markets and pick the live one.
  const prefix = slugPrefixForAsset(asset);
  const markets = await fetchActiveMarketsBySlugPrefix({ slugPrefix: prefix, maxPages: 25 });
  const picked = pickLatestLiveMarket(markets);

  marketCacheByAsset.set(asset, { market: picked, fetchedAtMs: nowMs });
  return picked;
}

function pickOutcomeTokenIds(market) {
  const outcomes = Array.isArray(market?.outcomes)
    ? market.outcomes
    : typeof market?.outcomes === "string"
      ? JSON.parse(market.outcomes)
      : [];

  const clobTokenIds = Array.isArray(market?.clobTokenIds)
    ? market.clobTokenIds
    : typeof market?.clobTokenIds === "string"
      ? JSON.parse(market.clobTokenIds)
      : [];

  let upTokenId = null;
  let downTokenId = null;

  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i] ?? "").toLowerCase();
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label === String(CONFIG.polymarket.upOutcomeLabel ?? "up").toLowerCase()) upTokenId = tokenId;
    if (label === String(CONFIG.polymarket.downOutcomeLabel ?? "down").toLowerCase()) downTokenId = tokenId;
  }

  return { upTokenId, downTokenId };
}

export async function computeSnapshot({ asset }: { asset?: string } = {}) {
  applyGlobalProxyFromEnv();

  const a = normalizeAsset(asset);
  const now = new Date();
  const nowMs = now.getTime();

  const market = await resolveCurrentUpdown15mMarket({ asset: a, nowMs });

  if (!market) {
    return {
      meta: { ts: now.toISOString(), etTime: fmtEtTime(now), btcSession: getBtcSession(now) },
      polymarket: { ok: false, marketSlug: null, marketStartTime: null, marketEndTime: null, tokens: null, liquidity: null, spread: null },
      prices: {}
    };
  }

  const tokens = pickOutcomeTokenIds(market);
  const liquidity = safeNum(market?.liquidityNum) ?? safeNum(market?.liquidity);
  const spread = safeNum(market?.spread);

  return {
    meta: {
      ts: now.toISOString(),
      etTime: fmtEtTime(now),
      btcSession: getBtcSession(now)
    },
    polymarket: {
      ok: true,
      marketSlug: String(market?.slug ?? ""),
      marketStartTime: market?.eventStartTime ?? market?.startTime ?? market?.startDate ?? null,
      marketEndTime: market?.endDate ?? null,
      tokens,
      liquidity,
      spread
    }
  };
}
