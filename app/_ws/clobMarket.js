// Browser-only Polymarket CLOB market-channel WS client.
// Docs:
// - wss://ws-subscriptions-clob.polymarket.com/ws/market
// - subscribe payload: { type: "market", assets_ids: [tokenId], custom_feature_enabled: true }
//
// We use WS to maintain best bid/ask for outcome token ids.

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

function computeBestFromBook(msg) {
  const bids = Array.isArray(msg?.bids) ? msg.bids : Array.isArray(msg?.buys) ? msg.buys : [];
  const asks = Array.isArray(msg?.asks) ? msg.asks : Array.isArray(msg?.sells) ? msg.sells : [];

  const bestBid = bids.length
    ? bids.reduce((best, lvl) => {
        const p = toNum(lvl?.price);
        if (p === null) return best;
        return best === null ? p : Math.max(best, p);
      }, null)
    : null;

  const bestAsk = asks.length
    ? asks.reduce((best, lvl) => {
        const p = toNum(lvl?.price);
        if (p === null) return best;
        return best === null ? p : Math.min(best, p);
      }, null)
    : null;

  return { bestBid, bestAsk };
}

export function connectClobMarketWs({
  wsUrl = "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  assetIds = [],
  onBestBidAsk,
  onStatus
} = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;

  const send = (obj) => {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  };

  const subscribe = () => {
    const ids = Array.from(new Set((assetIds || []).map(String).filter(Boolean)));
    if (!ids.length) return;

    // Data-feeds docs show this shape.
    send({
      type: "market",
      assets_ids: ids,
      custom_feature_enabled: true
    });
  };

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
      onStatus?.({ status: "open" });
      subscribe();
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt?.data === "string" ? evt.data : "";
      if (!raw || !raw.trim()) return;

      const msg = safeJsonParse(raw);
      if (!msg) return;

      const eventType = String(msg.event_type ?? msg.eventType ?? "");
      const assetId = String(msg.asset_id ?? msg.assetId ?? "");
      if (!assetId) return;

      // 1) best_bid_ask (preferred when available)
      if (eventType === "best_bid_ask") {
        const bestBid = toNum(msg.best_bid);
        const bestAsk = toNum(msg.best_ask);
        onBestBidAsk?.({ assetId, bestBid, bestAsk, source: "best_bid_ask", timestamp: msg.timestamp ?? null });
        return;
      }

      // 2) price_change also carries best_bid/best_ask per change
      if (eventType === "price_change") {
        const changes = Array.isArray(msg.price_changes) ? msg.price_changes : [];
        for (const c of changes) {
          const id = String(c?.asset_id ?? "");
          if (!id) continue;
          const bestBid = toNum(c.best_bid);
          const bestAsk = toNum(c.best_ask);
          onBestBidAsk?.({ assetId: id, bestBid, bestAsk, source: "price_change", timestamp: msg.timestamp ?? null });
        }
        return;
      }

      // 3) book snapshot
      if (eventType === "book") {
        const { bestBid, bestAsk } = computeBestFromBook(msg);
        onBestBidAsk?.({ assetId, bestBid, bestAsk, source: "book", timestamp: msg.timestamp ?? null });
        return;
      }

      // ignore other message types
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
    updateAssetIds(nextIds) {
      assetIds = nextIds;
      // Resubscribe (safe even if not open yet)
      subscribe();
    },
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
