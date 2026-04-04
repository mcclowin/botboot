import { db } from './db.js';
import { pollAndStoreAgentUsage } from './usage.js';

export type UsagePollerStatus = {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunDurationMs: number | null;
  lastRunSummary: {
    agentsSeen: number;
    agentsPolled: number;
    successCount: number;
    errorCount: number;
  } | null;
  lastError: string | null;
};

const state: UsagePollerStatus = {
  enabled: false,
  intervalMinutes: 0,
  running: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastRunDurationMs: null,
  lastRunSummary: null,
  lastError: null,
};

let timer: NodeJS.Timeout | null = null;

export function getUsagePollerStatus(): UsagePollerStatus {
  return { ...state, lastRunSummary: state.lastRunSummary ? { ...state.lastRunSummary } : null };
}

export async function runUsagePollCycle(): Promise<UsagePollerStatus> {
  if (state.running) return getUsagePollerStatus();

  state.running = true;
  state.lastRunStartedAt = new Date().toISOString();
  state.lastError = null;
  const started = Date.now();

  try {
    const agents = await db.listAllActiveAgents();
    let successCount = 0;
    let errorCount = 0;
    let agentsPolled = 0;

    for (const agent of agents) {
      try {
        const result = await pollAndStoreAgentUsage(agent);
        agentsPolled += result.count > 0 ? 1 : 1;
        successCount += 1;
      } catch (err) {
        errorCount += 1;
        console.warn('[usage-poller] poll failed', {
          agentId: agent.id,
          name: agent.name,
          runtime: agent.runtime,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    state.lastRunSummary = {
      agentsSeen: agents.length,
      agentsPolled,
      successCount,
      errorCount,
    };
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error('[usage-poller] cycle failed', err);
  } finally {
    state.running = false;
    state.lastRunFinishedAt = new Date().toISOString();
    state.lastRunDurationMs = Date.now() - started;
  }

  return getUsagePollerStatus();
}

export function startUsagePoller(config: { enabled: boolean; intervalMinutes: number; startupDelayMs?: number }) {
  state.enabled = config.enabled;
  state.intervalMinutes = config.intervalMinutes;

  if (!config.enabled) {
    console.log('[usage-poller] disabled');
    return;
  }

  const intervalMs = Math.max(1, config.intervalMinutes) * 60_000;
  const startupDelayMs = Math.max(0, config.startupDelayMs || 0);

  const kick = () => {
    void runUsagePollCycle();
    timer = setInterval(() => {
      void runUsagePollCycle();
    }, intervalMs);
  };

  if (startupDelayMs > 0) {
    setTimeout(kick, startupDelayMs);
  } else {
    kick();
  }

  console.log(`[usage-poller] enabled: every ${Math.max(1, config.intervalMinutes)} minute(s)`);
}

export function stopUsagePoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
