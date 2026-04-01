import { env } from "../../src/env.js";

export function baseUrl(): string {
  return `http://127.0.0.1:${env.PORT}`;
}

export async function createTestApiKey(email: string, name = "test-key"): Promise<{ key: string; account_id: string }> {
  const res = await fetch(`${baseUrl()}/v1/auth/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    throw new Error(`createTestApiKey failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json() as { key: string; account_id: string };
  return data;
}

export async function putSecrets(apiKey: string, payload: Record<string, string>): Promise<any> {
  const res = await fetch(`${baseUrl()}/v1/secrets`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`putSecrets failed (${res.status}): ${JSON.stringify(data)}`);
  return data;
}
