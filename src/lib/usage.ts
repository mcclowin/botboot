/**
 * Usage collection + aggregation.
 *
 * Phase 1: SSH poll each runtime's local usage store and upsert daily totals
 * into usage_logs.
 */

import * as ssh from "./ssh.js";
import { db, type Agent } from "./db.js";

export interface UsageRow {
  usage_date: string; // YYYY-MM-DD
  runtime: string;
  provider: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
}

export async function pollAgentUsage(agent: Agent): Promise<UsageRow[]> {
  if (!agent.ip) throw new Error("Agent has no IP");
  if (agent.runtime === "openclaw") return pollOpenClawUsage(agent.ip);
  if (agent.runtime === "hermes") return pollHermesUsage(agent.ip);
  throw new Error(`Unsupported runtime for usage polling: ${agent.runtime}`);
}

export async function storeAgentUsage(agentId: string, rows: UsageRow[]): Promise<void> {
  for (const row of rows) {
    await db.upsertUsageLog({ agent_id: agentId, ...row });
  }
}

export async function pollAndStoreAgentUsage(agent: Agent): Promise<{ rows: UsageRow[]; count: number }> {
  const rows = await pollAgentUsage(agent);
  await storeAgentUsage(agent.id, rows);
  return { rows, count: rows.length };
}

async function pollOpenClawUsage(ip: string): Promise<UsageRow[]> {
  const command = `python3 - <<'PY'
import json, glob, os
from collections import defaultdict

base = '/home/agent/.openclaw/agents/main/sessions'
files = glob.glob(os.path.join(base, '*.jsonl'))
agg = defaultdict(lambda: {
    'input_tokens': 0,
    'output_tokens': 0,
    'cache_read_tokens': 0,
    'cache_write_tokens': 0,
    'reasoning_tokens': 0,
    'total_tokens': 0,
    'estimated_cost_usd': 0.0,
})

for path in files:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                if row.get('type') != 'message':
                    continue
                msg = row.get('message') or {}
                if msg.get('role') != 'assistant':
                    continue
                usage = msg.get('usage') or {}
                if not usage:
                    continue
                ts = row.get('timestamp') or msg.get('timestamp')
                if not ts:
                    continue
                day = ts[:10]
                provider = msg.get('provider') or 'unknown'
                model = msg.get('model') or 'unknown'
                key = (day, provider, model)
                bucket = agg[key]
                bucket['input_tokens'] += int(usage.get('input', 0) or 0)
                bucket['output_tokens'] += int(usage.get('output', 0) or 0)
                bucket['cache_read_tokens'] += int(usage.get('cacheRead', 0) or 0)
                bucket['cache_write_tokens'] += int(usage.get('cacheWrite', 0) or 0)
                bucket['reasoning_tokens'] += int(usage.get('reasoning', 0) or 0)
                bucket['total_tokens'] += int(usage.get('totalTokens', 0) or 0)
                cost = usage.get('cost') or {}
                total_cost = cost.get('total', 0) if isinstance(cost, dict) else 0
                try:
                    bucket['estimated_cost_usd'] += float(total_cost or 0)
                except Exception:
                    pass
    except Exception:
        continue

out = []
for (day, provider, model), v in sorted(agg.items()):
    out.append({
        'usage_date': day,
        'runtime': 'openclaw',
        'provider': provider,
        'model': model,
        **v,
    })
print(json.dumps(out))
PY`;

  const result = await ssh.exec(ip, command, { user: 'root', timeoutMs: 60000 });
  if (result.exitCode !== 0) throw new Error(`OpenClaw usage poll failed: ${result.stderr}`);
  return JSON.parse(result.stdout || '[]');
}

async function pollHermesUsage(ip: string): Promise<UsageRow[]> {
  const command = `python3 - <<'PY'
import sqlite3, json, os
path = '/home/agent/.hermes/state.db'
if not os.path.exists(path):
    print('[]')
    raise SystemExit(0)
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
q = '''
SELECT 
  date(started_at, 'unixepoch') AS usage_date,
  COALESCE(billing_provider, 'unknown') AS provider,
  COALESCE(model, 'unknown') AS model,
  COALESCE(sum(input_tokens), 0) AS input_tokens,
  COALESCE(sum(output_tokens), 0) AS output_tokens,
  COALESCE(sum(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(sum(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(sum(reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + reasoning_tokens), 0) AS total_tokens,
  COALESCE(sum(COALESCE(actual_cost_usd, estimated_cost_usd, 0)), 0) AS estimated_cost_usd
FROM sessions
WHERE started_at IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
'''
rows = [dict(r) for r in conn.execute(q).fetchall()]
for r in rows:
    r['runtime'] = 'hermes'
print(json.dumps(rows))
PY`;

  const result = await ssh.exec(ip, command, { user: 'root', timeoutMs: 60000 });
  if (result.exitCode !== 0) throw new Error(`Hermes usage poll failed: ${result.stderr}`);
  return JSON.parse(result.stdout || '[]');
}
