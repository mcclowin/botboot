import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../../src/env.js";
import { StageTimer, appendTimingArtifact } from "../helpers/timing.js";
import { baseUrl, createTestApiKey, putSecrets } from "../helpers/api.js";

const TEST_MODEL = process.env.TEST_MODEL || "openai-codex/gpt-5.4";
const TEST_ACCOUNT_EMAIL = process.env.TEST_ACCOUNT_EMAIL || "test@botboot.dev";
const TEST_ACCOUNT_NAME = process.env.TEST_ACCOUNT_NAME || "BotBoot Test";
const TEST_KEEP_ALIVE_MIN = parseInt(process.env.TEST_KEEP_ALIVE_MIN || "0", 10);
const SKIP_REASON = !process.env.HETZNER_API_TOKEN && !process.env.HETZNER_API_TOKEN ? "Hetzner env not set" : null;

function runtimeTelegramToken(runtime: "openclaw" | "hermes"): string | undefined {
  if (runtime === "openclaw") return process.env.TEST_TELEGRAM_BOT_TOKEN_OPENCLAW || process.env.TEST_TELEGRAM_BOT_TOKEN;
  return process.env.TEST_TELEGRAM_BOT_TOKEN_HERMES || process.env.TEST_TELEGRAM_BOT_TOKEN;
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${baseUrl()}/health`);
      if (res.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("BotBoot server did not start in time");
}

async function createAgent(apiKey: string, runtime: "openclaw" | "hermes") {
  const exposedSecrets = ["OPENAI_AUTH_JSON"];
  const telegramBotToken = runtimeTelegramToken(runtime);
  if (telegramBotToken) exposedSecrets.push("TELEGRAM_BOT_TOKEN");

  const res = await fetch(`${baseUrl()}/v1/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      name: `${runtime}-api-e2e`,
      runtime,
      model: TEST_MODEL,
      exposedSecrets,
      telegramBotToken,
      files: {
        "SOUL.md": `You are a ${runtime} API E2E test agent.`,
        "USER.md": `Name: ${TEST_ACCOUNT_NAME}`,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`createAgent failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function getHealth(apiKey: string, agentId: string) {
  const res = await fetch(`${baseUrl()}/v1/agents/${agentId}/health`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`health failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}

async function getLogs(apiKey: string, agentId: string) {
  const res = await fetch(`${baseUrl()}/v1/agents/${agentId}/logs`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.json();
}

async function apiGet(apiKey: string, path: string) {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return { status: res.status, data: await res.json() };
}

async function apiPost(apiKey: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function apiPut(apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe("API-driven E2E", { skip: SKIP_REASON ?? false }, () => {
  it("should create OpenClaw agent via BotBoot APIs and reach healthy state", async () => {
    const server = spawn("node", ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    try {
      await waitForServer();

      for (const runtime of ["openclaw"] as const) {
        const timer = new StageTimer();
        const api = await createTestApiKey(TEST_ACCOUNT_EMAIL, `${runtime}-api-key`);

        const secretPayload: Record<string, string> = {};
        if (process.env.TEST_OPENAI_AUTH_JSON) secretPayload.OPENAI_AUTH_JSON = process.env.TEST_OPENAI_AUTH_JSON;
        const tg = runtimeTelegramToken(runtime);
        if (tg) secretPayload.TELEGRAM_BOT_TOKEN = tg;

        timer.start("put_secrets_ms");
        await putSecrets(api.key, secretPayload);
        timer.end("put_secrets_ms");

        timer.start("create_agent_ms");
        const created = await createAgent(api.key, runtime);
        timer.end("create_agent_ms");
        assert.ok(created.id, `${runtime} agent should have id`);

        timer.start("health_ready_ms");
        const deadline = Date.now() + 12 * 60_000;
        let healthy = false;
        let lastHealth: any = null;
        while (Date.now() < deadline) {
          lastHealth = await getHealth(api.key, created.id);
          if (lastHealth?.service?.active && lastHealth?.provision?.complete) {
            healthy = true;
            break;
          }
          await sleep(15_000);
        }
        timer.end("health_ready_ms");

        if (!healthy) {
          const logs = await getLogs(api.key, created.id);
          console.log(`❌ ${runtime} failed to reach healthy state`, JSON.stringify(lastHealth, null, 2));
          console.log(`📜 ${runtime} logs`, JSON.stringify(logs, null, 2));
        }

        assert.ok(healthy, `${runtime} agent should reach healthy state`);
        timer.set("total_flow_ms", Object.values(timer.summary()).reduce((a, b) => a + Number(b), 0));
        timer.print(`⏱ [${runtime}]`);
        appendTimingArtifact({ kind: "api-e2e", runtime, agentId: created.id, model: TEST_MODEL, ...timer.summary() });

        // ── Tevy2-relevant probes ────────────────────────────────
        console.log(`\n🧪 Running Tevy2 integration probes on ${created.id}...`);

        // List agents
        const listRes = await apiGet(api.key, "/v1/agents");
        assert.equal(listRes.status, 200, "list agents should return 200");
        assert.ok(listRes.data.agents?.length > 0, "should have at least 1 agent");
        console.log(`  ✅ GET /v1/agents — ${listRes.data.agents.length} agent(s)`);

        // Get single agent
        const getRes = await apiGet(api.key, `/v1/agents/${created.id}`);
        assert.equal(getRes.status, 200, "get agent should return 200");
        assert.equal(getRes.data.id, created.id);
        console.log(`  ✅ GET /v1/agents/:id — state: ${getRes.data.state}`);

        // Runtime info
        const rtRes = await apiGet(api.key, `/v1/agents/${created.id}/runtime`);
        assert.equal(rtRes.status, 200, "runtime should return 200");
        assert.equal(rtRes.data.sshReachable, true, "SSH should be reachable");
        console.log(`  ✅ GET /v1/agents/:id/runtime — gateway: ${rtRes.data.gatewayStatus}, version: ${rtRes.data.version}`);

        // Boot status
        const bootRes = await apiGet(api.key, `/v1/agents/${created.id}/boot-status`);
        assert.equal(bootRes.status, 200, "boot-status should return 200");
        assert.equal(bootRes.data.ready, true, "should be ready");
        console.log(`  ✅ GET /v1/agents/:id/boot-status — ready: ${bootRes.data.ready}`);

        // Write file
        const writeRes = await apiPut(api.key, `/v1/agents/${created.id}/files/SOUL.md`, {
          content: "You are a Tevy2 marketing bot for TestCorp.",
        });
        assert.equal(writeRes.status, 200, "file write should return 200");
        assert.ok(writeRes.data.success);
        console.log(`  ✅ PUT /v1/agents/:id/files/SOUL.md`);

        // Read file back
        const readRes = await apiGet(api.key, `/v1/agents/${created.id}/files/SOUL.md`);
        assert.equal(readRes.status, 200, "file read should return 200");
        assert.ok(readRes.data.content.includes("Tevy2 marketing bot"), "file content should match");
        console.log(`  ✅ GET /v1/agents/:id/files/SOUL.md — ${readRes.data.content.length} chars`);

        // Write file with base64 encoding
        const b64Content = Buffer.from("Base64 encoded brand doc").toString("base64");
        const writeB64 = await apiPut(api.key, `/v1/agents/${created.id}/files/BRAND.md`, {
          content: b64Content,
          encoding: "base64",
        });
        assert.equal(writeB64.status, 200, "base64 file write should return 200");
        const readB64 = await apiGet(api.key, `/v1/agents/${created.id}/files/BRAND.md`);
        assert.ok(readB64.data.content.includes("Base64 encoded brand doc"));
        console.log(`  ✅ PUT+GET base64 file write/read`);

        // SSH exec
        const sshRes = await apiPost(api.key, `/v1/agents/${created.id}/ssh`, {
          command: "echo hello-from-tevy2",
        });
        assert.equal(sshRes.status, 200, "ssh exec should return 200");
        assert.ok(sshRes.data.stdout.includes("hello-from-tevy2"), "ssh output should match");
        assert.equal(sshRes.data.exitCode, 0);
        console.log(`  ✅ POST /v1/agents/:id/ssh — exitCode: ${sshRes.data.exitCode}`);

        // SSH exec — blocked command
        const blockedRes = await apiPost(api.key, `/v1/agents/${created.id}/ssh`, {
          command: "rm -rf / --no-preserve-root",
        });
        assert.equal(blockedRes.status, 403, "dangerous command should be blocked");
        console.log(`  ✅ POST /v1/agents/:id/ssh — blocked dangerous command`);

        // Secrets list
        const secretsRes = await apiGet(api.key, "/v1/secrets");
        assert.equal(secretsRes.status, 200);
        console.log(`  ✅ GET /v1/secrets — ${secretsRes.data.keys?.length} key(s)`);

        // Auth /me
        const meRes = await apiGet(api.key, "/v1/auth/me");
        assert.equal(meRes.status, 200);
        assert.ok(meRes.data.email);
        console.log(`  ✅ GET /v1/auth/me — ${meRes.data.email}`);

        console.log(`\n✨ All Tevy2 probes passed!\n`);

        if (TEST_KEEP_ALIVE_MIN > 0) {
          console.log(`⏸️ Keeping ${runtime} agent ${created.id} alive for ${TEST_KEEP_ALIVE_MIN} minute(s) for manual checks.`);
        }
      }
    } finally {
      server.kill("SIGTERM");
    }
  }, 20 * 60 * 1000);
});
