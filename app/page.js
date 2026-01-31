"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { connectPolymarketChainlinkWs } from "./_ws/polymarketPrice";

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

function useAssetStream({ asset, enabled, onSnapshot, onError }) {
  useEffect(() => {
    if (!enabled) return;

    const es = new EventSource(`/api/stream?asset=${encodeURIComponent(asset)}`);

    es.addEventListener("snapshot", (evt) => {
      try {
        const j = JSON.parse(evt.data);
        onSnapshot?.(j);
      } catch (e) {
        onError?.(e?.message ?? String(e));
      }
    });

    es.addEventListener("error", (evt) => {
      if (evt?.data) {
        try {
          const j = JSON.parse(evt.data);
          onError?.(j?.error ?? "Stream error");
        } catch {
          onError?.("Stream error");
        }
      } else {
        onError?.("Stream disconnected");
      }
    });

    return () => es.close();
  }, [asset, enabled, onSnapshot, onError]);
}

export default function Page() {
  const [activeAsset, setActiveAsset] = useState("btc");

  // server-proxied snapshot data (per asset)
  const [snapByAsset, setSnapByAsset] = useState({});
  const [errByAsset, setErrByAsset] = useState({});
  const [loadingByAsset, setLoadingByAsset] = useState({ btc: true, eth: true, xrp: true, sol: true });

  // client WS price (per asset)
  const [wsByAsset, setWsByAsset] = useState({});

  // client-latched price-to-beat (per asset)
  const [ptbByAsset, setPtbByAsset] = useState({});

  const wsRef = useRef(null);

  const activeSnap = snapByAsset[activeAsset] ?? null;
  const activeErr = errByAsset[activeAsset] ?? null;
  const activeLoading = loadingByAsset[activeAsset] ?? false;

  const activeWs = wsByAsset[activeAsset] ?? { price: null, updatedAtMs: null, status: "-" };
  const activePtb = ptbByAsset[activeAsset] ?? { value: null, setAtMs: null, marketSlug: null };

  // SSE: only keep one EventSource alive for the active tab.
  useAssetStream({
    asset: activeAsset,
    enabled: true,
    onSnapshot: (j) => {
      setSnapByAsset((prev) => ({ ...prev, [activeAsset]: j }));
      setErrByAsset((prev) => ({ ...prev, [activeAsset]: null }));
      setLoadingByAsset((prev) => ({ ...prev, [activeAsset]: false }));
    },
    onError: (msg) => {
      setErrByAsset((prev) => ({ ...prev, [activeAsset]: msg }));
      setLoadingByAsset((prev) => ({ ...prev, [activeAsset]: false }));
    }
  });

  // Client WS: connect only for active tab.
  useEffect(() => {
    wsRef.current?.close?.();

    setWsByAsset((prev) => ({
      ...prev,
      [activeAsset]: { ...(prev[activeAsset] ?? {}), status: "connecting" }
    }));

    const c = connectPolymarketChainlinkWs({
      symbolIncludes: activeAsset,
      onTick: ({ price, updatedAtMs }) => {
        setWsByAsset((prev) => ({
          ...prev,
          [activeAsset]: { price, updatedAtMs, status: "live" }
        }));
      },
      onStatus: ({ status }) => {
        setWsByAsset((prev) => ({
          ...prev,
          [activeAsset]: { ...(prev[activeAsset] ?? {}), status }
        }));
      }
    });

    wsRef.current = c;
    return () => c?.close?.();
  }, [activeAsset]);

  // Latch price-to-beat per asset: first WS tick at/after marketStartTime, resets on rollover.
  useEffect(() => {
    const marketSlug = activeSnap?.polymarket?.marketSlug ?? null;
    const startTime = activeSnap?.polymarket?.marketStartTime ?? null;
    const startMs = startTime ? new Date(startTime).getTime() : null;

    const wsPrice = activeWs?.price ?? null;

    setPtbByAsset((prev) => {
      const cur = prev[activeAsset] ?? { value: null, setAtMs: null, marketSlug: null };

      // reset if market rolled
      if (marketSlug && cur.marketSlug !== marketSlug) {
        return {
          ...prev,
          [activeAsset]: { value: null, setAtMs: null, marketSlug }
        };
      }

      // if no market, clear
      if (!marketSlug) {
        if (cur.value === null && cur.marketSlug === null) return prev;
        return {
          ...prev,
          [activeAsset]: { value: null, setAtMs: null, marketSlug: null }
        };
      }

      // already latched
      if (cur.value !== null) return prev;
      if (wsPrice === null) return prev;

      const nowMs = Date.now();
      const okToLatch = startMs === null ? true : Number.isFinite(startMs) && nowMs >= startMs;
      if (!okToLatch) return prev;

      return {
        ...prev,
        [activeAsset]: { value: wsPrice, setAtMs: nowMs, marketSlug }
      };
    });
  }, [activeAsset, activeSnap?.polymarket?.marketSlug, activeSnap?.polymarket?.marketStartTime, activeWs?.price]);

  async function refreshOnce(asset) {
    setLoadingByAsset((prev) => ({ ...prev, [asset]: true }));
    setErrByAsset((prev) => ({ ...prev, [asset]: null }));
    try {
      const res = await fetch(`/api/snapshot?asset=${encodeURIComponent(asset)}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setSnapByAsset((prev) => ({ ...prev, [asset]: j }));
    } catch (e) {
      setErrByAsset((prev) => ({ ...prev, [asset]: e?.message ?? String(e) }));
    } finally {
      setLoadingByAsset((prev) => ({ ...prev, [asset]: false }));
    }
  }

  const pUp = activeSnap?.predict?.pUp ?? null;
  const pDown = activeSnap?.predict?.pDown ?? null;

  const mood = useMemo(() => {
    if (pUp === null || pDown === null) return { label: "NO SIGNAL", dot: "amber" };
    if (pUp > pDown) return { label: `LEAN UP (${Math.round(pUp * 100)}%)`, dot: "green" };
    if (pDown > pUp) return { label: `LEAN DOWN (${Math.round(pDown * 100)}%)`, dot: "red" };
    return { label: "NEUTRAL", dot: "amber" };
  }, [pUp, pDown]);

  const action = activeSnap?.recommendation?.action || "-";
  const actionDot = action === "ENTER" ? (activeSnap?.recommendation?.side === "UP" ? "green" : "red") : "amber";

  const wsPrice = activeWs?.price ?? null;
  const priceToBeat = activePtb?.value ?? null;

  return (
    <main className="container">
      <div className="header">
        <div className="brand">
          <div className="h1">Crypto 15m Assistant</div>
          <div className="sub">
            Tabs per asset. Indicators/market data are server-proxied via Next.js. Current price uses a direct Polymarket WS connection (approved).
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
          <span className="pill">Market: <span className="mono">{activeSnap?.polymarket?.marketSlug ?? "-"}</span></span>
          <span className="pill">ET: <span className="mono">{activeSnap?.meta?.etTime ?? "-"}</span></span>
          <span className="pill">Session: <span className="mono">{activeSnap?.meta?.btcSession ?? "-"}</span></span>
          <span className="pill">Updated: <span className="mono">{activeSnap?.meta?.ts ? new Date(activeSnap.meta.ts).toLocaleTimeString() : "-"}</span></span>
        </div>
      </div>

      {activeErr ? <div className="error">{activeErr}</div> : null}

      <div className="grid" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="cardTop">
            <div className="cardTitle">Signal</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="badge"><span className={dotClass(mood.dot)} />{mood.label}</span>
              <span className="badge"><span className={dotClass(actionDot)} />{activeSnap?.recommendation?.label ?? "-"}</span>
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
                  <div className="kv"><div className="k">Time left</div><div className="v mono" style={{ color: activeSnap?.timing?.danger ? "var(--red)" : activeSnap?.timing?.warn ? "var(--amber)" : "var(--text)" }}>{fmtTimeLeft(activeSnap?.timing?.timeLeftMin)}</div></div>
                  <div className="kv"><div className="k">Phase</div><div className="v mono">{activeSnap?.recommendation?.phase ?? "-"}</div></div>
                  <div className="kv"><div className="k">Window</div><div className="v mono">{activeSnap?.timing?.windowMin ?? "-"}m</div></div>
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="card" style={{ boxShadow: "none" }}>
              <div className="cardTop"><div className="cardTitle">Indicators</div></div>
              <div className="cardBody">
                <div className="kv"><div className="k">Heiken Ashi</div><div className="v mono">{activeSnap?.indicators?.heiken?.color ?? "-"} x{activeSnap?.indicators?.heiken?.count ?? "-"}</div></div>
                <div className="kv"><div className="k">RSI</div><div className="v mono">{fmtNum(activeSnap?.indicators?.rsi?.value, 1)} {activeSnap?.indicators?.rsi?.slopeSign ?? ""}</div></div>
                <div className="kv"><div className="k">MACD</div><div className="v mono">{activeSnap?.indicators?.macd?.label ?? "-"}</div></div>
                <div className="kv"><div className="k">VWAP</div><div className="v mono">{fmtUsd(activeSnap?.indicators?.vwap?.value, 0)} ({fmtPct(activeSnap?.indicators?.vwap?.distPct, 2)}) · slope {activeSnap?.indicators?.vwap?.slopeLabel ?? "-"}</div></div>
              </div>
            </div>
          </div>
        </section>

        <aside className="card">
          <div className="cardTop">
            <div className="cardTitle">Market</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={() => refreshOnce(activeAsset)} disabled={activeLoading}>{activeLoading ? "Loading…" : "Refresh"}</button>
              <span className="badge"><span className={dotClass(activeWs?.status === "live" ? "green" : activeWs?.status === "connecting" ? "amber" : "red")} />WS: {String(activeWs?.status ?? "-")}</span>
            </div>
          </div>
          <div className="cardBody">
            <div className="kv"><div className="k">Polymarket UP</div><div className="v mono" style={{ color: "var(--green)" }}>{activeSnap?.polymarket?.prices?.up !== null && activeSnap?.polymarket?.prices?.up !== undefined ? `${fmtNum(activeSnap.polymarket.prices.up, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Polymarket DOWN</div><div className="v mono" style={{ color: "var(--red)" }}>{activeSnap?.polymarket?.prices?.down !== null && activeSnap?.polymarket?.prices?.down !== undefined ? `${fmtNum(activeSnap.polymarket.prices.down, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Liquidity</div><div className="v mono">{activeSnap?.polymarket?.liquidity !== null && activeSnap?.polymarket?.liquidity !== undefined ? fmtNum(activeSnap.polymarket.liquidity, 0) : "-"}</div></div>
            <div className="kv"><div className="k">Spread (worst)</div><div className="v mono">{activeSnap?.polymarket?.spread !== null && activeSnap?.polymarket?.spread !== undefined ? fmtNum(activeSnap.polymarket.spread, 4) : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Current price (Polymarket WS)</div><div className="v mono">{fmtUsd(wsPrice, 2)}</div></div>
            <div className="kv"><div className="k">Price to beat</div><div className="v mono">{fmtUsd(priceToBeat, 0)}</div></div>
            <div className="kv"><div className="k">Δ vs price to beat</div><div className="v mono">{(wsPrice !== null && priceToBeat !== null) ? `${wsPrice - priceToBeat > 0 ? "+" : "-"}${fmtUsd(Math.abs(wsPrice - priceToBeat), 2)}` : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Binance {activeAsset.toUpperCase()}USDT</div><div className="v mono">{fmtUsd(activeSnap?.prices?.binance, activeAsset === "xrp" ? 4 : 2)}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Model edge (UP)</div><div className="v mono">{activeSnap?.edge?.edgeUp !== null && activeSnap?.edge?.edgeUp !== undefined ? fmtPct(activeSnap.edge.edgeUp, 2) : "-"}</div></div>
            <div className="kv"><div className="k">Model edge (DOWN)</div><div className="v mono">{activeSnap?.edge?.edgeDown !== null && activeSnap?.edge?.edgeDown !== undefined ? fmtPct(activeSnap.edge.edgeDown, 2) : "-"}</div></div>
          </div>
        </aside>
      </div>

      <div className="footer">
        <div>Tabs: BTC, ETH, XRP, SOL. Web UI via <span className="mono">npm run web</span>.</div>
        <div className="mono">SSE: /api/stream?asset=... · Snapshot: /api/snapshot?asset=...</div>
      </div>
    </main>
  );
}
