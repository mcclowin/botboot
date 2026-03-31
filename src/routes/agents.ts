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
import { getProvider } from "../providers/index.js";
import { getRuntime, listRuntimes } from "../runtimes/index.js";
import { buildCloudInit } from "../lib/cloud-init.js";

const agents = new Hono();
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
    files?: Record<string, string>;
  }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const runtimeName = body.runtime || "openclaw";
  const runtime = getRuntime(runtimeName);
  const provider = getProvider(body.provider);

  // Resolve secrets (3-tier cascade)
  const secrets = await resolveSecrets(accountId, undefined);

  // Validate at least one LLM key exists
  if (!secrets.ANTHROPIC_API_KEY && !secrets.OPENROUTER_API_KEY) {
    return c.json({
      error: "No LLM API key configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY via PUT /v1/secrets",
    }, 400);
  }

  // Build cloud-init script
  const cloudInit = buildCloudInit({
    runtime,
    config: {
      name: body.name,
      model: body.model,
      telegramBotToken: body.telegramBotToken,
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
        model: body.model,
        telegramBotToken: body.telegramBotToken,
        files: Object.keys(body.files || {}),
      },
    });

    return c.json({
      id: agent.id,
      name: body.name,
      runtime: runtimeName,
      provider: provider.name,
      state: "provisioning",
      ip: machine.ip,
    }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Agent creation failed";
    console.error("Agent creation failed:", msg);
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

// ── Helpers ────────────────────────────────────────────────────────────

async function resolveSecrets(accountId: string, agentId?: string): Promise<Record<string, string>> {
  const { env: e } = await import("../env.js");

  // Tier 1: Platform defaults
  const secrets: Record<string, string> = {};
  if (e.PLATFORM_ANTHROPIC_KEY) secrets.ANTHROPIC_API_KEY = e.PLATFORM_ANTHROPIC_KEY;
  if (e.PLATFORM_OPENROUTER_KEY) secrets.OPENROUTER_API_KEY = e.PLATFORM_OPENROUTER_KEY;
  if (e.PLATFORM_TAVILY_KEY) secrets.TAVILY_API_KEY = e.PLATFORM_TAVILY_KEY;
  if (e.PLATFORM_FIRECRAWL_KEY) secrets.FIRECRAWL_API_KEY = e.PLATFORM_FIRECRAWL_KEY;

  // Tier 2: Account-level secrets
  // TODO: decrypt from db.getSecrets(accountId)

  // Tier 3: Agent-level overrides
  // TODO: decrypt from db.getSecrets(accountId, agentId)

  return secrets;
}

export default agents;
