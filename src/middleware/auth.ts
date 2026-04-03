import type { Context, Next } from "hono";
import { db } from "../lib/db.js";
import { getStytchClient, stytchEnabled } from "../lib/stytch.js";

async function resolveAuthAccount(authHeader?: string) {
  if (!authHeader?.startsWith("Bearer ")) return { error: "Missing Authorization header" } as const;

  const token = authHeader.slice(7);

  // API key auth
  if (token.startsWith("bb_")) {
    const account = await db.getAccountByApiKey(token);
    if (!account) return { error: "Invalid API key" } as const;
    return { account } as const;
  }

  // Stytch session token auth
  if (stytchEnabled()) {
    try {
      const stytch = await getStytchClient();
      const response = await stytch.sessions.authenticate({ session_token: token });
      const stytchUserId = response.user?.user_id || response.session?.user_id;
      const userEmail = response.user?.emails?.[0]?.email || "";

      if (!stytchUserId || !userEmail) {
        return { error: "Invalid Stytch session" } as const;
      }

      const account = await db.getOrCreateAccountByStytch(userEmail, stytchUserId);
      return { account } as const;
    } catch {
      return { error: "Invalid session token" } as const;
    }
  }

  return { error: "Invalid auth token" } as const;
}

/**
 * Auth middleware.
 *
 * Accepts either:
 * - Authorization: Bearer bb_<key>
 * - Authorization: Bearer <stytch_session_token> (when Stytch configured)
 */
export async function apiKeyAuth(c: Context, next: Next) {
  const resolved = await resolveAuthAccount(c.req.header("Authorization"));
  if ("error" in resolved || !resolved.account) {
    return c.json({ error: "error" in resolved ? resolved.error : "Unauthorized" }, 401);
  }

  const account = resolved.account;
  c.set("accountId", account.id);
  c.set("accountEmail", account.email);
  await next();
}

export async function optionalAuth(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return next();

  const resolved = await resolveAuthAccount(authHeader);
  if ("account" in resolved && resolved.account) {
    c.set("accountId", resolved.account.id);
    c.set("accountEmail", resolved.account.email);
  }
  await next();
}
