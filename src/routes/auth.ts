/**
 * Auth routes — API key management.
 *
 * POST   /v1/auth/api-keys       → Generate new API key
 * GET    /v1/auth/api-keys       → List API keys (prefix only)
 * DELETE /v1/auth/api-keys/:id   → Revoke an API key
 */

import { Hono } from "hono";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";
import { generateApiKey } from "../lib/crypto.js";

const auth = new Hono();

// Key generation — creates account if needed
auth.post("/api-keys", async (c) => {
  const body = await c.req.json<{ name?: string; email?: string }>();

  if (!body.email) {
    return c.json({ error: "email is required" }, 400);
  }

  const account = await db.getOrCreateAccount(body.email);
  const { key, prefix, hash } = generateApiKey();
  await db.createApiKey(account.id, body.name || "default", hash, prefix);

  return c.json({
    key,       // Only shown once — save it!
    prefix,    // For identification
    name: body.name || "default",
    account_id: account.id,
    message: "Save this key — it won't be shown again.",
  });
});

// List keys (requires auth)
auth.get("/api-keys", apiKeyAuth, async (c) => {
  const accountId = c.get("accountId");
  const keys = await db.listApiKeys(accountId);
  return c.json({
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      created_at: k.created_at,
    })),
  });
});

// Delete key (requires auth)
auth.delete("/api-keys/:id", apiKeyAuth, async (c) => {
  const accountId = c.get("accountId");
  const keyId = c.req.param("id");
  const deleted = await db.deleteApiKey(accountId, keyId);
  if (!deleted) return c.json({ error: "API key not found" }, 404);
  return c.json({ success: true });
});

export default auth;
