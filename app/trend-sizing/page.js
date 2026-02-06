"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, LineSeries, createSeriesMarkers } from "lightweight-charts";
import { connectClobMarketWs } from "../_ws/clobMarket";

const TAB_ORDER = [
  { asset: "btc", label: "BTC" },
  { asset: "eth", label: "ETH" },
  { asset: "xrp", label: "XRP" },
  { asset: "sol", label: "SOL" }
];

const RATIO_POINTS_LIMIT = 1200;
const MAX_BUY_PRICE = 0.99;
const MIN_BUY_PRICE = 0.01;
const DEFAULT_END_CLAMP_SEC = 120;
const LIVE_FILL_WAIT_MS = 60000;
const LIVE_FILL_POLL_MS = 1500;
const LIVE_RECONCILE_MS = 15000;
const LIVE_MIN_SHARES = 5;
const LIVE_MIN_NOTIONAL_USD = 1;
const LIVE_RETRY_BACKOFF_MS = 2500;
const LIVE_RETRY_BACKOFF_COLLATERAL_MS = 10000;
const LIVE_RETRY_BACKOFF_CONDITIONAL_MS = 6000;
const LIVE_RETRY_BACKOFF_FAK_NO_MATCH_MS = 4000;
const LIVE_RETRY_BACKOFF_INVALID_PRICE_MS = 15000;
const NUMERIC_EPSILON = 1e-9;
const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);
const VOL_TIME_SCALE_SEC = 60;
const VOL_RATIO_TIGHTEN = 1.0;
const VOL_MOMENTUM_BUMP = 0.01;
const VOL_SIZE_DAMP = 0.8;
const TIME_RATIO_TIGHTEN = 0.5;
const TIME_MOMENTUM_BUMP = 0.005;
const TIME_SIZE_DAMP_MIN = 0.5;
const SPREAD_BASE_MAX = 0.03;
const SPREAD_TIME_TIGHTEN = 0.02;
const SPREAD_VOL_TIGHTEN = 0.02;

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function fmtUsd(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return `$${fmtNum(n, digits)}`;
}

function fmtRatio(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return `${fmtNum(n, digits)}x`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isBelowMin(value, min, epsilon = NUMERIC_EPSILON) {
  return !Number.isFinite(value) || value + epsilon < min;
}

function isFakNoMatchError(errorText) {
  return String(errorText ?? "").toLowerCase().includes("no orders found to match with fak order");
}

function isInsufficientBalanceAllowanceError(errorText) {
  return String(errorText ?? "").toLowerCase().includes("not enough balance / allowance");
}

function isPriceOutOfTradableRange(price) {
  return isBelowMin(price, MIN_BUY_PRICE) || price > (MAX_BUY_PRICE + NUMERIC_EPSILON);
}

function isPriceOutOfRangeError(errorText) {
  return String(errorText ?? "").toLowerCase().includes("price out of tradable range");
}

function roundTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.floor((value + 1e-9) * factor) / factor;
}

function ceilTo(value, decimals = 2) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.ceil((value - 1e-9) * factor) / factor;
}

function normalizeTradeSize({
  rawSize,
  side,
  price,
  maxSize = Number.POSITIVE_INFINITY,
  available = Number.POSITIVE_INFINITY,
  minShares = LIVE_MIN_SHARES,
  minNotional = LIVE_MIN_NOTIONAL_USD
}) {
  let size = Number(rawSize);
  if (!Number.isFinite(size) || size <= 0) return 0;

  const px = Number(price);
  const hasPx = Number.isFinite(px) && px > 0;
  const maxAllowed = Number.isFinite(maxSize) ? Math.max(0, maxSize) : Number.POSITIVE_INFINITY;
  const availAllowed = Number.isFinite(available) ? Math.max(0, available) : Number.POSITIVE_INFINITY;
  const minSharesFromNotional = hasPx ? ceilTo(minNotional / px, 2) : minShares;
  const hardMinShares = Math.max(minShares, minSharesFromNotional);

  if (side === "SELL") {
    if (isBelowMin(availAllowed, hardMinShares)) return 0;
    size = Math.max(size, hardMinShares);
    size = Math.min(size, availAllowed);
    const remaining = availAllowed - size;
    if (remaining > NUMERIC_EPSILON && isBelowMin(remaining, hardMinShares)) {
      // Avoid leaving an unsellable residual position (e.g. 7 -> 5 + 2).
      size = availAllowed;
    }
    if (isBelowMin(size, minShares)) return 0;
  } else {
    size = Math.max(size, hardMinShares);
  }

  size = Math.min(size, maxAllowed);
  if (side === "SELL") {
    const remainingAfterCap = availAllowed - size;
    if (remainingAfterCap > NUMERIC_EPSILON && isBelowMin(remainingAfterCap, hardMinShares)) {
      size = availAllowed;
    }
  }
  if (isBelowMin(size, minShares)) return 0;
  if (hasPx && isBelowMin(size * px, minNotional)) return 0;

  return roundTo(Math.max(size, minShares), 2);
}

function tooltip(text) {
  return (
    <span className="tooltip" aria-label={text} data-tip={text}>
      ?
    </span>
  );
}

function fmtTimeLeftSec(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "-";
  const total = Math.max(0, Math.floor(Number(value)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function computeTradeStats(entries) {
  const stats = {
    events: 0,
    liveEvents: 0,
    apiAttempts: 0,
    liveApiAttempts: 0,
    filled: 0,
    liveFilled: 0,
    failedApi: 0,
    liveFailedApi: 0,
    skipped: 0,
    liveSkipped: 0
  };
  if (!Array.isArray(entries) || !entries.length) return stats;
  for (const entry of entries) {
    if (!entry) continue;
    stats.events += 1;
    const isLive = entry.mode === "live";
    if (isLive) stats.liveEvents += 1;
    const size = Number(entry.size);
    const status = String(entry.status ?? "").toLowerCase();
    const apiAttempted = Boolean(
      entry.apiAttempted === true
      || (isLive && (entry.orderId || status === "filled" || status === "partial" || status === "no-fill"))
    );
    const isFilled = (status === "filled" || status === "partial" || status === "sim") && size > 0;
    const isApiFailed = apiAttempted && (status === "error" || status === "no-fill" || status === "rejected");
    const isSkipped = !apiAttempted && (status === "skipped" || status === "blocked" || status === "error");
    if (apiAttempted) {
      stats.apiAttempts += 1;
      if (isLive) stats.liveApiAttempts += 1;
    }
    if (isFilled) {
      stats.filled += 1;
      if (isLive) stats.liveFilled += 1;
    }
    if (isApiFailed) {
      stats.failedApi += 1;
      if (isLive) stats.liveFailedApi += 1;
    }
    if (isSkipped) {
      stats.skipped += 1;
      if (isLive) stats.liveSkipped += 1;
    }
  }
  return stats;
}

function computeSkippedReasonCounts(entries, { liveOnly = true } = {}) {
  const counts = {};
  if (!Array.isArray(entries) || !entries.length) return counts;
  for (const entry of entries) {
    if (!entry) continue;
    if (liveOnly && entry.mode !== "live") continue;
    const status = String(entry.status ?? "").toLowerCase();
    if (status !== "skipped" && status !== "blocked") continue;
    const reason = String(entry.reason ?? "").trim() || "unspecified";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function mergeReasonCounts(base, extra) {
  const merged = { ...(base ?? {}) };
  const source = extra ?? {};
  for (const [reason, count] of Object.entries(source)) {
    merged[reason] = (merged[reason] ?? 0) + (Number(count) || 0);
  }
  return merged;
}

function reasonCountsToRows(counts) {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function buyPayoutRatio(price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  return (1 - price) / price;
}

function sellPayoutRatio(price) {
  if (!Number.isFinite(price) || price >= 1) return null;
  return price / (1 - price);
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_TWO_PI;
}

function normInv(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q = 0;
  let r = 0;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function impliedVolScore(price, timeLeftSec) {
  if (!Number.isFinite(price) || !Number.isFinite(timeLeftSec) || timeLeftSec <= 0) return null;
  const p = clamp(price, 1e-4, 1 - 1e-4);
  const z = normInv(p);
  if (z === null) return null;
  const denom = Math.sqrt(Math.max(1, timeLeftSec / VOL_TIME_SCALE_SEC));
  return normPdf(z) / denom;
}

function midPrice(bid, ask) {
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  if (Number.isFinite(bid)) return bid;
  if (Number.isFinite(ask)) return ask;
  return null;
}

function computeSpreadLimit(timeFrac, volScore) {
  const timePenalty = Number.isFinite(timeFrac) ? (1 - timeFrac) * SPREAD_TIME_TIGHTEN : 0;
  const volPenalty = Number.isFinite(volScore) ? volScore * SPREAD_VOL_TIGHTEN : 0;
  return clamp(SPREAD_BASE_MAX - timePenalty - volPenalty, 0.005, SPREAD_BASE_MAX);
}

function appendPoint(series, point) {
  if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.value)) return series;
  const next = series.length ? [...series] : [];
  const last = next[next.length - 1];
  if (last && last.time === point.time) {
    next[next.length - 1] = point;
  } else {
    next.push(point);
  }
  if (next.length > RATIO_POINTS_LIMIT) {
    next.splice(0, next.length - RATIO_POINTS_LIMIT);
  }
  return next;
}

function computeMomentum(series, windowSec) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = series[series.length - 1];
  if (!last) return null;
  const cutoff = last.time - windowSec;
  let anchor = null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const point = series[i];
    if (point.time <= cutoff) {
      anchor = point;
      break;
    }
  }
  if (!anchor) anchor = series[0];
  const dt = Math.max(1, last.time - anchor.time);
  return (last.value - anchor.value) / dt;
}

function RatioChart({ series, markers }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const upBuyRef = useRef(null);
  const upSellRef = useRef(null);
  const downBuyRef = useRef(null);
  const downSellRef = useRef(null);
  const upBuyMarkersRef = useRef(null);
  const upSellMarkersRef = useRef(null);
  const downBuyMarkersRef = useRef(null);
  const downSellMarkersRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(document.documentElement);
    const text = styles.getPropertyValue("--text").trim() || "#e9eef9";
    const border = styles.getPropertyValue("--border").trim() || "#1b2a44";
    const muted = styles.getPropertyValue("--muted").trim() || "#a5b4d0";
    const green = styles.getPropertyValue("--green").trim() || "#45ffb2";
    const cyan = styles.getPropertyValue("--cyan").trim() || "#59d7ff";
    const amber = styles.getPropertyValue("--amber").trim() || "#ffcc66";
    const red = styles.getPropertyValue("--red").trim() || "#ff5c7a";

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: text,
        attributionLogo: false
      },
      grid: {
        vertLines: { color: border },
        horzLines: { color: border }
      },
      rightPriceScale: { borderColor: border },
      timeScale: {
        borderColor: border,
        rightOffset: 2,
        timeVisible: true,
        secondsVisible: true
      },
      crosshair: {
        horzLine: { color: muted },
        vertLine: { color: muted }
      }
    });

    const upBuy = chart.addSeries(LineSeries, { color: green, lineWidth: 2 });
    const upSell = chart.addSeries(LineSeries, { color: cyan, lineWidth: 2 });
    const downBuy = chart.addSeries(LineSeries, { color: amber, lineWidth: 2 });
    const downSell = chart.addSeries(LineSeries, { color: red, lineWidth: 2 });

    const upBuyMarkers = createSeriesMarkers(upBuy);
    const upSellMarkers = createSeriesMarkers(upSell);
    const downBuyMarkers = createSeriesMarkers(downBuy);
    const downSellMarkers = createSeriesMarkers(downSell);

    chartRef.current = chart;
    upBuyRef.current = upBuy;
    upSellRef.current = upSell;
    downBuyRef.current = downBuy;
    downSellRef.current = downSell;
    upBuyMarkersRef.current = upBuyMarkers;
    upSellMarkersRef.current = upSellMarkers;
    downBuyMarkersRef.current = downBuyMarkers;
    downSellMarkersRef.current = downSellMarkers;

    const resizeObserver = new ResizeObserver(() => {
      if (!container) return;
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      upBuyMarkersRef.current?.detach?.();
      upSellMarkersRef.current?.detach?.();
      downBuyMarkersRef.current?.detach?.();
      downSellMarkersRef.current?.detach?.();
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    upBuyRef.current?.setData(series.upBuy ?? []);
    upSellRef.current?.setData(series.upSell ?? []);
    downBuyRef.current?.setData(series.downBuy ?? []);
    downSellRef.current?.setData(series.downSell ?? []);
  }, [series]);

  useEffect(() => {
    upBuyMarkersRef.current?.setMarkers(markers.upBuy ?? []);
    upSellMarkersRef.current?.setMarkers(markers.upSell ?? []);
    downBuyMarkersRef.current?.setMarkers(markers.downBuy ?? []);
    downSellMarkersRef.current?.setMarkers(markers.downSell ?? []);
  }, [markers]);

  return <div className="chartCanvas" ref={containerRef} />;
}

export default function TrendSizingPage() {
  const [activeAsset, setActiveAsset] = useState("btc");
  const [meta, setMeta] = useState(null);
  const [metaErr, setMetaErr] = useState(null);
  const [metaLoading, setMetaLoading] = useState(true);

  const [clobByAsset, setClobByAsset] = useState({});
  const clobRef = useRef(null);

  const [liveAllowed, setLiveAllowed] = useState(false);
  const [tradeActive, setTradeActive] = useState(false);
  const [tradeArmed, setTradeArmed] = useState(false);
  const [tradeNotice, setTradeNotice] = useState(null);
  const [buyRatioMin, setBuyRatioMin] = useState(8);
  const [sellRatioMin, setSellRatioMin] = useState(20);
  const [momentumWindowSec, setMomentumWindowSec] = useState(15);
  const [minMomentum, setMinMomentum] = useState(0);
  const [baseSize, setBaseSize] = useState(5);
  const [maxSize, setMaxSize] = useState(200);
  const [sizeScale, setSizeScale] = useState(2);
  const [cooldownSec, setCooldownSec] = useState(5);
  const [hedgeEnabled, setHedgeEnabled] = useState(true);
  const [hedgeRatioMin, setHedgeRatioMin] = useState(2.5);
  const [hedgeRatioMax, setHedgeRatioMax] = useState(4);
  const [hedgeSizeMult, setHedgeSizeMult] = useState(0.7);
  const [winnerBuyMinPrice, setWinnerBuyMinPrice] = useState(0.8);
  const [winnerBuyRequireFavored, setWinnerBuyRequireFavored] = useState(true);
  const [endClampLoserBuySec, setEndClampLoserBuySec] = useState(DEFAULT_END_CLAMP_SEC);
  const [endClampWinnerSellSec, setEndClampWinnerSellSec] = useState(DEFAULT_END_CLAMP_SEC);
  const [settlementBuffer, setSettlementBuffer] = useState(5);
  const [settlementCapMult, setSettlementCapMult] = useState(0.95);
  const [rebalanceMode, setRebalanceMode] = useState("sell-first");
  const [maxRebalanceSizeMult, setMaxRebalanceSizeMult] = useState(1);
  const [flipRebalanceEnabled, setFlipRebalanceEnabled] = useState(true);
  const [rebalanceIgnoreCooldown, setRebalanceIgnoreCooldown] = useState(true);
  const [lateRebalanceOverride, setLateRebalanceOverride] = useState(true);
  const [dojiThreshold, setDojiThreshold] = useState(0.05);
  const [dojiSizeMult, setDojiSizeMult] = useState(0.3);
  const [dojiAllowBuys, setDojiAllowBuys] = useState(false);
  const [lateDojiUnwind, setLateDojiUnwind] = useState(true);
  const [lateWindowSec, setLateWindowSec] = useState(300);
  const [lateBufferMult, setLateBufferMult] = useState(1.5);
  const [lateCapMult, setLateCapMult] = useState(0.85);
  const [lateCapFloor, setLateCapFloor] = useState(0.7);
  const [enableUpBuy, setEnableUpBuy] = useState(true);
  const [enableUpSell, setEnableUpSell] = useState(true);
  const [enableDownBuy, setEnableDownBuy] = useState(true);
  const [enableDownSell, setEnableDownSell] = useState(true);

  const [ratioSeries, setRatioSeries] = useState({ upBuy: [], upSell: [], downBuy: [], downSell: [] });
  const ratioSeriesRef = useRef(ratioSeries);

  const [trades, setTrades] = useState([]);
  const lastTradeRef = useRef({});
  const [windowHistory, setWindowHistory] = useState([]);
  const lastWindowRef = useRef({ slug: null, start: null, end: null, asset: null });
  const tradeStartTimerRef = useRef(null);
  const liveOrderBusyRef = useRef(false);
  const liveReconcileBusyRef = useRef(false);
  const liveRetryAfterRef = useRef(0);
  const liveNoMatchRetryByOrderRef = useRef({});
  const livePriceNudgeByOrderRef = useRef({});
  const lastWinnerSideRef = useRef(null);
  const positionsRef = useRef({ Up: 0, Down: 0 });
  const [positions, setPositions] = useState({ Up: 0, Down: 0 });

  // Polled conditional token balances (preferred over WS-derived position state).
  // Shape: { [tokenId]: { balance, allowance, available, ts } }
  const conditionalAvailByTokenRef = useRef({});
  const avgCostRef = useRef({ Up: 0, Down: 0 });
  const [avgCost, setAvgCost] = useState({ Up: 0, Down: 0 });
  const [positionNotional, setPositionNotional] = useState({ Up: 0, Down: 0 });
  const cashFlowRef = useRef({ spent: 0, received: 0 });
  const [cashFlow, setCashFlow] = useState({ spent: 0, received: 0 });
  const [lastSyncTs, setLastSyncTs] = useState(null);
  const lastBboRef = useRef({ upBid: null, downBid: null });
  const [timeLeftSec, setTimeLeftSec] = useState(null);
  const timeLeftRef = useRef(null);

  const activeTokens = meta?.polymarket?.tokens ?? null;
  const activeMarketSlug = meta?.polymarket?.marketSlug ?? null;

  const BALANCE_POLL_MS = useMemo(() => {
    const raw = Number(process.env.NEXT_PUBLIC_TSZ_BALANCE_POLL_MS ?? 1500);
    return Number.isFinite(raw) && raw > 100 ? raw : 1500;
  }, []);
  const BALANCE_STALE_MS = useMemo(() => {
    const raw = Number(process.env.NEXT_PUBLIC_TSZ_BALANCE_STALE_MS ?? 5000);
    return Number.isFinite(raw) && raw > 0 ? raw : 5000;
  }, []);

  const activeBbo = clobByAsset[activeAsset] ?? { marketSlug: null, up: null, down: null };
  const upBid = activeBbo?.up?.bid ?? null;
  const upAsk = activeBbo?.up?.ask ?? null;
  const downBid = activeBbo?.down?.bid ?? null;
  const downAsk = activeBbo?.down?.ask ?? null;
  const upMid = useMemo(() => midPrice(upBid, upAsk), [upBid, upAsk]);
  const downMid = useMemo(() => midPrice(downBid, downAsk), [downBid, downAsk]);
  const upSpread = Number.isFinite(upAsk) && Number.isFinite(upBid) ? upAsk - upBid : null;
  const downSpread = Number.isFinite(downAsk) && Number.isFinite(downBid) ? downAsk - downBid : null;

  const windowDurationSec = useMemo(() => {
    const start = meta?.polymarket?.marketStartTime;
    const end = meta?.polymarket?.marketEndTime;
    if (!start || !end) return null;
    const duration = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }, [meta?.polymarket?.marketStartTime, meta?.polymarket?.marketEndTime]);

  const timeFrac = useMemo(() => {
    if (!Number.isFinite(timeLeftSec) || !Number.isFinite(windowDurationSec)) return null;
    return clamp(timeLeftSec / windowDurationSec, 0, 1);
  }, [timeLeftSec, windowDurationSec]);

  const upVolScore = useMemo(() => impliedVolScore(upMid, timeLeftSec), [upMid, timeLeftSec]);
  const downVolScore = useMemo(() => impliedVolScore(downMid, timeLeftSec), [downMid, timeLeftSec]);
  const volScore = useMemo(() => {
    const scores = [upVolScore, downVolScore].filter((v) => Number.isFinite(v));
    if (!scores.length) return null;
    return Math.max(...scores);
  }, [upVolScore, downVolScore]);

  const dojiDiff = useMemo(() => {
    if (!Number.isFinite(upMid) || !Number.isFinite(downMid)) return null;
    return Math.abs(upMid - downMid);
  }, [upMid, downMid]);

  const dojiActive = useMemo(() => {
    if (!Number.isFinite(dojiDiff)) return false;
    return dojiDiff <= dojiThreshold;
  }, [dojiDiff, dojiThreshold]);

  const lateWindowActive = useMemo(() => {
    if (!Number.isFinite(timeLeftSec)) return false;
    return timeLeftSec <= lateWindowSec;
  }, [timeLeftSec, lateWindowSec]);

  const ratioTighten = 1
    + (Number.isFinite(volScore) ? volScore * VOL_RATIO_TIGHTEN : 0)
    + (Number.isFinite(timeFrac) ? (1 - timeFrac) * TIME_RATIO_TIGHTEN : 0);
  const buyRatioMinAdj = buyRatioMin * ratioTighten;
  const sellRatioMinAdj = sellRatioMin * ratioTighten;
  const minMomentumAdj = Math.max(0, minMomentum
    + (Number.isFinite(volScore) ? volScore * VOL_MOMENTUM_BUMP : 0)
    + (Number.isFinite(timeFrac) ? (1 - timeFrac) * TIME_MOMENTUM_BUMP : 0));
  const sizeAdjust = useMemo(() => {
    let adjust = 1;
    if (Number.isFinite(volScore)) {
      adjust *= Math.max(0.35, 1 - volScore * VOL_SIZE_DAMP);
    }
    if (Number.isFinite(timeFrac)) {
      adjust *= Math.max(TIME_SIZE_DAMP_MIN, TIME_SIZE_DAMP_MIN + timeFrac * (1 - TIME_SIZE_DAMP_MIN));
    }
    return adjust;
  }, [volScore, timeFrac]);

  const lateProgress = useMemo(() => {
    if (!lateWindowActive || !Number.isFinite(timeLeftSec) || lateWindowSec <= 0) return 1;
    return clamp(timeLeftSec / lateWindowSec, 0, 1);
  }, [lateWindowActive, timeLeftSec, lateWindowSec]);
  const bufferScale = lateWindowActive
    ? 1 + (lateBufferMult - 1) * (1 - lateProgress)
    : 1;
  const capScale = lateWindowActive
    ? lateCapMult + (1 - lateCapMult) * lateProgress
    : 1;
  const effectiveSettlementBuffer = settlementBuffer * bufferScale;
  const effectiveCapMult = clamp(settlementCapMult * capScale, lateCapFloor, 2);

  const upSpreadLimit = useMemo(() => computeSpreadLimit(timeFrac, upVolScore), [timeFrac, upVolScore]);
  const downSpreadLimit = useMemo(() => computeSpreadLimit(timeFrac, downVolScore), [timeFrac, downVolScore]);

  const upBuyRatio = useMemo(() => buyPayoutRatio(upAsk), [upAsk]);
  const upSellRatio = useMemo(() => sellPayoutRatio(upBid), [upBid]);
  const downBuyRatio = useMemo(() => buyPayoutRatio(downAsk), [downAsk]);
  const downSellRatio = useMemo(() => sellPayoutRatio(downBid), [downBid]);

  const upBuyMomentum = useMemo(() => computeMomentum(ratioSeries.upBuy, momentumWindowSec), [ratioSeries.upBuy, momentumWindowSec]);
  const upSellMomentum = useMemo(() => computeMomentum(ratioSeries.upSell, momentumWindowSec), [ratioSeries.upSell, momentumWindowSec]);
  const downBuyMomentum = useMemo(() => computeMomentum(ratioSeries.downBuy, momentumWindowSec), [ratioSeries.downBuy, momentumWindowSec]);
  const downSellMomentum = useMemo(() => computeMomentum(ratioSeries.downSell, momentumWindowSec), [ratioSeries.downSell, momentumWindowSec]);

  useEffect(() => {
    ratioSeriesRef.current = ratioSeries;
  }, [ratioSeries]);

  const refreshConditionalBalance = async (tokenId, { force = false } = {}) => {
    const id = String(tokenId ?? "").trim();
    if (!id) return null;

    const existing = conditionalAvailByTokenRef.current?.[id];
    const now = Date.now();
    if (!force && existing?.ts && now - existing.ts < BALANCE_POLL_MS) return existing;

    try {
      const res = await fetch(`/api/trade/balance?tokenId=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      const balance = Number(data?.balance ?? 0);
      const allowance = Number(data?.allowance ?? 0);
      const available = Math.max(0, Math.min(
        Number.isFinite(balance) ? balance : 0,
        Number.isFinite(allowance) ? allowance : 0
      ));
      const next = {
        balance,
        allowance,
        available,
        ts: now
      };
      conditionalAvailByTokenRef.current = {
        ...(conditionalAvailByTokenRef.current ?? {}),
        [id]: next
      };
      return next;
    } catch {
      return null;
    }
  };

  // Keep polled token balances reasonably fresh while trading is active.
  useEffect(() => {
    if (!tradeActive) return;
    const upTokenId = activeTokens?.upTokenId;
    const downTokenId = activeTokens?.downTokenId;
    if (!upTokenId && !downTokenId) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (upTokenId) await refreshConditionalBalance(upTokenId);
      if (downTokenId) await refreshConditionalBalance(downTokenId);
    };

    // prime immediately
    tick();
    const handle = setInterval(tick, BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [tradeActive, activeTokens?.upTokenId, activeTokens?.downTokenId, BALANCE_POLL_MS]);

  useEffect(() => {
    let alive = true;
    async function initTrading() {
      try {
        const res = await fetch("/api/trade/init", { cache: "no-store" });
        if (!alive) return;
        if (!res.ok) {
          setLiveAllowed(false);
          return;
        }
        setLiveAllowed(true);
      } catch {
        if (!alive) return;
        setLiveAllowed(false);
      }
    }
    initTrading();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeMarketSlug) return;
    const prev = lastWindowRef.current?.slug;
    if (prev && prev !== activeMarketSlug) {
      recordWindow({
        slug: prev,
        startTime: lastWindowRef.current?.start,
        endTime: lastWindowRef.current?.end,
        asset: lastWindowRef.current?.asset
      });
      resetSim();
      if (tradeArmed) {
        setTradeActive(true);
        setTradeArmed(false);
        setTradeNotice(null);
      }
    }
    lastWindowRef.current = {
      slug: activeMarketSlug,
      start: meta?.polymarket?.marketStartTime ?? null,
      end: meta?.polymarket?.marketEndTime ?? null,
      asset: activeAsset
    };
  }, [activeMarketSlug, meta?.polymarket?.marketStartTime, meta?.polymarket?.marketEndTime, activeAsset, tradeArmed]);

  useEffect(() => {
    if (Number.isFinite(upBid)) lastBboRef.current.upBid = upBid;
    if (Number.isFinite(downBid)) lastBboRef.current.downBid = downBid;
  }, [upBid, downBid]);

  useEffect(() => {
    if (!liveAllowed || !tradeActive) return;
    const upTokenId = activeTokens?.upTokenId ?? null;
    const downTokenId = activeTokens?.downTokenId ?? null;
    if (!upTokenId || !downTokenId) return;

    let canceled = false;
    let timeoutId = null;

    const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

    const reconcileOnce = async () => {
      if (canceled || liveReconcileBusyRef.current || !isVisible()) return;
      liveReconcileBusyRef.current = true;
      try {
        const [upRes, downRes] = await Promise.all([
          fetch(`/api/trade/balance?tokenId=${encodeURIComponent(upTokenId)}`, { cache: "no-store" }),
          fetch(`/api/trade/balance?tokenId=${encodeURIComponent(downTokenId)}`, { cache: "no-store" })
        ]);
        if (!upRes.ok || !downRes.ok) return;
        const [upData, downData] = await Promise.all([
          upRes.json().catch(() => ({})),
          downRes.json().catch(() => ({}))
        ]);
        const upAvailable = Number(upData?.available);
        const downAvailable = Number(downData?.available);
        if (!Number.isFinite(upAvailable) || !Number.isFinite(downAvailable)) return;
        if (canceled) return;
        setLastSyncTs(Date.now());
      } catch {
        // Best-effort reconciliation; ignore transient transport errors.
      } finally {
        liveReconcileBusyRef.current = false;
      }
    };

    const scheduleNext = () => {
      if (canceled) return;
      timeoutId = setTimeout(async () => {
        await reconcileOnce();
        scheduleNext();
      }, LIVE_RECONCILE_MS);
    };

    const onVisibilityChange = () => {
      if (!canceled && isVisible()) void reconcileOnce();
    };

    void reconcileOnce();
    scheduleNext();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      canceled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [liveAllowed, tradeActive, activeTokens?.upTokenId, activeTokens?.downTokenId]);

  useEffect(() => {
    if (!tradeArmed) return;
    const startMs = meta?.polymarket?.marketStartTime ? new Date(meta.polymarket.marketStartTime).getTime() : null;
    if (!Number.isFinite(startMs)) return;
    const now = Date.now();
    if (now >= startMs) return;
    if (tradeStartTimerRef.current) clearTimeout(tradeStartTimerRef.current);
    tradeStartTimerRef.current = setTimeout(() => {
      setTradeActive(true);
      setTradeArmed(false);
      setTradeNotice(null);
    }, Math.max(0, startMs - now));
    return () => {
      if (tradeStartTimerRef.current) clearTimeout(tradeStartTimerRef.current);
      tradeStartTimerRef.current = null;
    };
  }, [tradeArmed, meta?.polymarket?.marketStartTime]);

  const recordWindow = ({ slug, startTime, endTime, asset }) => {
    const upMark = Number.isFinite(lastBboRef.current.upBid) ? lastBboRef.current.upBid : null;
    const downMark = Number.isFinite(lastBboRef.current.downBid) ? lastBboRef.current.downBid : null;
    const upPnl = upMark !== null ? (positionsRef.current.Up ?? 0) * (upMark - (avgCostRef.current.Up ?? 0)) : null;
    const downPnl = downMark !== null ? (positionsRef.current.Down ?? 0) * (downMark - (avgCostRef.current.Down ?? 0)) : null;
    const total = upPnl !== null && downPnl !== null ? upPnl + downPnl : null;
    const winner = upMark === null || downMark === null ? null : (upMark >= downMark ? "Up" : "Down");
    const winnerShares = winner === "Up" ? (positionsRef.current.Up ?? 0) : winner === "Down" ? (positionsRef.current.Down ?? 0) : 0;
    const netSpent = (cashFlowRef.current.spent ?? 0) - (cashFlowRef.current.received ?? 0);
    const settlementPnl = winner ? winnerShares - netSpent : null;

    const windowTradeStats = computeTradeStats(trades);
    const windowSkippedReasonCounts = computeSkippedReasonCounts(trades, { liveOnly: true });
    const entry = {
      id: `${slug ?? "window"}-${Date.now()}`,
      ts: Date.now(),
      asset,
      marketSlug: slug,
      startTime,
      endTime,
      positions: { ...positionsRef.current },
      avgCost: { ...avgCostRef.current },
      notional: {
        Up: (avgCostRef.current.Up ?? 0) * (positionsRef.current.Up ?? 0),
        Down: (avgCostRef.current.Down ?? 0) * (positionsRef.current.Down ?? 0)
      },
      pnl: { up: upPnl, down: downPnl, total },
      settlement: { winner, winnerShares, pnl: settlementPnl, netSpent },
      cashFlow: { ...cashFlowRef.current, netSpent },
      marks: { up: upMark, down: downMark },
      trades: windowTradeStats.events,
      tradeStats: windowTradeStats,
      skippedReasonCounts: windowSkippedReasonCounts
    };

    setWindowHistory((prev) => [entry, ...prev].slice(0, 200));
  };

  useEffect(() => {
    let alive = true;
    let rolloverTimer = null;

    const clearTimers = () => {
      if (rolloverTimer) clearTimeout(rolloverTimer);
      rolloverTimer = null;
    };

    const scheduleRollover = (endTime) => {
      clearTimers();
      if (!endTime) return;
      const endMs = new Date(endTime).getTime();
      if (!Number.isFinite(endMs)) return;
      const delay = Math.max(0, endMs - Date.now());
      rolloverTimer = setTimeout(() => {
        loadMeta();
      }, delay);
    };

    async function loadMeta() {
      setMetaLoading(true);
      setMetaErr(null);
      try {
        const res = await fetch(`/api/snapshot?asset=${encodeURIComponent(activeAsset)}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setMeta(j);
        scheduleRollover(j?.polymarket?.marketEndTime ?? null);
      } catch (err) {
        if (!alive) return;
        setMetaErr(err?.message ?? String(err));
      } finally {
        if (!alive) return;
        setMetaLoading(false);
      }
    }

    loadMeta();
    return () => {
      alive = false;
      clearTimers();
    };
  }, [activeAsset]);

  useEffect(() => {
    const upTokenId = activeTokens?.upTokenId ?? null;
    const downTokenId = activeTokens?.downTokenId ?? null;

    setClobByAsset((prev) => ({
      ...prev,
      [activeAsset]: {
        marketSlug: activeMarketSlug,
        up: null,
        down: null
      }
    }));

    const ids = [upTokenId, downTokenId].filter(Boolean);
    if (!ids.length) {
      clobRef.current?.close?.();
      clobRef.current = null;
      return;
    }

    clobRef.current?.close?.();

    const c = connectClobMarketWs({
      assetIds: ids,
      onBestBidAsk: ({ assetId, bestBid, bestAsk }) => {
        setClobByAsset((prev) => {
          const cur = prev[activeAsset] ?? { marketSlug: activeMarketSlug, up: null, down: null };
          const next = { ...cur, marketSlug: activeMarketSlug };
          if (assetId === String(upTokenId)) next.up = { bid: bestBid, ask: bestAsk };
          if (assetId === String(downTokenId)) next.down = { bid: bestBid, ask: bestAsk };
          return { ...prev, [activeAsset]: next };
        });
      }
    });

    clobRef.current = c;
    return () => c?.close?.();
  }, [activeAsset, activeMarketSlug, activeTokens?.upTokenId, activeTokens?.downTokenId]);

  useEffect(() => {
    const askBidReady = [upAsk, upBid, downAsk, downBid].every((v) => Number.isFinite(v));
    if (!askBidReady) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const next = {
      upBuy: appendPoint(ratioSeriesRef.current.upBuy ?? [], { time: nowSec, value: upBuyRatio }),
      upSell: appendPoint(ratioSeriesRef.current.upSell ?? [], { time: nowSec, value: upSellRatio }),
      downBuy: appendPoint(ratioSeriesRef.current.downBuy ?? [], { time: nowSec, value: downBuyRatio }),
      downSell: appendPoint(ratioSeriesRef.current.downSell ?? [], { time: nowSec, value: downSellRatio })
    };

    const endMs = meta?.polymarket?.marketEndTime ? new Date(meta.polymarket.marketEndTime).getTime() : null;
    const nextTimeLeft = Number.isFinite(endMs) ? Math.max(0, Math.floor((endMs - Date.now()) / 1000)) : null;
    if (nextTimeLeft !== timeLeftRef.current) {
      timeLeftRef.current = nextTimeLeft;
      setTimeLeftSec(nextTimeLeft);
    }

    ratioSeriesRef.current = next;
    setRatioSeries(next);

    if (!tradeActive) return;
    if (liveAllowed && liveOrderBusyRef.current) return;

    const sizeFromRatio = (ratio, threshold, side, outcome) => {
      const dojiMult = side === "BUY"
        ? (dojiActive ? (dojiAllowBuys ? dojiSizeMult : 0) : 1)
        : 1;
      if (!Number.isFinite(ratio) || !Number.isFinite(threshold) || threshold <= 0) {
        const fallbackSize = baseSize * sizeAdjust * dojiMult;
        const fallbackPrice = side === "BUY"
          ? (outcome === "Up" ? upAsk : downAsk)
          : (outcome === "Up" ? upBid : downBid);
        return normalizeTradeSize({
          rawSize: fallbackSize,
          side,
          price: fallbackPrice,
          maxSize,
          available: positionsRef.current[outcome] ?? 0
        });
      }
      const multiplier = Math.max(1, ratio / threshold);
      const sized = baseSize * sizeAdjust * dojiMult * Math.pow(multiplier, sizeScale);
      const tradePrice = side === "BUY"
        ? (outcome === "Up" ? upAsk : downAsk)
        : (outcome === "Up" ? upBid : downBid);
      return normalizeTradeSize({
        rawSize: sized,
        side,
        price: tradePrice,
        maxSize,
        available: positionsRef.current[outcome] ?? 0
      });
    };

    const shouldTrade = (key) => {
      const last = lastTradeRef.current[key] ?? 0;
      return nowSec - last >= cooldownSec;
    };

    const favoredOutcome = Number.isFinite(upAsk) && Number.isFinite(downAsk)
      ? (upAsk >= downAsk ? "Up" : "Down")
      : null;
    const requireFavoredPrimaryBuys = true;
    const inLoserBuyClamp = Number.isFinite(nextTimeLeft) && nextTimeLeft <= endClampLoserBuySec;
    const inWinnerHold = Number.isFinite(nextTimeLeft) && nextTimeLeft <= endClampWinnerSellSec;
    const upSpreadOk = Number.isFinite(upSpread) && upSpread <= upSpreadLimit;
    const downSpreadOk = Number.isFinite(downSpread) && downSpread <= downSpreadLimit;

    const recordTrade = ({
      outcome,
      side,
      price,
      ratio,
      momentum,
      threshold,
      reason,
      isHedge = false,
      hedgeOf = null,
      sizeOverride = null,
      requestedSize = null,
      filledSize = null,
      avgPrice = null,
      status = "filled",
      mode = "sim",
      orderId = null,
      apiAttempted = false
    }) => {
      const desiredSize = requestedSize ?? sizeOverride ?? sizeFromRatio(ratio, threshold, side, outcome);
      const tradePrice = Number.isFinite(avgPrice) ? avgPrice : price;
      const size = Number.isFinite(filledSize) ? filledSize : desiredSize;
      const applyFill = Number.isFinite(size) && size > 0 && Number.isFinite(tradePrice);
      const notional = applyFill ? size * tradePrice : 0;
      const prevPos = positionsRef.current[outcome] ?? 0;
      const prevAvg = avgCostRef.current[outcome] ?? 0;
      let nextPos = positionsRef.current;
      let nextAvgMap = avgCostRef.current;

      if (applyFill) {
        const nextPosValue = side === "BUY" ? prevPos + size : Math.max(0, prevPos - size);
        const nextAvg = side === "BUY"
          ? (nextPosValue > 0 ? ((prevAvg * prevPos) + (tradePrice * size)) / nextPosValue : 0)
          : (nextPosValue > 0 ? prevAvg : 0);
        nextPos = { ...positionsRef.current, [outcome]: nextPosValue };
        nextAvgMap = { ...avgCostRef.current, [outcome]: nextAvg };
        positionsRef.current = nextPos;
        avgCostRef.current = nextAvgMap;
        setPositions(nextPos);
        setAvgCost(nextAvgMap);
        const nextCashFlow = side === "BUY"
          ? {
              spent: (cashFlowRef.current.spent ?? 0) + notional,
              received: cashFlowRef.current.received ?? 0
            }
          : {
              spent: cashFlowRef.current.spent ?? 0,
              received: (cashFlowRef.current.received ?? 0) + notional
            };
        cashFlowRef.current = nextCashFlow;
        setCashFlow(nextCashFlow);
        setPositionNotional({
          Up: (nextAvgMap.Up ?? 0) * (nextPos.Up ?? 0),
          Down: (nextAvgMap.Down ?? 0) * (nextPos.Down ?? 0)
        });
      }

      const entry = {
        id: `${nowSec}-${outcome}-${side}-${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        time: nowSec,
        asset: activeAsset,
        outcome,
        side,
        price: tradePrice,
        ratio,
        momentum,
        size: applyFill ? size : 0,
        requestedSize: Number.isFinite(desiredSize) ? desiredSize : 0,
        notional,
        threshold,
        reason,
        positionAfter: nextPos[outcome],
        isHedge,
        hedgeOf,
        status,
        mode,
        orderId,
        apiAttempted
      };
      setTrades((prev) => [entry, ...prev].slice(0, 2000));
      return entry;
    };

    const executeTrade = async ({
      outcome,
      side,
      price,
      ratio,
      momentum,
      threshold,
      reason,
      isHedge = false,
      hedgeOf = null,
      sizeOverride = null
    }) => {
      const tokenId = outcome === "Up" ? activeTokens?.upTokenId : activeTokens?.downTokenId;

      // Price rounding MUST be directional for marketability:
      // - BUY should round UP (still crosses ask)
      // - SELL should round DOWN (still crosses bid)
      // Additionally, prefer using the actual BBO input (bid for SELL, ask for BUY) so the limit is marketable.
      const bboPrice = side === "SELL" ? (outcome === "Up" ? upBid : downBid) : (outcome === "Up" ? upAsk : downAsk);
      const basisPrice = Number.isFinite(bboPrice) ? bboPrice : price;
      const baseSubmitPrice = side === "SELL" ? floorTo(basisPrice, 2) : ceilTo(basisPrice, 2);

      // If we repeatedly get FAK no-match, nudge the limit price more aggressively in the marketable direction.
      // SELL: nudge down, BUY: nudge up.
      const retryKeyPreview = tokenId ? `${tokenId}:${side}` : null;
      const nudge = retryKeyPreview ? Number(livePriceNudgeByOrderRef.current?.[retryKeyPreview] ?? 0) : 0;
      const nudged = side === "SELL" ? (baseSubmitPrice - nudge) : (baseSubmitPrice + nudge);
      const submitPrice = clamp(roundTo(nudged, 2), MIN_BUY_PRICE, MAX_BUY_PRICE);

      // Ensure conditional balances are fresh for SELL sizing (polling is preferred over WS).
      if (side === "SELL" && tokenId) {
        const cached = conditionalAvailByTokenRef.current?.[tokenId];
        const stale = !cached?.ts || (Date.now() - cached.ts > BALANCE_STALE_MS);
        if (stale) {
          await refreshConditionalBalance(tokenId, { force: true });
        }
      }

      const rawDesiredSize = sizeOverride ?? sizeFromRatio(ratio, threshold, side, outcome);

      // For SELLs, prefer polled conditional token availability over local position tracking.
      // User WS can be unreliable in some deployments, and local positions can drift.
      const polledAvailable = side === "SELL" && tokenId
        ? (conditionalAvailByTokenRef.current?.[tokenId]?.available ?? null)
        : null;
      const effectiveAvailable = side === "SELL"
        ? (Number.isFinite(Number(polledAvailable)) ? Number(polledAvailable) : (positionsRef.current[outcome] ?? 0))
        : (positionsRef.current[outcome] ?? 0);

      const desiredSize = normalizeTradeSize({
        rawSize: rawDesiredSize,
        side,
        price: submitPrice,
        maxSize,
        available: effectiveAvailable
      });
      if (!Number.isFinite(desiredSize) || desiredSize <= 0) return null;
      const mode = liveAllowed ? "live" : "sim";

      if (!liveAllowed) {
        return recordTrade({
          outcome,
          side,
          price,
          ratio,
          momentum,
          threshold,
          reason,
          isHedge,
          hedgeOf,
          requestedSize: desiredSize,
          filledSize: desiredSize,
          avgPrice: price,
          status: "sim",
          mode,
          apiAttempted: false
        });
      }

      if (liveOrderBusyRef.current) return null;
      if (!tokenId) {
        return recordTrade({
          outcome,
          side,
          price,
          ratio,
          momentum,
          threshold,
          reason: `${reason} · missing tokenId`,
          isHedge,
          hedgeOf,
          requestedSize: desiredSize,
          filledSize: 0,
          status: "skipped",
          mode,
          apiAttempted: false
        });
      }

      const retryKey = `${tokenId}:${side}`;
      const nowMs = Date.now();
      if (nowMs < liveRetryAfterRef.current) return null;
      const noMatchRetryAt = Number(liveNoMatchRetryByOrderRef.current[retryKey] ?? 0);
      if (nowMs < noMatchRetryAt) return null;

      liveOrderBusyRef.current = true;
      try {
        if (isPriceOutOfTradableRange(submitPrice)) {
          const invalidPriceRetryAfter = Date.now() + LIVE_RETRY_BACKOFF_INVALID_PRICE_MS;
          const prevRetry = Number(liveNoMatchRetryByOrderRef.current[retryKey] ?? 0);
          liveNoMatchRetryByOrderRef.current[retryKey] = Math.max(prevRetry, invalidPriceRetryAfter);
          return recordTrade({
            outcome,
            side,
            price,
            ratio,
            momentum,
            threshold,
            reason: `${reason} · price out of tradable range ($${fmtNum(MIN_BUY_PRICE, 2)}-$${fmtNum(MAX_BUY_PRICE, 2)})`,
            isHedge,
            hedgeOf,
            requestedSize: desiredSize,
            filledSize: 0,
            status: "skipped",
            mode,
            apiAttempted: false
          });
        }
        const submitAmount = side === "BUY"
          ? ceilTo(desiredSize * submitPrice, 2)
          : floorTo(desiredSize, 2);
        if (!Number.isFinite(submitPrice) || submitPrice <= 0 || !Number.isFinite(submitAmount) || submitAmount <= 0) {
          return recordTrade({
            outcome,
            side,
            price,
            ratio,
            momentum,
            threshold,
            reason: `${reason} · invalid amount`,
            isHedge,
            hedgeOf,
            requestedSize: desiredSize,
            filledSize: 0,
            status: "skipped",
            mode,
            apiAttempted: false
          });
        }
        if (side === "BUY" && isBelowMin(submitAmount, LIVE_MIN_NOTIONAL_USD)) {
          return recordTrade({
            outcome,
            side,
            price,
            ratio,
            momentum,
            threshold,
            reason: `${reason} · buy amount below $${LIVE_MIN_NOTIONAL_USD} minimum`,
            isHedge,
            hedgeOf,
            requestedSize: desiredSize,
            filledSize: 0,
            status: "skipped",
            mode,
            apiAttempted: false
          });
        }
        if (side === "SELL" && isBelowMin(submitAmount * submitPrice, LIVE_MIN_NOTIONAL_USD)) {
          return recordTrade({
            outcome,
            side,
            price,
            ratio,
            momentum,
            threshold,
            reason: `${reason} · sell notional below $${LIVE_MIN_NOTIONAL_USD} minimum`,
            isHedge,
            hedgeOf,
            requestedSize: desiredSize,
            filledSize: 0,
            status: "skipped",
            mode,
            apiAttempted: false
          });
        }

        const res = await fetch("/api/trade/limit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenId,
            side,
            price: submitPrice,
            amount: submitAmount,
            market: true,
            orderType: "FAK",
            postOnly: false,
            awaitFill: true,
            maxWaitMs: LIVE_FILL_WAIT_MS,
            pollIntervalMs: LIVE_FILL_POLL_MS
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errorText = String(data?.error ?? "");
          if (isFakNoMatchError(errorText)) {
            const noMatchRetryAfter = Date.now() + LIVE_RETRY_BACKOFF_FAK_NO_MATCH_MS;
            const prevRetry = Number(liveNoMatchRetryByOrderRef.current[retryKey] ?? 0);
            liveNoMatchRetryByOrderRef.current[retryKey] = Math.max(prevRetry, noMatchRetryAfter);

            const prevNudge = Number(livePriceNudgeByOrderRef.current?.[retryKey] ?? 0);
            // Increase in 1-tick steps, capped.
            livePriceNudgeByOrderRef.current = {
              ...(livePriceNudgeByOrderRef.current ?? {}),
              [retryKey]: clamp(prevNudge + 0.01, 0, 0.05)
            };
          }
          if (isInsufficientBalanceAllowanceError(errorText)) {
            const balanceBackoffMs = side === "BUY"
              ? LIVE_RETRY_BACKOFF_COLLATERAL_MS
              : LIVE_RETRY_BACKOFF_CONDITIONAL_MS;
            liveRetryAfterRef.current = Math.max(liveRetryAfterRef.current, Date.now() + balanceBackoffMs);

            if (side === "SELL" && tokenId) {
              // Immediately refresh conditional availability so next attempt can clamp size correctly.
              await refreshConditionalBalance(tokenId, { force: true });
            }
          }
          if (isPriceOutOfRangeError(errorText)) {
            const invalidPriceRetryAfter = Date.now() + LIVE_RETRY_BACKOFF_INVALID_PRICE_MS;
            const prevRetry = Number(liveNoMatchRetryByOrderRef.current[retryKey] ?? 0);
            liveNoMatchRetryByOrderRef.current[retryKey] = Math.max(prevRetry, invalidPriceRetryAfter);
          }
          const detailAssetType = String(data?.details?.availableAssetType ?? "").toUpperCase();
          if (res.status === 409) {
            let backoffMs = LIVE_RETRY_BACKOFF_MS;
            if (detailAssetType === "COLLATERAL") backoffMs = LIVE_RETRY_BACKOFF_COLLATERAL_MS;
            else if (detailAssetType === "CONDITIONAL") backoffMs = LIVE_RETRY_BACKOFF_CONDITIONAL_MS;
            liveRetryAfterRef.current = Math.max(liveRetryAfterRef.current, Date.now() + backoffMs);
          }
          return recordTrade({
            outcome,
            side,
            price,
            ratio,
            momentum,
            threshold,
            reason: `${reason} · ${data?.error ?? "order failed"}`,
            isHedge,
            hedgeOf,
            requestedSize: desiredSize,
            filledSize: 0,
            status: "error",
            mode,
            orderId: data?.orderId ?? null,
            apiAttempted: true
          });
        }
        const orderId = data?.orderId ?? null;
        const apiFilledSize = Number(data?.filledSize ?? 0);
        const filledSize = Number.isFinite(apiFilledSize) ? Math.max(0, apiFilledSize) : 0;
        const avgPrice = Number.isFinite(Number(data?.avgPrice)) ? Number(data.avgPrice) : price;
        const status = filledSize > 0
          ? (filledSize < desiredSize ? "partial" : "filled")
          : "no-fill";
        if (status === "no-fill") {
          const noMatchRetryAfter = Date.now() + LIVE_RETRY_BACKOFF_FAK_NO_MATCH_MS;
          const prevRetry = Number(liveNoMatchRetryByOrderRef.current[retryKey] ?? 0);
          liveNoMatchRetryByOrderRef.current[retryKey] = Math.max(prevRetry, noMatchRetryAfter);

          const prevNudge = Number(livePriceNudgeByOrderRef.current?.[retryKey] ?? 0);
          livePriceNudgeByOrderRef.current = {
            ...(livePriceNudgeByOrderRef.current ?? {}),
            [retryKey]: clamp(prevNudge + 0.01, 0, 0.05)
          };
        } else {
          // Reset nudge once we get a fill.
          if (Number(livePriceNudgeByOrderRef.current?.[retryKey] ?? 0) > 0) {
            livePriceNudgeByOrderRef.current = {
              ...(livePriceNudgeByOrderRef.current ?? {}),
              [retryKey]: 0
            };
          }
        }
        const entry = recordTrade({
          outcome,
          side,
          price,
          ratio,
          momentum,
          threshold,
          reason,
          isHedge,
          hedgeOf,
          requestedSize: desiredSize,
          filledSize,
          avgPrice,
          status,
          mode,
          orderId,
          apiAttempted: true
        });
        return entry;
      } catch (err) {
        return recordTrade({
          outcome,
          side,
          price,
          ratio,
          momentum,
          threshold,
          reason: `${reason} · ${err?.message ?? "order failed"}`,
          isHedge,
          hedgeOf,
          requestedSize: desiredSize,
          filledSize: 0,
          status: "error",
          mode,
          apiAttempted: true
        });
      } finally {
        liveOrderBusyRef.current = false;
      }
    };

    const signals = [
      {
        key: "up-buy",
        enabled: enableUpBuy,
        outcome: "Up",
        side: "BUY",
        price: upAsk,
        ratio: upBuyRatio,
        momentum: computeMomentum(next.upBuy, momentumWindowSec),
        threshold: buyRatioMinAdj,
        minMomentum: minMomentumAdj,
        spreadOk: upSpreadOk
      },
      {
        key: "up-sell",
        enabled: enableUpSell,
        outcome: "Up",
        side: "SELL",
        price: upBid,
        ratio: upSellRatio,
        momentum: computeMomentum(next.upSell, momentumWindowSec),
        threshold: sellRatioMinAdj,
        minMomentum: minMomentumAdj,
        spreadOk: upSpreadOk
      },
      {
        key: "down-buy",
        enabled: enableDownBuy,
        outcome: "Down",
        side: "BUY",
        price: downAsk,
        ratio: downBuyRatio,
        momentum: computeMomentum(next.downBuy, momentumWindowSec),
        threshold: buyRatioMinAdj,
        minMomentum: minMomentumAdj,
        spreadOk: downSpreadOk
      },
      {
        key: "down-sell",
        enabled: enableDownSell,
        outcome: "Down",
        side: "SELL",
        price: downBid,
        ratio: downSellRatio,
        momentum: computeMomentum(next.downSell, momentumWindowSec),
        threshold: sellRatioMinAdj,
        minMomentum: minMomentumAdj,
        spreadOk: downSpreadOk
      }
    ];

    const winnerPriceUp = Number.isFinite(upBid) ? upBid : upMid;
    const winnerPriceDown = Number.isFinite(downBid) ? downBid : downMid;
    const winnerSide = Number.isFinite(winnerPriceUp) && Number.isFinite(winnerPriceDown)
      ? (winnerPriceUp >= winnerPriceDown ? "Up" : "Down")
      : null;
    const loserSide = winnerSide ? (winnerSide === "Up" ? "Down" : "Up") : null;
    const winnerShares = winnerSide ? (positionsRef.current[winnerSide] ?? 0) : 0;
    const netSpentNow = (cashFlowRef.current.spent ?? 0) - (cashFlowRef.current.received ?? 0);
    const settlementNow = winnerSide ? winnerShares - netSpentNow : null;
    const capNow = winnerSide ? winnerShares * effectiveCapMult : null;
    const prevWinnerSide = lastWinnerSideRef.current;
    const winnerFlip = Boolean(
      flipRebalanceEnabled
        && lateWindowActive
        && winnerSide
        && prevWinnerSide
        && prevWinnerSide !== winnerSide
    );
    if (winnerSide) lastWinnerSideRef.current = winnerSide;

    const rebalanceBypassSpread = lateRebalanceOverride && lateWindowActive;
    const dojiNeutralActive = lateDojiUnwind && lateWindowActive && dojiActive;

    const runTrading = async () => {
      if (dojiNeutralActive) {
        const upNotional = (avgCostRef.current.Up ?? 0) * (positionsRef.current.Up ?? 0);
        const downNotional = (avgCostRef.current.Down ?? 0) * (positionsRef.current.Down ?? 0);
        const unwindSide = upNotional >= downNotional ? "Up" : "Down";
        const unwindBid = unwindSide === "Up" ? upBid : downBid;
        const unwindShares = positionsRef.current[unwindSide] ?? 0;
        const unwindSpreadOk = unwindSide === "Up" ? upSpreadOk : downSpreadOk;
        const canUnwind = Number.isFinite(unwindBid)
          && unwindBid > 0
          && unwindShares > 0
          && (rebalanceBypassSpread || unwindSpreadOk);
        const rebalanceKey = "rebalance-doji";
        if (canUnwind && (rebalanceIgnoreCooldown || shouldTrade(rebalanceKey))) {
          const baseRebalanceSize = Math.min(maxSize, baseSize * sizeAdjust * maxRebalanceSizeMult);
          const size = Math.max(0, Math.min(baseRebalanceSize, unwindShares));
          if (size > 0) {
            const ratio = unwindSide === "Up" ? upSellRatio : downSellRatio;
            const momentum = unwindSide === "Up"
              ? computeMomentum(next.upSell, momentumWindowSec)
              : computeMomentum(next.downSell, momentumWindowSec);
            const entry = await executeTrade({
              outcome: unwindSide,
              side: "SELL",
              price: unwindBid,
              ratio,
              momentum,
              threshold: "doji",
              reason: "late doji unwind · neutralize inventory",
              sizeOverride: size
            });
            if (entry) {
              lastTradeRef.current[rebalanceKey] = nowSec;
              return;
            }
          }
        }
      }

      const needsRebalance = winnerSide
        && (winnerFlip
          || (settlementNow !== null && settlementNow < effectiveSettlementBuffer)
          || (capNow !== null && netSpentNow > capNow));

      if (needsRebalance && loserSide) {
        const loserShares = positionsRef.current[loserSide] ?? 0;
        const winnerAsk = winnerSide === "Up" ? upAsk : downAsk;
        const loserBid = loserSide === "Up" ? upBid : downBid;
        const winnerSpreadOk = winnerSide === "Up" ? upSpreadOk : downSpreadOk;
        const loserSpreadOk = loserSide === "Up" ? upSpreadOk : downSpreadOk;
        const canBuyWinner = Number.isFinite(winnerAsk)
          && winnerAsk >= MIN_BUY_PRICE
          && winnerAsk < MAX_BUY_PRICE
          && (rebalanceBypassSpread || winnerSpreadOk);
        const canSellLoser = Number.isFinite(loserBid)
          && loserBid > 0
          && loserShares > 0
          && (rebalanceBypassSpread || loserSpreadOk);
        let action = null;
        if (rebalanceMode === "buy-first") {
          action = canBuyWinner ? "buy" : (canSellLoser ? "sell" : null);
        } else if (rebalanceMode === "balanced") {
          if (canBuyWinner && canSellLoser) {
            const buyGain = Math.max(0, 1 - winnerAsk);
            const sellGain = Math.max(0, loserBid);
            action = buyGain >= sellGain ? "buy" : "sell";
          } else {
            action = canSellLoser ? "sell" : (canBuyWinner ? "buy" : null);
          }
        } else {
          action = canSellLoser ? "sell" : (canBuyWinner ? "buy" : null);
        }

        if (action === "buy" && capNow !== null && Number.isFinite(winnerAsk) && effectiveCapMult <= winnerAsk && canSellLoser) {
          action = "sell";
        }

        if (action) {
          const rebalanceKey = `rebalance-${action}-${winnerSide}`;
          if (rebalanceIgnoreCooldown || winnerFlip || shouldTrade(rebalanceKey)) {
            const baseRebalanceSize = Math.min(maxSize, baseSize * sizeAdjust * maxRebalanceSizeMult);
            const gapBuffer = settlementNow !== null ? Math.max(0, effectiveSettlementBuffer - settlementNow) : 0;
            const gapCap = capNow !== null ? Math.max(0, netSpentNow - capNow) : 0;
            if (action === "sell" && canSellLoser) {
              const perShareGain = Math.max(1e-6, loserBid);
              const neededShares = (Math.max(gapBuffer, gapCap) / perShareGain) || baseRebalanceSize;
              const targetSize = Math.min(baseRebalanceSize, neededShares);
              const size = Math.max(0, Math.min(targetSize, loserShares));
              if (size > 0) {
                const ratio = loserSide === "Up" ? upSellRatio : downSellRatio;
                const momentum = loserSide === "Up"
                  ? computeMomentum(next.upSell, momentumWindowSec)
                  : computeMomentum(next.downSell, momentumWindowSec);
                const entry = await executeTrade({
                  outcome: loserSide,
                  side: "SELL",
                  price: loserBid,
                  ratio,
                  momentum,
                  threshold: "rebalance",
                  reason: `rebalance sell loser · settle ${fmtUsd(settlementNow, 2)} < ${fmtUsd(effectiveSettlementBuffer, 2)} or netSpent ${fmtUsd(netSpentNow, 2)} > cap ${fmtUsd(capNow, 2)}`,
                  sizeOverride: size
                });
                if (entry) {
                  lastTradeRef.current[rebalanceKey] = nowSec;
                  return;
                }
              }
            }
            if (action === "buy" && canBuyWinner) {
              const perShareGain = Math.max(1e-6, 1 - winnerAsk);
              let neededShares = gapBuffer / perShareGain;
              if (gapCap > 0 && effectiveCapMult > winnerAsk) {
                neededShares = Math.max(neededShares, gapCap / Math.max(1e-6, effectiveCapMult - winnerAsk));
              }
              const targetSize = Math.min(baseRebalanceSize, neededShares || baseRebalanceSize);
              const ratio = winnerSide === "Up" ? upBuyRatio : downBuyRatio;
              const momentum = winnerSide === "Up"
                ? computeMomentum(next.upBuy, momentumWindowSec)
                : computeMomentum(next.downBuy, momentumWindowSec);
              const entry = await executeTrade({
                outcome: winnerSide,
                side: "BUY",
                price: winnerAsk,
                ratio,
                momentum,
                threshold: "rebalance",
                reason: `rebalance buy winner · settle ${fmtUsd(settlementNow, 2)} < ${fmtUsd(effectiveSettlementBuffer, 2)} or netSpent ${fmtUsd(netSpentNow, 2)} > cap ${fmtUsd(capNow, 2)}`,
                sizeOverride: targetSize
              });
              if (entry) {
                lastTradeRef.current[rebalanceKey] = nowSec;
                return;
              }
            }
          }
        }
      }

      const outcomeLock = new Set();
      for (const signal of signals) {
        if (!signal.enabled) continue;
        if (!Number.isFinite(signal.price) || !Number.isFinite(signal.ratio)) continue;
        if (!signal.spreadOk) continue;
        if (signal.side === "BUY" && dojiActive && !dojiAllowBuys) continue;
        if (signal.side === "BUY" && (signal.price >= MAX_BUY_PRICE || signal.price < MIN_BUY_PRICE)) continue;
        if (signal.side === "BUY" && requireFavoredPrimaryBuys && favoredOutcome && signal.outcome !== favoredOutcome) continue;
        if (signal.side === "SELL" && (positionsRef.current[signal.outcome] ?? 0) <= 0) continue;
        if (signal.side === "BUY" && inLoserBuyClamp && favoredOutcome && signal.outcome !== favoredOutcome) continue;
        if (signal.side === "SELL" && inWinnerHold && favoredOutcome && signal.outcome === favoredOutcome) continue;
        const passesRatio = signal.ratio >= signal.threshold;
        const favored = signal.outcome === "Up"
          ? Number.isFinite(upAsk) && Number.isFinite(downAsk) && upAsk >= downAsk
          : Number.isFinite(upAsk) && Number.isFinite(downAsk) && downAsk >= upAsk;
        const passesWinnerBuy = signal.side === "BUY"
          && Number.isFinite(winnerBuyMinPrice)
          && signal.price >= winnerBuyMinPrice
          && (!winnerBuyRequireFavored || favored);
        if (signal.side === "BUY") {
          if (!passesRatio && !passesWinnerBuy) continue;
        } else if (!passesRatio) {
          continue;
        }
        if (!Number.isFinite(signal.momentum) || signal.momentum < signal.minMomentum) continue;
        if (!shouldTrade(signal.key)) continue;
        if (outcomeLock.has(signal.outcome)) continue;
        outcomeLock.add(signal.outcome);
        lastTradeRef.current[signal.key] = nowSec;
        const reasonParts = [];
        if (passesRatio) reasonParts.push(`ratio>=${fmtNum(signal.threshold, 2)}`);
        if (passesWinnerBuy && !passesRatio) reasonParts.push(`favored price>=${fmtNum(winnerBuyMinPrice, 2)}`);
        reasonParts.push(`mom>=${fmtNum(signal.minMomentum, 4)}`);
        const entry = await executeTrade({
          outcome: signal.outcome,
          side: signal.side,
          price: signal.price,
          ratio: signal.ratio,
          momentum: signal.momentum,
          threshold: signal.threshold,
          reason: reasonParts.join(" & ")
        });
        if (!entry || entry.isHedge || entry.status === "no-fill" || entry.status === "error") continue;
        if (!hedgeEnabled || entry.side !== "BUY") continue;

        const hedgeOutcome = entry.outcome === "Up" ? "Down" : "Up";
        const hedgePrice = hedgeOutcome === "Up" ? upAsk : downAsk;
        const hedgeRatio = hedgeOutcome === "Up" ? upBuyRatio : downBuyRatio;
        const hedgeMomentum = hedgeOutcome === "Up"
          ? computeMomentum(next.upBuy, momentumWindowSec)
          : computeMomentum(next.downBuy, momentumWindowSec);

        if (!Number.isFinite(hedgePrice) || !Number.isFinite(hedgeRatio)) continue;
        const hedgeSpreadOk = hedgeOutcome === "Up" ? upSpreadOk : downSpreadOk;
        if (!hedgeSpreadOk) continue;
        if (inLoserBuyClamp && favoredOutcome && hedgeOutcome !== favoredOutcome) continue;
        if (hedgePrice >= MAX_BUY_PRICE || hedgePrice < MIN_BUY_PRICE) continue;
        if (hedgeRatioMax < hedgeRatioMin) continue;
        if (hedgeRatio < hedgeRatioMin || hedgeRatio > hedgeRatioMax) continue;
        if (!Number.isFinite(hedgeSizeMult) || hedgeSizeMult <= 0) continue;

        await executeTrade({
          outcome: hedgeOutcome,
          side: "BUY",
          price: hedgePrice,
          ratio: hedgeRatio,
          momentum: hedgeMomentum,
          threshold: `${fmtNum(hedgeRatioMin, 2)}-${fmtNum(hedgeRatioMax, 2)}`,
          reason: `hedge ${entry.outcome} BUY · ratio in [${fmtNum(hedgeRatioMin, 2)}, ${fmtNum(hedgeRatioMax, 2)}]`,
          isHedge: true,
          hedgeOf: entry.id,
          sizeOverride: Math.min(maxSize, entry.size * hedgeSizeMult)
        });
      }
    };

    void runTrading();
  }, [
    upAsk,
    upBid,
    downAsk,
    downBid,
    upBuyRatio,
    upSellRatio,
    downBuyRatio,
    downSellRatio,
    tradeActive,
    liveAllowed,
    buyRatioMinAdj,
    sellRatioMinAdj,
    minMomentumAdj,
    momentumWindowSec,
    baseSize,
    maxSize,
    sizeScale,
    sizeAdjust,
    cooldownSec,
    dojiActive,
    dojiAllowBuys,
    dojiSizeMult,
    lateWindowActive,
    flipRebalanceEnabled,
    rebalanceIgnoreCooldown,
    lateRebalanceOverride,
    lateDojiUnwind,
    hedgeEnabled,
    hedgeRatioMin,
    hedgeRatioMax,
    hedgeSizeMult,
    effectiveSettlementBuffer,
    effectiveCapMult,
    maxRebalanceSizeMult,
    rebalanceMode,
    winnerBuyMinPrice,
    winnerBuyRequireFavored,
    endClampLoserBuySec,
    endClampWinnerSellSec,
    enableUpBuy,
    enableUpSell,
    enableDownBuy,
    enableDownSell,
    upMid,
    downMid,
    upSpread,
    downSpread,
    upSpreadLimit,
    downSpreadLimit,
    activeTokens?.upTokenId,
    activeTokens?.downTokenId,
    activeAsset
  ]);

  const markers = useMemo(() => {
    const map = { upBuy: [], upSell: [], downBuy: [], downSell: [] };
    for (const trade of trades) {
      if (!Number.isFinite(trade.size) || trade.size <= 0) continue;
      if (trade.status === "no-fill" || trade.status === "error") continue;
      const modeTag = trade.mode === "live" ? "L" : "S";
      const marker = {
        time: trade.time,
        position: trade.side === "BUY" ? "belowBar" : "aboveBar",
        color: trade.outcome === "Up"
          ? (trade.side === "BUY" ? "#45ffb2" : "#59d7ff")
          : (trade.side === "BUY" ? "#ffcc66" : "#ff5c7a"),
        shape: trade.side === "BUY" ? "arrowUp" : "arrowDown",
        text: `${modeTag}${trade.isHedge ? " H" : ""} ${trade.outcome} ${trade.side} ${fmtNum(trade.size, 0)}`
      };
      if (trade.outcome === "Up" && trade.side === "BUY") map.upBuy.push(marker);
      if (trade.outcome === "Up" && trade.side === "SELL") map.upSell.push(marker);
      if (trade.outcome === "Down" && trade.side === "BUY") map.downBuy.push(marker);
      if (trade.outcome === "Down" && trade.side === "SELL") map.downSell.push(marker);
    }
    return map;
  }, [trades]);

  const resetSim = () => {
    setTrades([]);
    const empty = { upBuy: [], upSell: [], downBuy: [], downSell: [] };
    setRatioSeries(empty);
    ratioSeriesRef.current = empty;
    positionsRef.current = { Up: 0, Down: 0 };
    setPositions({ Up: 0, Down: 0 });
    avgCostRef.current = { Up: 0, Down: 0 };
    setAvgCost({ Up: 0, Down: 0 });
    setPositionNotional({ Up: 0, Down: 0 });
    cashFlowRef.current = { spent: 0, received: 0 };
    setCashFlow({ spent: 0, received: 0 });
    setTimeLeftSec(null);
    lastTradeRef.current = {};
    liveRetryAfterRef.current = 0;
    liveNoMatchRetryByOrderRef.current = {};
    lastWinnerSideRef.current = null;
  };

  const stopTrading = () => {
    setTradeActive(false);
    setTradeArmed(false);
    setTradeNotice("Trading stopped.");
    if (tradeStartTimerRef.current) clearTimeout(tradeStartTimerRef.current);
    tradeStartTimerRef.current = null;
  };

  const startTrading = () => {
    const now = Date.now();
    const startMs = meta?.polymarket?.marketStartTime ? new Date(meta.polymarket.marketStartTime).getTime() : null;
    const endMs = meta?.polymarket?.marketEndTime ? new Date(meta.polymarket.marketEndTime).getTime() : null;
    if (tradeStartTimerRef.current) clearTimeout(tradeStartTimerRef.current);
    tradeStartTimerRef.current = null;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setTradeActive(false);
      setTradeArmed(true);
      setTradeNotice("Queued for next window.");
      return;
    }
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      if (now < startMs) {
        setTradeActive(false);
        setTradeArmed(true);
        const label = new Date(startMs).toLocaleTimeString();
        setTradeNotice(`Queued for ${label}.`);
        tradeStartTimerRef.current = setTimeout(() => {
          setTradeActive(true);
          setTradeArmed(false);
          setTradeNotice(null);
        }, Math.max(0, startMs - now));
        return;
      }
      if (now >= startMs && now <= endMs) {
        setTradeActive(false);
        setTradeArmed(true);
        setTradeNotice("Queued for next window.");
        return;
      }
      setTradeActive(false);
      setTradeArmed(true);
      setTradeNotice("Queued for next window.");
      return;
    }
    setTradeActive(true);
    setTradeArmed(false);
    setTradeNotice(null);
  };

  const calcSizePreview = (ratio, threshold, side, outcome) => {
    if (!Number.isFinite(ratio) || !Number.isFinite(threshold) || threshold <= 0) return 0;
    const multiplier = Math.max(1, ratio / threshold);
    const dojiMult = side === "BUY"
      ? (dojiActive ? (dojiAllowBuys ? dojiSizeMult : 0) : 1)
      : 1;
    const sized = Math.min(maxSize, baseSize * sizeAdjust * dojiMult * Math.pow(multiplier, sizeScale));
    const previewPrice = side === "BUY"
      ? (outcome === "Up" ? upAsk : downAsk)
      : (outcome === "Up" ? upBid : downBid);
    return normalizeTradeSize({
      rawSize: sized,
      side,
      price: previewPrice,
      maxSize,
      available: positions[outcome] ?? 0
    });
  };

  const pnl = useMemo(() => {
    const fallbackUp = Number.isFinite(lastBboRef.current.upBid) ? lastBboRef.current.upBid : null;
    const fallbackDown = Number.isFinite(lastBboRef.current.downBid) ? lastBboRef.current.downBid : null;
    const upMark = Number.isFinite(upBid) ? upBid : fallbackUp;
    const downMark = Number.isFinite(downBid) ? downBid : fallbackDown;
    const upPnl = upMark !== null ? (positions.Up ?? 0) * (upMark - (avgCost.Up ?? 0)) : null;
    const downPnl = downMark !== null ? (positions.Down ?? 0) * (downMark - (avgCost.Down ?? 0)) : null;
    const total = upPnl !== null && downPnl !== null ? upPnl + downPnl : null;
    const winner = upMark === null || downMark === null ? null : (upMark >= downMark ? "Up" : "Down");
    const winnerShares = winner === "Up" ? (positions.Up ?? 0) : winner === "Down" ? (positions.Down ?? 0) : 0;
    const netSpent = (cashFlow.spent ?? 0) - (cashFlow.received ?? 0);
    const settlement = winner ? winnerShares - netSpent : null;
    const safeUp = upPnl ?? 0;
    const safeDown = downPnl ?? 0;
    const safeTotal = total ?? (safeUp + safeDown);
    const safeWinner = winner ?? (fallbackUp !== null && fallbackDown !== null ? (fallbackUp >= fallbackDown ? "Up" : "Down") : "Up");
    const safeSettlement = settlement ?? (safeWinner === "Up"
      ? (positions.Up ?? 0) - netSpent
      : (positions.Down ?? 0) - netSpent);
    return {
      upPnl,
      downPnl,
      total,
      settlement,
      winner,
      netSpent,
      safe: {
        up: safeUp,
        down: safeDown,
        total: safeTotal,
        winner: safeWinner,
        settlement: safeSettlement
      }
    };
  }, [positions, avgCost, upBid, downBid, cashFlow]);

  const tradeStats = useMemo(() => {
    const current = computeTradeStats(trades);
    const session = {
      events: current.events,
      liveEvents: current.liveEvents,
      apiAttempts: current.apiAttempts,
      liveApiAttempts: current.liveApiAttempts,
      filled: current.filled,
      liveFilled: current.liveFilled,
      failedApi: current.failedApi,
      liveFailedApi: current.liveFailedApi,
      skipped: current.skipped,
      liveSkipped: current.liveSkipped
    };
    for (const entry of windowHistory) {
      if (entry?.asset && entry.asset !== activeAsset) continue;
      const s = entry?.tradeStats;
      if (s && Number.isFinite(s.events)) {
        session.events += Number(s.events) || 0;
        session.liveEvents += Number(s.liveEvents) || 0;
        session.apiAttempts += Number(s.apiAttempts) || 0;
        session.liveApiAttempts += Number(s.liveApiAttempts) || 0;
        session.filled += Number(s.filled) || 0;
        session.liveFilled += Number(s.liveFilled) || 0;
        session.failedApi += Number(s.failedApi) || 0;
        session.liveFailedApi += Number(s.liveFailedApi) || 0;
        session.skipped += Number(s.skipped) || 0;
        session.liveSkipped += Number(s.liveSkipped) || 0;
      } else {
        session.events += Number(entry?.trades) || 0;
      }
    }
    return { current, session };
  }, [trades, windowHistory, activeAsset]);

  const skippedReasonStats = useMemo(() => {
    const currentCounts = computeSkippedReasonCounts(trades, { liveOnly: true });
    let sessionCounts = { ...currentCounts };
    for (const entry of windowHistory) {
      if (entry?.asset && entry.asset !== activeAsset) continue;
      sessionCounts = mergeReasonCounts(sessionCounts, entry?.skippedReasonCounts ?? {});
    }
    return {
      currentRows: reasonCountsToRows(currentCounts),
      sessionRows: reasonCountsToRows(sessionCounts)
    };
  }, [trades, windowHistory, activeAsset]);

  return (
    <div className="container">
      <div className="header">
        <div className="brand">
          <div className="h1">Trend Sizing Trader</div>
          <div className="sub">Automated payout-ratio gating with live CLOB BBO.</div>
        </div>
        <div className="pills">
          <span className="pill">Market: <span className="mono">{activeMarketSlug ?? "-"}</span></span>
          <span className="pill">Meta: <span className="mono">{metaLoading ? "loading" : metaErr ? "error" : "live"}</span></span>
          <span className="pill">Trade: <span className="mono">{tradeActive ? (liveAllowed ? "live" : "sim") : tradeArmed ? "armed" : "stopped"}</span></span>
          <span className="pill">Mode: <span className="mono">{liveAllowed ? "live" : "sim"}</span></span>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 12 }}>
        {TAB_ORDER.map((tab) => (
          <button
            key={tab.asset}
            className={`tab ${activeAsset === tab.asset ? "tabActive" : ""}`}
            onClick={() => setActiveAsset(tab.asset)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {metaErr ? <div className="error">{metaErr}</div> : null}

      <div className="grid">
        <section className="card overflowVisible">
          <div className="cardTop">
            <div className="cardTitle">Payout Ratio Chart</div>
            <div className="ratioLegend">
              <span className="ratioTag upBuy">Up Buy</span>
              <span className="ratioTag upSell">Up Sell</span>
              <span className="ratioTag downBuy">Down Buy</span>
              <span className="ratioTag downSell">Down Sell</span>
            </div>
          </div>
          <div className="cardBody">
            <div className="chartShell">
              <RatioChart series={ratioSeries} markers={markers} />
              {ratioSeries.upBuy.length === 0 ? (
                <div className="chartEmpty">Waiting for CLOB best bid/ask…</div>
              ) : null}
            </div>
            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Trade Information</div>
              <div className="tradeTableScroll">
                <table className="tradeTable">
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>API Attempts</th>
                      <th>Filled</th>
                      <th>Failed API</th>
                      <th>Skipped</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Window</td>
                      <td className="mono">{fmtNum(tradeStats.current.liveApiAttempts, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.current.liveFilled, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.current.liveFailedApi, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.current.liveSkipped, 0)}</td>
                    </tr>
                    <tr>
                      <td>Session</td>
                      <td className="mono">{fmtNum(tradeStats.session.liveApiAttempts, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.session.liveFilled, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.session.liveFailedApi, 0)}</td>
                      <td className="mono">{fmtNum(tradeStats.session.liveSkipped, 0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="tradeControlHint" style={{ marginTop: 8 }}>
                Last sync: {Number.isFinite(lastSyncTs)
                  ? new Date(lastSyncTs).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                    second: "2-digit",
                    timeZoneName: "short"
                  })
                  : "-"}
              </div>
              <div className="tradeInfoReasons">
                <div className="tradeInfoReasonsBlock">
                  <div className="tradeInfoReasonsTitle">Window skipped reasons</div>
                  {skippedReasonStats.currentRows.length ? (
                    <div className="tradeInfoReasonsList">
                      {skippedReasonStats.currentRows.map(([reason, count]) => (
                        <div key={`window-${reason}`} className="tradeInfoReasonRow">
                          <span>{reason}</span>
                          <span className="mono">{fmtNum(count, 0)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="tradeHistoryEmpty">No skipped reasons yet.</div>
                  )}
                </div>
                <div className="tradeInfoReasonsBlock">
                  <div className="tradeInfoReasonsTitle">Session skipped reasons</div>
                  {skippedReasonStats.sessionRows.length ? (
                    <div className="tradeInfoReasonsList">
                      {skippedReasonStats.sessionRows.map(([reason, count]) => (
                        <div key={`session-${reason}`} className="tradeInfoReasonRow">
                          <span>{reason}</span>
                          <span className="mono">{fmtNum(count, 0)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="tradeHistoryEmpty">No skipped reasons yet.</div>
                  )}
                </div>
              </div>
            </div>
            <div className="chartBelowGrid">
              <div className="tradeHistory">
                <div className="tradeHistoryHeader">
                  <div className="cardTitle">Live Ratios</div>
                  <div className="tradeHistoryMeta mono">{fmtNum(ratioSeries.upBuy.length, 0)} pts</div>
                </div>
                <div className="tradeHistoryList">
                  <div className="tradeHistoryItem">
                    <div className="tradeHistoryRow">
                      <span>Up Ask/Bid</span>
                      <span className="mono">{fmtUsd(upAsk, 2)} / {fmtUsd(upBid, 2)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Up Buy/Sell Ratio</span>
                      <span className="mono">{fmtRatio(upBuyRatio, 2)} / {fmtRatio(upSellRatio, 2)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Down Ask/Bid</span>
                      <span className="mono">{fmtUsd(downAsk, 2)} / {fmtUsd(downBid, 2)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Down Buy/Sell Ratio</span>
                      <span className="mono">{fmtRatio(downBuyRatio, 2)} / {fmtRatio(downSellRatio, 2)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Vol Score (Up/Down)</span>
                      <span className="mono">{fmtNum(upVolScore, 4)} / {fmtNum(downVolScore, 4)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Time Factor</span>
                      <span className="mono">{timeFrac === null ? "-" : `${fmtNum(timeFrac * 100, 0)}%`}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Spread (Up/Down)</span>
                      <span className="mono">{fmtUsd(upSpread, 3)} / {fmtUsd(downSpread, 3)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Spread Max (Up/Down)</span>
                      <span className="mono">{fmtUsd(upSpreadLimit, 3)} / {fmtUsd(downSpreadLimit, 3)}</span>
                    </div>
                    <div className="tradeHistoryRow">
                      <span>Doji (Δ)</span>
                      <span className="mono">{dojiActive ? "Yes" : "No"} · {fmtUsd(dojiDiff, 3)} ≤ {fmtUsd(dojiThreshold, 3)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="tradeConsole">
                <div className="tradeConsoleHeader">
                  <div className="cardTitle">State & Momentum</div>
                  <div className="tradeHistoryMeta mono">cooldown {cooldownSec}s</div>
                </div>
                <div className="kv">
                  <div className="k">Up Buy Momentum</div>
                  <div className="v mono">{fmtNum(upBuyMomentum, 6)}</div>
                </div>
                <div className="kv">
                  <div className="k">Up Sell Momentum</div>
                  <div className="v mono">{fmtNum(upSellMomentum, 6)}</div>
                </div>
                <div className="kv">
                  <div className="k">Down Buy Momentum</div>
                  <div className="v mono">{fmtNum(downBuyMomentum, 6)}</div>
                </div>
                <div className="kv">
                  <div className="k">Down Sell Momentum</div>
                  <div className="v mono">{fmtNum(downSellMomentum, 6)}</div>
                </div>
                <div className="kv">
                  <div className="k">Time Left</div>
                  <div className="v mono">{fmtTimeLeftSec(timeLeftSec)}</div>
                </div>
                <div className="kv">
                  <div className="k">Positions</div>
                  <div className="v posSplit mono">
                    <span>Up {fmtNum(positions.Up, 2)} · {fmtUsd(positionNotional.Up, 2)}</span>
                    <span>Down {fmtNum(positions.Down, 2)} · {fmtUsd(positionNotional.Down, 2)}</span>
                  </div>
                </div>
                <div className="kv">
                  <div className="k">Avg Cost</div>
                  <div className="v posSplit mono">
                    <span>Up {fmtUsd(avgCost.Up, 2)}</span>
                    <span>Down {fmtUsd(avgCost.Down, 2)}</span>
                  </div>
                </div>
                <div className="kv">
                  <div className="k">Unrealized PnL</div>
                  <div className="v posSplit mono">
                    <span>Up {fmtUsd(pnl.safe.up, 2)}</span>
                    <span>Down {fmtUsd(pnl.safe.down, 2)}</span>
                  </div>
                </div>
                <div className="kv">
                  <div className="k">Total PnL</div>
                  <div className="v mono">{fmtUsd(pnl.safe.total, 2)}</div>
                </div>
                <div className="kv">
                  <div className="k">Settlement PnL</div>
                  <div className="v posSplit mono">
                    <span>{pnl.safe.winner}</span>
                    <span>{fmtUsd(pnl.safe.settlement, 2)}</span>
                  </div>
                </div>
                <div className="kv">
                  <div className="k">Net Spent</div>
                  <div className="v mono">{fmtUsd(Number.isFinite(pnl.netSpent) ? pnl.netSpent : 0, 2)}</div>
                </div>
                <div className="kv">
                  <div className="k">Gross Flow</div>
                  <div className="v posSplit mono">
                    <span>Spent {fmtUsd(cashFlow.spent, 2)}</span>
                    <span>Received {fmtUsd(cashFlow.received, 2)}</span>
                  </div>
                </div>
                <div className="tradeHeaderActions" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={() => (tradeActive || tradeArmed ? stopTrading() : startTrading())}>
                    {tradeActive || tradeArmed ? "Stop Trading" : "Start Trading"}
                  </button>
                  <button className="btn" onClick={resetSim}>Clear</button>
                </div>
                {tradeNotice ? (
                  <div className="tradeControlHint" style={{ marginTop: 6 }}>{tradeNotice}</div>
                ) : null}
                {!liveAllowed ? (
                  <div className="tradeControlHint" style={{ marginTop: 6 }}>
                    Live trading disabled (TRADING_ENABLED=true required). Running in sim mode.
                  </div>
                ) : null}
              </div>

              <div className="tradeHistory windowHistory">
                <div className="tradeHistoryHeader">
                  <div className="cardTitle">Window PnL</div>
                  <div className="tradeHistoryMeta mono">{windowHistory.length} windows</div>
                </div>
                {windowHistory.length ? (
                  <div className="tradeHistoryList">
                    {windowHistory.map((entry) => (
                      <div key={entry.id} className="tradeHistoryItem">
                        <div className="tradeHistoryRow">
                          <span className="mono">{new Date(entry.ts).toLocaleTimeString()}</span>
                          <span>{entry.asset ? entry.asset.toUpperCase() : "-"}</span>
                          <span className="mono">{entry.marketSlug ?? "-"}</span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>Avg Buy: Up {fmtUsd(entry.avgCost?.Up, 2)} · Down {fmtUsd(entry.avgCost?.Down, 2)}</span>
                          <span>Marks: Up {fmtUsd(entry.marks?.up, 2)} · Down {fmtUsd(entry.marks?.down, 2)}</span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>Notional: Up {fmtUsd(entry.notional?.Up, 2)} · Down {fmtUsd(entry.notional?.Down, 2)}</span>
                          <span>Positions: Up {fmtNum(entry.positions?.Up, 2)} · Down {fmtNum(entry.positions?.Down, 2)}</span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>PnL: Up {entry.pnl?.up === null ? "-" : fmtUsd(entry.pnl.up, 2)} · Down {entry.pnl?.down === null ? "-" : fmtUsd(entry.pnl.down, 2)}</span>
                          <span>Total {entry.pnl?.total === null ? "-" : fmtUsd(entry.pnl.total, 2)}</span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>Winner: {entry.settlement?.winner ?? "-"}</span>
                          <span>Settlement PnL: {entry.settlement?.pnl === null ? "-" : fmtUsd(entry.settlement.pnl, 2)}</span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>Net Spent: {entry.settlement?.netSpent === null || entry.settlement?.netSpent === undefined ? "-" : fmtUsd(entry.settlement.netSpent, 2)}</span>
                          <span>
                            API {fmtNum(entry.tradeStats?.liveApiAttempts ?? 0, 0)} · Filled {fmtNum(entry.tradeStats?.liveFilled ?? 0, 0)} · Failed {fmtNum(entry.tradeStats?.liveFailedApi ?? 0, 0)} · Skipped {fmtNum(entry.tradeStats?.liveSkipped ?? 0, 0)}
                          </span>
                        </div>
                        <div className="tradeHistoryRow">
                          <span>Spent: {entry.cashFlow?.spent === null || entry.cashFlow?.spent === undefined ? "-" : fmtUsd(entry.cashFlow.spent, 2)}</span>
                          <span>Received: {entry.cashFlow?.received === null || entry.cashFlow?.received === undefined ? "-" : fmtUsd(entry.cashFlow.received, 2)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="tradeHistoryEmpty">No window stats yet.</div>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="cardTop">
            <div className="cardTitle">Strategy Controls</div>
          </div>
          <div className="cardBody">
            <div className="tradeControls">
              <div className="tradeControl">
                <div className="tradeControlLabel">Buy Ratio Min {tooltip("Minimum buy payout ratio required to allow BUY signals. Buy ratio = (1 - ask) / ask. If below, BUY is blocked unless Winner Buy Gate passes. Adjusted upward as time-to-expiry shrinks and implied vol rises.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="0.1"
                  value={buyRatioMin}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setBuyRatioMin(Number.isFinite(next) ? next : 0);
                  }}
                />
                <div className="tradeControlHint">Buy if ratio ≥ threshold</div>
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Sell Ratio Min {tooltip("Minimum sell payout ratio required to allow SELL signals. Sell ratio = bid / (1 - bid).")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="0.1"
                  value={sellRatioMin}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setSellRatioMin(Number.isFinite(next) ? next : 0);
                  }}
                />
                <div className="tradeControlHint">Sell if ratio ≥ threshold</div>
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Momentum Window (s) {tooltip("Lookback window used to compute ratio momentum slope (Δ ratio / Δ time).")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  min="1"
                  step="1"
                  value={momentumWindowSec}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setMomentumWindowSec(Number.isFinite(next) && next > 0 ? next : 1);
                  }}
                />
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Min Momentum / s {tooltip("Minimum ratio slope per second required to allow a signal. Adjusted upward as time-to-expiry shrinks and implied vol rises.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="0.0001"
                  value={minMomentum}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setMinMomentum(Number.isFinite(next) ? next : 0);
                  }}
                />
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Base Size {tooltip("Base share size for signals before scaling by ratio.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="1"
                  value={baseSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setBaseSize(Number.isFinite(next) ? next : 0);
                  }}
                />
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Max Size {tooltip("Maximum share size cap for any signal or hedge.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="1"
                  value={maxSize}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setMaxSize(Number.isFinite(next) ? next : 0);
                  }}
                />
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Size Scale {tooltip("Exponent for scaling size by ratio. Size = baseSize * (ratio/threshold)^scale, capped by Max Size.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  step="0.1"
                  value={sizeScale}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setSizeScale(Number.isFinite(next) ? next : 1);
                  }}
                />
              </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Cooldown (s) {tooltip("Minimum seconds between identical signal triggers (per side).")}</div>
                <input
                  className="tradeInput"
                  type="number"
                  min="0"
                  step="1"
                  value={cooldownSec}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setCooldownSec(Number.isFinite(next) && next >= 0 ? next : 0);
                  }}
                />
              </div>
            </div>

            <div className="toggleGrid" style={{ marginTop: 14 }}>
              <label className="toggleRow">
                <input type="checkbox" checked={enableUpBuy} onChange={(e) => setEnableUpBuy(e.target.checked)} />
                <span>Enable Up BUY {tooltip("Allow BUY signals for the Up outcome.")}</span>
              </label>
              <label className="toggleRow">
                <input type="checkbox" checked={enableUpSell} onChange={(e) => setEnableUpSell(e.target.checked)} />
                <span>Enable Up SELL {tooltip("Allow SELL signals for the Up outcome (requires position).")}</span>
              </label>
              <label className="toggleRow">
                <input type="checkbox" checked={enableDownBuy} onChange={(e) => setEnableDownBuy(e.target.checked)} />
                <span>Enable Down BUY {tooltip("Allow BUY signals for the Down outcome.")}</span>
              </label>
              <label className="toggleRow">
                <input type="checkbox" checked={enableDownSell} onChange={(e) => setEnableDownSell(e.target.checked)} />
                <span>Enable Down SELL {tooltip("Allow SELL signals for the Down outcome (requires position).")}</span>
              </label>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Conditional Hedge</div>
              <div className="toggleGrid">
                <label className="toggleRow">
                  <input type="checkbox" checked={hedgeEnabled} onChange={(e) => setHedgeEnabled(e.target.checked)} />
                  <span>Enable Opposite BUY Hedge {tooltip("After a BUY, optionally BUY the opposite outcome if hedge ratio conditions pass.")}</span>
                </label>
                <div className="tradeControlHint">Hedge only when opposite buy ratio is within range.</div>
              </div>
              <div className="tradeControls" style={{ marginTop: 10 }}>
              <div className="tradeControl">
                <div className="tradeControlLabel">Hedge Ratio Min {tooltip("Opposite buy ratio must be >= this to allow hedge BUY.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    step="0.1"
                    value={hedgeRatioMin}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setHedgeRatioMin(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Hedge Ratio Max {tooltip("Opposite buy ratio must be <= this to allow hedge BUY.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    step="0.1"
                    value={hedgeRatioMax}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setHedgeRatioMax(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Hedge Size Mult {tooltip("Hedge size multiplier relative to the triggering BUY size (capped by Max Size).")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    step="0.1"
                    value={hedgeSizeMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setHedgeSizeMult(Number.isFinite(next) ? next : 1);
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Winner Buy Gate</div>
              <div className="tradeControls">
              <div className="tradeControl">
                <div className="tradeControlLabel">Winner Buy Min Price {tooltip("If BUY ratio is below threshold, allow BUY if price >= this value (favored side gate).")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    step="0.01"
                    value={winnerBuyMinPrice}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setWinnerBuyMinPrice(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
              </div>
              <div className="toggleGrid" style={{ marginTop: 8 }}>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={winnerBuyRequireFavored}
                    onChange={(e) => setWinnerBuyRequireFavored(e.target.checked)}
                  />
                  <span>Require Favored Side {tooltip("Winner Buy Gate applies only to the higher-priced (favored) side.")}</span>
                </label>
              </div>
              <div className="tradeControlHint" style={{ marginTop: 6 }}>
                Allows BUY on the higher-priced side even when payout ratio is low.
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Settlement Safety</div>
              <div className="tradeControls">
                <div className="tradeControl">
                  <div className="tradeControlLabel">Settlement Buffer ($) {tooltip("Require Settlement PnL to stay above this buffer. Triggers rebalancing if breached.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.1"
                    value={settlementBuffer}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setSettlementBuffer(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Cap Multiplier {tooltip("Cap net spent as a multiple of winner shares. netSpent must stay <= winnerShares * capMult.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.01"
                    value={settlementCapMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setSettlementCapMult(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Rebalance Mode {tooltip("Controls whether rebalancing sells loser or buys winner first when Settlement PnL is negative.")}</div>
                  <select
                    className="tradeInput"
                    value={rebalanceMode}
                    onChange={(e) => setRebalanceMode(e.target.value)}
                  >
                    <option value="sell-first">Sell Loser First</option>
                    <option value="buy-first">Buy Winner First</option>
                    <option value="balanced">Balanced</option>
                  </select>
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Max Rebalance Size (x) {tooltip("Cap rebalancing size as a multiple of Base Size.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.1"
                    value={maxRebalanceSizeMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setMaxRebalanceSizeMult(Number.isFinite(next) ? next : 1);
                    }}
                  />
                </div>
              </div>
              <div className="toggleGrid" style={{ marginTop: 8 }}>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={flipRebalanceEnabled}
                    onChange={(e) => setFlipRebalanceEnabled(e.target.checked)}
                  />
                  <span>Flip Rebalance {tooltip("When the favored side flips late, force an immediate rebalance.")}</span>
                </label>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={rebalanceIgnoreCooldown}
                    onChange={(e) => setRebalanceIgnoreCooldown(e.target.checked)}
                  />
                  <span>Ignore Rebalance Cooldown {tooltip("Allow rebalances to fire without waiting for cooldown.")}</span>
                </label>
              </div>
              <div className="tradeControlHint" style={{ marginTop: 6 }}>
                Rebalances inventory to keep Settlement PnL ≥ buffer and netSpent within the cap.
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Doji Control</div>
              <div className="tradeControls">
                <div className="tradeControl">
                  <div className="tradeControlLabel">Doji Threshold (Δ) {tooltip("Treat market as doji if |Up mid - Down mid| <= threshold.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.01"
                    value={dojiThreshold}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setDojiThreshold(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Doji Size Mult {tooltip("Scale BUY size when in doji regime (SELLs unaffected).")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.05"
                    value={dojiSizeMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setDojiSizeMult(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
              </div>
              <div className="toggleGrid" style={{ marginTop: 8 }}>
                <label className="toggleRow">
                  <input type="checkbox" checked={dojiAllowBuys} onChange={(e) => setDojiAllowBuys(e.target.checked)} />
                  <span>Allow Buys in Doji {tooltip("When off, BUYs are blocked in a doji regime unless rebalancing.")}</span>
                </label>
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Late Window Scaling</div>
              <div className="tradeControls">
                <div className="tradeControl">
                  <div className="tradeControlLabel">Late Window (s) {tooltip("Time-to-expiry threshold for late-window safety adjustments.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    min="0"
                    step="1"
                    value={lateWindowSec}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setLateWindowSec(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Late Buffer Mult {tooltip("Multiplier applied to Settlement Buffer during late window.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.1"
                    value={lateBufferMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setLateBufferMult(Number.isFinite(next) ? next : 1);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Late Cap Mult {tooltip("Multiplier applied to net spent cap during late window (lower = tighter).")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.05"
                    value={lateCapMult}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setLateCapMult(Number.isFinite(next) ? next : 1);
                    }}
                  />
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Late Cap Floor {tooltip("Minimum cap multiplier allowed during late window.")}</div>
                  <input
                    className="tradeInput"
                    type="number"
                    step="0.05"
                    value={lateCapFloor}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setLateCapFloor(Number.isFinite(next) ? next : 0);
                    }}
                  />
                </div>
              </div>
              <div className="toggleGrid" style={{ marginTop: 8 }}>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={lateRebalanceOverride}
                    onChange={(e) => setLateRebalanceOverride(e.target.checked)}
                  />
                  <span>Late Rebalance Override {tooltip("Bypass spread/doji gates for rebalancing during the late window.")}</span>
                </label>
                <label className="toggleRow">
                  <input
                    type="checkbox"
                    checked={lateDojiUnwind}
                    onChange={(e) => setLateDojiUnwind(e.target.checked)}
                  />
                  <span>Late Doji Unwind {tooltip("During late doji, sell down the larger side to neutralize inventory.")}</span>
                </label>
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>End Window Rules</div>
              <div className="tradeControls">
              <div className="tradeControl">
                <div className="tradeControlLabel">Stop Loser Buys (s) {tooltip("In the last N seconds, block BUYs on the non-favored side.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    min="0"
                    step="1"
                    value={endClampLoserBuySec}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setEndClampLoserBuySec(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                  />
                </div>
              <div className="tradeControl">
                <div className="tradeControlLabel">Hold Winner Sells (s) {tooltip("In the last N seconds, block SELLs on the favored side.")}</div>
                <input
                  className="tradeInput"
                  type="number"
                    min="0"
                    step="1"
                    value={endClampWinnerSellSec}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setEndClampWinnerSellSec(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                  />
                </div>
              </div>
              <div className="tradeControlHint" style={{ marginTop: 6 }}>
                Near expiry, avoid adding to the losing side and avoid selling the favored side.
              </div>
            </div>

            <div className="tradeTableWrap">
              <div className="cardTitle" style={{ marginBottom: 8 }}>Derived Sizing</div>
              <div className="kv">
                <div className="k">Up Buy Size</div>
                <div className="v mono">{fmtNum(calcSizePreview(upBuyRatio, buyRatioMinAdj, "BUY", "Up"), 2)}</div>
              </div>
              <div className="kv">
                <div className="k">Up Sell Size</div>
                <div className="v mono">{fmtNum(calcSizePreview(upSellRatio, sellRatioMinAdj, "SELL", "Up"), 2)}</div>
              </div>
              <div className="kv">
                <div className="k">Down Buy Size</div>
                <div className="v mono">{fmtNum(calcSizePreview(downBuyRatio, buyRatioMinAdj, "BUY", "Down"), 2)}</div>
              </div>
              <div className="kv">
                <div className="k">Down Sell Size</div>
                <div className="v mono">{fmtNum(calcSizePreview(downSellRatio, sellRatioMinAdj, "SELL", "Down"), 2)}</div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 18 }}>
        <div className="cardTop">
          <div className="cardTitle">Trade History</div>
          <div className="tradeHistoryMeta mono">{trades.length} entries</div>
        </div>
        <div className="cardBody">
          {trades.length ? (
            <div className="tradeHistoryList">
              {trades.map((trade) => (
                <div key={trade.id} className="tradeHistoryItem">
                  <div className="tradeHistoryRow">
                    <span className="mono">{new Date(trade.ts).toLocaleTimeString()}</span>
                    <span className="tradeHistoryTag">{trade.outcome.toUpperCase()}</span>
                    <span className="tradeHistoryTag">{trade.side}</span>
                    <span className="tradeHistoryTag">{trade.mode?.toUpperCase?.() ?? "SIM"}</span>
                    <span className="tradeHistoryTag">{trade.status?.toUpperCase?.() ?? "-"}</span>
                    {trade.isHedge ? <span className="tradeHistoryTag">HEDGE</span> : null}
                  </div>
                  <div className="tradeHistoryRow">
                    <span>
                      {trade.asset.toUpperCase()} · {fmtNum(trade.size, 0)} sh
                      {Number.isFinite(trade.requestedSize) ? ` / req ${fmtNum(trade.requestedSize, 0)} sh` : ""}
                      · {fmtUsd(trade.notional, 2)}
                    </span>
                    <span>Avg {fmtUsd(trade.price, 2)} · Ratio {fmtRatio(trade.ratio, 2)}</span>
                  </div>
                  <div className="tradeHistoryRow">
                    <span>Momentum {fmtNum(trade.momentum, 6)}</span>
                    <span>Pos After {fmtNum(trade.positionAfter, 2)} sh</span>
                  </div>
                  <div className="tradeHistoryRow">{trade.reason}</div>
                  {trade.orderId ? (
                    <div className="tradeHistoryRow mono">Order ID: {trade.orderId}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="tradeHistoryEmpty">No trades yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}
