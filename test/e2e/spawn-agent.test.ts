/**
 * E2E test: Spawn a real agent on Hetzner, verify it boots, then destroy it.
 *
 * REQUIREMENTS:
 *   - HETZNER_API_TOKEN set (real Hetzner account)
 *   - HETZNER_SSH_KEY_ID set (SSH key registered in Hetzner)
 *   - HETZNER_SSH_KEY_PATH set (local private key path)
 *   - PLATFORM_ANTHROPIC_KEY or test LLM key
 *
 * WARNING: This creates a real VPS (~€0.007/test at CX23 hourly rate).
 * It cleans up after itself, but if the test crashes, check Hetzner dashboard.
 *
 * Run:
 *   HETZNER_API_TOKEN=xxx npm run test:e2e
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Env setup
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://botboot:botboot-local@localhost:5432/botboot";
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY || "a".repeat(64);
process.env.INFRA_PROVIDER = "hetzner";

import { env } from "../../src/env.js";
import { HetznerProvider } from "../../src/providers/hetzner.js";
import { getRuntime } from "../../src/runtimes/index.js";
import { buildCloudInit } from "../../src/lib/cloud-init.js";
import * as ssh from "../../src/lib/ssh.js";
import { sleep } from "../helpers/wait.js";

const SKIP_REASON = !env.HETZNER_API_TOKEN
  ? "HETZNER_API_TOKEN not set — skipping E2E spawn test"
  : !env.HETZNER_SSH_KEY_ID
    ? "HETZNER_SSH_KEY_ID not set — skipping E2E spawn test"
    : null;

const TEST_MODEL = process.env.TEST_MODEL || "openai-codex/gpt-5.4";
const TEST_KEEP_ALIVE_MIN = parseInt(process.env.TEST_KEEP_ALIVE_MIN || "0", 10);
const TEST_KEEP_ALIVE = process.env.TEST_KEEP_ALIVE === "1" || TEST_KEEP_ALIVE_MIN > 0;
const TEST_OPENAI_AUTH_JSON = process.env.TEST_OPENAI_AUTH_JSON || "";
const TEST_TELEGRAM_BOT_TOKEN = process.env.TEST_TELEGRAM_BOT_TOKEN || "";

describe("E2E: Spawn Agent on Hetzner", { skip: SKIP_REASON ?? false }, () => {
  const provider = new HetznerProvider();
  let machineId: string | null = null;
  let machineIp: string | null = null;

  after(async () => {
    if (!machineId) return;

    if (TEST_KEEP_ALIVE) {
      console.log(`⏸️  Keeping OpenClaw test server ${machineId} alive at ${machineIp} for manual checks.`);
      if (TEST_KEEP_ALIVE_MIN > 0) {
        console.log(`⏳ Waiting ${TEST_KEEP_ALIVE_MIN} minute(s) before cleanup...`);
        await sleep(TEST_KEEP_ALIVE_MIN * 60_000);
      } else {
        console.log("ℹ️  TEST_KEEP_ALIVE=1 set — skipping automatic cleanup. Delete it manually when done.");
        return;
      }
    }

    console.log(`🧹 Cleaning up Hetzner server ${machineId}...`);
    try {
      await provider.deleteMachine(machineId);
      console.log("✅ Server deleted");
    } catch (err) {
      console.error(`⚠️  Failed to delete server ${machineId} — DELETE MANUALLY!`, err);
    }
  });

  describe("OpenClaw runtime", () => {
    it("should provision an OpenClaw agent from stock Ubuntu", async () => {
      const runtime = getRuntime("openclaw");
      const testName = `bb-test-oc-${Date.now().toString(36)}`;

      // Build cloud-init
      const cloudInit = buildCloudInit({
        runtime,
        config: {
          name: "e2e-test-agent",
          model: TEST_MODEL,
          telegramBotToken: TEST_TELEGRAM_BOT_TOKEN || undefined,
        },
        secrets: {
          ...(TEST_OPENAI_AUTH_JSON ? { OPENAI_AUTH_JSON: TEST_OPENAI_AUTH_JSON } : {}),
          ...(env.PLATFORM_ANTHROPIC_KEY ? { ANTHROPIC_API_KEY: env.PLATFORM_ANTHROPIC_KEY } : {}),
          ...(env.PLATFORM_OPENROUTER_KEY ? { OPENROUTER_API_KEY: env.PLATFORM_OPENROUTER_KEY } : {}),
        },
        files: {
          "SOUL.md": "You are a test agent created by BotBoot E2E tests. Be brief.",
          "USER.md": "# Owner\nName: BotBoot Test Suite\nNote: This agent will be deleted shortly.",
        },
      });

      console.log(`🚀 Creating Hetzner VPS: ${testName}...`);
      const machine = await provider.createMachine({
        name: testName,
        cloudInit,
        labels: { test: "true", runtime: "openclaw" },
      });

      machineId = machine.id;
      machineIp = machine.ip;
      console.log(`📦 Server created: id=${machine.id} ip=${machine.ip}`);
      assert.ok(machine.id, "Machine should have an ID");
      assert.ok(machine.ip, "Machine should have an IP");
    });

    it("should become SSH-reachable within 3 minutes", async function () {
      if (!machineIp) return this.skip();

      const maxWait = 180_000; // 3 minutes
      const start = Date.now();
      let reachable = false;

      console.log(`⏳ Waiting for SSH on ${machineIp}...`);
      while (Date.now() - start < maxWait) {
        reachable = await ssh.ping(machineIp);
        if (reachable) break;
        await new Promise((r) => setTimeout(r, 10_000));
        process.stdout.write(".");
      }
      console.log(reachable ? "\n✅ SSH reachable" : "\n❌ SSH timeout");
      assert.ok(reachable, `SSH not reachable after ${maxWait / 1000}s`);
    });

    it("should complete provisioning within 5 minutes", async function () {
      if (!machineIp) return this.skip();

      const maxWait = 300_000; // 5 minutes
      const start = Date.now();
      let provisioned = false;

      console.log("⏳ Waiting for provisioning to complete...");
      while (Date.now() - start < maxWait) {
        const result = await ssh.exec(machineIp, "tail -3 /var/log/botboot-provision.log 2>/dev/null || echo 'no log'", { user: "root" });
        if (result.stdout.includes("Provisioning complete")) {
          provisioned = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 15_000));
        process.stdout.write(".");
      }
      console.log(provisioned ? "\n✅ Provisioning complete" : "\n❌ Provisioning timeout");
      assert.ok(provisioned, `Provisioning not complete after ${maxWait / 1000}s`);
    });

    it("should have OpenClaw installed and gateway running", async function () {
      if (!machineIp) return this.skip();

      // Check OpenClaw version
      const version = await ssh.exec(machineIp, "openclaw --version 2>/dev/null || echo 'not found'");
      console.log(`📦 OpenClaw version: ${version.stdout.trim()}`);
      assert.ok(!version.stdout.includes("not found"), "OpenClaw should be installed");

      // Check gateway status
      const status = await ssh.exec(machineIp, "systemctl is-active botboot-agent 2>/dev/null || echo inactive");
      console.log(`🔌 Gateway status: ${status.stdout.trim()}`);
      assert.equal(status.stdout.trim(), "active", "Gateway should be active");
    });

    it("should have identity files written", async function () {
      if (!machineIp) return this.skip();

      const soul = await ssh.exec(machineIp, "cat /home/agent/.openclaw/workspace/SOUL.md 2>/dev/null || echo 'MISSING'");
      assert.ok(soul.stdout.includes("test agent"), "SOUL.md should contain our test content");

      const user = await ssh.exec(machineIp, "cat /home/agent/.openclaw/workspace/USER.md 2>/dev/null || echo 'MISSING'");
      assert.ok(user.stdout.includes("BotBoot Test Suite"), "USER.md should contain our test content");
    });

    it("should have config and auth profiles", async function () {
      if (!machineIp) return this.skip();

      const config = await ssh.exec(machineIp, "cat /home/agent/.openclaw/openclaw.json 2>/dev/null || echo 'MISSING'");
      assert.ok(!config.stdout.includes("MISSING"), "openclaw.json should exist");

      const auth = await ssh.exec(machineIp, "cat /home/agent/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || echo 'MISSING'");
      assert.ok(!auth.stdout.includes("MISSING"), "auth-profiles.json should exist");
    });

    it("should clean up the server", async () => {
      if (!machineId) return;
      if (TEST_KEEP_ALIVE) {
        console.log("⏭️  Skipping immediate OpenClaw cleanup because TEST_KEEP_ALIVE is enabled.");
        return;
      }
      console.log(`🧹 Deleting server ${machineId}...`);
      await provider.deleteMachine(machineId);
      machineId = null; // Prevent double-delete in after()
      console.log("✅ Server deleted");
    });
  });
});

describe("E2E: Spawn Hermes Agent on Hetzner", { skip: SKIP_REASON ?? false }, () => {
  const provider = new HetznerProvider();
  let machineId: string | null = null;
  let machineIp: string | null = null;

  after(async () => {
    if (!machineId) return;

    if (TEST_KEEP_ALIVE) {
      console.log(`⏸️  Keeping Hermes test server ${machineId} alive at ${machineIp} for manual checks.`);
      if (TEST_KEEP_ALIVE_MIN > 0) {
        console.log(`⏳ Waiting ${TEST_KEEP_ALIVE_MIN} minute(s) before cleanup...`);
        await sleep(TEST_KEEP_ALIVE_MIN * 60_000);
      } else {
        console.log("ℹ️  TEST_KEEP_ALIVE=1 set — skipping automatic cleanup. Delete it manually when done.");
        return;
      }
    }

    console.log(`🧹 Cleaning up Hetzner server ${machineId}...`);
    try {
      await provider.deleteMachine(machineId);
      console.log("✅ Server deleted");
    } catch (err) {
      console.error(`⚠️  Failed to delete server ${machineId} — DELETE MANUALLY!`, err);
    }
  });

  it("should provision a Hermes agent from stock Ubuntu", async () => {
    const runtime = getRuntime("hermes");
    const testName = `bb-test-hm-${Date.now().toString(36)}`;

    const cloudInit = buildCloudInit({
      runtime,
      config: {
        name: "e2e-hermes-test",
        model: TEST_MODEL,
      },
      secrets: {
        ...(TEST_OPENAI_AUTH_JSON ? { OPENAI_AUTH_JSON: TEST_OPENAI_AUTH_JSON } : {}),
        ...(env.PLATFORM_ANTHROPIC_KEY ? { ANTHROPIC_API_KEY: env.PLATFORM_ANTHROPIC_KEY } : {}),
        ...(env.PLATFORM_OPENROUTER_KEY ? { OPENROUTER_API_KEY: env.PLATFORM_OPENROUTER_KEY } : {}),
      },
      files: {
        "SOUL.md": "You are a Hermes test agent created by BotBoot E2E tests. Be brief and helpful.",
        "USER.md": "Name: BotBoot Test\nNote: This agent will be deleted shortly.",
      },
    });

    console.log(`🚀 Creating Hetzner VPS: ${testName}...`);
    const machine = await provider.createMachine({
      name: testName,
      cloudInit,
      labels: { test: "true", runtime: "hermes" },
    });

    machineId = machine.id;
    machineIp = machine.ip;
    console.log(`📦 Server created: id=${machine.id} ip=${machine.ip}`);
    assert.ok(machine.id);
    assert.ok(machine.ip);
  });

  it("should become SSH-reachable within 5 minutes", async function () {
    if (!machineIp) return this.skip();

    // Hermes install takes longer — SSH as root first (agent user may not exist yet)
    const maxWait = 300_000;
    const start = Date.now();
    let reachable = false;

    console.log(`⏳ Waiting for SSH (root) on ${machineIp}...`);
    while (Date.now() - start < maxWait) {
      try {
        const result = await ssh.exec(machineIp, "echo ok", { user: "root", timeoutMs: 10_000 });
        if (result.stdout.trim() === "ok") { reachable = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 10_000));
      process.stdout.write(".");
    }
    console.log(reachable ? "\n✅ SSH reachable (root)" : "\n❌ SSH timeout");
    assert.ok(reachable);
  });

  it("should complete provisioning within 10 minutes (Hermes is heavier)", async function () {
    if (!machineIp) return this.skip();

    const maxWait = 600_000; // 10 minutes (Python + git clone + uv install + npm)
    const start = Date.now();
    let provisioned = false;

    console.log("⏳ Waiting for Hermes provisioning...");
    while (Date.now() - start < maxWait) {
      try {
        const result = await ssh.exec(machineIp, "tail -3 /var/log/botboot-provision.log 2>/dev/null || echo 'no log'", { user: "root" });
        if (result.stdout.includes("Provisioning complete")) {
          provisioned = true;
          break;
        }
        // Show progress
        const progress = await ssh.exec(machineIp, "tail -1 /var/log/botboot-provision.log 2>/dev/null || echo '...'", { user: "root" });
        process.stdout.write(`\r  ${progress.stdout.trim().slice(0, 80)}`);
      } catch { /* SSH might fail during early boot */ }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log(provisioned ? "\n✅ Hermes provisioning complete" : "\n❌ Hermes provisioning timeout");
    assert.ok(provisioned, `Provisioning not complete after ${maxWait / 1000}s`);
  });

  it("should have Hermes installed and gateway running", async function () {
    if (!machineIp) return this.skip();

    // hermes may not be in agent's PATH — check with full path and as root
    const version = await ssh.exec(machineIp, "/usr/local/bin/hermes version 2>/dev/null || hermes version 2>/dev/null || echo 'not found'", { user: "root" });
    console.log(`📦 Hermes version: ${version.stdout.trim()}`);
    assert.ok(!version.stdout.includes("not found"), "Hermes should be installed");

    // Gateway may need a moment after provisioning
    let gatewayActive = false;
    for (let i = 0; i < 6; i++) {
      const status = await ssh.exec(machineIp, "systemctl is-active botboot-agent 2>/dev/null || echo inactive", { user: "root" });
      console.log(`🔌 Gateway status: ${status.stdout.trim()}`);
      if (status.stdout.trim() === "active") { gatewayActive = true; break; }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    assert.ok(gatewayActive, "Gateway should be active");
  });

  it("should have identity files in correct Hermes paths", async function () {
    if (!machineIp) return this.skip();

    // SOUL.md → ~/.hermes/SOUL.md
    const soul = await ssh.exec(machineIp, "cat /home/agent/.hermes/SOUL.md 2>/dev/null || echo 'MISSING'");
    assert.ok(soul.stdout.includes("Hermes test agent"), "SOUL.md should be at ~/.hermes/SOUL.md");

    // USER.md → ~/.hermes/memories/USER.md
    const user = await ssh.exec(machineIp, "cat /home/agent/.hermes/memories/USER.md 2>/dev/null || echo 'MISSING'");
    assert.ok(user.stdout.includes("BotBoot Test"), "USER.md should be at ~/.hermes/memories/USER.md");

    // config.yaml
    const config = await ssh.exec(machineIp, "cat /home/agent/.hermes/config.yaml 2>/dev/null || echo 'MISSING'");
    assert.ok(config.stdout.includes("claude-sonnet"), "config.yaml should contain the model");

    // .env
    const envFile = await ssh.exec(machineIp, "cat /home/agent/.hermes/.env 2>/dev/null || echo 'MISSING'");
    assert.ok(!envFile.stdout.includes("MISSING"), ".env should exist");

    // state.db should be created by hermes
    const stateDb = await ssh.exec(machineIp, "ls -la /home/agent/.hermes/state.db 2>/dev/null || echo 'MISSING'");
    console.log(`📊 state.db: ${stateDb.stdout.includes("MISSING") ? "not yet created (normal on first boot)" : "exists"}`);
  });

  it("should clean up the server", async () => {
    if (!machineId) return;
    if (TEST_KEEP_ALIVE) {
      console.log("⏭️  Skipping immediate Hermes cleanup because TEST_KEEP_ALIVE is enabled.");
      return;
    }
    console.log(`🧹 Deleting server ${machineId}...`);
    await provider.deleteMachine(machineId);
    machineId = null;
    console.log("✅ Server deleted");
  });
});
