# Crypto 15m Assistant (Polymarket)

A web-based assistant for **Polymarket 15-minute Up/Down crypto markets**, powered by:
- Binance spot klines for indicators (VWAP/RSI/MACD/Heiken Ashi)
- Polymarket Gamma API (market discovery + UP/DOWN prices + liquidity)
- A simple probability/edge model that produces:
  - **Lean UP/DOWN (%)**
  - **Enter Now (UP/DOWN)** when edge + probability thresholds are met

Supported tabs (UI order): **BTC, ETH, XRP, SOL**.

---

## Web UI (Next.js 15)

### Run
```bash
npm install
npm run web
```
Open: <http://localhost:3000>

### Endpoints
- Snapshot (single response):
  - `/api/snapshot?asset=btc|eth|xrp|sol`
- Live stream (SSE):
  - `/api/stream?asset=btc|eth|xrp|sol`

### Data flow
- **HTTP requests to third-party sources are proxied server-side** via Next.js route handlers.
  - Binance (klines + last price)
  - Polymarket Gamma / CLOB (market discovery + outcome prices + book summaries)
- **Current Price** is fetched **client-side** from Polymarket’s live-data WebSocket:
  - `wss://ws-live-data.polymarket.com`
- **Price to Beat** is latched client-side:
  - first WS tick at/after the market start time
  - resets on market slug rollover

---

## CLI

The original CLI remains available:
```bash
npm start
```

---

## Trading utilities

This repo includes optional trading utilities under:
- `src/trading/`

These functions are **NOT used automatically** by the web UI.
They are gated behind:
- `TRADING_ENABLED=true`

### Environment variables
- `TRADING_ENABLED` (default: false)
- `POLY_PRIVATE_KEY` (required if trading enabled)
- `POLY_FUNDER_ADDRESS` (optional)
- `POLY_CLOB_API` (default: https://clob.polymarket.com)
- `POLY_SIGNATURE_TYPE` (optional)
- `POLY_USE_SERVER_TIME` (optional)
