import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const env = {
  PORT: parseInt(optional("PORT", "3001")),

  // Database
  DATABASE_URL: required("DATABASE_URL"),

  // Infrastructure provider
  INFRA_PROVIDER: optional("INFRA_PROVIDER", "hetzner") as "hetzner" | "docker",

  // Hetzner Cloud
  HETZNER_API_TOKEN: optional("HETZNER_API_TOKEN", ""),
  HETZNER_SERVER_TYPE: optional("HETZNER_SERVER_TYPE", "cx23"),
  HETZNER_LOCATION: optional("HETZNER_LOCATION", "nbg1"),
  HETZNER_SSH_KEY_ID: optional("HETZNER_SSH_KEY_ID", ""),
  HETZNER_SSH_KEY_PATH: optional("HETZNER_SSH_KEY_PATH", ""),
  HETZNER_FIREWALL_ID: optional("HETZNER_FIREWALL_ID", ""),

  // Secret encryption
  SECRETS_ENCRYPTION_KEY: optional("SECRETS_ENCRYPTION_KEY", ""),

  // Platform-level fallback secrets (Tier 1)
  PLATFORM_ANTHROPIC_KEY: optional("PLATFORM_ANTHROPIC_KEY", ""),
  PLATFORM_OPENROUTER_KEY: optional("PLATFORM_OPENROUTER_KEY", ""),
  PLATFORM_TAVILY_KEY: optional("PLATFORM_TAVILY_KEY", ""),
  PLATFORM_FIRECRAWL_KEY: optional("PLATFORM_FIRECRAWL_KEY", ""),

  // Admin
  ADMIN_API_KEY: optional("ADMIN_API_KEY", ""),
};
