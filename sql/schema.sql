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
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(account_id, key_name, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_agents_account ON agents(account_id);
CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state);
CREATE INDEX IF NOT EXISTS idx_secrets_account ON account_secrets(account_id);
CREATE INDEX IF NOT EXISTS idx_secrets_agent ON account_secrets(agent_id);
