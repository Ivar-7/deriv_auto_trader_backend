# Deriv connectivity

This feature owns Authorization Code + PKCE, short-lived server-side token sessions, Options account discovery, and one OTP-authenticated WebSocket connection per selected account.

The connection manager subscribes to balance updates and reconciles portfolio/open-contract state after initial connection and reconnection. An account-scoped idempotency ledger is ready for future trade submission routes, preventing a reconnect from creating duplicate entries. Tokens and one-time OTP URLs are never returned to the frontend or logged.
