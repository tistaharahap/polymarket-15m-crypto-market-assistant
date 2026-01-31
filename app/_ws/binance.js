// Binance client data: one-time HTTP seed for klines, then WS for live updates.
//
// HTTP seed:
//   https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=240
// WS:
//   wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/btcusdt@trade

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function toNum(x) {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : null;
}

export function normalizeBinanceSymbol(asset) {
  return `${String(asset).toUpperCase()}USDT`;
}

export async function seedKlines({ symbol, interval = "1m", limit = 240, baseUrl = "https://api.binance.com" }) {
  const url = new URL("/api/v3/klines", baseUrl);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Binance klines seed error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return data.map((k) => ({
    openTime: Number(k[0]),
    open: toNum(k[1]),
    high: toNum(k[2]),
    low: toNum(k[3]),
    close: toNum(k[4]),
    volume: toNum(k[5]),
    closeTime: Number(k[6])
  }));
}

export function connectBinanceWs({
  symbol, // e.g. BTCUSDT
  interval = "1m",
  onKline,
  onTrade,
  onStatus
} = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;

  const sym = String(symbol).toLowerCase();
  const url = `wss://stream.binance.com:9443/stream?streams=${sym}@kline_${interval}/${sym}@trade`;

  const connect = () => {
    if (closed) return;

    ws = new WebSocket(url);

    const scheduleReconnect = () => {
      if (closed) return;
      try { ws?.close(); } catch {}
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.addEventListener("open", () => {
      reconnectMs = 500;
      onStatus?.({ status: "open" });
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt?.data === "string" ? evt.data : "";
      if (!raw || !raw.trim()) return;

      const msg = safeJsonParse(raw);
      if (!msg) return;

      const data = msg.data ?? msg;
      const eventType = data?.e;

      if (eventType === "kline") {
        const k = data.k;
        if (!k) return;
        onKline?.({
          openTime: Number(k.t),
          closeTime: Number(k.T),
          open: toNum(k.o),
          high: toNum(k.h),
          low: toNum(k.l),
          close: toNum(k.c),
          volume: toNum(k.v),
          isFinal: Boolean(k.x)
        });
        return;
      }

      if (eventType === "trade") {
        onTrade?.({
          price: toNum(data.p),
          qty: toNum(data.q),
          tradeTime: Number(data.T)
        });
      }
    });

    ws.addEventListener("close", () => {
      onStatus?.({ status: "closed" });
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      onStatus?.({ status: "error" });
      scheduleReconnect();
    });
  };

  connect();

  return {
    close() {
      closed = true;
      try { ws?.close(); } catch {}
      ws = null;
    }
  };
}
