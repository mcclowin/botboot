/**
 * File routes — read/write agent workspace files via SSH.
 *
 * GET /v1/agents/:id/files/*  → Read file
 * PUT /v1/agents/:id/files/*  → Write file
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import * as ssh from "../lib/ssh.js";
import { getRuntime } from "../runtimes/index.js";
import type { AuthEnv } from "../lib/types.js";

const files = new Hono<AuthEnv>();
files.use("*", apiKeyAuth);

files.get("/:id/files/*", async (c) => {
  const accountId = c.get("accountId");
  const agentId = c.req.param("id");
  const filePath = c.req.path.split("/files/")[1];

  if (!filePath) return c.json({ error: "File path required" }, 400);
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const agent = await db.getAgent(accountId, agentId);
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  const runtime = getRuntime(agent.runtime);
  const fullPath = `${runtime.workspacePath()}/${filePath}`;

  try {
    const result = await ssh.exec(agent.ip, `cat ${JSON.stringify(fullPath)}`);
    if (result.exitCode !== 0) {
      return c.json({ error: `File not found: ${filePath}` }, 404);
    }
    return c.json({ path: filePath, content: result.stdout });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Read failed" }, 500);
  }
});

files.put("/:id/files/*", async (c) => {
  const accountId = c.get("accountId");
  const agentId = c.req.param("id");
  const filePath = c.req.path.split("/files/")[1];

  if (!filePath) return c.json({ error: "File path required" }, 400);
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const { content, encoding } = await c.req.json<{ content: string; encoding?: "utf8" | "base64" }>();
  if (content === undefined) return c.json({ error: "content required" }, 400);

  const agent = await db.getAgent(accountId, agentId);
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  const runtime = getRuntime(agent.runtime);
  const fullPath = `${runtime.workspacePath()}/${filePath}`;

  try {
    const decoded = encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;
    await ssh.writeFile(agent.ip, fullPath, decoded);
    return c.json({ success: true, path: filePath });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Write failed" }, 500);
  }
});

export default files;
