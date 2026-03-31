/**
 * Database layer — PostgreSQL via postgres.js (no ORM).
 *
 * Tables: accounts, agents, api_keys, account_secrets
 */

import postgres from "postgres";
import { env } from "../env.js";
import { hashApiKey } from "./crypto.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  account_id: string;
  name: string;
  runtime: "openclaw" | "hermes";
  provider: "hetzner" | "docker";
  server_id: string | null;
  ip: string | null;
  state: "provisioning" | "running" | "stopped" | "error" | "deleted";
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  account_id: string;
  key_hash: string;
  name: string;
  prefix: string;
  created_at: string;
}

export interface AccountSecret {
  id: string;
  account_id: string;
  key_name: string;
  encrypted: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsageLog {
  id?: string;
  agent_id: string;
  usage_date: string;
  runtime: string;
  provider: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  source?: string;
  last_polled_at?: string;
  created_at?: string;
  updated_at?: string;
}

// ── Connection ─────────────────────────────────────────────────────────

const sql = env.DATABASE_URL
  ? postgres(env.DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : (null as unknown as ReturnType<typeof postgres>);

// ── Database operations ────────────────────────────────────────────────

export const db = {
  /** Raw sql instance for testing/migrations */
  sql,

  // ── Accounts ───────────────────────────────────────────────────────

  async getAccountByApiKey(apiKey: string): Promise<Account | null> {
    const keyHash = hashApiKey(apiKey);
    const rows = await sql<Account[]>`
      SELECT a.* FROM accounts a
      JOIN api_keys k ON k.account_id = a.id
      WHERE k.key_hash = ${keyHash}
      LIMIT 1
    `;
    return rows[0] || null;
  },

  async getOrCreateAccount(email: string): Promise<Account> {
    const rows = await sql<Account[]>`
      INSERT INTO accounts (email)
      VALUES (${email})
      ON CONFLICT (email) DO UPDATE SET updated_at = now()
      RETURNING *
    `;
    return rows[0];
  },

  async getAccountById(id: string): Promise<Account | null> {
    const rows = await sql<Account[]>`
      SELECT * FROM accounts WHERE id = ${id}
    `;
    return rows[0] || null;
  },

  // ── API Keys ───────────────────────────────────────────────────────

  async createApiKey(accountId: string, name: string, keyHash: string, prefix: string): Promise<ApiKey> {
    const rows = await sql<ApiKey[]>`
      INSERT INTO api_keys (account_id, name, key_hash, prefix)
      VALUES (${accountId}, ${name}, ${keyHash}, ${prefix})
      RETURNING *
    `;
    return rows[0];
  },

  async listApiKeys(accountId: string): Promise<ApiKey[]> {
    return sql<ApiKey[]>`
      SELECT * FROM api_keys
      WHERE account_id = ${accountId}
      ORDER BY created_at DESC
    `;
  },

  async deleteApiKey(accountId: string, keyId: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM api_keys
      WHERE id = ${keyId} AND account_id = ${accountId}
    `;
    return result.count > 0;
  },

  // ── Agents ─────────────────────────────────────────────────────────

  async createAgent(agent: Omit<Agent, "id" | "created_at" | "updated_at">): Promise<Agent> {
    const rows = await sql<Agent[]>`
      INSERT INTO agents (account_id, name, runtime, provider, server_id, ip, state, config)
      VALUES (
        ${agent.account_id},
        ${agent.name},
        ${agent.runtime},
        ${agent.provider},
        ${agent.server_id},
        ${agent.ip},
        ${agent.state},
        ${JSON.stringify(agent.config)}
      )
      RETURNING *
    `;
    return rows[0];
  },

  async listAgents(accountId: string): Promise<Agent[]> {
    return sql<Agent[]>`
      SELECT * FROM agents
      WHERE account_id = ${accountId} AND state != 'deleted'
      ORDER BY created_at DESC
    `;
  },

  async getAgent(accountId: string, agentId: string): Promise<Agent | null> {
    const rows = await sql<Agent[]>`
      SELECT * FROM agents
      WHERE id = ${agentId} AND account_id = ${accountId}
    `;
    return rows[0] || null;
  },

  async updateAgent(agentId: string, updates: Partial<Agent>): Promise<void> {
    await sql`
      UPDATE agents SET
        state = COALESCE(${updates.state ?? null}, state),
        ip = COALESCE(${updates.ip ?? null}, ip),
        server_id = COALESCE(${updates.server_id ?? null}, server_id),
        config = COALESCE(${updates.config ? JSON.stringify(updates.config) : null}::jsonb, config),
        updated_at = now()
      WHERE id = ${agentId}
    `;
  },

  async deleteAgent(agentId: string): Promise<void> {
    await sql`
      UPDATE agents SET state = 'deleted', updated_at = now()
      WHERE id = ${agentId}
    `;
  },

  // ── Secrets ────────────────────────────────────────────────────────

  async setSecret(accountId: string, keyName: string, encrypted: string, agentId?: string): Promise<void> {
    if (agentId) {
      await sql`
        INSERT INTO account_secrets (account_id, key_name, encrypted, agent_id)
        VALUES (${accountId}, ${keyName}, ${encrypted}, ${agentId})
        ON CONFLICT (account_id, key_name, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
        DO UPDATE SET encrypted = ${encrypted}, updated_at = now()
      `;
    } else {
      await sql`
        INSERT INTO account_secrets (account_id, key_name, encrypted)
        VALUES (${accountId}, ${keyName}, ${encrypted})
        ON CONFLICT (account_id, key_name, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
        DO UPDATE SET encrypted = ${encrypted}, updated_at = now()
      `;
    }
  },

  async getSecrets(accountId: string, agentId?: string): Promise<AccountSecret[]> {
    if (agentId) {
      return sql<AccountSecret[]>`
        SELECT * FROM account_secrets
        WHERE account_id = ${accountId} AND agent_id = ${agentId}
        ORDER BY key_name
      `;
    }
    return sql<AccountSecret[]>`
      SELECT * FROM account_secrets
      WHERE account_id = ${accountId} AND agent_id IS NULL
      ORDER BY key_name
    `;
  },

  async deleteSecret(accountId: string, keyName: string, agentId?: string): Promise<boolean> {
    let result;
    if (agentId) {
      result = await sql`
        DELETE FROM account_secrets
        WHERE account_id = ${accountId} AND key_name = ${keyName} AND agent_id = ${agentId}
      `;
    } else {
      result = await sql`
        DELETE FROM account_secrets
        WHERE account_id = ${accountId} AND key_name = ${keyName} AND agent_id IS NULL
      `;
    }
    return result.count > 0;
  },

  // ── Usage logs ─────────────────────────────────────────────────────

  async upsertUsageLog(log: UsageLog): Promise<void> {
    await sql`
      INSERT INTO usage_logs (
        agent_id, usage_date, runtime, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, estimated_cost_usd, source, last_polled_at
      ) VALUES (
        ${log.agent_id}, ${log.usage_date}, ${log.runtime}, ${log.provider}, ${log.model},
        ${log.input_tokens}, ${log.output_tokens}, ${log.cache_read_tokens}, ${log.cache_write_tokens},
        ${log.reasoning_tokens}, ${log.total_tokens}, ${log.estimated_cost_usd}, ${log.source || 'poll'}, now()
      )
      ON CONFLICT (agent_id, usage_date, runtime, provider, model)
      DO UPDATE SET
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        cache_write_tokens = EXCLUDED.cache_write_tokens,
        reasoning_tokens = EXCLUDED.reasoning_tokens,
        total_tokens = EXCLUDED.total_tokens,
        estimated_cost_usd = EXCLUDED.estimated_cost_usd,
        source = EXCLUDED.source,
        last_polled_at = now(),
        updated_at = now()
    `;
  },

  async getAgentUsageSummary(agentId: string, days = 30): Promise<Record<string, unknown>> {
    const totals = await sql<any[]>`
      SELECT
        COALESCE(sum(input_tokens), 0) AS input_tokens,
        COALESCE(sum(output_tokens), 0) AS output_tokens,
        COALESCE(sum(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(sum(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(sum(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(sum(total_tokens), 0) AS total_tokens,
        COALESCE(sum(estimated_cost_usd), 0) AS estimated_cost_usd
      FROM usage_logs
      WHERE agent_id = ${agentId}
        AND usage_date >= current_date - ${days - 1} * interval '1 day'
    `;

    const byModel = await sql<any[]>`
      SELECT provider, model,
        sum(input_tokens) AS input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cache_read_tokens) AS cache_read_tokens,
        sum(cache_write_tokens) AS cache_write_tokens,
        sum(reasoning_tokens) AS reasoning_tokens,
        sum(total_tokens) AS total_tokens,
        sum(estimated_cost_usd) AS estimated_cost_usd
      FROM usage_logs
      WHERE agent_id = ${agentId}
        AND usage_date >= current_date - ${days - 1} * interval '1 day'
      GROUP BY provider, model
      ORDER BY estimated_cost_usd DESC, total_tokens DESC
    `;

    const daily = await sql<any[]>`
      SELECT usage_date, 
        sum(input_tokens) AS input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cache_read_tokens) AS cache_read_tokens,
        sum(cache_write_tokens) AS cache_write_tokens,
        sum(reasoning_tokens) AS reasoning_tokens,
        sum(total_tokens) AS total_tokens,
        sum(estimated_cost_usd) AS estimated_cost_usd
      FROM usage_logs
      WHERE agent_id = ${agentId}
        AND usage_date >= current_date - ${days - 1} * interval '1 day'
      GROUP BY usage_date
      ORDER BY usage_date DESC
    `;

    return {
      period_days: days,
      totals: totals[0] || {},
      by_model: byModel,
      daily,
    };
  },

  async getAccountUsageSummary(accountId: string, days = 30): Promise<Record<string, unknown>> {
    const totals = await sql<any[]>`
      SELECT
        count(DISTINCT u.agent_id) AS agents_count,
        COALESCE(sum(u.input_tokens), 0) AS input_tokens,
        COALESCE(sum(u.output_tokens), 0) AS output_tokens,
        COALESCE(sum(u.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(sum(u.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(sum(u.reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(sum(u.total_tokens), 0) AS total_tokens,
        COALESCE(sum(u.estimated_cost_usd), 0) AS estimated_cost_usd
      FROM usage_logs u
      JOIN agents a ON a.id = u.agent_id
      WHERE a.account_id = ${accountId}
        AND u.usage_date >= current_date - ${days - 1} * interval '1 day'
    `;

    const byAgent = await sql<any[]>`
      SELECT a.id AS agent_id, a.name, a.runtime,
        sum(u.input_tokens) AS input_tokens,
        sum(u.output_tokens) AS output_tokens,
        sum(u.total_tokens) AS total_tokens,
        sum(u.estimated_cost_usd) AS estimated_cost_usd
      FROM usage_logs u
      JOIN agents a ON a.id = u.agent_id
      WHERE a.account_id = ${accountId}
        AND u.usage_date >= current_date - ${days - 1} * interval '1 day'
      GROUP BY a.id, a.name, a.runtime
      ORDER BY estimated_cost_usd DESC, total_tokens DESC
    `;

    return {
      period_days: days,
      totals: totals[0] || {},
      by_agent: byAgent,
    };
  },

  // ── Lifecycle ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    await sql.end();
  },
};
