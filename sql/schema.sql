-- BotBoot Database Schema
-- PostgreSQL 15+

-- Accounts
CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- API Keys (one account can have multiple keys)
CREATE TABLE IF NOT EXISTS api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash        TEXT NOT NULL UNIQUE,    -- SHA-256 of the full key
  name            TEXT DEFAULT 'default',
  prefix          TEXT NOT NULL,           -- bb_abc123... (for display)
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  runtime         TEXT NOT NULL DEFAULT 'openclaw',   -- openclaw | hermes
  provider        TEXT NOT NULL DEFAULT 'hetzner',    -- hetzner | docker | phala
  server_id       TEXT,                               -- Provider's machine ID
  ip              TEXT,                               -- Public IPv4
  state           TEXT DEFAULT 'provisioning',        -- provisioning | running | stopped | error | deleted
  config          JSONB DEFAULT '{}',                 -- Non-secret config (model, channels, etc)
  exposed_secrets JSONB DEFAULT '[]',                 -- Explicit allowlist of secret key names exposed to this agent
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Account Secrets (encrypted, 3-tier: platform → account → agent)
CREATE TABLE IF NOT EXISTS account_secrets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_name        TEXT NOT NULL,             -- e.g. ANTHROPIC_API_KEY
  encrypted       TEXT NOT NULL,             -- AES-256-GCM encrypted value
  agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,  -- NULL = account-level
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agents_account ON agents(account_id);
CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS exposed_secrets JSONB DEFAULT '[]'::jsonb;
UPDATE agents SET exposed_secrets = '[]'::jsonb WHERE exposed_secrets IS NULL;
CREATE INDEX IF NOT EXISTS idx_secrets_account ON account_secrets(account_id);
CREATE INDEX IF NOT EXISTS idx_secrets_agent ON account_secrets(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_secrets_account_key_agent
  ON account_secrets (account_id, key_name, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Daily usage snapshots per agent/model
CREATE TABLE IF NOT EXISTS usage_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  usage_date        DATE NOT NULL,
  runtime           TEXT NOT NULL,
  provider          TEXT,
  model             TEXT NOT NULL,
  input_tokens      BIGINT DEFAULT 0,
  output_tokens     BIGINT DEFAULT 0,
  cache_read_tokens BIGINT DEFAULT 0,
  cache_write_tokens BIGINT DEFAULT 0,
  reasoning_tokens  BIGINT DEFAULT 0,
  total_tokens      BIGINT DEFAULT 0,
  estimated_cost_usd DOUBLE PRECISION DEFAULT 0,
  source            TEXT DEFAULT 'poll',
  last_polled_at    TIMESTAMPTZ DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_id, usage_date, runtime, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_agent_date ON usage_logs(agent_id, usage_date DESC);
CREATE INDEX IF NOT EXISTS idx_usage_logs_date ON usage_logs(usage_date DESC);
