// Browser-only Polymarket live-data WS client.
// Mirrors src/data/polymarketLiveWs.js but without node ws + proxy agent.

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function normalizePayload(payload) {
  if (!payload) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload === "string") return safeJsonParse(payload);
  return null;
}

function toFiniteNumber(x) {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

export function connectPolymarketChainlinkWs({
  wsUrl = "wss://ws-live-data.polymarket.com",
  symbolIncludes = "btc",
  onTick,
  onStatus
} = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;

  const connect = () => {
    if (closed) return;

    ws = new WebSocket(wsUrl);

    const scheduleReconnect = () => {
      if (closed) return;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.addEventListener("open", () => {
      reconnectMs = 500;
      try {
        if (typeof onStatus === "function") onStatus({ status: "open" });
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: "" }]
          })
        );
      } catch {
        scheduleReconnect();
      }
    });

    ws.addEventListener("message", (evt) => {
      const msg = typeof evt?.data === "string" ? evt.data : "";
      if (!msg || !msg.trim()) return;

      const data = safeJsonParse(msg);
      if (!data || data.topic !== "crypto_prices_chainlink") return;

      const payload = normalizePayload(data.payload) || {};
      const symbol = String(payload.symbol || payload.pair || payload.ticker || "").toLowerCase();
      if (symbolIncludes && !symbol.includes(String(symbolIncludes).toLowerCase())) return;

      const price = toFiniteNumber(payload.value ?? payload.price ?? payload.current ?? payload.data);
      if (price === null) return;

      const updatedAtMs = toFiniteNumber(payload.timestamp)
        ? Math.floor(Number(payload.timestamp) * 1000)
        : toFiniteNumber(payload.updatedAt)
          ? Math.floor(Number(payload.updatedAt) * 1000)
          : null;

      if (typeof onTick === "function") onTick({ price, updatedAtMs });
    });

    ws.addEventListener("close", () => {
      if (typeof onStatus === "function") onStatus({ status: "closed" });
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      if (typeof onStatus === "function") onStatus({ status: "error" });
      scheduleReconnect();
    });
  };

  connect();

  return {
    close() {
      closed = true;
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
