/**
 * Runtime interface — each agent framework implements this.
 *
 * A runtime knows how to install itself, write config,
 * inject identity files, and manage its gateway process.
 * It does NOT know about infrastructure (VPS, Docker, etc).
 */

export interface AgentConfig {
  name: string;
  model?: string;
  telegramBotToken?: string;
  channels?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

export interface RuntimeAdapter {
  /** Runtime identifier */
  name: string;

  /** Shell commands to install this runtime on a fresh Ubuntu box */
  installCommands(): string[];

  /** Create user and directories */
  setupUserCommands(): string[];

  /** Write the runtime config (e.g. openclaw.json, config.yaml) */
  writeConfigCommands(config: AgentConfig, secrets: Record<string, string>): string[];

  /** Write identity/workspace files (SOUL.md, AGENTS.md, etc) */
  writeFileCommands(files: Record<string, string>): string[];

  /** Systemd service file content */
  systemdUnit(): string;

  /** Command to check gateway status */
  statusCommand(): string;

  /** Command to get runtime version */
  versionCommand(): string;

  /** Base path for workspace files (used by file API) */
  workspacePath(): string;

  /** Base path for runtime config directory */
  configPath(): string;
}
