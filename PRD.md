# BotBoot — Product Requirements Document

**Version:** 0.1.0
**Date:** 2026-03-31
**Author:** Brain&Bot (Mohammed + McClowin)

---

## 1. What Is BotBoot?

An open-source API platform for deploying and managing isolated AI agent instances at scale. Developers use BotBoot to give each of their users a dedicated, persistent AI agent — without building custom infrastructure.

**One-liner:** Railway for AI agents.

**Key insight:** Agent frameworks (OpenClaw, Hermes, CrewAI) help you *build* agents. Cloud platforms (Railway, Fly.io) help you *host* apps. Nobody helps you *deploy isolated agents for your users via API*. BotBoot does.

## 2. Target Users

### Primary: Agent SaaS Developers
Developers building products that give each end-user their own AI agent (marketing bot, support agent, research assistant). They need:
- API to provision 100s-1000s of agents programmatically
- Per-agent isolation (each user's data stays separate)
- Per-agent LLM usage tracking and billing
- Secret management across their fleet
- File API to update agent identity/behavior remotely

### Secondary: Self-Hosters
Developers/hobbyists who want to manage a handful of agents on their own Hetzner/VPS without a SaaS dependency. They need:
- `docker compose up` simplicity
- No vendor lock-in
- Full control over infra and keys

### Tertiary: Agent Framework Creators
Creators of new agent frameworks who want a deployment target. They implement a runtime adapter and their agents become deployable via BotBoot.

## 3. Architecture

### Core Separation: Providers × Runtimes

```
┌─────────────────────────────┐
│       BotBoot API           │
│       (Hono + TypeScript)   │
├──────────┬──────────────────┤
│ Providers│ Runtimes         │
│ (WHERE)  │ (WHAT)           │
│          │                  │
│ Hetzner  │ OpenClaw         │
│ Docker   │ Hermes Agent     │
│ Phala TEE│ (bring your own) │
└──────────┴──────────────────┘
```

**Providers** know how to create/manage machines. They don't know what agents are.
**Runtimes** know how to install/configure agent frameworks. They don't know about infrastructure.
**BotBoot** orchestrates both: picks a provider, picks a runtime, generates a cloud-init script, provisions the machine, injects identity files + secrets.

### Three-Layer Config Model

```
Layer 1: Platform Secrets (owned by platform operator)
  → LLM API keys, tool API keys
  → Shared across ALL agents
  → Stored in backend env vars

Layer 2: Account Secrets (owned by developer)
  → Developer's own API keys
  → Shared across their agents
  → Stored encrypted in DB (AES-256-GCM)

Layer 3: Agent Config (per agent)
  → Identity files (SOUL.md, USER.md, AGENTS.md)
  → Agent-specific secret overrides
  → Channel config (Telegram bot token, etc.)
  → Stored encrypted in DB + injected via SSH
```

Resolution: Agent → Account → Platform (first non-null wins).

### No Custom Images

All provisioning is from **stock Ubuntu 24.04** via cloud-init. No snapshots to maintain, no images to build. The cloud-init script:
1. Installs the runtime (Node.js/npm for OpenClaw, Python/uv for Hermes)
2. Writes config files
3. Injects secrets to `/etc/botboot/secrets.env`
4. Writes identity files (SOUL.md, etc.)
5. Creates systemd service
6. Starts the agent gateway

Provision time: ~3-4 minutes from stock Ubuntu.

## 4. API Surface

### Auth
All requests require `Authorization: Bearer bb_<key>`.

```
POST   /v1/auth/api-keys          → Generate API key (creates account)
GET    /v1/auth/api-keys          → List keys (prefix only, never values)
DELETE /v1/auth/api-keys/:id      → Revoke key
```

### Agents
```
POST   /v1/agents                 → Create agent (provision machine)
GET    /v1/agents                 → List agents + live status
GET    /v1/agents/:id             → Get agent details + live status
DELETE /v1/agents/:id             → Backup + delete agent
POST   /v1/agents/:id/start      → Power on
POST   /v1/agents/:id/stop       → Shutdown
POST   /v1/agents/:id/update     → Update runtime (git pull + restart)
POST   /v1/agents/:id/backup     → Create backup tarball
GET    /v1/agents/:id/runtime     → Runtime version + gateway status
GET    /v1/agents/:id/boot-status → Poll provisioning progress (0-100%)
```

### Files
```
GET    /v1/agents/:id/files/*     → Read workspace file
PUT    /v1/agents/:id/files/*     → Write workspace file
```

### Secrets
```
PUT    /v1/secrets                → Set account-level secrets
GET    /v1/secrets                → List secret names (never values)
DELETE /v1/secrets/:key           → Remove secret
PUT    /v1/agents/:id/secrets     → Set agent-level overrides
GET    /v1/agents/:id/secrets     → List agent secrets + inherited
```

### Usage (planned)
```
GET    /v1/agents/:id/usage       → LLM token usage for this agent
GET    /v1/usage                  → Aggregate usage across all agents
GET    /v1/usage/daily            → Daily breakdown
```

## 5. Database Schema

4 tables:
- **accounts** — email, created_at
- **api_keys** — account_id, key_hash (SHA-256), name, prefix
- **agents** — account_id, name, runtime, provider, server_id, ip, state, config (JSONB)
- **account_secrets** — account_id, key_name, encrypted (AES-256-GCM), agent_id (nullable for account-level)

Planned:
- **usage_logs** — agent_id, date, input_tokens, output_tokens, cost_usd, model, provider

## 6. Supported Runtimes

| Runtime | Status | Language | Config Format |
|---------|--------|----------|--------------|
| OpenClaw | ✅ Supported | Node.js | `openclaw.json` + auth-profiles.json |
| Hermes Agent | 🚧 In Progress | Python | `config.yaml` + `.env` |

### Adding a Runtime

Implement the `RuntimeAdapter` interface:
```typescript
interface RuntimeAdapter {
  name: string;
  installCommands(): string[];
  setupUserCommands(): string[];
  writeConfigCommands(config, secrets): string[];
  writeFileCommands(files): string[];
  systemdUnit(): string;
  statusCommand(): string;
  versionCommand(): string;
  workspacePath(): string;
  configPath(): string;
}
```

## 7. Supported Providers

| Provider | Status | Cost/Agent | Isolation |
|----------|--------|-----------|-----------|
| Hetzner Cloud | ✅ Supported | ~€4.49/mo (CX23) | Full VM |
| Docker (local) | 🚧 Planned | Free | Container |
| Phala TEE | 🚧 Planned | Variable | Hardware enclave |

### Adding a Provider

Implement the `ProviderAdapter` interface:
```typescript
interface ProviderAdapter {
  name: string;
  createMachine(opts): Promise<Machine>;
  getMachine(id): Promise<Machine>;
  listMachines(): Promise<Machine[]>;
  startMachine(id): Promise<void>;
  stopMachine(id): Promise<void>;
  deleteMachine(id): Promise<void>;
}
```

## 8. LLM Usage Tracking

### The Problem
Developers deploying 100s of agents need to know:
- How much each agent costs them in LLM tokens
- Which agents are most/least active
- Daily/weekly/monthly spend per agent and aggregate
- Which model each agent is using

### Approach: Agent-Side Reporting

Each agent runtime already tracks its own token usage internally:
- **OpenClaw**: `session_status` shows per-session token counts + cost estimates
- **Hermes**: `/usage` and `/insights` commands show token consumption

BotBoot needs to **pull this data periodically** and aggregate it.

### Implementation Plan

**Phase 1: SSH-based polling (MVP)**
- Cron job polls each running agent via SSH
- OpenClaw: `cat ~/.openclaw/agents/main/usage.json` or query gateway API
- Hermes: `hermes usage --json` or read SQLite session DB
- Store in `usage_logs` table
- Expose via `GET /v1/agents/:id/usage`

**Phase 2: Agent-side reporting (better)**
- Agent pushes usage data to BotBoot callback URL
- BotBoot exposes `POST /v1/agents/:id/usage/report` (authenticated via agent's gateway token)
- Near-real-time usage data
- Requires adding a heartbeat/webhook skill to agent templates

**Phase 3: LLM proxy (most control)**
- BotBoot runs an LLM proxy that agents route through
- Full visibility into every API call: tokens, latency, model, cost
- Can enforce rate limits, budgets, model restrictions per agent
- Highest control but adds latency and complexity

### Usage API (planned)

```
GET /v1/agents/:id/usage
→ {
    "agent_id": "uuid",
    "period": "2026-03",
    "total_input_tokens": 1250000,
    "total_output_tokens": 430000,
    "estimated_cost_usd": 12.45,
    "by_model": {
      "claude-sonnet-4": { "input": 1200000, "output": 400000, "cost": 11.20 },
      "claude-haiku-3": { "input": 50000, "output": 30000, "cost": 1.25 }
    },
    "daily": [
      { "date": "2026-03-30", "input": 45000, "output": 18000, "cost": 0.42 },
      ...
    ]
  }

GET /v1/usage
→ {
    "period": "2026-03",
    "total_agents": 47,
    "active_agents": 32,
    "total_cost_usd": 487.30,
    "by_agent": [ ... ]
  }
```

## 9. Roadmap

### Phase 1: Core Platform (NOW)
- [x] Project scaffold + repo
- [x] Runtime adapters (OpenClaw + Hermes)
- [x] Hetzner provider
- [x] Cloud-init builder (no snapshots)
- [x] 3-tier secret management
- [x] API key auth
- [x] DB layer (postgres.js)
- [x] Agent CRUD + lifecycle
- [x] File API (read/write workspace)
- [x] Unit + integration tests
- [ ] npm install + build verification
- [ ] Wire up secret resolution (Tier 2+3 from DB)
- [ ] E2E test: actually provision an agent on Hetzner
- [ ] Usage tracking (Phase 1: SSH polling)

### Phase 2: Developer Experience
- [ ] OpenAPI / Swagger docs
- [ ] TypeScript SDK (`@botboot/sdk`)
- [ ] Python SDK (`botboot`)
- [ ] CLI tool (`npx botboot`)
- [ ] Rate limiting
- [ ] Webhook callbacks (agent status changes)
- [ ] Usage-based billing (Stripe metered)

### Phase 3: Scale & Ops
- [ ] Docker provider (for local dev / cheap hosting)
- [ ] LLM proxy (full usage visibility)
- [ ] Agent-to-agent communication
- [ ] Custom domain per agent
- [ ] Multi-region support
- [ ] Phala TEE provider
- [ ] Web dashboard (admin console)

### Phase 4: Ecosystem
- [ ] Agent template marketplace
- [ ] Community runtime adapters
- [ ] Plugin system for custom providers
- [ ] Federation (connect multiple BotBoot instances)

## 10. Competitive Landscape

| Competitor | Type | Pricing | Differentiator |
|-----------|------|---------|---------------|
| **Volra** | OSS, Docker/K8s agents | Free (self-host) | Framework-agnostic, agent mesh, Go CLI |
| **AgentStation** | Closed SaaS | Unknown (funded) | Browser-based agents, managed |
| **SpawnClaw** | OSS, Docker | Free | Wallet auth, crypto-native |
| **HostKit** | OSS, MCP-based | Free | Agent manages VPS (inverse model) |
| **LangGraph Platform** | Managed | $39/user/mo + usage | LangGraph-only, serverless |
| **CrewAI Enterprise** | Managed | $25/mo + executions | CrewAI-only, workflow-oriented |
| **Ampere.sh** | Managed | Unknown | OpenClaw-specific hosting |

### BotBoot's Differentiators
1. **Full VM isolation** — not containers, real VMs per agent
2. **Framework-agnostic** — OpenClaw, Hermes, add your own
3. **Built-in messaging** — Telegram, WhatsApp, Discord out of the box
4. **3-tier secrets** — Platform/Account/Agent key cascade
5. **File-based identity** — SOUL.md, not JSON config blobs
6. **Self-hostable** — `docker compose up`, no vendor dependency
7. **Open source** — MIT license

## 11. Business Model

### Open Source (self-hosted)
- Free forever
- Community support
- Full feature parity

### Managed Cloud (future: botboot.dev or clawster.run)
- Hosted API — no infra to manage
- Usage-based pricing per agent/month
- LLM proxy with usage dashboards
- Priority support
- SLA

### First Customer: Tevy2.ai
Tevy2 is a marketing concierge product built by Brain&Bot. It uses BotBoot as infrastructure:
- Tevy2 is an **account** on BotBoot
- Tevy2 provides marketing agent templates (SOUL.md, skills)
- Tevy2 provides master API keys (Anthropic, Tavily)
- Tevy2's dashboard calls BotBoot API to manage customer agents

This proves the platform works before opening to external developers.

---

*Last updated: 2026-03-31 by McClowin 🤖⚡*
