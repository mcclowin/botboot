import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

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
const TEST_TELEGRAM_BOT_TOKEN_HERMES = process.env.TEST_TELEGRAM_BOT_TOKEN_HERMES || process.env.TEST_TELEGRAM_BOT_TOKEN || "";

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
        telegramBotToken: TEST_TELEGRAM_BOT_TOKEN_HERMES || undefined,
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

    const maxWait = 300_000;
    const start = Date.now();
    let reachable = false;

    console.log(`⏳ Waiting for SSH (root) on ${machineIp}...`);
    while (Date.now() - start < maxWait) {
      try {
        const result = await ssh.exec(machineIp, "echo ok", { user: "root", timeoutMs: 10_000 });
        if (result.stdout.trim() === "ok") { reachable = true; break; }
      } catch {}
      await sleep(10_000);
      process.stdout.write(".");
    }
    console.log(reachable ? "\n✅ SSH reachable (root)" : "\n❌ SSH timeout");
    assert.ok(reachable);
  });

  it("should complete provisioning within 10 minutes (Hermes is heavier)", async function () {
    if (!machineIp) return this.skip();

    const maxWait = 600_000;
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
        const progress = await ssh.exec(machineIp, "tail -1 /var/log/botboot-provision.log 2>/dev/null || echo '...'", { user: "root" });
        process.stdout.write(`\r  ${progress.stdout.trim().slice(0, 80)}`);
      } catch {}
      await sleep(15_000);
    }
    console.log(provisioned ? "\n✅ Hermes provisioning complete" : "\n❌ Hermes provisioning timeout");
    assert.ok(provisioned, `Provisioning not complete after ${maxWait / 1000}s`);
  });

  it("should have Hermes installed and gateway running", async function () {
    if (!machineIp) return this.skip();

    const version = await ssh.exec(machineIp, "/usr/local/bin/hermes version 2>/dev/null || hermes version 2>/dev/null || echo 'not found'", { user: "root" });
    console.log(`📦 Hermes version: ${version.stdout.trim()}`);
    assert.ok(!version.stdout.includes("not found"), "Hermes should be installed");

    let gatewayActive = false;
    for (let i = 0; i < 6; i++) {
      const status = await ssh.exec(machineIp, "systemctl is-active botboot-agent 2>/dev/null || echo inactive", { user: "root" });
      console.log(`🔌 Gateway status: ${status.stdout.trim()}`);
      if (status.stdout.trim() === "active") { gatewayActive = true; break; }
      await sleep(10_000);
    }
    assert.ok(gatewayActive, "Gateway should be active");
  });

  it("should have identity files in correct Hermes paths", async function () {
    if (!machineIp) return this.skip();

    const soul = await ssh.exec(machineIp, "cat /home/agent/.hermes/SOUL.md 2>/dev/null || echo 'MISSING'");
    assert.ok(soul.stdout.includes("Hermes test agent"), "SOUL.md should be at ~/.hermes/SOUL.md");

    const user = await ssh.exec(machineIp, "cat /home/agent/.hermes/memories/USER.md 2>/dev/null || echo 'MISSING'");
    assert.ok(user.stdout.includes("BotBoot Test"), "USER.md should be at ~/.hermes/memories/USER.md");

    const config = await ssh.exec(machineIp, "cat /home/agent/.hermes/config.yaml 2>/dev/null || echo 'MISSING'");
    assert.ok(config.stdout.includes(TEST_MODEL), `config.yaml should contain the model ${TEST_MODEL}`);

    const envFile = await ssh.exec(machineIp, "cat /home/agent/.hermes/.env 2>/dev/null || echo 'MISSING'");
    assert.ok(!envFile.stdout.includes("MISSING"), ".env should exist");

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
