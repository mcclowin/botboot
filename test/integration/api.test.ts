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

  describe("Agents", () => {
    let testAgentId: string;

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

    it("should soft-delete agent", async () => {
      await db.deleteAgent(testAgentId);
      const agents = await db.listAgents(testAccountId);
      // Deleted agents shouldn't appear in list
      assert.ok(!agents.find((a) => a.id === testAgentId));
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
});
