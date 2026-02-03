"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CandlestickSeries } from "lightweight-charts";
import { connectPolymarketChainlinkWs } from "./_ws/polymarketPrice";
import { connectClobMarketWs } from "./_ws/clobMarket";
import { connectBinanceWs, normalizeBinanceSymbol, seedKlines } from "./_ws/binance";
import {
  computeHeikenAshi,
  countConsecutive,
  computeMacd,
  computeRsi,
  computeVwapSeries,
  slopeLast,
  scoreDirection,
  applyTimeAwareness,
  detectRegime,
  computeEdge,
  decide
} from "./lib/ta";

const TAB_ORDER = [
  { asset: "btc", label: "BTC" },
  { asset: "eth", label: "ETH" },
  { asset: "xrp", label: "XRP" },
  { asset: "sol", label: "SOL" }
];

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function fmtUsd(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "-";
  return `$${fmtNum(n, digits)}`;
}

function fmtPct(p, digits = 2) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function roundToCent(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundDownToCent(value) {
  return Math.floor(Number(value) * 100) / 100;
}

function fmtTimeLeft(mins) {
  if (mins === null || mins === undefined || !Number.isFinite(Number(mins))) return "-";
  const totalSeconds = Math.max(0, Math.floor(Number(mins) * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function dotClass(kind) {
  if (kind === "green") return "dot green";
  if (kind === "red") return "dot red";
  if (kind === "amber") return "dot amber";
  return "dot";
}

const DELTA_PERIOD = 21;
const DELTA_MODE = "EMA";

function computeDeltaSeries(candles, period = DELTA_PERIOD, mode = DELTA_MODE) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { data: [], currentRatio: null, emaRatio: null };
  }

  const k = 2 / (period + 1);
  let ema = null;
  let currentRatio = null;
  const data = [];

  for (const c of candles) {
    const time = Math.floor(Number(c.openTime) / 1000);
    if (!Number.isFinite(time)) continue;

    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    const valid = [o, h, l, cl].every((v) => Number.isFinite(v));

    if (!valid) {
      data.push({ time });
      continue;
    }

    const range = h - l;
    let ratio = range > 0 ? (cl - l) / range : 0.5;
    if (!Number.isFinite(ratio)) ratio = 0.5;
    ratio = Math.min(1, Math.max(0, Math.abs(ratio)));
    currentRatio = ratio;

    ema = ema === null ? ratio : ratio * k + ema * (1 - k);
    const cumulative = mode === "EMA" ? ema : ratio;

    const isUp = cl >= o;
    const bodyOpen = isUp ? o : cl + (o - cl) * cumulative;
    const bodyClose = isUp ? o + (cl - o) * cumulative : o;
    const color = isUp ? "rgba(8,153,129,0.65)" : "rgba(242,54,69,0.65)";

    data.push({
      time,
      openTime: c.openTime,
      open: bodyOpen,
      high: h,
      low: l,
      close: bodyClose,
      color,
      wickColor: "rgba(0,0,0,0)",
      borderColor: "rgba(0,0,0,0)"
    });
  }

  return { data, currentRatio, emaRatio: ema };
}

function CandleChart({ candles, seriesData, asset, intervalLabel = "1m" }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const baseSeriesRef = useRef(null);
  const overlaySeriesRef = useRef(null);
  const lastLenRef = useRef(0);

  const priceDigits = asset === "xrp" ? 4 : 2;
  const lastCandle = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
  const symbol = normalizeBinanceSymbol(asset);
  const baseData = useMemo(() => {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    return candles
      .slice(-240)
      .filter((c) => [c.open, c.high, c.low, c.close].every((v) => typeof v === "number" && Number.isFinite(v)))
      .map((c) => ({
        time: Math.floor(c.openTime / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }));
  }, [candles]);
  const overlayData = Array.isArray(seriesData) ? seriesData : [];

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = getComputedStyle(document.documentElement);
    const green = styles.getPropertyValue("--green").trim() || "#45ffb2";
    const red = styles.getPropertyValue("--red").trim() || "#ff5c7a";
    const text = styles.getPropertyValue("--text").trim() || "#e9eef9";
    const border = styles.getPropertyValue("--border").trim() || "#1b2a44";
    const muted = styles.getPropertyValue("--muted").trim() || "#a5b4d0";

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
        secondsVisible: false
      },
      crosshair: {
        horzLine: { color: muted },
        vertLine: { color: muted }
      }
    });

    const baseSeries = chart.addSeries(CandlestickSeries, {
      upColor: green,
      downColor: red,
      wickUpColor: muted,
      wickDownColor: muted,
      borderVisible: true,
      borderUpColor: green,
      borderDownColor: red,
      wickVisible: true,
      priceLineVisible: false,
      priceFormat: {
        type: "price",
        precision: priceDigits,
        minMove: 1 / 10 ** priceDigits
      }
    });

    const overlaySeries = chart.addSeries(CandlestickSeries, {
      upColor: green,
      downColor: red,
      wickUpColor: "rgba(0,0,0,0)",
      wickDownColor: "rgba(0,0,0,0)",
      borderVisible: false,
      wickVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "price",
        precision: priceDigits,
        minMove: 1 / 10 ** priceDigits
      }
    });

    chartRef.current = chart;
    baseSeriesRef.current = baseSeries;
    overlaySeriesRef.current = overlaySeries;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight
      });
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      baseSeriesRef.current = null;
      overlaySeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    lastLenRef.current = 0;
  }, [asset]);

  useEffect(() => {
    if (!baseSeriesRef.current || !overlaySeriesRef.current) return;
    baseSeriesRef.current.applyOptions({
      priceFormat: {
        type: "price",
        precision: priceDigits,
        minMove: 1 / 10 ** priceDigits
      }
    });
    overlaySeriesRef.current.applyOptions({
      priceFormat: {
        type: "price",
        precision: priceDigits,
        minMove: 1 / 10 ** priceDigits
      }
    });
  }, [priceDigits]);

  useEffect(() => {
    if (!baseSeriesRef.current || !overlaySeriesRef.current) return;
    if (baseData.length === 0) {
      baseSeriesRef.current.setData([]);
      overlaySeriesRef.current.setData([]);
      lastLenRef.current = 0;
      return;
    }

    baseSeriesRef.current.setData(baseData);
    overlaySeriesRef.current.setData(overlayData);
    if (lastLenRef.current === 0 && baseData.length > 0) {
      const targetBars = 30;
      const lastIndex = baseData.length - 1;
      const from = Math.max(0, lastIndex - targetBars + 1);
      chartRef.current?.timeScale().setVisibleLogicalRange({ from, to: lastIndex });
    }
    lastLenRef.current = baseData.length;
  }, [baseData, overlayData]);

  return (
    <div className="chartShell">
      <div className="chartHeader">
        <div>
          <div className="chartTitle">Live Candles ({intervalLabel})</div>
          <div className="chartMetaRow">
            <div className="chartMeta mono">{symbol} · showing {Array.isArray(candles) ? Math.min(240, candles.length) : 0}</div>
            <a className="chartAttribution" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Powered by TradingView</a>
          </div>
        </div>
        <div className="chartLast mono">
          {lastCandle
            ? `O ${fmtUsd(lastCandle.open, priceDigits)} · H ${fmtUsd(lastCandle.high, priceDigits)} · L ${fmtUsd(lastCandle.low, priceDigits)} · C ${fmtUsd(lastCandle.close, priceDigits)}`
            : "-"}
        </div>
      </div>
      <div className="chartCanvas" ref={containerRef} />
      {(!Array.isArray(candles) || candles.length === 0) ? (
        <div className="chartEmpty">Waiting for Binance candles…</div>
      ) : null}
    </div>
  );
}

export default function Page() {
  const [activeAsset, setActiveAsset] = useState("btc");
  const [hedgeOffsetCents, setHedgeOffsetCents] = useState(10);
  const [hedgeSizeInput, setHedgeSizeInput] = useState("20");
  const [maxLegPriceCents, setMaxLegPriceCents] = useState(58);
  const [tradeBusy, setTradeBusy] = useState(false);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoDelaySec, setAutoDelaySec] = useState(30);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
  const [autoStatus, setAutoStatus] = useState(null);

  useEffect(() => {
    fetch("/api/trade/init").catch(() => {});
  }, []);

  // market meta (from server /api/snapshot). No SSE.
  const [metaByAsset, setMetaByAsset] = useState({});
  const [metaErrByAsset, setMetaErrByAsset] = useState({});
  const [metaLoadingByAsset, setMetaLoadingByAsset] = useState({ btc: true, eth: true, xrp: true, sol: true });
  const lastMarketSlugRef = useRef({});

  // Polymarket RTDS price (oracle/current price) per active asset
  const [pmPrice, setPmPrice] = useState({ price: null, updatedAtMs: null, status: "-" });

  // Price-to-beat latch per asset
  const [ptbByAsset, setPtbByAsset] = useState({});

  // Binance candles + price per asset (client-side)
  const [binanceByAsset, setBinanceByAsset] = useState({});
  const [binanceChartByAsset, setBinanceChartByAsset] = useState({});

  // CLOB best bid/ask per asset
  const [clobByAsset, setClobByAsset] = useState({});

  const pmWsRef = useRef(null);
  const clobRef = useRef(null);
  const binanceRef = useRef(null);
  const binanceChartRef = useRef(null);

  const activeMeta = metaByAsset[activeAsset] ?? null;
  const activeMetaErr = metaErrByAsset[activeAsset] ?? null;
  const activeMetaLoading = metaLoadingByAsset[activeAsset] ?? false;

  const activeTokens = activeMeta?.polymarket?.tokens ?? null;
  const activeMarketSlug = activeMeta?.polymarket?.marketSlug ?? null;
  const activeStartTime = activeMeta?.polymarket?.marketStartTime ?? null;
  const activeEndTime = activeMeta?.polymarket?.marketEndTime ?? null;

  const activeBbo = clobByAsset[activeAsset] ?? { marketSlug: null, up: null, down: null };

  const bin = binanceByAsset[activeAsset] ?? { status: "-", candles: null, lastTrade: null };
  const chartBin = binanceChartByAsset[activeAsset] ?? { status: "-", candles: null };

  // Fetch Polymarket market meta on tab open, then schedule a rollover fetch at the precise end time.
  // No periodic polling: rollover is controlled by the client clock.
  useEffect(() => {
    let alive = true;
    let rolloverTimer = null;
    let retryTimer = null;

    const clearTimers = () => {
      if (rolloverTimer) clearTimeout(rolloverTimer);
      if (retryTimer) clearTimeout(retryTimer);
      rolloverTimer = null;
      retryTimer = null;
    };

    const scheduleRollover = (endTime) => {
      clearTimers();
      if (!endTime) return;
      const endMs = new Date(endTime).getTime();
      if (!Number.isFinite(endMs)) return;

      const now = Date.now();
      const delay = Math.max(0, endMs - now);

      rolloverTimer = setTimeout(() => {
        // At boundary, fetch next market immediately.
        load({ expectNewSlug: true });
      }, delay);
    };

    async function load({ expectNewSlug = false, attempt = 0 } = {}) {
      setMetaLoadingByAsset((p) => ({ ...p, [activeAsset]: true }));
      setMetaErrByAsset((p) => ({ ...p, [activeAsset]: null }));

      const prevSlug = lastMarketSlugRef.current?.[activeAsset] ?? null;

      try {
        const res = await fetch(`/api/snapshot?asset=${encodeURIComponent(activeAsset)}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
        if (!alive) return;

        setMetaByAsset((p) => ({ ...p, [activeAsset]: j }));
        lastMarketSlugRef.current = { ...(lastMarketSlugRef.current ?? {}), [activeAsset]: j?.polymarket?.marketSlug ?? null };

        // schedule next rollover based on the market end time we just got
        scheduleRollover(j?.polymarket?.marketEndTime ?? null);

        // If we're expecting a new slug right after boundary, but Gamma hasn't surfaced it yet,
        // retry quickly a few times (sub-second) to minimize rollover lag.
        const newSlug = j?.polymarket?.marketSlug ?? null;
        if (expectNewSlug && prevSlug && newSlug === prevSlug && attempt < 20) {
          const backoff = Math.min(1000, 150 + attempt * 50);
          retryTimer = setTimeout(() => load({ expectNewSlug: true, attempt: attempt + 1 }), backoff);
        }
      } catch (e) {
        if (!alive) return;
        setMetaErrByAsset((p) => ({ ...p, [activeAsset]: e?.message ?? String(e) }));

        // On error, retry quickly around rollover window.
        if (expectNewSlug && attempt < 20) {
          const backoff = Math.min(1000, 150 + attempt * 50);
          retryTimer = setTimeout(() => load({ expectNewSlug: true, attempt: attempt + 1 }), backoff);
        }
      } finally {
        if (!alive) return;
        setMetaLoadingByAsset((p) => ({ ...p, [activeAsset]: false }));
      }
    }

    load();

    return () => {
      alive = false;
      clearTimers();
    };
    // Intentionally NOT depending on metaByAsset to avoid rerender loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAsset]);

  // Polymarket RTDS WS for CURRENT PRICE (active asset only)
  useEffect(() => {
    pmWsRef.current?.close?.();
    setPmPrice({ price: null, updatedAtMs: null, status: "connecting" });

    const c = connectPolymarketChainlinkWs({
      symbolIncludes: activeAsset,
      onTick: ({ price, updatedAtMs }) => setPmPrice({ price, updatedAtMs, status: "live" }),
      onStatus: ({ status }) => setPmPrice((p) => ({ ...p, status }))
    });

    pmWsRef.current = c;
    return () => c?.close?.();
  }, [activeAsset]);

  // Client-latch price-to-beat (first PM WS tick at/after market start)
  useEffect(() => {
    const marketSlug = activeMarketSlug;
    const startMs = activeStartTime ? new Date(activeStartTime).getTime() : null;

    setPtbByAsset((prev) => {
      const cur = prev[activeAsset] ?? { value: null, setAtMs: null, marketSlug: null };
      if (marketSlug && cur.marketSlug !== marketSlug) {
        return { ...prev, [activeAsset]: { value: null, setAtMs: null, marketSlug } };
      }
      return prev;
    });

    const wsPrice = pmPrice?.price ?? null;
    if (!marketSlug || wsPrice === null) return;

    setPtbByAsset((prev) => {
      const cur = prev[activeAsset] ?? { value: null, setAtMs: null, marketSlug };
      if (cur.value !== null) return prev;

      const nowMs = Date.now();
      const okToLatch = startMs === null ? true : Number.isFinite(startMs) && nowMs >= startMs;
      if (!okToLatch) return prev;

      return { ...prev, [activeAsset]: { value: wsPrice, setAtMs: nowMs, marketSlug } };
    });
  }, [activeAsset, activeMarketSlug, activeStartTime, pmPrice?.price]);

  // Binance (1m): seed once per active tab (HTTP) then WS updates
  useEffect(() => {
    let closed = false;

    async function start() {
      // if already seeded for this asset, don't reseed
      const existing = binanceByAsset[activeAsset];
      if (existing?.candles && Array.isArray(existing.candles) && existing.candles.length >= 50) {
        return;
      }

      const symbol = normalizeBinanceSymbol(activeAsset);

      setBinanceByAsset((p) => ({ ...p, [activeAsset]: { status: "seeding", candles: null, lastTrade: null } }));

      let candles;
      try {
        candles = await seedKlines({ symbol, interval: "1m", limit: 240 });
      } catch (e) {
        if (closed) return;
        setBinanceByAsset((p) => ({ ...p, [activeAsset]: { status: `seed_error: ${e?.message ?? String(e)}`, candles: null, lastTrade: null } }));
        return;
      }

      if (closed) return;
      setBinanceByAsset((p) => ({ ...p, [activeAsset]: { status: "ws_connecting", candles, lastTrade: null } }));

      binanceRef.current?.close?.();

      const ws = connectBinanceWs({
        symbol,
        interval: "1m",
        onKline: (k) => {
          setBinanceByAsset((prev) => {
            const cur = prev[activeAsset] ?? { status: "live", candles: [], lastTrade: null };
            const arr = Array.isArray(cur.candles) ? cur.candles.slice() : [];

            // update last candle (forming) or append if new
            const last = arr[arr.length - 1];
            if (last && Number(last.openTime) === Number(k.openTime)) {
              arr[arr.length - 1] = { ...last, ...k, isFinal: undefined };
            } else {
              arr.push({
                openTime: k.openTime,
                closeTime: k.closeTime,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume
              });
            }

            // when final, keep window size
            if (k.isFinal) {
              while (arr.length > 240) arr.shift();
            }

            return { ...prev, [activeAsset]: { ...cur, status: "live", candles: arr } };
          });
        },
        onTrade: (t) => {
          setBinanceByAsset((prev) => {
            const cur = prev[activeAsset] ?? { status: "live", candles: null, lastTrade: null };
            return { ...prev, [activeAsset]: { ...cur, lastTrade: t } };
          });
        },
        onStatus: ({ status }) => {
          setBinanceByAsset((prev) => {
            const cur = prev[activeAsset] ?? { status: "-", candles: null, lastTrade: null };
            return { ...prev, [activeAsset]: { ...cur, status } };
          });
        }
      });

      binanceRef.current = ws;
    }

    start();

    return () => {
      closed = true;
      // Close WS when leaving tab (reduce load)
      try {
        binanceRef.current?.close?.();
      } catch {
        // ignore
      }
      binanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAsset]);

  // Binance (15m chart): separate feed for the candlestick chart
  useEffect(() => {
    let closed = false;

    async function start() {
      const existing = binanceChartByAsset[activeAsset];
      if (existing?.candles && Array.isArray(existing.candles) && existing.candles.length >= 20) {
        return;
      }

      const symbol = normalizeBinanceSymbol(activeAsset);

      setBinanceChartByAsset((p) => ({ ...p, [activeAsset]: { status: "seeding", candles: null } }));

      let candles;
      try {
        candles = await seedKlines({ symbol, interval: "15m", limit: 240 });
      } catch (e) {
        if (closed) return;
        setBinanceChartByAsset((p) => ({ ...p, [activeAsset]: { status: `seed_error: ${e?.message ?? String(e)}`, candles: null } }));
        return;
      }

      if (closed) return;
      setBinanceChartByAsset((p) => ({ ...p, [activeAsset]: { status: "ws_connecting", candles } }));

      binanceChartRef.current?.close?.();

      const ws = connectBinanceWs({
        symbol,
        interval: "15m",
        onKline: (k) => {
          setBinanceChartByAsset((prev) => {
            const cur = prev[activeAsset] ?? { status: "live", candles: [] };
            const arr = Array.isArray(cur.candles) ? cur.candles.slice() : [];

            const last = arr[arr.length - 1];
            if (last && Number(last.openTime) === Number(k.openTime)) {
              arr[arr.length - 1] = { ...last, ...k, isFinal: undefined };
            } else {
              arr.push({
                openTime: k.openTime,
                closeTime: k.closeTime,
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume
              });
            }

            if (k.isFinal) {
              while (arr.length > 240) arr.shift();
            }

            return { ...prev, [activeAsset]: { ...cur, status: "live", candles: arr } };
          });
        },
        onStatus: ({ status }) => {
          setBinanceChartByAsset((prev) => {
            const cur = prev[activeAsset] ?? { status: "-", candles: null };
            return { ...prev, [activeAsset]: { ...cur, status } };
          });
        }
      });

      binanceChartRef.current = ws;
    }

    start();

    return () => {
      closed = true;
      try {
        binanceChartRef.current?.close?.();
      } catch {
        // ignore
      }
      binanceChartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAsset]);

  // CLOB market WS (best bid/ask for UP+DOWN) active asset only
  useEffect(() => {
    const upTokenId = activeTokens?.upTokenId ?? null;
    const downTokenId = activeTokens?.downTokenId ?? null;

    // reset bbo when market changes
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

  // === Derived model values (client-side) ===
  const candles = Array.isArray(bin.candles) ? bin.candles : null;
  const chartCandles = Array.isArray(chartBin.candles) ? chartBin.candles : null;
  const delta = useMemo(
    () => computeDeltaSeries(chartCandles ?? [], DELTA_PERIOD, DELTA_MODE),
    [chartCandles]
  );

  const hedgePlan = useMemo(() => {
    const upBid = activeBbo?.up?.bid ?? null;
    const downBid = activeBbo?.down?.bid ?? null;
    const targetTotal = (100 - hedgeOffsetCents) / 100;

    if (!Number.isFinite(upBid) || !Number.isFinite(downBid)) {
      return {
        ok: false,
        reason: "Waiting for best bids",
        upBid,
        downBid,
        targetTotal
      };
    }

    const higherSide = downBid >= upBid ? "down" : "up";
    const higherBid = higherSide === "down" ? downBid : upBid;
    const higherPrice = roundToCent(higherBid);

    const lowerRaw = targetTotal - higherPrice;
    let lowerPrice = roundToCent(lowerRaw);
    if (higherPrice + lowerPrice > targetTotal + 1e-6) {
      lowerPrice = roundDownToCent(lowerRaw);
    }

    const upPrice = higherSide === "up" ? higherPrice : lowerPrice;
    const downPrice = higherSide === "down" ? higherPrice : lowerPrice;
    const sum = upPrice + downPrice;

    if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) {
      return { ok: false, reason: "Invalid price calculation", upBid, downBid, targetTotal };
    }

    if (upPrice <= 0 || downPrice <= 0) {
      return { ok: false, reason: "Offset too large for current bids", upBid, downBid, targetTotal };
    }

    return {
      ok: true,
      upBid,
      downBid,
      higherSide,
      targetTotal,
      upPrice,
      downPrice,
      sum
    };
  }, [activeBbo?.up?.bid, activeBbo?.down?.bid, hedgeOffsetCents]);

  const hedgeSize = useMemo(() => {
    const num = Number(hedgeSizeInput);
    return Number.isFinite(num) ? num : null;
  }, [hedgeSizeInput]);

  function adjustHedgeSize(delta) {
    setHedgeSizeInput((prev) => {
      const current = Number(prev);
      const base = Number.isFinite(current) ? current : 0;
      const next = Math.max(0, base + delta);
      return String(next);
    });
  }

  const tradeDisabledReason = useMemo(() => {
    if (!activeTokens?.upTokenId || !activeTokens?.downTokenId) return "Missing token IDs";
    if (!hedgePlan.ok) return hedgePlan.reason;
    const maxLeg = maxLegPriceCents / 100;
    const highestLeg = Math.max(hedgePlan.upPrice ?? 0, hedgePlan.downPrice ?? 0);
    if (Number.isFinite(maxLeg) && highestLeg > maxLeg) return `Highest leg > ${fmtUsd(maxLeg, 2)} (max)`;
    if (!hedgeSize || hedgeSize <= 0) return "Enter a valid share size";
    return "";
  }, [activeTokens?.upTokenId, activeTokens?.downTokenId, hedgePlan, hedgeSize, maxLegPriceCents]);

  const manualDisabledReason = autoEnabled ? "Auto trade mode enabled" : tradeDisabledReason;

  const tradeBadge = useMemo(() => {
    if (tradeBusy) return { label: "Submitting", dot: "amber" };
    if (manualDisabledReason) return { label: "Disabled", dot: "red" };
    return { label: "Ready", dot: "green" };
  }, [tradeBusy, manualDisabledReason]);

  const autoTimerRef = useRef(null);
  const autoLastTradeRef = useRef({ slug: null });

  function clearAutoTimer() {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }

  async function submitHedgeOrders({ source = "manual" } = {}) {
    const reason = source === "auto" ? tradeDisabledReason : manualDisabledReason;
    if (tradeBusy || reason) {
      if (source === "auto" && reason) {
        setAutoStatus({ type: "error", message: reason });
      }
      return;
    }
    setTradeBusy(true);
    setTradeStatus({ type: "pending", message: source === "auto" ? "Auto trade submitting…" : "Submitting hedge orders…" });

    const upTokenId = activeTokens?.upTokenId;
    const downTokenId = activeTokens?.downTokenId;
    if (!upTokenId || !downTokenId) {
      setTradeBusy(false);
      setTradeStatus({ type: "error", message: "Missing token IDs" });
      return;
    }

    const payloads = hedgePlan.higherSide === "up"
      ? [
        { tokenId: upTokenId, price: hedgePlan.upPrice, side: "BUY" },
        { tokenId: downTokenId, price: hedgePlan.downPrice, side: "BUY" }
      ]
      : [
        { tokenId: downTokenId, price: hedgePlan.downPrice, side: "BUY" },
        { tokenId: upTokenId, price: hedgePlan.upPrice, side: "BUY" }
      ];

    const results = {};

    try {
      const requests = payloads.map(async (payload) => {
        const res = await fetch("/api/trade/limit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenId: payload.tokenId,
            side: payload.side,
            price: payload.price,
            size: hedgeSize,
            postOnly: true
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Order failed (HTTP ${res.status})`);
        return { tokenId: payload.tokenId, data };
      });

      const settled = await Promise.allSettled(requests);
      const errors = [];
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          results[outcome.value.tokenId] = outcome.value.data;
        } else {
          errors.push(outcome.reason);
        }
      }

      if (errors.length) {
        const message = errors[0]?.message ?? String(errors[0]);
        const orderIds = Object.values(results)
          .map((r) => r?.orderId)
          .filter(Boolean);

        if (orderIds.length) {
          const cancelResults = await Promise.allSettled(orderIds.map(async (orderId) => {
            const res = await fetch("/api/trade/cancel", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ orderId })
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data?.error || `Cancel failed (HTTP ${res.status})`);
            }
            return orderId;
          }));

          const canceled = cancelResults.filter((r) => r.status === "fulfilled").length;
          const cancelFailures = cancelResults.filter((r) => r.status === "rejected");
          const cancelNote = cancelFailures.length
            ? `Canceled ${canceled}/${orderIds.length} (some cancel failures)`
            : `Canceled ${canceled}/${orderIds.length}`;

          setTradeStatus({
            type: "error",
            message: `${message}. ${cancelNote}.`,
            results
          });
          if (source === "auto") {
            setAutoStatus({ type: "error", message: `${message}. ${cancelNote}.` });
          }
        } else {
          setTradeStatus({
            type: "error",
            message,
            results
          });
          if (source === "auto") {
            setAutoStatus({ type: "error", message });
          }
        }
      } else {
        setTradeStatus({
          type: "success",
          message: "Hedge orders submitted",
          results
        });
        if (source === "auto") {
          setAutoStatus({ type: "success", message: "Auto trade submitted" });
        }
      }
    } catch (err) {
      setTradeStatus({
        type: "error",
        message: err?.message ?? String(err),
        results
      });
      if (source === "auto") {
        setAutoStatus({ type: "error", message: err?.message ?? String(err) });
      }
    } finally {
      setTradeBusy(false);
    }
  }

  useEffect(() => {
    if (!autoEnabled) {
      clearAutoTimer();
      setAutoStatus(null);
      return;
    }

    clearAutoTimer();

    const startMs = activeStartTime ? new Date(activeStartTime).getTime() : null;
    if (!Number.isFinite(startMs)) {
      setAutoStatus({ type: "error", message: "Waiting for market start time" });
      return;
    }

    const fireAt = startMs + autoDelaySec * 1000;
    if (Date.now() > fireAt) {
      setAutoStatus({ type: "error", message: "Auto window passed; no trades allowed" });
      return;
    }

    if (autoLastTradeRef.current.slug && autoLastTradeRef.current.slug === activeMarketSlug) {
      setAutoStatus({ type: "info", message: "Auto already fired for this window" });
      return;
    }

    const delay = Math.max(0, fireAt - Date.now());
    setAutoStatus({ type: "pending", message: `Auto trade scheduled for ${new Date(fireAt).toLocaleTimeString()}` });
    autoTimerRef.current = setTimeout(async () => {
      if (!autoEnabled) return;
      autoLastTradeRef.current = { slug: activeMarketSlug ?? null };
      await submitHedgeOrders({ source: "auto" });
    }, delay);

    return () => clearAutoTimer();
  }, [autoEnabled, activeStartTime, autoDelaySec, activeMarketSlug, tradeDisabledReason]);

  const derived = useMemo(() => {
    if (!candles || candles.length < 60) {
      return { ok: false, reason: "warming_up" };
    }

    const closes = candles.map((c) => c.close);
    const vwapSeries = computeVwapSeries(candles);
    const vwapNow = vwapSeries[vwapSeries.length - 1];

    const lookback = 5;
    const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
    const lastPrice = closes[closes.length - 1];
    const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

    const rsiNow = computeRsi(closes, 14);
    const rsiSeries = [];
    for (let i = 0; i < closes.length; i += 1) {
      const sub = closes.slice(0, i + 1);
      const r = computeRsi(sub, 14);
      if (r !== null) rsiSeries.push(r);
    }
    const rsiSlope = slopeLast(rsiSeries, 3);

    const macd = computeMacd(closes, 12, 26, 9);

    const ha = computeHeikenAshi(candles);
    const consec = countConsecutive(ha);

    // vwap crosses
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

    const endMs = activeEndTime ? new Date(activeEndTime).getTime() : null;
    const remainingMinutes = endMs ? (endMs - Date.now()) / 60_000 : null;

    const timeLeftMin = remainingMinutes;

    const timeAware = remainingMinutes === null
      ? { adjustedUp: scored.rawUp, adjustedDown: 1 - scored.rawUp, timeDecay: 1 }
      : applyTimeAwareness(scored.rawUp, remainingMinutes, 15);

    // Market prices from CLOB best ask (buy now)
    const marketUpAsk = activeBbo?.up?.ask ?? null;
    const marketDownAsk = activeBbo?.down?.ask ?? null;

    const edge = computeEdge({
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown,
      marketYes: marketUpAsk,
      marketNo: marketDownAsk
    });

    const rec = decide({
      remainingMinutes: remainingMinutes ?? 999,
      edgeUp: edge.edgeUp,
      edgeDown: edge.edgeDown,
      modelUp: timeAware.adjustedUp,
      modelDown: timeAware.adjustedDown
    });

    return {
      ok: true,
      regime: regimeInfo.regime,
      timeLeftMin,
      indicators: {
        heiken: consec,
        rsi: { value: rsiNow, slopeSign: rsiSlope === null ? "" : rsiSlope > 0 ? "↑" : rsiSlope < 0 ? "↓" : "-" },
        macd: { label: macd === null ? "-" : macd.hist < 0 ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish") : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish") },
        vwap: { value: vwapNow, distPct: vwapDist, slopeLabel: vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT" }
      },
      predict: { pUp: timeAware.adjustedUp, pDown: timeAware.adjustedDown },
      edge,
      recommendation: rec
    };
  }, [candles, activeEndTime, activeBbo, activeAsset]);

  const pUp = derived.ok ? derived.predict.pUp : null;
  const pDown = derived.ok ? derived.predict.pDown : null;

  const mood = useMemo(() => {
    if (pUp === null || pDown === null) return { label: "WARMING UP", dot: "amber" };
    if (pUp > pDown) return { label: `LEAN UP (${Math.round(pUp * 100)}%)`, dot: "green" };
    if (pDown > pUp) return { label: `LEAN DOWN (${Math.round(pDown * 100)}%)`, dot: "red" };
    return { label: "NEUTRAL", dot: "amber" };
  }, [pUp, pDown]);

  const recLabel = derived.ok
    ? (derived.recommendation.action === "ENTER" ? `ENTER NOW (${derived.recommendation.side})` : `NO TRADE (${derived.recommendation.phase})`)
    : "-";

  const recDot = derived.ok
    ? (derived.recommendation.action === "ENTER" ? (derived.recommendation.side === "UP" ? "green" : "red") : "amber")
    : "amber";

  const priceToBeat = ptbByAsset[activeAsset]?.value ?? null;
  const currentPmPrice = pmPrice?.price ?? null;

  return (
    <main className="container">
      <div className="header">
        <div className="brand">
          <div className="h1">Crypto 15m Assistant</div>
          <div className="sub">
            Client-first mode: Binance (seed HTTP once per tab + WS), Polymarket WS (current price + orderbook). Server only provides market metadata.
          </div>
          <div className="tabs" style={{ marginTop: 12 }}>
            {TAB_ORDER.map((t) => (
              <div
                key={t.asset}
                className={`tab ${activeAsset === t.asset ? "tabActive" : ""}`}
                onClick={() => setActiveAsset(t.asset)}
                role="button"
                tabIndex={0}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>

        <div className="pills">
          <span className="pill">Asset: <span className="mono">{activeAsset.toUpperCase()}</span></span>
          <span className="pill">Market: <span className="mono">{activeMarketSlug ?? "-"}</span></span>
          <span className="pill">ET: <span className="mono">{activeMeta?.meta?.etTime ?? "-"}</span></span>
          <span className="pill">Session: <span className="mono">{activeMeta?.meta?.btcSession ?? "-"}</span></span>
          <span className="pill">Updated: <span className="mono">{activeMeta?.meta?.ts ? new Date(activeMeta.meta.ts).toLocaleTimeString() : "-"}</span></span>
        </div>
      </div>

      {activeMetaErr ? <div className="error">{activeMetaErr}</div> : null}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="cardTop">
          <div className="cardTitle">Candles</div>
          <div className="badge"><span className={dotClass(chartBin.status === "live" ? "green" : chartBin.status === "seeding" ? "amber" : "red")} />BN 15m: {String(chartBin.status ?? "-")}</div>
        </div>
        <div className="cardBody">
          <CandleChart candles={chartCandles} seriesData={delta.data} asset={activeAsset} intervalLabel="15m" />
          <div className="chartBelowGrid">
            <div className="infoTableWrap">
              <table className="infoTable">
                <thead>
                  <tr>
                    <th colSpan={3}>Info Table</th>
                  </tr>
                  <tr>
                    <th>Method</th>
                    <th>Demand Strength</th>
                    <th>Supply Strength</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Current Candle</td>
                    <td className="demand">{fmtPct(delta.currentRatio, 2)}</td>
                    <td className="supply">{fmtPct(delta.currentRatio === null ? null : 1 - delta.currentRatio, 2)}</td>
                  </tr>
                  <tr>
                    <td>Moving Average (EMA {DELTA_PERIOD})</td>
                    <td className="demand">{fmtPct(delta.emaRatio, 2)}</td>
                    <td className="supply">{fmtPct(delta.emaRatio === null ? null : 1 - delta.emaRatio, 2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="tradeConsole">
              <div className="tradeConsoleHeader">
                <div className="cardTitle">Trade (Hedged)</div>
                <div className="tradeHeaderActions">
                  <div className="badge"><span className={dotClass(tradeBadge.dot)} />{tradeBadge.label}</div>
                  <button
                    className="btn"
                    onClick={() => (autoEnabled ? setAutoEnabled(false) : setAutoConfirmOpen(true))}
                    disabled={tradeBusy}
                  >
                    {autoEnabled ? "Disable Auto" : "Enable Auto"}
                  </button>
                </div>
              </div>

              <div className="tradeControls">
                <div className="tradeControl">
                  <div className="tradeControlLabel">Offset</div>
                  <div className="stepper">
                    <button
                      className="stepperBtn"
                      onClick={() => setHedgeOffsetCents((v) => Math.max(1, v - 1))}
                      disabled={tradeBusy || autoEnabled || hedgeOffsetCents <= 1}
                    >
                      –
                    </button>
                    <div className="stepperValue mono">{hedgeOffsetCents}¢ under $1</div>
                    <button
                      className="stepperBtn"
                      onClick={() => setHedgeOffsetCents((v) => Math.min(30, v + 1))}
                      disabled={tradeBusy || autoEnabled || hedgeOffsetCents >= 30}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Shares</div>
                  <input
                    className="tradeInput"
                    type="number"
                    min="0"
                    step="1"
                    value={hedgeSizeInput}
                    onChange={(e) => setHedgeSizeInput(e.target.value)}
                    disabled={tradeBusy || autoEnabled}
                  />
                  <div className="shareButtons">
                    {[-50, -20, -10, 10, 20, 50].map((delta) => (
                      <button
                        key={delta}
                        className="shareBtn"
                        onClick={() => adjustHedgeSize(delta)}
                        disabled={tradeBusy || autoEnabled}
                      >
                        {delta > 0 ? `+${delta}` : `${delta}`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Max Leg Price</div>
                  <div className="stepper">
                    <button
                      className="stepperBtn"
                      onClick={() => setMaxLegPriceCents((v) => Math.max(1, v - 1))}
                      disabled={tradeBusy || autoEnabled || maxLegPriceCents <= 1}
                    >
                      –
                    </button>
                    <div className="stepperValue mono">{maxLegPriceCents}¢ max</div>
                    <button
                      className="stepperBtn"
                      onClick={() => setMaxLegPriceCents((v) => Math.min(99, v + 1))}
                      disabled={tradeBusy || autoEnabled || maxLegPriceCents >= 99}
                    >
                      +
                    </button>
                  </div>
                  <div className="tradeControlHint mono">{fmtUsd(maxLegPriceCents / 100, 2)} limit</div>
                </div>
                <div className="tradeControl">
                  <div className="tradeControlLabel">Auto Delay</div>
                  <div className="stepper">
                    <button
                      className="stepperBtn"
                      onClick={() => setAutoDelaySec((v) => Math.max(5, v - 5))}
                      disabled={tradeBusy || autoEnabled || autoDelaySec <= 5}
                    >
                      –
                    </button>
                    <div className="stepperValue mono">{autoDelaySec}s after start</div>
                    <button
                      className="stepperBtn"
                      onClick={() => setAutoDelaySec((v) => Math.min(300, v + 5))}
                      disabled={tradeBusy || autoEnabled || autoDelaySec >= 300}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div className="tradeTableWrap">
                <table className="tradeTable">
                  <thead>
                    <tr>
                      <th />
                      <th>UP</th>
                      <th>DOWN</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Bid Price</td>
                      <td className="tradePrice">{hedgePlan.ok ? fmtUsd(hedgePlan.upPrice, 2) : "-"}</td>
                      <td className="tradePrice">{hedgePlan.ok ? fmtUsd(hedgePlan.downPrice, 2) : "-"}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="tradeMeta">
                  <div>Best Bid: UP {fmtUsd(hedgePlan.upBid, 2)} · DOWN {fmtUsd(hedgePlan.downBid, 2)}</div>
                  <div>Shares: {hedgeSize ? fmtNum(hedgeSize, 0) : "-"}</div>
                  <div>Max leg: {fmtUsd(maxLegPriceCents / 100, 2)}</div>
                  {hedgePlan.ok && hedgeSize ? (
                    <div>
                      Preview: BUY {fmtNum(hedgeSize, 0)} UP @ {fmtUsd(hedgePlan.upPrice, 2)} · BUY {fmtNum(hedgeSize, 0)} DOWN @ {fmtUsd(hedgePlan.downPrice, 2)} · Total {fmtUsd(hedgePlan.sum, 2)} (Target {fmtUsd(hedgePlan.targetTotal, 2)}) · Higher {hedgePlan.higherSide.toUpperCase()}
                    </div>
                  ) : (
                    <div className="tradeHint">{tradeDisabledReason || "Preview unavailable"}</div>
                  )}
                </div>
              </div>

              {autoStatus ? (
                <div className={`autoStatus ${autoStatus.type}`}>
                  {autoStatus.message}
                </div>
              ) : null}

              <div className="tradeActions">
                <button className="btn" onClick={() => submitHedgeOrders({ source: "manual" })} disabled={tradeBusy || Boolean(manualDisabledReason)}>
                  Place Hedge Orders
                </button>
                {manualDisabledReason ? <div className="tradeHint">{manualDisabledReason}</div> : null}
              </div>

              {tradeStatus ? (
                <div className={`tradeStatus ${tradeStatus.type}`}>
                  <div className="tradeStatusTitle">{tradeStatus.message}</div>
                  {tradeStatus.results && activeTokens?.upTokenId && activeTokens?.downTokenId ? (
                    <div className="tradeStatusBody mono">
                      <div>UP: {tradeStatus.results[activeTokens.upTokenId]?.orderId ?? "-"}</div>
                      <div>DOWN: {tradeStatus.results[activeTokens.downTokenId]?.orderId ?? "-"}</div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {autoConfirmOpen ? (
                <div className="modalBackdrop">
                  <div className="modal">
                    <div className="modalTitle">Enable Auto Trade</div>
                    <div className="modalBody">
                      <div className="modalWarning">
                        Auto Trade will place hedged BUY orders exactly {autoDelaySec}s after the market window starts. If that time has already passed, no trades will be placed while Auto is on.
                      </div>
                      <div className="modalList">
                        <div>Asset: {activeAsset.toUpperCase()}</div>
                        <div>Offset: {hedgeOffsetCents}¢ under $1</div>
                        <div>Shares: {hedgeSize ? fmtNum(hedgeSize, 0) : "-"}</div>
                        <div>Max leg: {fmtUsd(maxLegPriceCents / 100, 2)}</div>
                        <div>Auto delay: {autoDelaySec}s</div>
                        <div>Best bid: UP {fmtUsd(hedgePlan.upBid, 2)} · DOWN {fmtUsd(hedgePlan.downBid, 2)}</div>
                        <div>Order prices: UP {hedgePlan.ok ? fmtUsd(hedgePlan.upPrice, 2) : "-"} · DOWN {hedgePlan.ok ? fmtUsd(hedgePlan.downPrice, 2) : "-"}</div>
                        <div>Status: {tradeDisabledReason || "Ready"}</div>
                      </div>
                    </div>
                    <div className="modalActions">
                      <button className="btn" onClick={() => setAutoConfirmOpen(false)} disabled={tradeBusy}>Cancel</button>
                      <button
                        className="btn primary"
                        onClick={() => {
                          setAutoConfirmOpen(false);
                          setAutoEnabled(true);
                        }}
                        disabled={tradeBusy}
                      >
                        Confirm & Enable
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="grid" style={{ marginTop: 18 }}>
        <section className="card">
          <div className="cardTop">
            <div className="cardTitle">Signal</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="badge"><span className={dotClass(mood.dot)} />{mood.label}</span>
              <span className="badge"><span className={dotClass(recDot)} />{recLabel}</span>
            </div>
          </div>
          <div className="cardBody">
            <div className="split">
              <div className="card" style={{ boxShadow: "none" }}>
                <div className="cardTop"><div className="cardTitle">TA Predict</div></div>
                <div className="cardBody">
                  <div className="bigRow">
                    <div className="bigLabel">UP</div>
                    <div className="bigValue" style={{ color: "var(--green)" }}>{pUp === null ? "-" : `${Math.round(pUp * 100)}%`}</div>
                  </div>
                  <div className="bigRow">
                    <div className="bigLabel">DOWN</div>
                    <div className="bigValue" style={{ color: "var(--red)" }}>{pDown === null ? "-" : `${Math.round(pDown * 100)}%`}</div>
                  </div>
                </div>
              </div>

              <div className="card" style={{ boxShadow: "none" }}>
                <div className="cardTop"><div className="cardTitle">Clock</div></div>
                <div className="cardBody">
                  <div className="kv"><div className="k">Time left</div><div className="v mono" style={{ color: derived.ok && derived.timeLeftMin !== null && derived.timeLeftMin < 5 ? "var(--red)" : derived.ok && derived.timeLeftMin !== null && derived.timeLeftMin < 10 ? "var(--amber)" : "var(--text)" }}>{fmtTimeLeft(derived.ok ? derived.timeLeftMin : null)}</div></div>
                  <div className="kv"><div className="k">Phase</div><div className="v mono">{derived.ok ? derived.recommendation.phase : "-"}</div></div>
                  <div className="kv"><div className="k">Window</div><div className="v mono">15m</div></div>
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="card" style={{ boxShadow: "none" }}>
              <div className="cardTop"><div className="cardTitle">Indicators</div></div>
              <div className="cardBody">
                <div className="kv"><div className="k">Heiken Ashi</div><div className="v mono">{derived.ok ? `${derived.indicators.heiken.color} x${derived.indicators.heiken.count}` : "-"}</div></div>
                <div className="kv"><div className="k">RSI</div><div className="v mono">{derived.ok ? `${fmtNum(derived.indicators.rsi.value, 1)} ${derived.indicators.rsi.slopeSign}` : "-"}</div></div>
                <div className="kv"><div className="k">MACD</div><div className="v mono">{derived.ok ? derived.indicators.macd.label : "-"}</div></div>
                <div className="kv"><div className="k">VWAP</div><div className="v mono">{derived.ok ? `${fmtUsd(derived.indicators.vwap.value, 0)} (${fmtPct(derived.indicators.vwap.distPct, 2)}) · slope ${derived.indicators.vwap.slopeLabel}` : "-"}</div></div>
              </div>
            </div>
          </div>
        </section>

        <aside className="card">
          <div className="cardTop">
            <div className="cardTitle">Market</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={() => setMetaByAsset((p) => ({ ...p }))} disabled={activeMetaLoading}>{activeMetaLoading ? "Loading…" : "Refresh"}</button>
              <span className="badge"><span className={dotClass(pmPrice.status === "live" ? "green" : pmPrice.status === "connecting" ? "amber" : "red")} />PM WS: {pmPrice.status}</span>
              <span className="badge"><span className={dotClass(bin.status === "live" ? "green" : bin.status === "seeding" ? "amber" : "red")} />BN: {String(bin.status ?? "-")}</span>
            </div>
          </div>
          <div className="cardBody">
            <div className="kv">
              <div className="k">Polymarket UP</div>
              <div className="v mono" style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                <span style={{ color: "var(--muted)" }}>bid</span>
                <span style={{ color: "var(--green)", minWidth: 62, textAlign: "right" }}>{activeBbo?.up?.bid !== null && activeBbo?.up?.bid !== undefined ? `${fmtNum(activeBbo.up.bid * 100, 2)}¢` : "-"}</span>
                <span style={{ color: "var(--muted)", marginLeft: 10 }}>ask</span>
                <span style={{ color: "var(--green)", minWidth: 62, textAlign: "right" }}>{activeBbo?.up?.ask !== null && activeBbo?.up?.ask !== undefined ? `${fmtNum(activeBbo.up.ask * 100, 2)}¢` : "-"}</span>
              </div>
            </div>
            <div className="kv">
              <div className="k">Polymarket DOWN</div>
              <div className="v mono" style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                <span style={{ color: "var(--muted)" }}>bid</span>
                <span style={{ color: "var(--red)", minWidth: 62, textAlign: "right" }}>{activeBbo?.down?.bid !== null && activeBbo?.down?.bid !== undefined ? `${fmtNum(activeBbo.down.bid * 100, 2)}¢` : "-"}</span>
                <span style={{ color: "var(--muted)", marginLeft: 10 }}>ask</span>
                <span style={{ color: "var(--red)", minWidth: 62, textAlign: "right" }}>{activeBbo?.down?.ask !== null && activeBbo?.down?.ask !== undefined ? `${fmtNum(activeBbo.down.ask * 100, 2)}¢` : "-"}</span>
              </div>
            </div>

            <div className="kv"><div className="k">Liquidity</div><div className="v mono">{activeMeta?.polymarket?.liquidity !== null && activeMeta?.polymarket?.liquidity !== undefined ? fmtNum(activeMeta.polymarket.liquidity, 0) : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Current price (Polymarket WS)</div><div className="v mono">{fmtUsd(currentPmPrice, 2)}</div></div>
            <div className="kv"><div className="k">Price to beat</div><div className="v mono">{fmtUsd(priceToBeat, 0)}</div></div>
            <div className="kv"><div className="k">Δ vs price to beat</div><div className="v mono">{(currentPmPrice !== null && priceToBeat !== null) ? `${currentPmPrice - priceToBeat > 0 ? "+" : "-"}${fmtUsd(Math.abs(currentPmPrice - priceToBeat), 2)}` : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Binance {normalizeBinanceSymbol(activeAsset)}</div><div className="v mono">{candles ? fmtUsd(candles[candles.length - 1]?.close ?? null, activeAsset === "xrp" ? 4 : 2) : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Model edge (UP)</div><div className="v mono">{derived.ok && derived.edge.edgeUp !== null ? fmtPct(derived.edge.edgeUp, 2) : "-"}</div></div>
            <div className="kv"><div className="k">Model edge (DOWN)</div><div className="v mono">{derived.ok && derived.edge.edgeDown !== null ? fmtPct(derived.edge.edgeDown, 2) : "-"}</div></div>
          </div>
        </aside>
      </div>

      <div className="footer">
        <div>Client-first: Binance seed-on-open + WS. No server SSE.</div>
      </div>
    </main>
  );
}
