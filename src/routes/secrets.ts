/**
 * Secret management routes — 3-tier key storage.
 *
 * PUT    /v1/secrets             → Set account-level secrets
 * GET    /v1/secrets             → List secret names (no values)
 * DELETE /v1/secrets/:key        → Remove a secret
 * PUT    /v1/agents/:id/secrets  → Set agent-level overrides
 * GET    /v1/agents/:id/secrets  → List agent secrets + inherited
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { encrypt } from "../lib/crypto.js";

const secrets = new Hono();
secrets.use("*", apiKeyAuth);

// ── Account-level secrets ──────────────────────────────────────────────

secrets.put("/", async (c) => {
  const accountId = c.get("accountId");
  const body = await c.req.json<Record<string, string>>();

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return c.json({ error: "Provide at least one key-value pair" }, 400);
  }

  for (const [keyName, value] of Object.entries(body)) {
    const encrypted = encrypt(value);
    await db.setSecret(accountId, keyName, encrypted);
  }

  return c.json({ success: true, keys });
});

secrets.get("/", async (c) => {
  const accountId = c.get("accountId");
  const accountSecrets = await db.getSecrets(accountId);
  return c.json({
    keys: accountSecrets.map((s) => ({
      name: s.key_name,
      scope: "account",
      created_at: s.created_at,
    })),
  });
});

secrets.delete("/:key", async (c) => {
  const accountId = c.get("accountId");
  const keyName = c.req.param("key");
  const deleted = await db.deleteSecret(accountId, keyName);
  if (!deleted) return c.json({ error: "Secret not found" }, 404);
  return c.json({ success: true });
});

export default secrets;
