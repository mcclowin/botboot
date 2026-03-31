/**
 * Cloud-init script builder.
 *
 * Generates a complete provisioning script from:
 * - Runtime adapter (install commands, config, systemd)
 * - Agent config (model, channels, etc)
 * - Secrets (API keys, cascaded)
 * - Identity files (SOUL.md, AGENTS.md, etc)
 *
 * No custom images needed — works from stock Ubuntu 24.04.
 */

import type { RuntimeAdapter, AgentConfig } from "../runtimes/types.js";

export interface CloudInitOpts {
  runtime: RuntimeAdapter;
  config: AgentConfig;
  secrets: Record<string, string>;
  files: Record<string, string>;
}

export function buildCloudInit(opts: CloudInitOpts): string {
  const { runtime, config, secrets, files } = opts;

  const sections = [
    "#!/bin/bash",
    "set -euo pipefail",
    "exec > /var/log/botboot-provision.log 2>&1",
    "",
    `echo "=== BotBoot provisioning (${runtime.name}) ==="`,
    `echo "Started: $(date -u)"`,
    "",
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    "# ── System packages ──────────────────────────────────────",
    "apt-get update -y",
    "apt-get install -y curl git jq unzip wget ca-certificates gnupg",
    "",
    "# ── Install runtime ─────────────────────────────────────",
    ...runtime.installCommands(),
    "",
    "# ── Setup user ──────────────────────────────────────────",
    ...runtime.setupUserCommands(),
    "",
    "# ── Secrets directory ────────────────────────────────────",
    "mkdir -p /etc/botboot",
    "chmod 700 /etc/botboot",
    "",
    "# ── Write config ────────────────────────────────────────",
    ...runtime.writeConfigCommands(config, secrets),
    "",
    "# ── SSH management access (early, so polling works) ────",
    "if [ -f /root/.ssh/authorized_keys ]; then",
    '  su - agent -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh"',
    "  cp /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys",
    "  chown agent:agent /home/agent/.ssh/authorized_keys",
    "  chmod 600 /home/agent/.ssh/authorized_keys",
    "fi",
    "",
    "# ── Write identity files ────────────────────────────────",
    ...runtime.writeFileCommands(files),
    "",
    "# ── Systemd service ─────────────────────────────────────",
    "cat > /etc/systemd/system/botboot-agent.service << 'SYSTEMD'",
    runtime.systemdUnit(),
    "SYSTEMD",
    "",
    "systemctl daemon-reload",
    "systemctl enable botboot-agent",
    "systemctl start botboot-agent",
    "",
    "# Wait for gateway (max 90s)",
    "for i in $(seq 1 18); do",
    "  if systemctl is-active botboot-agent >/dev/null 2>&1; then",
    '    echo "Gateway active after ~$((i * 5))s"',
    "    break",
    "  fi",
    "  sleep 5",
    "done",
    "",
    `echo "=== Provisioning complete: $(date -u) ==="`,
  ];

  return sections.join("\n");
}
