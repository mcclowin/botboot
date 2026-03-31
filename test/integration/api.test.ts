/**
 * Integration tests — requires a running PostgreSQL database.
 *
 * Set DATABASE_URL before running:
 *   DATABASE_URL=postgresql://botboot:botboot-local@localhost:5432/botboot npm run test:integration
 *
 * Run `docker compose up db` to start the test database.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Set required env vars for testing
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://botboot:botboot-local@localhost:5432/botboot";
process.env.SECRETS_ENCRYPTION_KEY = "a".repeat(64);

import { db } from "../../src/lib/db.js";
import { generateApiKey } from "../../src/lib/crypto.js";
import { encrypt, decrypt } from "../../src/lib/crypto.js";

describe("Database Integration", () => {
  let testAccountId: string;
  let testApiKey: string;

  before(async () => {
    // Check if DB is reachable
    try {
      await db.sql`SELECT 1`;
    } catch {
      console.log("⚠️  Skipping integration tests — database not available");
      console.log("   Run: docker compose up db");
      process.exit(0);
    }
  });

  after(async () => {
    // Cleanup test data
    if (testAccountId) {
      await db.sql`DELETE FROM accounts WHERE id = ${testAccountId}`;
    }
    await db.close();
  });

  describe("Accounts", () => {
    it("should create an account", async () => {
      const account = await db.getOrCreateAccount("test@botboot.dev");
      assert.ok(account.id);
      assert.equal(account.email, "test@botboot.dev");
      testAccountId = account.id;
    });

    it("should return existing account on duplicate email", async () => {
      const account = await db.getOrCreateAccount("test@botboot.dev");
      assert.equal(account.id, testAccountId);
    });

    it("should get account by id", async () => {
      const account = await db.getAccountById(testAccountId);
      assert.ok(account);
      assert.equal(account.email, "test@botboot.dev");
    });
  });

  describe("API Keys", () => {
    it("should create and retrieve via hash lookup", async () => {
      const { key, prefix, hash } = generateApiKey();
      testApiKey = key;

      const apiKey = await db.createApiKey(testAccountId, "test-key", hash, prefix);
      assert.ok(apiKey.id);
      assert.equal(apiKey.name, "test-key");

      // Should find account via key
      const account = await db.getAccountByApiKey(key);
      assert.ok(account);
      assert.equal(account.id, testAccountId);
    });

    it("should list keys for account", async () => {
      const keys = await db.listApiKeys(testAccountId);
      assert.ok(keys.length >= 1);
      assert.equal(keys[0].name, "test-key");
    });

    it("should return null for invalid key", async () => {
      const account = await db.getAccountByApiKey("bb_nonexistent");
      assert.equal(account, null);
    });
  });

  let testAgentId: string;

  describe("Agents", () => {

    it("should create an agent", async () => {
      const agent = await db.createAgent({
        account_id: testAccountId,
        name: "test-bot",
        runtime: "openclaw",
        provider: "hetzner",
        server_id: "12345",
        ip: "1.2.3.4",
        state: "provisioning",
        config: { model: "claude-sonnet-4" },
      });
      assert.ok(agent.id);
      assert.equal(agent.name, "test-bot");
      assert.equal(agent.runtime, "openclaw");
      testAgentId = agent.id;
    });

    it("should list agents for account", async () => {
      const agents = await db.listAgents(testAccountId);
      assert.ok(agents.length >= 1);
      assert.equal(agents[0].name, "test-bot");
    });

    it("should get agent by id", async () => {
      const agent = await db.getAgent(testAccountId, testAgentId);
      assert.ok(agent);
      assert.equal(agent.name, "test-bot");
      assert.equal(agent.runtime, "openclaw");
    });

    it("should update agent state", async () => {
      await db.updateAgent(testAgentId, { state: "running" });
      const agent = await db.getAgent(testAccountId, testAgentId);
      assert.equal(agent?.state, "running");
    });
  });

  describe("Usage Logs", () => {
    it("should upsert and summarize daily usage", async () => {
      await db.upsertUsageLog({
        agent_id: testAgentId,
        usage_date: "2026-03-31",
        runtime: "openclaw",
        provider: "anthropic",
        model: "claude-sonnet-4",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 25,
        cache_write_tokens: 10,
        reasoning_tokens: 5,
        total_tokens: 190,
        estimated_cost_usd: 0.12,
      });

      await db.upsertUsageLog({
        agent_id: testAgentId,
        usage_date: "2026-03-31",
        runtime: "openclaw",
        provider: "anthropic",
        model: "claude-sonnet-4",
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 30,
        cache_write_tokens: 20,
        reasoning_tokens: 10,
        total_tokens: 340,
        estimated_cost_usd: 0.22,
      });

      const summary = await db.getAgentUsageSummary(testAgentId, 3650) as any;
      assert.equal(Number(summary.totals.input_tokens), 200);
      assert.equal(Number(summary.totals.output_tokens), 80);
      assert.equal(Number(summary.totals.total_tokens), 340);
      assert.equal(Number(summary.by_model[0].estimated_cost_usd), 0.22);
    });

    it("should summarize account usage", async () => {
      const summary = await db.getAccountUsageSummary(testAccountId, 3650) as any;
      assert.equal(Number(summary.totals.agents_count), 1);
      assert.equal(Number(summary.totals.total_tokens), 340);
    });
  });

  describe("Secrets", () => {
    it("should store and retrieve account-level secrets", async () => {
      const encrypted = encrypt("sk-test-secret");
      await db.setSecret(testAccountId, "ANTHROPIC_API_KEY", encrypted);

      const secrets = await db.getSecrets(testAccountId);
      assert.ok(secrets.length >= 1);
      const found = secrets.find((s) => s.key_name === "ANTHROPIC_API_KEY");
      assert.ok(found);
      assert.equal(decrypt(found.encrypted), "sk-test-secret");
    });

    it("should upsert secrets (update existing)", async () => {
      const encrypted = encrypt("sk-updated-secret");
      await db.setSecret(testAccountId, "ANTHROPIC_API_KEY", encrypted);

      const secrets = await db.getSecrets(testAccountId);
      const found = secrets.find((s) => s.key_name === "ANTHROPIC_API_KEY");
      assert.equal(decrypt(found!.encrypted), "sk-updated-secret");
    });

    it("should delete a secret", async () => {
      const deleted = await db.deleteSecret(testAccountId, "ANTHROPIC_API_KEY");
      assert.ok(deleted);

      const secrets = await db.getSecrets(testAccountId);
      assert.ok(!secrets.find((s) => s.key_name === "ANTHROPIC_API_KEY"));
    });
  });

  describe("Cleanup", () => {
    it("should soft-delete agent", async () => {
      await db.deleteAgent(testAgentId);
      const agents = await db.listAgents(testAccountId);
      assert.ok(!agents.find((a) => a.id === testAgentId));
    });
  });
});
