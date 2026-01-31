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

### Run (local dev)
```bash
npm install
npm run web
```
Open: <http://localhost:3000>

### Run (production / Coolify)
Use build + start (do not run `next dev` in production).

- Build command:
  ```bash
  npm run web:build
  ```
- Start command:
  ```bash
  npm run web:start
  ```

### Basic HTTP Auth (optional)
If you set these env vars, the web UI is protected with Basic Auth:
- `BASIC_AUTH_USER`
- `BASIC_AUTH_PASS`

If either one is missing, auth is disabled.

Note: `/api/stream` (SSE) is intentionally **exempt** from Basic Auth, because browser `EventSource` cannot reliably attach `Authorization` headers.

Example:
```bash
export BASIC_AUTH_USER="tista"
export BASIC_AUTH_PASS="change-me"
npm run web
```

### Endpoints
- Market metadata snapshot (lightweight):
  - `/api/snapshot?asset=btc|eth|xrp|sol`

### Data flow (client-first)
- **Binance candles + last price**
  - Client does a **one-time HTTP seed** per tab: `/api/v3/klines?interval=1m&limit=240`
  - Then switches to **Binance WebSocket** streams for live updates (`@kline_1m` + `@trade`).
  - All TA calculations (VWAP/RSI/MACD/Heiken + scoring/edge/decision) happen in the browser.
- **Polymarket**
  - Server provides market metadata (slug/start/end + token IDs) via `/api/snapshot`.
  - Client uses Polymarket WS:
    - RTDS live price: `wss://ws-live-data.polymarket.com`
    - CLOB best bid/ask: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- **Price to Beat**
  - Latched client-side: first Polymarket WS tick at/after market start.

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
