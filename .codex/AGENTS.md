# Fastify

## Architecture
- **Application** — `src/app.ts`: Fastify factory.
- **Runtime** — `src/server.ts`: listener startup and graceful shutdown.
- **Features** — `src/modules/<feature>/`: feature plugin, routes, schemas, handlers, and services.
- **Infrastructure** — `src/plugins/`: shared capabilities, integrations, and decorators.
- **Configuration** — `src/config/`: validated runtime configuration.
- **Utilities** — `src/lib/`: framework-independent shared code.

## Core Rules
- **Types** — Enable TypeScript strict mode and use no `any`.
- **Plugins** — Register features and shared capabilities as Fastify plugins.
- **Schemas** — Define JSON Schemas for route parameters, queries, headers, JSON request bodies, and JSON response bodies.
- **Validation** — Keep database and network operations out of schema validation.
- **Errors** — Translate application errors in one Fastify error handler; never expose stack traces.
- **Resources** — Release resources through `onClose` hooks.
- **Logging** — Redact secrets, credentials, and tokens in Pino logs.
- **Testing** — Build the application without a listener; test through `app.inject()`; close every test instance.

## Project Conventions
- **Compatibility** — Install the version listed for the project's Fastify major in each `@fastify/*` plugin compatibility table.

## Verification
- **Checks** — Run `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`; fix errors and warnings.
