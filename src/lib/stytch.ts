/**
 * Stytch client — lazy-initialized, only loaded when STYTCH_PROJECT_ID is set.
 */

import { env } from "../env.js";

let _client: any = null;

export function stytchEnabled(): boolean {
  return Boolean(env.STYTCH_PROJECT_ID && env.STYTCH_SECRET);
}

export async function getStytchClient() {
  if (!stytchEnabled()) {
    throw new Error("Stytch is not configured (STYTCH_PROJECT_ID / STYTCH_SECRET missing)");
  }
  if (!_client) {
    const stytch = await import("stytch");
    _client = new stytch.Client({
      project_id: env.STYTCH_PROJECT_ID,
      secret: env.STYTCH_SECRET,
    });
  }
  return _client;
}
