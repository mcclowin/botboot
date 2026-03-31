/**
 * Runtime registry — maps runtime names to their adapters.
 */

import type { RuntimeAdapter } from "./types.js";
import { OpenClawRuntime } from "./openclaw.js";
import { HermesRuntime } from "./hermes.js";

const runtimes: Record<string, RuntimeAdapter> = {
  openclaw: new OpenClawRuntime(),
  hermes: new HermesRuntime(),
};

export function getRuntime(name: string): RuntimeAdapter {
  const runtime = runtimes[name];
  if (!runtime) {
    throw new Error(`Unknown runtime: ${name}. Available: ${Object.keys(runtimes).join(", ")}`);
  }
  return runtime;
}

export function listRuntimes(): string[] {
  return Object.keys(runtimes);
}

export type { RuntimeAdapter, AgentConfig } from "./types.js";
