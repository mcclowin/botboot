import { Hono } from "hono";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import * as ssh from "../lib/ssh.js";
import { getProvider } from "../providers/index.js";
import { getRuntime } from "../runtimes/index.js";
import type { AuthEnv } from "../lib/types.js";

const diagnostics = new Hono<AuthEnv>();
diagnostics.use("*", apiKeyAuth);

diagnostics.get("/:id/health", async (c) => {
  const accountId = c.get("accountId");
  const agentId = c.req.param("id");
  const agent = await db.getAgent(accountId, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const runtime = getRuntime(agent.runtime);
  const provider = getProvider(agent.provider);

  let machine: any = null;
  let providerError: string | null = null;
  if (agent.server_id) {
    try {
      machine = await provider.getMachine(agent.server_id);
    } catch (err: unknown) {
      providerError = err instanceof Error ? err.message : "Provider lookup failed";
    }
  }

  const ip = agent.ip || machine?.ip || null;
  const sshReachable = ip ? await ssh.ping(ip) : false;

  let provisionTail = "";
  let gatewayStatus = "unreachable";
  let version = "unknown";
  let openclawConfigPreview: any = null;
  let authProfilesPreview: any = null;
  let runtimeChecks: Record<string, unknown> = {};
  let recentErrors: string[] = [];

  if (ip && sshReachable) {
    try {
      const [prov, status, ver, journal] = await Promise.all([
        ssh.exec(ip, "tail -20 /var/log/botboot-provision.log 2>/dev/null || echo 'no log'", { user: "root" }),
        ssh.exec(ip, runtime.statusCommand(), { user: agent.runtime === "hermes" ? "root" : "agent" }),
        ssh.exec(ip, runtime.versionCommand(), { user: agent.runtime === "hermes" ? "root" : "agent" }),
        ssh.exec(ip, "journalctl -u botboot-agent -n 80 --no-pager 2>/dev/null || true", { user: "root", timeoutMs: 20_000 }),
      ]);

      provisionTail = prov.stdout;
      gatewayStatus = status.stdout.trim() || "unknown";
      version = ver.stdout.trim() || "unknown";
      recentErrors = journal.stdout
        .split("\n")
        .filter((line) => /error|failed|exception|denied|telegram|auth/i.test(line))
        .slice(-20);

      if (agent.runtime === "openclaw") {
        const [cfg, auth, secretsEnv, gatewayStatus] = await Promise.all([
          ssh.exec(ip, "cat /home/agent/.openclaw/openclaw.json 2>/dev/null || echo '{}'", { user: "root" }),
          ssh.exec(ip, "cat /home/agent/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || echo '{}'", { user: "root" }),
          ssh.exec(ip, "cat /etc/botboot/secrets.env 2>/dev/null || true", { user: "root" }),
          ssh.exec(ip, "openclaw gateway status 2>/dev/null || true", { user: "root", timeoutMs: 20_000 }),
        ]);
        try { openclawConfigPreview = JSON.parse(cfg.stdout); } catch {}
        try { authProfilesPreview = JSON.parse(auth.stdout); } catch {}
        runtimeChecks = {
          telegramConfigured: Boolean((openclawConfigPreview as any)?.channels?.telegram?.enabled),
          telegramPluginEnabled: Boolean((openclawConfigPreview as any)?.plugins?.entries?.telegram?.enabled),
          telegramTokenPresent: /TELEGRAM_BOT_TOKEN=|botToken/i.test(secretsEnv.stdout + '\n' + cfg.stdout),
          authProfilesPresent: Boolean((authProfilesPreview as any)?.profiles),
          providerKeys: Object.keys((authProfilesPreview as any)?.profiles || {}),
          gatewayStatusText: gatewayStatus.stdout.trim(),
        };
      } else if (agent.runtime === "hermes") {
        const [cfg, envFile] = await Promise.all([
          ssh.exec(ip, "cat /home/agent/.hermes/config.yaml 2>/dev/null || true", { user: "root" }),
          ssh.exec(ip, "cat /home/agent/.hermes/.env 2>/dev/null || true", { user: "root" }),
        ]);
        runtimeChecks = {
          telegramConfigured: /TELEGRAM_BOT_TOKEN=/.test(envFile.stdout),
          homeChannelPromptSeen: /No home channel is set/i.test(journal.stdout),
          providerAuthError: /Provider authentication failed/i.test(journal.stdout),
          configPreview: cfg.stdout.slice(0, 1200),
        };
      }
    } catch (err: unknown) {
      recentErrors.push(err instanceof Error ? err.message : "Diagnostic probe failed");
    }
  }

  return c.json({
    agent: {
      id: agent.id,
      name: agent.name,
      runtime: agent.runtime,
      provider: agent.provider,
      state: agent.state,
      ip,
    },
    machine: machine || null,
    providerError,
    ssh: { reachable: sshReachable },
    provision: {
      complete: provisionTail.includes("Provisioning complete"),
      tail: provisionTail,
    },
    service: {
      status: gatewayStatus,
      active: gatewayStatus === "active",
    },
    runtime: {
      version,
      checks: runtimeChecks,
    },
    recentErrors,
  });
});

diagnostics.get("/:id/logs", async (c) => {
  const accountId = c.get("accountId");
  const agentId = c.req.param("id");
  const lines = Math.max(1, Math.min(500, parseInt(c.req.query("lines") || "120", 10)));
  const agent = await db.getAgent(accountId, agentId);
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  try {
    const [journal, provision] = await Promise.all([
      ssh.exec(agent.ip, `journalctl -u botboot-agent -n ${lines} --no-pager 2>/dev/null || true`, { user: "root", timeoutMs: 20_000 }),
      ssh.exec(agent.ip, `tail -n ${lines} /var/log/botboot-provision.log 2>/dev/null || true`, { user: "root", timeoutMs: 20_000 }),
    ]);

    return c.json({
      journal: journal.stdout,
      provision: provision.stdout,
    });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Log fetch failed" }, 500);
  }
});

export default diagnostics;
