CREATE TABLE IF NOT EXISTS saved_configurations (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bot_type TEXT NOT NULL,
  configuration JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT saved_configurations_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE INDEX IF NOT EXISTS saved_configurations_account_id_idx
  ON saved_configurations (account_id);

CREATE TABLE IF NOT EXISTS automation_sessions (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  configuration_id UUID REFERENCES saved_configurations(id) ON DELETE SET NULL,
  bot_type TEXT NOT NULL,
  market TEXT NOT NULL,
  state TEXT NOT NULL,
  session_snapshot JSONB NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT automation_sessions_state_valid
    CHECK (state IN (
      'idle', 'starting', 'running', 'paused', 'stopping', 'stopped',
      'reconnecting', 'risk_limit_reached', 'completed', 'error'
    )),
  CONSTRAINT automation_sessions_snapshot_object
    CHECK (jsonb_typeof(session_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS automation_sessions_account_id_idx
  ON automation_sessions (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_snapshots (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES automation_sessions(id) ON DELETE SET NULL,
  account_id TEXT NOT NULL,
  deriv_contract_id TEXT NOT NULL,
  market TEXT NOT NULL,
  contract_type TEXT NOT NULL,
  prediction TEXT,
  stake NUMERIC(20, 8) NOT NULL,
  potential_payout NUMERIC(20, 8),
  status TEXT NOT NULL,
  profit_loss NUMERIC(20, 8),
  deriv_status TEXT,
  snapshot JSONB NOT NULL,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trade_snapshots_status_valid
    CHECK (status IN (
      'pending', 'open', 'won', 'lost', 'sold_early', 'expired',
      'cancelled', 'error'
    )),
  CONSTRAINT trade_snapshots_snapshot_object
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT trade_snapshots_account_contract_unique
    UNIQUE (account_id, deriv_contract_id)
);

CREATE INDEX IF NOT EXISTS trade_snapshots_session_id_idx
  ON trade_snapshots (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_events (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id UUID REFERENCES automation_sessions(id) ON DELETE SET NULL,
  market TEXT,
  category TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  details JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT activity_events_category_valid
    CHECK (category IN (
      'account', 'connection', 'session', 'signal', 'trade', 'martingale',
      'risk', 'bulk', 'copy', 'reconciliation', 'error'
    )),
  CONSTRAINT activity_events_details_object
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS activity_events_account_id_idx
  ON activity_events (account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS disclosure_acceptances (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  disclosure_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT disclosure_acceptances_account_version_unique
    UNIQUE (account_id, disclosure_version)
);
