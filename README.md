# Deriv Auto Trader API

Phase Zero establishes a typed Fastify service, validated configuration, PostgreSQL migration runner, and durable storage for non-secret bot configuration, sessions, trade snapshots, activity, and risk-disclosure acceptance.

## Setup

Copy `.env.example` to `.env` and set your assigned `DERIV_APP_ID`, matching OAuth redirect URI, CORS origin, and PostgreSQL URL. The app refuses to start when any required value is missing or malformed. Deriv credentials are never committed to source control.

## Commands

- `npm run db:migrate` applies ordered SQL migrations.
- `npm run format`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` verify the foundation.
- `npm run dev` starts the local Fastify service after configuration is valid.

The public health check is available at `GET /api/v1/health`.
