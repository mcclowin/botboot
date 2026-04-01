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
import { StageTimer, appendTimingArtifact } from "../helpers/timing.js";

const SKIP_REASON = !env.HETZNER_API_TOKEN
  ? "HETZNER_API_TOKEN not set — skipping E2E spawn test"
  : !env.HETZNER_SSH_KEY_ID
    ? "HETZNER_SSH_KEY_ID not set — skipping E2E spawn test"
    : null;

const TEST_MODEL = process.env.TEST_MODEL || "openai-codex/gpt-5.4";
const TEST_KEEP_ALIVE_MIN = parseInt(process.env.TEST_KEEP_ALIVE_MIN || "0", 10);
const TEST_KEEP_ALIVE = process.env.TEST_KEEP_ALIVE === "1" || TEST_KEEP_ALIVE_MIN > 0;
const TEST_OPENAI_AUTH_JSON = process.env.TEST_OPENAI_AUTH_JSON || "";
const TEST_TELEGRAM_BOT_TOKEN_OPENCLAW = process.env.TEST_TELEGRAM_BOT_TOKEN_OPENCLAW || process.env.TEST_TELEGRAM_BOT_TOKEN || "";

describe("E2E: Spawn OpenClaw Agent on Hetzner", { skip: SKIP_REASON ?? false }, () => {
  const provider = new HetznerProvider();
  const timer = new StageTimer();
  const suiteStart = Date.now();
  let machineId: string | null = null;
  let machineIp: string | null = null;

  after(async () => {
    timer.set("total_suite_ms", Date.now() - suiteStart);
    timer.print();
    appendTimingArtifact({ runtime: "openclaw", model: TEST_MODEL, machineId, machineIp, ...timer.summary() });

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

  it("should provision an OpenClaw agent from stock Ubuntu", async () => {
    const runtime = getRuntime("openclaw");
    const testName = `bb-test-oc-${Date.now().toString(36)}`;

    const cloudInit = buildCloudInit({
      runtime,
      config: {
        name: "e2e-test-agent",
        model: TEST_MODEL,
        telegramBotToken: TEST_TELEGRAM_BOT_TOKEN_OPENCLAW || undefined,
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
    timer.start("create_machine_ms");
    const machine = await provider.createMachine({
      name: testName,
      cloudInit,
      labels: { test: "true", runtime: "openclaw" },
    });

    timer.end("create_machine_ms");
    machineId = machine.id;
    machineIp = machine.ip;
    console.log(`📦 Server created: id=${machine.id} ip=${machine.ip}`);
    assert.ok(machine.id, "Machine should have an ID");
    assert.ok(machine.ip, "Machine should have an IP");
  });

  it("should become SSH-reachable within 3 minutes", async function () {
    if (!machineIp) return this.skip();

    const maxWait = 180_000;
    const start = Date.now();
    let reachable = false;

    console.log(`⏳ Waiting for SSH on ${machineIp}...`);
    timer.start("ssh_ready_ms");
    while (Date.now() - start < maxWait) {
      try {
        const result = await ssh.exec(machineIp, "echo ok", { user: "root", timeoutMs: 10_000 });
        reachable = result.stdout.trim() === "ok";
      } catch {
        reachable = false;
      }
      if (reachable) break;
      await sleep(10_000);
      process.stdout.write(".");
    }
    timer.end("ssh_ready_ms");
    console.log(reachable ? "\n✅ SSH reachable" : "\n❌ SSH timeout");
    assert.ok(reachable, `SSH not reachable after ${maxWait / 1000}s`);
  });

  it("should complete provisioning within 5 minutes", async function () {
    if (!machineIp) return this.skip();

    const maxWait = 300_000;
    const start = Date.now();
    let provisioned = false;

    console.log("⏳ Waiting for provisioning to complete...");
    timer.start("provision_complete_ms");
    while (Date.now() - start < maxWait) {
      const result = await ssh.exec(machineIp, "tail -3 /var/log/botboot-provision.log 2>/dev/null || echo 'no log'", { user: "root" });
      if (result.stdout.includes("Provisioning complete")) {
        provisioned = true;
        break;
      }
      await sleep(15_000);
      process.stdout.write(".");
    }
    timer.end("provision_complete_ms");
    console.log(provisioned ? "\n✅ Provisioning complete" : "\n❌ Provisioning timeout");
    assert.ok(provisioned, `Provisioning not complete after ${maxWait / 1000}s`);
  });

  it("should have OpenClaw installed and gateway running", async function () {
    if (!machineIp) return this.skip();

    timer.start("gateway_ready_ms");
    const version = await ssh.exec(machineIp, "openclaw --version 2>/dev/null || echo 'not found'");
    console.log(`📦 OpenClaw version: ${version.stdout.trim()}`);
    assert.ok(!version.stdout.includes("not found"), "OpenClaw should be installed");

    let active = false;
    for (let i = 0; i < 6; i++) {
      const status = await ssh.exec(machineIp, "systemctl is-active botboot-agent 2>/dev/null || echo inactive");
      console.log(`🔌 Gateway status: ${status.stdout.trim()}`);
      if (status.stdout.trim() === "active") { active = true; break; }
      await sleep(10_000);
    }
    timer.end("gateway_ready_ms");
    assert.ok(active, "Gateway should be active");
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
    machineId = null;
    console.log("✅ Server deleted");
  });
});
