import { CONFIG } from "../../../src/config.js";
import { fetchKlines, fetchLastPrice } from "../../../src/data/binance.js";
import { fetchChainlinkBtcUsd } from "../../../src/data/chainlink.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "../../../src/data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "../../../src/indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "../../../src/indicators/rsi.js";
import { computeMacd } from "../../../src/indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../../../src/indicators/heikenAshi.js";
import { detectRegime } from "../../../src/engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "../../../src/engines/probability.js";
import { computeEdge, decide } from "../../../src/engines/edge.js";
import { getCandleWindowTiming } from "../../../src/utils.js";
import { applyGlobalProxyFromEnv } from "../../../src/net/proxy.js";

export const dynamic = "force-dynamic";

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

// Small in-route cache to avoid hammering Gamma when UI polls quickly.
const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < 2_000) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();
  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes
    : typeof market.outcomes === "string"
      ? JSON.parse(market.outcomes)
      : [];

  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : typeof market.outcomePrices === "string"
      ? JSON.parse(market.outcomePrices)
      : [];

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : typeof market.clobTokenIds === "string"
      ? JSON.parse(market.clobTokenIds)
      : [];

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());
  const gammaUp = upIndex >= 0 ? safeNum(outcomePrices[upIndex]) : null;
  const gammaDown = downIndex >= 0 ? safeNum(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: "missing_token_ids", market };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [u, d, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = u;
    downBuy = d;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    // fall back to Gamma-derived fields if CLOB endpoints fail
    upBuy = null;
    downBuy = null;
  }

  const prices = {
    up: upBuy ?? gammaUp,
    down: downBuy ?? gammaDown
  };

  const spreadUp = safeNum(upBookSummary?.spread);
  const spreadDown = safeNum(downBookSummary?.spread);
  const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);

  const liquidity = safeNum(market?.liquidityNum) ?? safeNum(market?.liquidity);

  return {
    ok: true,
    market,
    marketSlug: String(market?.slug ?? ""),
    prices,
    liquidity,
    spread,
    tokens: { upTokenId, downTokenId },
    orderbook: { up: upBookSummary, down: downBookSummary }
  };
}

export async function GET() {
  // Make sure any proxy env settings apply for server-side fetches.
  applyGlobalProxyFromEnv();

  try {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
      fetchKlines({ interval: "1m", limit: 240 }),
      fetchLastPrice(),
      fetchChainlinkBtcUsd(),
      fetchPolymarketSnapshot()
    ]);

    const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
    const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
    const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

    const candles = klines1m;
    const closes = candles.map((c) => c.close);

    const vwapSeries = computeVwapSeries(candles);
    const vwapNow = vwapSeries.length ? vwapSeries[vwapSeries.length - 1] : null;

    const lookback = CONFIG.vwapSlopeLookbackMinutes;
    const vwapSlope = vwapNow !== null && vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
    const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

    const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
    const rsiSeries = [];
    for (let i = 0; i < closes.length; i += 1) {
      const sub = closes.slice(0, i + 1);
      const r = computeRsi(sub, CONFIG.rsiPeriod);
      if (r !== null) rsiSeries.push(r);
    }
    const rsiSlope = slopeLast(rsiSeries, 3);

    const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

    const ha = computeHeikenAshi(candles);
    const consec = countConsecutive(ha);

    // regime inputs
    const vwapCrossCount = (() => {
      const lookback = 20;
      if (closes.length < lookback || vwapSeries.length < lookback) return null;
      let crosses = 0;
      for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
        const prev = closes[i - 1] - vwapSeries[i - 1];
        const cur = closes[i] - vwapSeries[i];
        if (prev === 0) continue;
        if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
      }
      return crosses;
    })();

    const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
    const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

    const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
      ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
      : false;

    const regimeInfo = detectRegime({
      price: lastPrice,
      vwap: vwapNow,
      vwapSlope,
      vwapCrossCount,
      volumeRecent,
      volumeAvg
    });

    const scored = scoreDirection({
      price: lastPrice,
      vwap: vwapNow,
      vwapSlope,
      rsi: rsiNow,
      rsiSlope,
      macd,
      heikenColor: consec.color,
      heikenCount: consec.count,
      failedVwapReclaim
    });

    const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

    const marketUp = poly.ok ? poly.prices.up : null;
    const marketDown = poly.ok ? poly.prices.down : null;

    const edge = computeEdge({
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown,
      marketYes: marketUp,
      marketNo: marketDown
    });

    const rec = decide({
      remainingMinutes: timeLeftMin,
      edgeUp: edge.edgeUp,
      edgeDown: edge.edgeDown,
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown
    });

    const macdLabel = macd === null
      ? "-"
      : macd.hist < 0
        ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
        : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

    const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

    const now = new Date();

    const out = {
      meta: {
        ts: now.toISOString(),
        etTime: fmtEtTime(now),
        btcSession: getBtcSession(now),
        regime: regimeInfo?.regime ?? null
      },
      timing: {
        windowMin: CONFIG.candleWindowMinutes,
        timeLeftMin,
        warn: timeLeftMin !== null && timeLeftMin < 10,
        danger: timeLeftMin !== null && timeLeftMin < 5
      },
      indicators: {
        heiken: { color: consec.color ?? null, count: consec.count ?? null },
        rsi: { value: rsiNow, slope: rsiSlope, slopeSign: rsiSlope === null ? "" : rsiSlope > 0 ? "↑" : rsiSlope < 0 ? "↓" : "-" },
        macd: { label: macdLabel, hist: macd?.hist ?? null, histDelta: macd?.histDelta ?? null },
        vwap: { value: vwapNow, slope: vwapSlope, slopeLabel: vwapSlopeLabel, distPct: vwapDist }
      },
      predict: {
        pUp: timeAware?.adjustedUp ?? null,
        pDown: timeAware?.adjustedDown ?? null
      },
      edge: {
        edgeUp: edge.edgeUp,
        edgeDown: edge.edgeDown
      },
      recommendation: {
        action: rec.action,
        side: rec.side,
        phase: rec.phase,
        strength: rec.strength,
        label: rec.action === "ENTER" ? `${rec.action} NOW (${rec.side})` : `NO TRADE (${rec.phase})`
      },
      polymarket: {
        ok: poly.ok,
        marketSlug: poly.ok ? poly.marketSlug : null,
        prices: { up: marketUp, down: marketDown },
        liquidity: poly.ok ? poly.liquidity : null,
        spread: poly.ok ? poly.spread : null
      },
      prices: {
        chainlink: safeNum(chainlink?.price),
        binance: safeNum(lastPrice),
        diffUsd: (safeNum(lastPrice) !== null && safeNum(chainlink?.price) !== null) ? safeNum(lastPrice) - safeNum(chainlink?.price) : null,
        diffPct: (safeNum(lastPrice) !== null && safeNum(chainlink?.price) !== null && safeNum(chainlink?.price) !== 0)
          ? ((safeNum(lastPrice) - safeNum(chainlink?.price)) / safeNum(chainlink?.price)) * 100
          : null
      }
    };

    return Response.json(out, {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    });
  } catch (e) {
    return Response.json(
      { error: e?.message ?? String(e) },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
