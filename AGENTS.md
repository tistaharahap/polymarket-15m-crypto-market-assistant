# Repository Guidelines

## Project Structure & Module Organization
- `app/` is the Next.js App Router UI. Key areas: `app/page.tsx` for the client UI, `app/lib/` for technical analysis helpers, `app/_ws/` for Binance/Polymarket websocket clients, and `app/api/*` for API routes like `snapshot` and `stream`.
- `src/` holds the legacy CLI and shared logic: `src/index.ts` (CLI entry), `src/indicators/`, `src/engines/`, `src/net/`, `src/data/`, `src/trading/` (optional utilities), plus `src/config.ts` and `src/utils.ts`.
- `middleware.ts` implements Basic Auth for the web UI.
- `.env.example` documents configuration; `logs/` is runtime output.

## Build, Test, and Development Commands
- `bun install` installs dependencies.
- `bun run web` starts the Next.js dev server at `http://localhost:3000`.
- `bun run web:build` builds the production bundle.
- `bun run web:start` runs the production server from `.next`.
- `bun run start` runs the legacy CLI.

## Coding Style & Naming Conventions
- TypeScript ESM only (`type: module`); use `import`/`export`.
- Match existing formatting: 2-space indentation, double quotes, semicolons.
- React components in `app/` are default exports and favor hooks (`useState`, `useEffect`).
- File names are lowercase; internal groupings use underscore folders like `app/_ws/`.

## Testing Guidelines
- No automated test suite is configured. Validate changes manually: run `bun run web`, check the BTC/ETH/XRP/SOL tabs, and verify `/api/snapshot?asset=btc` responses.
- If you add tests, use `__tests__/` or `*.test.ts` and add a `bun test` script to `package.json`.

## Commit & Pull Request Guidelines
- Recent history favors short, imperative, capitalized summaries (e.g., “Fix …”, “Move …”).
- If you use prefixes, keep them minimal (`fix:`, `feat:`) and consistent within a PR.
- PRs should include a concise description, testing performed (command or manual steps), and screenshots for UI changes; link issues when available.

## Configuration & Security
- Copy `.env.example` to `.env` for local settings and never commit secrets.
- `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` enable Basic Auth; `/api/stream` is intentionally unauthenticated.
- Trading utilities are off by default and require `TRADING_ENABLED=true` plus `POLY_PRIVATE_KEY`.
- Server-side trading routes live under `app/api/trade/*` and execute with the server key; keep deployments local or behind Basic Auth.
