/**
 * OpenClaw runtime adapter.
 *
 * Installs OpenClaw via npm, configures via openclaw.json,
 * manages via systemd service.
 */

import { randomUUID } from "node:crypto";
import type { RuntimeAdapter, AgentConfig } from "./types.js";

export class OpenClawRuntime implements RuntimeAdapter {
  name = "openclaw";

  installCommands(): string[] {
    return [
      "# Install Node.js 22",
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
      "apt-get install -y nodejs",
      "",
      "# Install OpenClaw",
      "npm install -g openclaw",
      "",
      "# Verify binary integrity (npm install quirk)",
      'BINARY_SIZE=$(wc -c < /usr/lib/node_modules/openclaw/openclaw.mjs 2>/dev/null || echo 0)',
      'if [ "$BINARY_SIZE" -lt 100 ]; then',
      '  echo "Reinstalling openclaw (binary was $BINARY_SIZE bytes)..."',
      "  npm install -g openclaw",
      "fi",
      "openclaw --version",
    ];
  }

  setupUserCommands(): string[] {
    return [
      "# Create agent user",
      "id agent &>/dev/null || useradd -m -s /bin/bash agent",
      "",
      "# Sudo permissions for gateway management",
      "cat > /etc/sudoers.d/agent-gateway << 'SUDOERS'",
      "agent ALL=(ALL) NOPASSWD: /bin/systemctl restart botboot-agent, /bin/systemctl stop botboot-agent, /bin/systemctl start botboot-agent, /bin/systemctl status botboot-agent, /usr/bin/systemctl restart botboot-agent, /usr/bin/systemctl stop botboot-agent, /usr/bin/systemctl start botboot-agent, /usr/bin/systemctl status botboot-agent, /bin/journalctl *, /usr/bin/journalctl *",
      "SUDOERS",
      "chmod 440 /etc/sudoers.d/agent-gateway",
      "",
      "# Create directories",
      "su - agent -c 'mkdir -p ~/.openclaw/workspace/memory ~/.openclaw/workspace/skills ~/.openclaw/agents/main/agent'",
    ];
  }

  writeConfigCommands(config: AgentConfig, secrets: Record<string, string>): string[] {
    const openclawJson = this.buildConfig(config);
    const openclawB64 = Buffer.from(JSON.stringify(openclawJson, null, 2)).toString("base64");

    const authProfiles = JSON.stringify({
      version: 1,
      profiles: {
        ...(secrets.ANTHROPIC_API_KEY ? {
          "anthropic:default": {
            type: "token",
            provider: "anthropic",
            token: secrets.ANTHROPIC_API_KEY,
          },
        } : {}),
        ...(secrets.OPENROUTER_API_KEY ? {
          "openrouter:default": {
            type: "token",
            provider: "openrouter",
            token: secrets.OPENROUTER_API_KEY,
          },
        } : {}),
        ...(secrets.OPENAI_AUTH_JSON ? {
          "openai:default": JSON.parse(secrets.OPENAI_AUTH_JSON),
        } : {}),
      },
      lastGood: secrets.ANTHROPIC_API_KEY
        ? { anthropic: "anthropic:default" }
        : secrets.OPENROUTER_API_KEY
          ? { openrouter: "openrouter:default" }
          : secrets.OPENAI_AUTH_JSON
            ? { openai: "openai:default" }
            : {},
    });
    const authB64 = Buffer.from(authProfiles).toString("base64");

    return [
      "# Write openclaw.json",
      `echo '${openclawB64}' | base64 -d > /home/agent/.openclaw/openclaw.json`,
      "chmod 600 /home/agent/.openclaw/openclaw.json",
      "",
      "# Write auth profiles (API keys)",
      `echo '${authB64}' | base64 -d > /home/agent/.openclaw/agents/main/agent/auth-profiles.json`,
      "chmod 600 /home/agent/.openclaw/agents/main/agent/auth-profiles.json",
      "",
      "# Write platform secrets for tools",
      "cat > /etc/botboot/secrets.env << 'SECRETS'",
      ...Object.entries(secrets)
        .filter(([k]) => !["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"].includes(k))
        .map(([k, v]) => `${k}=${v}`),
      "SECRETS",
      "chmod 600 /etc/botboot/secrets.env",
    ];
  }

  writeFileCommands(files: Record<string, string>): string[] {
    const commands: string[] = ["# Write workspace files"];
    for (const [path, content] of Object.entries(files)) {
      const b64 = Buffer.from(content).toString("base64");
      const fullPath = `/home/agent/.openclaw/workspace/${path}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      commands.push(`mkdir -p ${JSON.stringify(dir)}`);
      commands.push(`echo '${b64}' | base64 -d > ${JSON.stringify(fullPath)}`);
    }
    commands.push("", "chown -R agent:agent /home/agent/.openclaw/");
    return commands;
  }

  systemdUnit(): string {
    return `[Unit]
Description=BotBoot Agent (OpenClaw)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/home/agent
ExecStart=/usr/bin/openclaw gateway run
Restart=on-failure
RestartSec=10
Environment=NODE_OPTIONS=--max-old-space-size=1536
EnvironmentFile=-/etc/botboot/secrets.env
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target`;
  }

  statusCommand(): string {
    return "systemctl is-active botboot-agent 2>/dev/null || echo unknown";
  }

  versionCommand(): string {
    return "openclaw --version 2>/dev/null || echo unknown";
  }

  workspacePath(): string {
    return "/home/agent/.openclaw/workspace";
  }

  configPath(): string {
    return "/home/agent/.openclaw";
  }

  private buildConfig(config: AgentConfig): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      auth: {
        profiles: {
          "anthropic:default": { provider: "anthropic", mode: "token" },
          "openrouter:default": { provider: "openrouter", mode: "token" },
          "openai:default": { provider: "openai", mode: "auth-json" },
        },
      },
      agents: {
        defaults: {
          workspace: this.workspacePath(),
          maxConcurrent: 4,
        },
      },
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: {
          mode: "token",
          token: randomUUID().replace(/-/g, ""),
        },
      },
      plugins: {
        entries: {} as Record<string, { enabled: boolean }>,
      },
    };

    // Telegram
    if (config.telegramBotToken) {
      (cfg as any).channels = {
        telegram: {
          enabled: true,
          botToken: config.telegramBotToken,
          streaming: true,
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      };
      ((cfg as any).plugins.entries).telegram = { enabled: true };
    }

    return cfg;
  }
}
