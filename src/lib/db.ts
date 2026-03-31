/**
 * Database layer — PostgreSQL via raw queries (no ORM).
 *
 * Tables: accounts, agents, api_keys, account_secrets
 */

import { env } from "../env.js";

// Placeholder — will use pg or postgres.js
// For now, define the interface

export interface Account {
  id: string;
  email: string;
  created_at: string;
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
}

// Database interface — implement with your preferred PG client
export const db = {
  // Accounts
  async getAccountByApiKey(_apiKey: string): Promise<Account | null> {
    // TODO: hash key, look up in api_keys table, join accounts
    return null;
  },

  // API Keys
  async createApiKey(_accountId: string, _name: string, _keyHash: string, _prefix: string): Promise<ApiKey> {
    throw new Error("Not implemented");
  },

  async listApiKeys(_accountId: string): Promise<ApiKey[]> {
    throw new Error("Not implemented");
  },

  async deleteApiKey(_accountId: string, _keyId: string): Promise<boolean> {
    throw new Error("Not implemented");
  },

  // Agents
  async createAgent(_agent: Omit<Agent, "id" | "created_at" | "updated_at">): Promise<Agent> {
    throw new Error("Not implemented");
  },

  async listAgents(_accountId: string): Promise<Agent[]> {
    throw new Error("Not implemented");
  },

  async getAgent(_accountId: string, _agentId: string): Promise<Agent | null> {
    throw new Error("Not implemented");
  },

  async updateAgent(_agentId: string, _updates: Partial<Agent>): Promise<void> {
    throw new Error("Not implemented");
  },

  async deleteAgent(_agentId: string): Promise<void> {
    throw new Error("Not implemented");
  },

  // Secrets
  async setSecret(_accountId: string, _keyName: string, _encrypted: string, _agentId?: string): Promise<void> {
    throw new Error("Not implemented");
  },

  async getSecrets(_accountId: string, _agentId?: string): Promise<AccountSecret[]> {
    throw new Error("Not implemented");
  },

  async deleteSecret(_accountId: string, _keyName: string, _agentId?: string): Promise<boolean> {
    throw new Error("Not implemented");
  },
};
