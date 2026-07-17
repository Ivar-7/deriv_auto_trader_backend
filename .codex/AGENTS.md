# Fastify + TypeScript Guidelines

## Architecture

- **Composition** — Register application infrastructure through encapsulated Fastify plugins.
- **Routes** — Group route modules by domain and keep handlers transport-only.
- **Services** — Place business rules in services.
- **Persistence** — Place database access in repositories.
- **Dependencies** — Maintain acyclic module dependencies.

## API

- **Schemas** — Declare schemas for every request and response.
- **Validation** — Reject every request that fails schema validation.
- **Versioning** — Prefix every public endpoint with its API version.
- **Errors** — Convert all operational failures through one application error handler.
- **Responses** — Return only declared response shapes.

## TypeScript

- **Strictness** — Keep strict compiler options enabled.
- **Boundaries** — Type every API, persistence, configuration, and external-service boundary.
- **Unsafe Types** — Do not use `any` or unvalidated type assertions.
- **Decorators** — Declare module augmentation for every Fastify decoration.

## Security

- **Configuration** — Validate required environment variables during application startup.
- **Secrets** — Do not hardcode or log secrets, credentials, or tokens.
- **Authorization** — Authorize every protected resource access.
- **Client Errors** — Return safe client-facing error messages only.

## Operations

- **Logging** — Use the Fastify logger for application logs.
- **External Calls** — Apply timeouts to every external request.
- **Retries** — Retry only idempotent external operations.
- **Writes** — Make state-changing operations atomic and idempotent.

## Verification

- **Checks** — Pass formatting, linting, typechecking, tests, and production build before completion.
- **Tests** — Cover validation, services, routes, authorization, error handling, and external failures.
