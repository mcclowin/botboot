/**
 * Hermes Agent runtime adapter.
 *
 * Installs Hermes via uv + git clone, configures via config.yaml + .env,
 * manages via systemd service.
 *
 * Key paths (from Hermes docs):
 *   ~/.hermes/config.yaml       — main config (model, terminal, memory settings)
 *   ~/.hermes/.env              — API keys + bot tokens
 *   ~/.hermes/SOUL.md           — agent identity (slot #1 in system prompt)
 *   ~/.hermes/memories/MEMORY.md — agent's personal notes (2200 char limit)
 *   ~/.hermes/memories/USER.md   — user profile (1375 char limit)
 *   ~/.hermes/skills/           — installed skills (agentskills.io compatible)
 *   ~/.hermes/state.db          — SQLite session DB (usage tracking lives here)
 *   ~/.hermes/sessions/         — gateway sessions
 *   ~/.hermes/cron/             — scheduled jobs
 *   ~/.hermes/logs/             — error + gateway logs (secrets auto-redacted)
 */

import type { RuntimeAdapter, AgentConfig } from "./types.js";

export class HermesRuntime implements RuntimeAdapter {
  name = "hermes";

  installCommands(): string[] {
    return [
      "# Install system deps",
      "apt-get install -y python3 python3-pip python3-venv git ffmpeg ripgrep",
      "",
      "# Install Node.js 22 (needed for browser tools + WhatsApp bridge)",
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
      "apt-get install -y nodejs",
      "",
      "# Clone Hermes Agent",
      "git clone --recurse-submodules https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent",
      "cd /opt/hermes-agent",
      "",
      "# Create service-user-safe venv with system Python (avoid /root/.local uv interpreter paths)",
      "python3 -m venv /opt/hermes-agent/venv",
      "/opt/hermes-agent/venv/bin/pip install --upgrade pip setuptools wheel",
      '/opt/hermes-agent/venv/bin/pip install -e ".[all]"',
      "",
      "# Install Node deps (browser automation + WhatsApp)",
      "npm install 2>/dev/null || true",
      "",
      "# Make hermes accessible to all users",
      "chmod -R a+rX /opt/hermes-agent",
      "chmod a+rx /opt/hermes-agent/venv/bin/hermes",
      "chmod a+rx /opt/hermes-agent/venv/bin/python3",
      "mkdir -p /usr/local/bin",
      "ln -sf /opt/hermes-agent/venv/bin/hermes /usr/local/bin/hermes",
      "/usr/local/bin/hermes version || echo 'hermes installed (version check may need config)'",
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
      "# Create Hermes directory structure",
      "su - agent -c 'mkdir -p ~/.hermes/{cron,sessions,logs,memories,skills,pairing,hooks,image_cache,audio_cache,whatsapp/session}'",
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
      "# If provided, write Hermes-native auth store for Codex/OpenAI flow",
      ...((secrets.OPENAI_AUTH_JSON ? (() => {
        const raw = JSON.parse(secrets.OPENAI_AUTH_JSON) as any;
        const authJson = JSON.stringify({
          version: 1,
          providers: {
            "openai-codex": {
              tokens: {
                access_token: raw?.tokens?.access_token || raw?.access_token,
                refresh_token: raw?.tokens?.refresh_token || raw?.refresh_token,
              },
              last_refresh: raw?.last_refresh || new Date().toISOString(),
              auth_mode: raw?.auth_mode || "chatgpt",
            },
          },
          active_provider: "openai-codex",
          updated_at: new Date().toISOString(),
          credential_pool: {
            "openai-codex": [
              {
                id: "botboot",
                label: "botboot_import",
                auth_type: "oauth",
                priority: 0,
                source: "botboot_import",
                access_token: raw?.tokens?.access_token || raw?.access_token,
                refresh_token: raw?.tokens?.refresh_token || raw?.refresh_token,
                last_status: null,
                last_status_at: null,
                last_error_code: null,
                base_url: "https://chatgpt.com/backend-api/codex",
                last_refresh: raw?.last_refresh || new Date().toISOString(),
                request_count: 0,
              },
            ],
          },
        }, null, 2);
        return [
          "mkdir -p /home/agent/.hermes",
          `cat > /home/agent/.hermes/auth.json << 'HERMESAUTH'\n${authJson}\nHERMESAUTH`,
          "chown agent:agent /home/agent/.hermes/auth.json",
          "chmod 600 /home/agent/.hermes/auth.json",
        ];
      })() : [])),
      "",
      "# Write platform secrets for tool env vars",
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
    return "/home/agent";
  }

  configPath(): string {
    return "/home/agent/.hermes";
  }

  /**
   * Map standard BotBoot file paths to Hermes-specific locations.
   *
   * Hermes file layout (from docs):
   *   SOUL.md       → ~/.hermes/SOUL.md (identity, slot #1 in system prompt)
   *   USER.md       → ~/.hermes/memories/USER.md (user profile, 1375 char limit)
   *   MEMORY.md     → ~/.hermes/memories/MEMORY.md (agent notes, 2200 char limit)
   *   AGENTS.md     → ~/AGENTS.md (working directory context file)
   *   WORKFLOWS.md  → ~/WORKFLOWS.md (working directory context file)
   *   TOOLS.md      → ~/TOOLS.md (working directory context file)
   *   memory/*      → ~/.hermes/memories/* (persistent memory files)
   *   skills/*      → ~/.hermes/skills/* (skill definitions)
   *   Everything else → ~/  (agent home = working directory)
   */
  private resolveFilePath(path: string): string {
    if (path === "SOUL.md") return "/home/agent/.hermes/SOUL.md";
    if (path === "USER.md") return "/home/agent/.hermes/memories/USER.md";
    if (path === "MEMORY.md") return "/home/agent/.hermes/memories/MEMORY.md";
    if (path.startsWith("memory/")) return `/home/agent/.hermes/memories/${path.slice(7)}`;
    if (path.startsWith("skills/")) return `/home/agent/.hermes/skills/${path.slice(7)}`;
    // Context files (AGENTS.md, WORKFLOWS.md, etc.) go in CWD = home
    return `/home/agent/${path}`;
  }

  private buildConfigYaml(config: AgentConfig): string {
    const model = config.model || "anthropic/claude-sonnet-4";
    const isCodexStyle = model.startsWith("openai-codex/") || model.startsWith("gpt-5") || model.startsWith("gpt-4.1") || model.startsWith("o1") || model.startsWith("o3");
    const defaultModel = model.startsWith("openai-codex/") ? model.replace(/^openai-codex\//, "") : model;

    // Match the working manual Hermes setup exactly for Codex/ChatGPT auth.
    const modelBlock = isCodexStyle
      ? `model:\n  provider: \"openai-codex\"\n  base_url: \"https://chatgpt.com/backend-api/codex\"\n  default: \"${defaultModel}\"\n`
      : `model:\n  default: \"${defaultModel}\"\n${((model.startsWith("anthropic/") || model.startsWith("claude") || model.startsWith("google/") || model.startsWith("gemini")) ? '  provider: "openrouter"\n' : '')}`;

    return `# BotBoot — Hermes Agent Config
# Generated at provisioning time. Edit via BotBoot API or SSH.

${modelBlock}
terminal:
  backend: local
  timeout: 180
  persistent_shell: false

memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375

display:
  tool_progress: all
  background_process_notifications: result

# Gateway session reset: idle after 24 hours
gateway:
  session_reset:
    mode: idle
    idle_minutes: 1440
`;
  }

  private buildEnvFile(config: AgentConfig, secrets: Record<string, string>): string {
    const lines: string[] = [
      "# BotBoot — Hermes Agent Secrets",
      "# Generated at provisioning time. Managed via BotBoot API.",
    ];

    // LLM provider keys
    if (secrets.ANTHROPIC_API_KEY) lines.push(`ANTHROPIC_API_KEY=${secrets.ANTHROPIC_API_KEY}`);
    if (secrets.OPENROUTER_API_KEY) lines.push(`OPENROUTER_API_KEY=${secrets.OPENROUTER_API_KEY}`);

    // Codex / ChatGPT OAuth-style auth.
    // Keep raw JSON available in env for tooling, and also point Hermes inference toward openai-codex.
    if (secrets.OPENAI_AUTH_JSON) {
      lines.push(`OPENAI_AUTH_JSON=${secrets.OPENAI_AUTH_JSON}`);
      lines.push("HERMES_INFERENCE_PROVIDER=openai-codex");
      lines.push("OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex");
    }

    // Messaging
    if (config.telegramBotToken) {
      lines.push(`TELEGRAM_BOT_TOKEN=${config.telegramBotToken}`);
      lines.push("GATEWAY_ALLOW_ALL_USERS=true");
    }

    // Tool keys
    if (secrets.TAVILY_API_KEY) lines.push(`TAVILY_API_KEY=${secrets.TAVILY_API_KEY}`);
    if (secrets.FIRECRAWL_API_KEY) lines.push(`FIRECRAWL_API_KEY=${secrets.FIRECRAWL_API_KEY}`);
    if (secrets.FAL_KEY) lines.push(`FAL_KEY=${secrets.FAL_KEY}`);
    if (secrets.BROWSERBASE_API_KEY) lines.push(`BROWSERBASE_API_KEY=${secrets.BROWSERBASE_API_KEY}`);

    return lines.join("\n") + "\n";
  }
}
