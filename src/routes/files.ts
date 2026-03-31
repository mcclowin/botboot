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

const files = new Hono();
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

  const { content } = await c.req.json<{ content: string }>();
  if (content === undefined) return c.json({ error: "content required" }, 400);

  const agent = await db.getAgent(accountId, agentId);
  if (!agent || !agent.ip) return c.json({ error: "Agent not found" }, 404);

  const runtime = getRuntime(agent.runtime);
  const fullPath = `${runtime.workspacePath()}/${filePath}`;

  try {
    await ssh.writeFile(agent.ip, fullPath, content);
    return c.json({ success: true, path: filePath });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : "Write failed" }, 500);
  }
});

export default files;
