"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

export default function Page() {
  const [activeAsset, setActiveAsset] = useState("btc");

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

  // CLOB best bid/ask per asset
  const [clobByAsset, setClobByAsset] = useState({});

  const pmWsRef = useRef(null);
  const clobRef = useRef(null);
  const binanceRef = useRef(null);

  const activeMeta = metaByAsset[activeAsset] ?? null;
  const activeMetaErr = metaErrByAsset[activeAsset] ?? null;
  const activeMetaLoading = metaLoadingByAsset[activeAsset] ?? false;

  const activeTokens = activeMeta?.polymarket?.tokens ?? null;
  const activeMarketSlug = activeMeta?.polymarket?.marketSlug ?? null;
  const activeStartTime = activeMeta?.polymarket?.marketStartTime ?? null;
  const activeEndTime = activeMeta?.polymarket?.marketEndTime ?? null;

  const activeBbo = clobByAsset[activeAsset] ?? { marketSlug: null, up: null, down: null };

  const bin = binanceByAsset[activeAsset] ?? { status: "-", candles: null, lastTrade: null };

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

  // Binance: seed once per active tab (HTTP) then WS updates
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

      <div className="grid" style={{ marginTop: 14 }}>
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
