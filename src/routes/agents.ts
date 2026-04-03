/**
 * Agent routes — CRUD + lifecycle management.
 *
 * POST   /v1/agents              → Create agent
 * GET    /v1/agents              → List agents
 * GET    /v1/agents/:id          → Get agent + live status
 * DELETE /v1/agents/:id          → Delete agent
 * POST   /v1/agents/:id/start    → Power on
 * POST   /v1/agents/:id/stop     → Shutdown
 * POST   /v1/agents/:id/update   → Update agent runtime
 * POST   /v1/agents/:id/backup   → Create backup
 * GET    /v1/agents/:id/runtime  → Runtime/version info
 * GET    /v1/agents/:id/boot-status → Poll provisioning progress
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import * as ssh from "../lib/ssh.js";
import { decrypt } from "../lib/crypto.js";
import { getProvider } from "../providers/index.js";
import { getRuntime, listRuntimes } from "../runtimes/index.js";
import { buildCloudInit } from "../lib/cloud-init.js";
import type { AuthEnv } from "../lib/types.js";

const agents = new Hono<AuthEnv>();
agents.use("*", apiKeyAuth);

// ── POST /v1/agents ────────────────────────────────────────────────────

agents.post("/", async (c) => {
  const accountId = c.get("accountId");
  const body = await c.req.json<{
    name: string;
    runtime?: string;
    provider?: string;
    model?: string;
    telegramBotToken?: string;
    exposedSecrets?: string[];
    files?: Record<string, string>;
    config?: Record<string, unknown>;
  }>();

  if (!body.name) {
    console.warn("[agents.create] rejected: missing name", { accountId, body });
    return c.json({ error: "name is required" }, 400);
  }

  const runtimeName = body.runtime || "openclaw";
  const runtime = getRuntime(runtimeName);
  const provider = getProvider(body.provider);

  const exposedSecrets = Array.isArray(body.exposedSecrets)
    ? body.exposedSecrets.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];

  // Resolve only explicitly exposed secrets (3-tier cascade)
  const secrets = await resolveSecrets(accountId, undefined, exposedSecrets);

  const telegramBotToken = body.telegramBotToken;

  // Validate at least one LLM key exists
  if (!secrets.ANTHROPIC_API_KEY && !secrets.OPENROUTER_API_KEY && !secrets.OPENAI_AUTH_JSON) {
    const error = "No LLM API key configured. Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or OPENAI_AUTH_JSON via PUT /v1/secrets";
    console.warn("[agents.create] rejected: missing llm credential", {
      accountId,
      body: {
        name: body.name,
        runtime: body.runtime,
        provider: body.provider,
        model: body.model,
        exposedSecrets,
      },
      resolvedSecretKeys: Object.keys(secrets),
    });
    return c.json({ error }, 400);
  }

  // Build cloud-init script
  const cloudInit = buildCloudInit({
    runtime,
    config: {
      name: body.name,
      model: body.model,
      telegramBotToken,
    },
    secrets,
    files: body.files || {},
  });

  const slug = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  const serverName = `bb-${slug}-${Date.now().toString(36)}`;

  try {
    const machine = await provider.createMachine({
      name: serverName,
      cloudInit,
      labels: { runtime: runtimeName, slug },
    });

    const agent = await db.createAgent({
      account_id: accountId,
      name: body.name,
      runtime: runtimeName as "openclaw" | "hermes",
      provider: provider.name as "hetzner" | "docker",
      server_id: machine.id,
      ip: machine.ip,
      state: "provisioning",
      config: {
        ...(body.config || {}),
        model: body.model,
        telegramBotToken,
        files: Object.keys(body.files || {}),
      },
      exposed_secrets: exposedSecrets,
    });

    return c.json({
      id: agent.id,
      name: body.name,
      runtime: runtimeName,
      provider: provider.name,
      state: "provisioning",
      ip: machine.ip,
      exposedSecrets,
    }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Agent creation failed";
    console.error("[agents.create] failed", {
      accountId,
      body: {
        name: body.name,
        runtime: runtimeName,
        provider: provider.name,
        model: body.model,
        exposedSecrets,
      },
      error: msg,
    });
    return c.json({ error: msg }, 500);
  }
});

// ── GET /v1/agents ─────────────────────────────────────────────────────

agents.get("/", async (c) => {
  const accountId = c.get("accountId");
  const agentList = await db.listAgents(accountId);

  // Enrich with live status
  const provider = getProvider();
  const enriched = await Promise.all(
    agentList.map(async (agent) => {
      try {
        if (!agent.server_id) return { ...agent, liveStatus: "unknown" };
        const machine = await provider.getMachine(agent.server_id);
        return { ...agent, liveStatus: machine.state };
      } catch {
        return { ...agent, liveStatus: "unknown" };
      }
    })
  );

  return c.json({ agents: enriched });
});

// ── GET /v1/agents/:id ─────────────────────────────────────────────────

agents.get("/:id", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  try {
    const provider = getProvider(agent.provider);
    const machine = agent.server_id ? await provider.getMachine(agent.server_id) : null;
    return c.json({ ...agent, liveStatus: machine?.state || "unknown" });
  } catch {
    return c.json({ ...agent, liveStatus: "unknown" });
  }
});

// ── DELETE /v1/agents/:id ──────────────────────────────────────────────

agents.delete("/:id", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  // Backup before delete
  if (agent.ip) {
    try {
      const runtime = getRuntime(agent.runtime);
      await ssh.backup(agent.ip, runtime.configPath());
    } catch {
      console.warn("Backup before delete failed — proceeding anyway");
    }
  }

  // Delete machine
  if (agent.server_id) {
    try {
      const provider = getProvider(agent.provider);
      await provider.deleteMachine(agent.server_id);
    } catch { /* may already be gone */ }
  }

  await db.updateAgent(agent.id, { state: "deleted" });
  return c.json({ success: true });
});

// ── POST /v1/agents/:id/start ──────────────────────────────────────────

agents.post("/:id/start", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent || !agent.server_id) return c.json({ error: "Agent not found" }, 404);

  try {
    const provider = getProvider(agent.provider);
    await provider.startMachine(agent.server_id);
    await db.updateAgent(agent.id, { state: "running" });
    return c.json({ success: true, state: "running" });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Start failed" }, 500);
  }
});

// ── POST /v1/agents/:id/stop ───────────────────────────────────────────

agents.post("/:id/stop", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent || !agent.server_id) return c.json({ error: "Agent not found" }, 404);

  try {
    const provider = getProvider(agent.provider);
    await provider.stopMachine(agent.server_id);
    await db.updateAgent(agent.id, { state: "stopped" });
    return c.json({ success: true, state: "stopped" });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Stop failed" }, 500);
  }
});

// ── GET /v1/agents/:id/runtime ─────────────────────────────────────────

agents.get("/:id/runtime", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  const runtime = getRuntime(agent.runtime);
  const reachable = await ssh.ping(agent.ip);

  if (!reachable) {
    return c.json({ sshReachable: false, gatewayStatus: "unreachable", version: null });
  }

  const [statusResult, versionResult] = await Promise.all([
    ssh.exec(agent.ip, runtime.statusCommand()),
    ssh.exec(agent.ip, runtime.versionCommand()),
  ]);

  return c.json({
    sshReachable: true,
    gatewayStatus: statusResult.stdout.trim(),
    version: versionResult.stdout.trim(),
    runtime: agent.runtime,
  });
});

// ── GET /v1/agents/:id/boot-status ─────────────────────────────────────

agents.get("/:id/boot-status", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent || !agent.server_id) return c.json({ error: "Agent not found" }, 404);

  try {
    const provider = getProvider(agent.provider);
    const machine = await provider.getMachine(agent.server_id);

    if (machine.state === "initializing" || machine.state === "starting") {
      return c.json({ stage: "provisioning", progress: 20, message: "Server starting...", ready: false });
    }

    if (machine.state === "off" || machine.state === "stopping") {
      return c.json({ stage: "offline", progress: 0, message: `Server is ${machine.state}`, ready: false });
    }

    const ip = agent.ip || machine.ip;
    const reachable = await ssh.ping(ip);
    if (!reachable) {
      return c.json({ stage: "booting", progress: 40, message: "Waiting for SSH...", ready: false });
    }

    // Check if provision is done
    const provResult = await ssh.exec(ip, "tail -3 /var/log/botboot-provision.log 2>/dev/null || echo 'no log'", { user: "root" });
    if (provResult.stdout.includes("Provisioning complete")) {
      const runtime = getRuntime(agent.runtime);
      const statusResult = await ssh.exec(ip, runtime.statusCommand());
      const status = statusResult.stdout.trim();

      if (status === "active") {
        if (agent.state === "provisioning") {
          await db.updateAgent(agent.id, { state: "running", ip });
        }
        return c.json({ stage: "ready", progress: 100, message: "Agent online!", ready: true });
      }
      return c.json({ stage: "gateway", progress: 80, message: "Gateway starting...", ready: false });
    }

    return c.json({ stage: "installing", progress: 60, message: "Installing agent...", ready: false });
  } catch (err: unknown) {
    return c.json({ stage: "error", progress: 0, message: err instanceof Error ? err.message : "Check failed", ready: false });
  }
});

// ── POST /v1/agents/:id/ssh ─────────────────────────────────────────────

agents.post("/:id/ssh", async (c) => {
  const accountId = c.get("accountId");
  const agent = await db.getAgent(accountId, c.req.param("id"));
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  const { command } = await c.req.json<{ command: string }>();
  if (!command) return c.json({ error: "command required" }, 400);

  // Block destructive commands
  const blocked = ["rm -rf /", "mkfs", "dd if=", "> /dev/sd"];
  if (blocked.some((b) => command.includes(b))) {
    return c.json({ error: "Command blocked" }, 403);
  }

  try {
    const result = await ssh.exec(agent.ip, command, { timeoutMs: 60_000 });
    return c.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "SSH failed" }, 500);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

async function resolveSecrets(accountId: string, agentId?: string, exposedKeys?: string[]): Promise<Record<string, string>> {
  const { env: e } = await import("../env.js");
  const allow = new Set((exposedKeys || []).map((k) => k.trim()).filter(Boolean));

  // Tier 1: Platform defaults
  const secrets: Record<string, string> = {};
  if (e.PLATFORM_ANTHROPIC_KEY) secrets.ANTHROPIC_API_KEY = e.PLATFORM_ANTHROPIC_KEY;
  if (e.PLATFORM_OPENROUTER_KEY) secrets.OPENROUTER_API_KEY = e.PLATFORM_OPENROUTER_KEY;
  if (e.PLATFORM_TAVILY_KEY) secrets.TAVILY_API_KEY = e.PLATFORM_TAVILY_KEY;
  if (e.PLATFORM_FIRECRAWL_KEY) secrets.FIRECRAWL_API_KEY = e.PLATFORM_FIRECRAWL_KEY;

  // Tier 2: Account-level secrets
  const accountSecrets = await db.getSecrets(accountId);
  for (const s of accountSecrets) {
    secrets[s.key_name] = decrypt(s.encrypted);
  }

  // Tier 3: Agent-level overrides
  if (agentId) {
    const agentSecrets = await db.getSecrets(accountId, agentId);
    for (const s of agentSecrets) {
      secrets[s.key_name] = decrypt(s.encrypted);
    }
  }

  if (allow.size === 0) {
    return {
      ...(secrets.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY } : {}),
      ...(secrets.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: secrets.OPENROUTER_API_KEY } : {}),
      ...(secrets.OPENAI_AUTH_JSON ? { OPENAI_AUTH_JSON: secrets.OPENAI_AUTH_JSON } : {}),
    };
  }

  const filtered: Record<string, string> = {};
  for (const key of allow) {
    if (secrets[key]) filtered[key] = secrets[key];
  }

  if (!filtered.ANTHROPIC_API_KEY && secrets.ANTHROPIC_API_KEY) filtered.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  if (!filtered.OPENROUTER_API_KEY && secrets.OPENROUTER_API_KEY) filtered.OPENROUTER_API_KEY = secrets.OPENROUTER_API_KEY;

  return filtered;
}

export default agents;
