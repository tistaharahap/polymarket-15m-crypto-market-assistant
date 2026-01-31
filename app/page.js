"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { connectPolymarketChainlinkWs } from "./_ws/polymarketPrice";

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
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [wsPrice, setWsPrice] = useState(null);
  const [wsUpdatedAt, setWsUpdatedAt] = useState(null);
  const [priceToBeat, setPriceToBeat] = useState(null);
  const [priceToBeatSetAt, setPriceToBeatSetAt] = useState(null);
  const [ptbMarketSlug, setPtbMarketSlug] = useState(null);

  // streaming mode; no polling tick needed
  const abortRef = useRef(null);
  const wsRef = useRef(null);

  // SSE stream for server-proxied snapshot (markets/indicators/edges)
  useEffect(() => {
    abortRef.current?.abort?.();

    if (!auto) return;

    const es = new EventSource("/api/stream");

    es.addEventListener("snapshot", (evt) => {
      try {
        const j = JSON.parse(evt.data);
        setData(j);
        setErr(null);
        setLoading(false);
      } catch (e) {
        setErr(e?.message ?? String(e));
      }
    });

    es.addEventListener("error", (evt) => {
      // Some browsers emit generic error events; route also may send {event:error}
      if (evt?.data) {
        try {
          const j = JSON.parse(evt.data);
          setErr(j?.error ?? "Stream error");
        } catch {
          setErr("Stream error");
        }
      } else {
        setErr("Stream disconnected");
      }
      setLoading(false);
    });

    return () => {
      es.close();
    };
  }, [auto]);

  // Client WS for CURRENT PRICE (Polymarket live-data WS)
  useEffect(() => {
    // always keep the WS alive (even when auto is off) so price-to-beat can latch correctly
    wsRef.current?.close?.();

    const c = connectPolymarketChainlinkWs({
      onTick: ({ price, updatedAtMs }) => {
        setWsPrice(price);
        setWsUpdatedAt(updatedAtMs);
      }
    });

    wsRef.current = c;
    return () => c?.close?.();
  }, []);

  // Latch price-to-beat once per market window using WS price + market start time.
  useEffect(() => {
    const marketSlug = data?.polymarket?.marketSlug ?? null;
    const startTime = data?.polymarket?.marketStartTime ?? null;
    const startMs = startTime ? new Date(startTime).getTime() : null;

    if (marketSlug && marketSlug !== ptbMarketSlug) {
      setPtbMarketSlug(marketSlug);
      setPriceToBeat(null);
      setPriceToBeatSetAt(null);
    }

    if (!marketSlug) return;
    if (priceToBeat !== null) return;
    if (wsPrice === null) return;

    const nowMs = Date.now();
    const okToLatch = startMs === null ? true : Number.isFinite(startMs) && nowMs >= startMs;
    if (!okToLatch) return;

    setPriceToBeat(wsPrice);
    setPriceToBeatSetAt(nowMs);
  }, [data?.polymarket?.marketSlug, data?.polymarket?.marketStartTime, wsPrice, ptbMarketSlug, priceToBeat]);

  async function refresh() {
    // manual refresh uses snapshot endpoint once
    abortRef.current?.abort?.();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/snapshot", { cache: "no-store", signal: ac.signal });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      if (String(e?.name) === "AbortError") return;
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // when auto is OFF, load once
    if (!auto) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const pUp = data?.predict?.pUp ?? null;
  const pDown = data?.predict?.pDown ?? null;

  const mood = useMemo(() => {
    if (pUp === null || pDown === null) return { label: "NO SIGNAL", dot: "amber" };
    if (pUp > pDown) return { label: `LEAN UP (${Math.round(pUp * 100)}%)`, dot: "green" };
    if (pDown > pUp) return { label: `LEAN DOWN (${Math.round(pDown * 100)}%)`, dot: "red" };
    return { label: "NEUTRAL", dot: "amber" };
  }, [pUp, pDown]);

  const action = data?.recommendation?.action || "-";
  const actionDot = action === "ENTER" ? (data?.recommendation?.side === "UP" ? "green" : "red") : "amber";

  return (
    <main className="container">
      <div className="header">
        <div className="brand">
          <div className="h1">BTC 15m Assistant</div>
          <div className="sub">
            Web UI overlay for the existing engine. Market/indicators are server-proxied. Current price uses a direct Polymarket WS connection (by design).
          </div>
        </div>

        <div className="pills">
          <span className="pill">Market: <span className="mono">{data?.polymarket?.marketSlug ?? "-"}</span></span>
          <span className="pill">ET: <span className="mono">{data?.meta?.etTime ?? "-"}</span></span>
          <span className="pill">Session: <span className="mono">{data?.meta?.btcSession ?? "-"}</span></span>
          <span className="pill">Updated: <span className="mono">{data?.meta?.ts ? new Date(data.meta.ts).toLocaleTimeString() : "-"}</span></span>
        </div>
      </div>

      {err ? <div className="error">{err}</div> : null}

      <div className="grid" style={{ marginTop: 14 }}>
        <section className="card">
          <div className="cardTop">
            <div className="cardTitle">Signal</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="badge"><span className={dotClass(mood.dot)} />{mood.label}</span>
              <span className="badge"><span className={dotClass(actionDot)} />{data?.recommendation?.label ?? "-"}</span>
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
                  <div className="kv"><div className="k">Time left</div><div className="v mono" style={{ color: data?.timing?.danger ? "var(--red)" : data?.timing?.warn ? "var(--amber)" : "var(--text)" }}>{fmtTimeLeft(data?.timing?.timeLeftMin)}</div></div>
                  <div className="kv"><div className="k">Phase</div><div className="v mono">{data?.recommendation?.phase ?? "-"}</div></div>
                  <div className="kv"><div className="k">Window</div><div className="v mono">{data?.timing?.windowMin ?? "-"}m</div></div>
                </div>
              </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="card" style={{ boxShadow: "none" }}>
              <div className="cardTop"><div className="cardTitle">Indicators</div></div>
              <div className="cardBody">
                <div className="kv"><div className="k">Heiken Ashi</div><div className="v mono">{data?.indicators?.heiken?.color ?? "-"} x{data?.indicators?.heiken?.count ?? "-"}</div></div>
                <div className="kv"><div className="k">RSI</div><div className="v mono">{fmtNum(data?.indicators?.rsi?.value, 1)} {data?.indicators?.rsi?.slopeSign ?? ""}</div></div>
                <div className="kv"><div className="k">MACD</div><div className="v mono">{data?.indicators?.macd?.label ?? "-"}</div></div>
                <div className="kv"><div className="k">VWAP</div><div className="v mono">{fmtUsd(data?.indicators?.vwap?.value, 0)} ({fmtPct(data?.indicators?.vwap?.distPct, 2)}) · slope {data?.indicators?.vwap?.slopeLabel ?? "-"}</div></div>
              </div>
            </div>
          </div>
        </section>

        <aside className="card">
          <div className="cardTop">
            <div className="cardTitle">Market</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button className="btn" onClick={() => refresh()} disabled={loading}>Refresh</button>
              <button className="btn" onClick={() => setAuto((x) => !x)}>{auto ? "Auto: ON" : "Auto: OFF"}</button>
            </div>
          </div>
          <div className="cardBody">
            <div className="kv"><div className="k">Polymarket UP</div><div className="v mono" style={{ color: "var(--green)" }}>{data?.polymarket?.prices?.up !== null && data?.polymarket?.prices?.up !== undefined ? `${fmtNum(data.polymarket.prices.up, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Polymarket DOWN</div><div className="v mono" style={{ color: "var(--red)" }}>{data?.polymarket?.prices?.down !== null && data?.polymarket?.prices?.down !== undefined ? `${fmtNum(data.polymarket.prices.down, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Liquidity</div><div className="v mono">{data?.polymarket?.liquidity !== null && data?.polymarket?.liquidity !== undefined ? fmtNum(data.polymarket.liquidity, 0) : "-"}</div></div>
            <div className="kv"><div className="k">Spread (worst)</div><div className="v mono">{data?.polymarket?.spread !== null && data?.polymarket?.spread !== undefined ? fmtNum(data.polymarket.spread, 4) : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Price to beat</div><div className="v mono">{fmtUsd(priceToBeat, 0)}</div></div>
            <div className="kv"><div className="k">Δ vs price to beat</div><div className="v mono">{(wsPrice !== null && priceToBeat !== null) ? `${wsPrice - priceToBeat > 0 ? "+" : "-"}${fmtUsd(Math.abs(wsPrice - priceToBeat), 2)}` : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Current price (Polymarket WS)</div><div className="v mono">{fmtUsd(wsPrice, 2)}</div></div>
            <div className="kv"><div className="k">Binance BTCUSDT</div><div className="v mono">{fmtUsd(data?.prices?.binance, 0)}</div></div>
            <div className="kv"><div className="k">Diff</div><div className="v mono">{data?.prices?.diffUsd !== null && data?.prices?.diffUsd !== undefined ? `${data.prices.diffUsd > 0 ? "+" : "-"}${fmtUsd(Math.abs(data.prices.diffUsd), 2)} (${(data?.prices?.diffPct ?? 0) > 0 ? "+" : "-"}${Math.abs(data?.prices?.diffPct ?? 0).toFixed(2)}%)` : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Model edge (UP)</div><div className="v mono">{data?.edge?.edgeUp !== null && data?.edge?.edgeUp !== undefined ? fmtPct(data.edge.edgeUp, 2) : "-"}</div></div>
            <div className="kv"><div className="k">Model edge (DOWN)</div><div className="v mono">{data?.edge?.edgeDown !== null && data?.edge?.edgeDown !== undefined ? fmtPct(data.edge.edgeDown, 2) : "-"}</div></div>
          </div>
        </aside>
      </div>

      <div className="footer">
        <div>CLI remains available via <span className="mono">npm start</span>. Web UI via <span className="mono">npm run web</span>.</div>
        <div className="mono">Proxy rule: browser → Next API → external sources</div>
      </div>
    </main>
  );
}
