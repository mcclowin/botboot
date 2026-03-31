/**
 * Provider registry — maps provider names to their adapters.
 */

import type { ProviderAdapter } from "./types.js";
import { HetznerProvider } from "./hetzner.js";
import { env } from "../env.js";

const providers: Record<string, () => ProviderAdapter> = {
  hetzner: () => new HetznerProvider(),
  // docker: () => new DockerProvider(),  // TODO
  // phala: () => new PhalaProvider(),     // TODO
};

export function getProvider(name?: string): ProviderAdapter {
  const providerName = name || env.INFRA_PROVIDER;
  const factory = providers[providerName];
  if (!factory) {
    throw new Error(`Unknown provider: ${providerName}. Available: ${Object.keys(providers).join(", ")}`);
  }
  return factory();
}

export function listProviders(): string[] {
  return Object.keys(providers);
}

export type { ProviderAdapter, Machine } from "./types.js";
