"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  const [tick, setTick] = useState(0);
  const abortRef = useRef(null);

  useEffect(() => {
    let t = null;
    if (auto) {
      t = setInterval(() => setTick((x) => x + 1), 1000);
    }
    return () => t && clearInterval(t);
  }, [auto]);

  async function refresh() {
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
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const mood = useMemo(() => {
    const pUp = data?.predict?.pUp;
    const pDown = data?.predict?.pDown;
    if (pUp === null || pDown === null) return { label: "NO SIGNAL", dot: "amber" };
    if (pUp > pDown) return { label: `LEAN UP (${Math.round(pUp * 100)}%)`, dot: "green" };
    if (pDown > pUp) return { label: `LEAN DOWN (${Math.round(pDown * 100)}%)`, dot: "red" };
    return { label: "NEUTRAL", dot: "amber" };
  }, [data]);

  const action = data?.recommendation?.action || "-";
  const actionDot = action === "ENTER" ? (data?.recommendation?.side === "UP" ? "green" : "red") : "amber";

  return (
    <main className="container">
      <div className="header">
        <div className="brand">
          <div className="h1">BTC 15m Assistant</div>
          <div className="sub">
            Web UI overlay for the existing engine. Client only talks to Next.js API routes—external data stays server-side.
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
                    <div className="bigValue" style={{ color: "var(--green)" }}>{data?.predict?.pUp !== null ? `${Math.round(data.predict.pUp * 100)}%` : "-"}</div>
                  </div>
                  <div className="bigRow">
                    <div className="bigLabel">DOWN</div>
                    <div className="bigValue" style={{ color: "var(--red)" }}>{data?.predict?.pDown !== null ? `${Math.round(data.predict.pDown * 100)}%` : "-"}</div>
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
            <div className="kv"><div className="k">Polymarket UP</div><div className="v mono" style={{ color: "var(--green)" }}>{data?.polymarket?.prices?.up !== null ? `${fmtNum(data.polymarket.prices.up, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Polymarket DOWN</div><div className="v mono" style={{ color: "var(--red)" }}>{data?.polymarket?.prices?.down !== null ? `${fmtNum(data.polymarket.prices.down, 2)}¢` : "-"}</div></div>
            <div className="kv"><div className="k">Liquidity</div><div className="v mono">{data?.polymarket?.liquidity !== null ? fmtNum(data.polymarket.liquidity, 0) : "-"}</div></div>
            <div className="kv"><div className="k">Spread (worst)</div><div className="v mono">{data?.polymarket?.spread !== null ? fmtNum(data.polymarket.spread, 4) : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Chainlink BTC/USD</div><div className="v mono">{fmtUsd(data?.prices?.chainlink, 2)}</div></div>
            <div className="kv"><div className="k">Binance BTCUSDT</div><div className="v mono">{fmtUsd(data?.prices?.binance, 0)}</div></div>
            <div className="kv"><div className="k">Diff</div><div className="v mono">{data?.prices?.diffUsd !== null ? `${data.prices.diffUsd > 0 ? "+" : "-"}${fmtUsd(Math.abs(data.prices.diffUsd), 2)} (${data.prices.diffPct > 0 ? "+" : "-"}${Math.abs(data.prices.diffPct).toFixed(2)}%)` : "-"}</div></div>

            <div style={{ height: 12 }} />

            <div className="kv"><div className="k">Model edge (UP)</div><div className="v mono">{data?.edge?.edgeUp !== null ? fmtPct(data.edge.edgeUp, 2) : "-"}</div></div>
            <div className="kv"><div className="k">Model edge (DOWN)</div><div className="v mono">{data?.edge?.edgeDown !== null ? fmtPct(data.edge.edgeDown, 2) : "-"}</div></div>
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
