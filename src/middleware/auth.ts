import type { Context, Next } from "hono";
import { db } from "../lib/db.js";

/**
 * API key authentication middleware.
 *
 * Expects: Authorization: Bearer bb_<key>
 * Sets: accountId, accountEmail on context
 */
export async function apiKeyAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header. Use: Bearer bb_<your-key>" }, 401);
  }

  const apiKey = authHeader.slice(7);
  if (!apiKey.startsWith("bb_")) {
    return c.json({ error: "Invalid API key format. Keys start with bb_" }, 401);
  }

  const account = await db.getAccountByApiKey(apiKey);
  if (!account) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("accountId", account.id);
  c.set("accountEmail", account.email);
  await next();
}
