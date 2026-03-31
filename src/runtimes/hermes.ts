/**
 * Hermes Agent runtime adapter.
 *
 * Installs Hermes via uv + git clone, configures via config.yaml + .env,
 * manages via systemd service.
 */

import type { RuntimeAdapter, AgentConfig } from "./types.js";

export class HermesRuntime implements RuntimeAdapter {
  name = "hermes";

  installCommands(): string[] {
    return [
      "# Install uv (Python package manager)",
      "curl -LsSf https://astral.sh/uv/install.sh | bash",
      'export PATH="$HOME/.local/bin:$PATH"',
      "",
      "# Install Node.js 22 (needed for browser tools + WhatsApp)",
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
      "apt-get install -y nodejs",
      "",
      "# Clone Hermes Agent",
      "git clone --recurse-submodules https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent",
      "cd /opt/hermes-agent",
      "",
      "# Create venv and install",
      "uv venv venv --python 3.11",
      'export VIRTUAL_ENV="/opt/hermes-agent/venv"',
      'uv pip install -e ".[all]"',
      "",
      "# Install Node deps (browser + WhatsApp)",
      "npm install",
      "",
      "# Symlink hermes to PATH",
      "ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes",
      "hermes version || true",
    ];
  }

  setupUserCommands(): string[] {
    return [
      "# Create agent user",
      "id agent &>/dev/null || useradd -m -s /bin/bash agent",
      "",
      "# Sudo permissions",
      "cat > /etc/sudoers.d/agent-gateway << 'SUDOERS'",
      "agent ALL=(ALL) NOPASSWD: /bin/systemctl restart botboot-agent, /bin/systemctl stop botboot-agent, /bin/systemctl start botboot-agent, /bin/systemctl status botboot-agent, /usr/bin/systemctl restart botboot-agent, /usr/bin/systemctl stop botboot-agent, /usr/bin/systemctl start botboot-agent, /usr/bin/systemctl status botboot-agent, /bin/journalctl *, /usr/bin/journalctl *",
      "SUDOERS",
      "chmod 440 /etc/sudoers.d/agent-gateway",
      "",
      "# Create Hermes directories",
      "su - agent -c 'mkdir -p ~/.hermes/{cron,sessions,logs,memories,skills,pairing,hooks,image_cache,audio_cache}'",
    ];
  }

  writeConfigCommands(config: AgentConfig, secrets: Record<string, string>): string[] {
    const configYaml = this.buildConfigYaml(config);
    const configB64 = Buffer.from(configYaml).toString("base64");

    const envFile = this.buildEnvFile(config, secrets);
    const envB64 = Buffer.from(envFile).toString("base64");

    return [
      "# Write config.yaml",
      `echo '${configB64}' | base64 -d > /home/agent/.hermes/config.yaml`,
      "chmod 600 /home/agent/.hermes/config.yaml",
      "",
      "# Write .env (API keys + bot tokens)",
      `echo '${envB64}' | base64 -d > /home/agent/.hermes/.env`,
      "chmod 600 /home/agent/.hermes/.env",
      "",
      "# Write platform secrets for tools",
      "mkdir -p /etc/botboot",
      "cat > /etc/botboot/secrets.env << 'SECRETS'",
      ...Object.entries(secrets)
        .filter(([k]) => !["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"].includes(k))
        .map(([k, v]) => `${k}=${v}`),
      "SECRETS",
      "chmod 600 /etc/botboot/secrets.env",
    ];
  }

  writeFileCommands(files: Record<string, string>): string[] {
    const commands: string[] = ["# Write identity files"];
    for (const [path, content] of Object.entries(files)) {
      const b64 = Buffer.from(content).toString("base64");
      // Map standard files to Hermes paths
      const fullPath = this.resolveFilePath(path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      commands.push(`mkdir -p ${JSON.stringify(dir)}`);
      commands.push(`echo '${b64}' | base64 -d > ${JSON.stringify(fullPath)}`);
    }
    commands.push("", "chown -R agent:agent /home/agent/.hermes/");
    return commands;
  }

  systemdUnit(): string {
    return `[Unit]
Description=BotBoot Agent (Hermes)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
Group=agent
WorkingDirectory=/home/agent
ExecStart=/usr/local/bin/hermes gateway
Restart=on-failure
RestartSec=10
EnvironmentFile=-/etc/botboot/secrets.env
EnvironmentFile=-/home/agent/.hermes/.env
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target`;
  }

  statusCommand(): string {
    return "systemctl is-active botboot-agent 2>/dev/null || echo unknown";
  }

  versionCommand(): string {
    return "hermes version 2>/dev/null || echo unknown";
  }

  workspacePath(): string {
    // Hermes uses CWD or ~ as workspace
    return "/home/agent";
  }

  configPath(): string {
    return "/home/agent/.hermes";
  }

  /**
   * Map standard file paths to Hermes-specific locations.
   * SOUL.md → ~/.hermes/SOUL.md
   * USER.md → ~/.hermes/memories/USER.md
   * AGENTS.md → stays in workspace
   * memory/* → ~/.hermes/memories/*
   */
  private resolveFilePath(path: string): string {
    if (path === "SOUL.md") return "/home/agent/.hermes/SOUL.md";
    if (path === "USER.md") return "/home/agent/.hermes/memories/USER.md";
    if (path === "MEMORY.md") return "/home/agent/.hermes/memories/MEMORY.md";
    if (path.startsWith("memory/")) return `/home/agent/.hermes/memories/${path.slice(7)}`;
    return `/home/agent/${path}`;
  }

  private buildConfigYaml(config: AgentConfig): string {
    const model = config.model || "anthropic/claude-sonnet-4";
    return `# BotBoot — Hermes Agent Config
model: "${model}"

terminal:
  backend: local
  timeout: 180

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375

display:
  tool_progress: all
`;
  }

  private buildEnvFile(config: AgentConfig, secrets: Record<string, string>): string {
    const lines: string[] = ["# BotBoot — Hermes Agent Secrets"];

    if (secrets.ANTHROPIC_API_KEY) {
      lines.push(`ANTHROPIC_API_KEY=${secrets.ANTHROPIC_API_KEY}`);
    }
    if (secrets.OPENROUTER_API_KEY) {
      lines.push(`OPENROUTER_API_KEY=${secrets.OPENROUTER_API_KEY}`);
    }
    if (config.telegramBotToken) {
      lines.push(`TELEGRAM_BOT_TOKEN=${config.telegramBotToken}`);
      lines.push("TELEGRAM_ALLOWED_USERS=*");
    }
    if (secrets.TAVILY_API_KEY) {
      lines.push(`TAVILY_API_KEY=${secrets.TAVILY_API_KEY}`);
    }
    if (secrets.FIRECRAWL_API_KEY) {
      lines.push(`FIRECRAWL_API_KEY=${secrets.FIRECRAWL_API_KEY}`);
    }

    return lines.join("\n") + "\n";
  }
}
