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

        if (TEST_KEEP_ALIVE_MIN > 0) {
          console.log(`⏸️ Keeping ${runtime} agent ${created.id} alive for ${TEST_KEEP_ALIVE_MIN} minute(s) for manual checks.`);
        }
      }
    } finally {
      server.kill("SIGTERM");
    }
  }, 20 * 60 * 1000);
});
