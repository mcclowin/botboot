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
import { env } from "../env.js";
import { getStytchClient, stytchEnabled } from "../lib/stytch.js";
import type { AuthEnv } from "../lib/types.js";

const auth = new Hono<AuthEnv>();

// Stytch magic link auth (optional)
auth.post("/magic-link", async (c) => {
  if (!stytchEnabled()) return c.json({ error: "Stytch is not configured" }, 501);

  const { email, redirectUrl } = await c.req.json<{ email: string; redirectUrl?: string }>();
  if (!email || !email.includes("@")) return c.json({ error: "Valid email required" }, 400);

  const stytch = await getStytchClient();
  await stytch.magicLinks.email.loginOrCreate({
    email,
    login_magic_link_url: redirectUrl || env.FRONTEND_URL,
    signup_magic_link_url: redirectUrl || env.FRONTEND_URL,
  });

  return c.json({ success: true, message: "Magic link sent" });
});

auth.post("/authenticate", async (c) => {
  if (!stytchEnabled()) return c.json({ error: "Stytch is not configured" }, 501);

  const { token } = await c.req.json<{ token: string }>();
  if (!token) return c.json({ error: "Token required" }, 400);

  const stytch = await getStytchClient();
  const response = await stytch.magicLinks.authenticate({
    token,
    session_duration_minutes: 60 * 24 * 7,
  });

  const stytchUserId = response.user_id;
  const userEmail = response.user.emails?.[0]?.email || "";
  const account = await db.getOrCreateAccountByStytch(userEmail, stytchUserId);

  return c.json({
    success: true,
    session_token: response.session_token,
    session_jwt: response.session_jwt,
    user: { id: account.id, email: userEmail },
  });
});

auth.get("/me", apiKeyAuth, async (c) => {
  return c.json({ id: c.get("accountId"), email: c.get("accountEmail") });
});

auth.post("/logout", async (c) => {
  if (!stytchEnabled()) return c.json({ success: true });
  const sessionToken = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!sessionToken || sessionToken.startsWith("bb_")) return c.json({ success: true });

  try {
    const stytch = await getStytchClient();
    await stytch.sessions.revoke({ session_token: sessionToken });
  } catch {}
  return c.json({ success: true });
});

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
  const keyId = c.req.param("id")!;
  const deleted = await db.deleteApiKey(accountId, keyId);
  if (!deleted) return c.json({ error: "API key not found" }, 404);
  return c.json({ success: true });
});

export default auth;
