# Deriv Auto Trader API

Phases Zero through Four establish a typed Fastify service, validated configuration, PostgreSQL migration runner, authorized Deriv account connections, an account-bound automation safety layer, public market analysis, and live single-bot sessions.

## Setup

Copy `.env.example` to `.env` and set your assigned `DERIV_APP_ID`, matching backend OAuth callback URI, CORS origin, PostgreSQL URL, and a 32-character-or-longer `SESSION_COOKIE_SECRET`. The app refuses to start when any required value is missing or malformed. Deriv credentials are never committed to source control. `CORS_ORIGIN=*` is available only as a temporary setup mode; it reflects the requesting origin so browser session cookies continue to work. Replace it with the deployed frontend URL before release.

The server binds to `0.0.0.0` and reads the standard platform `PORT` directly at runtime. Do not set `HOST` or `PORT` in `.env` or DigitalOcean; App Platform supplies the listener port automatically.

The OAuth callback must be registered in Deriv exactly as `DERIV_OAUTH_REDIRECT_URI`. The server uses Authorization Code + PKCE, exchanges the code server-side, and keeps the access token only in the server-side session store. It never receives a Deriv password.

## Commands

- `npm run db:migrate` applies ordered SQL migrations.
- `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` verify the foundation.
- `npm run dev` starts the local Fastify service after configuration is valid.

The public health check is available at `GET /api/v1/health`.

Phase One exposes `POST /api/v1/auth/deriv/login`, `GET /api/v1/auth/deriv/callback`, `GET /api/v1/accounts/session`, and account selection, refresh, disconnect, and logout routes under `/api/v1/accounts`.

Phase Two adds account-scoped routes under `/api/v1/automation` for guarded contract previews, session state transitions, open-contract status, account-cycle P/L, risk limits, Emergency Stop, and Activity Log entries. A proposal is required before a session can start; this phase does not submit a Deriv `buy` request.

Phase Three adds account-scoped, read-only market routes under `/api/v1/markets`. They manage public tick subscriptions and return explicit data health, bounded tick buffers, digit and movement observations, streaks, and scanner deviations. Market observations do not initiate trades.

Phase Four adds account-scoped bot routes under `/api/v1/bots`. They save reusable Rise/Fall, Over/Under, Even/Odd, Matches/Differs, and Smart Auto Trader configurations; evaluate live ticks; submit accepted Deriv proposals and buys with an idempotency ledger; track settlement statistics; enforce account/session/martingale limits; and record meaningful Smart No Signal transitions. Pause and Stop prevent new entries only and never sell an open contract.

Phase Five adds scanner routes under `/api/v1/scanner` and bulk routes under `/api/v1/bulk`. Scanner discovery reads Deriv-supported volatility symbols, ranks observed Differs deviations, and requires three matching completed evaluations before scanner-triggered Auto Bulk. The shared bulk engine submits fixed-stake entries sequentially, respects active-contract and P/L limits, never uses martingale, retains settlement statistics, and cancels only unsubmitted entries on Stop. Enabled profiles may also start a bulk run from an accepted Smart signal.

Phase Six adds authorised-account copy routes under `/api/v1/copy` and account-scoped Open Trades/History routes under `/api/v1/records`. Copy sessions react only to Deriv-accepted bot or bulk master entries, validate each sub-account independently, preserve partial results, and respect per-sub connection, contract, stake-cap, loss-limit, pause, and stop rules. Trade records retain original Deriv and platform status, source references, settlement values, filters, details, and CSV export.

Phase Seven adds `GET /api/v1/accounts/disclosure` and `POST /api/v1/accounts/disclosure/accept`. Each real account must explicitly accept the current disclosure before a guarded automation session, bot session, bulk run, or enabled copy-trading session can begin. Demo accounts are not gated.
