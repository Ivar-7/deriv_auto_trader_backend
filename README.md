# Deriv Auto Trader API

Phases Zero through Two establish a typed Fastify service, validated configuration, PostgreSQL migration runner, authorized Deriv account connections, and an account-bound automation safety layer.

## Setup

Copy `.env.example` to `.env` and set your assigned `DERIV_APP_ID`, matching backend OAuth callback URI, CORS origin, PostgreSQL URL, and a 32-character-or-longer `SESSION_COOKIE_SECRET`. The app refuses to start when any required value is missing or malformed. Deriv credentials are never committed to source control.

The OAuth callback must be registered in Deriv exactly as `DERIV_OAUTH_REDIRECT_URI`. The server uses Authorization Code + PKCE, exchanges the code server-side, and keeps the access token only in the server-side session store. It never receives a Deriv password.

## Commands

- `npm run db:migrate` applies ordered SQL migrations.
- `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` verify the foundation.
- `npm run dev` starts the local Fastify service after configuration is valid.

The public health check is available at `GET /api/v1/health`.

Phase One exposes `POST /api/v1/auth/deriv/login`, `GET /api/v1/auth/deriv/callback`, `GET /api/v1/accounts/session`, and account selection, refresh, disconnect, and logout routes under `/api/v1/accounts`.

Phase Two adds account-scoped routes under `/api/v1/automation` for guarded contract previews, session state transitions, open-contract status, account-cycle P/L, risk limits, Emergency Stop, and Activity Log entries. A proposal is required before a session can start; this phase does not submit a Deriv `buy` request.
