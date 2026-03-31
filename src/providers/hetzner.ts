/**
 * Hetzner Cloud provider adapter.
 *
 * Creates CX23 VPSes (2 vCPU, 4GB RAM, 40GB NVMe) from stock Ubuntu.
 * No custom snapshots required — cloud-init handles everything.
 */

import type { ProviderAdapter, Machine } from "./types.js";
import { env } from "../env.js";

const API = "https://api.hetzner.cloud/v1";

async function hetznerFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.HETZNER_API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hetzner API ${options.method || "GET"} ${path} failed (${res.status}): ${body}`);
  }

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

function toMachine(server: any): Machine {
  return {
    id: String(server.id),
    name: server.name,
    state: server.status || "unknown",
    ip: server.public_net?.ipv4?.ip || "",
    region: server.datacenter?.location?.name || env.HETZNER_LOCATION,
    created_at: server.created,
  };
}

export class HetznerProvider implements ProviderAdapter {
  name = "hetzner";

  async createMachine(opts: {
    name: string;
    cloudInit: string;
    labels?: Record<string, string>;
  }): Promise<Machine> {
    const payload: Record<string, unknown> = {
      name: opts.name,
      server_type: env.HETZNER_SERVER_TYPE,
      location: env.HETZNER_LOCATION,
      image: "ubuntu-24.04",
      start_after_create: true,
      user_data: opts.cloudInit,
      labels: {
        managed_by: "botboot",
        ...opts.labels,
      },
    };

    if (env.HETZNER_SSH_KEY_ID) {
      payload.ssh_keys = [parseInt(env.HETZNER_SSH_KEY_ID)];
    }

    if (env.HETZNER_FIREWALL_ID) {
      payload.firewalls = [{ firewall: parseInt(env.HETZNER_FIREWALL_ID) }];
    }

    const result = await hetznerFetch<{ server: any }>("/servers", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    return toMachine(result.server);
  }

  async getMachine(machineId: string): Promise<Machine> {
    const { server } = await hetznerFetch<{ server: any }>(`/servers/${machineId}`);
    return toMachine(server);
  }

  async listMachines(): Promise<Machine[]> {
    const { servers } = await hetznerFetch<{ servers: any[] }>(
      "/servers?label_selector=managed_by=botboot&per_page=50"
    );
    return servers.map(toMachine);
  }

  async startMachine(machineId: string): Promise<void> {
    const { action } = await hetznerFetch<{ action: { id: number } }>(
      `/servers/${machineId}/actions/poweron`,
      { method: "POST" }
    );
    await this.waitForAction(action.id);
  }

  async stopMachine(machineId: string): Promise<void> {
    const { action } = await hetznerFetch<{ action: { id: number } }>(
      `/servers/${machineId}/actions/shutdown`,
      { method: "POST" }
    );
    await this.waitForAction(action.id, 60_000);
  }

  async deleteMachine(machineId: string): Promise<void> {
    await hetznerFetch(`/servers/${machineId}`, { method: "DELETE" });
  }

  private async waitForAction(actionId: number, timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { action } = await hetznerFetch<{ action: { status: string } }>(`/actions/${actionId}`);
      if (action.status === "success") return;
      if (action.status === "error") throw new Error(`Hetzner action ${actionId} failed`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Hetzner action ${actionId} timed out`);
  }
}
