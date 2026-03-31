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

// ── Connection ─────────────────────────────────────────────────────────

const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

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
    const sets: string[] = [];
    const values: Record<string, unknown> = {};

    if (updates.state !== undefined) values.state = updates.state;
    if (updates.ip !== undefined) values.ip = updates.ip;
    if (updates.server_id !== undefined) values.server_id = updates.server_id;
    if (updates.config !== undefined) values.config = JSON.stringify(updates.config);

    // Build dynamic update
    await sql`
      UPDATE agents SET
        state = COALESCE(${updates.state ?? null}, state),
        ip = COALESCE(${updates.ip ?? null}, ip),
        server_id = COALESCE(${updates.server_id ?? null}, server_id),
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

  // ── Lifecycle ──────────────────────────────────────────────────────

  async close(): Promise<void> {
    await sql.end();
  },
};
