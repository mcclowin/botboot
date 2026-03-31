/**
 * Usage routes.
 *
 * GET  /v1/usage                 → Aggregate usage for account
 * POST /v1/usage/poll            → Poll all running agents now
 * GET  /v1/agents/:id/usage      → Usage for one agent
 * POST /v1/agents/:id/usage/poll → Poll one agent now
 */

import { Hono } from 'hono';
import { apiKeyAuth } from '../middleware/auth.js';
import { db } from '../lib/db.js';
import { pollAndStoreAgentUsage } from '../lib/usage.js';

const usage = new Hono();
usage.use('*', apiKeyAuth);

usage.get('/', async (c) => {
  const accountId = c.get('accountId');
  const days = parseInt(c.req.query('days') || '30', 10);
  const summary = await db.getAccountUsageSummary(accountId, days);
  return c.json(summary);
});

usage.post('/poll', async (c) => {
  const accountId = c.get('accountId');
  const agents = await db.listAgents(accountId);
  const running = agents.filter((a) => a.state !== 'deleted' && a.ip);

  const results = [] as any[];
  for (const agent of running) {
    try {
      const polled = await pollAndStoreAgentUsage(agent);
      results.push({ agent_id: agent.id, name: agent.name, ok: true, rows: polled.count });
    } catch (err: any) {
      results.push({ agent_id: agent.id, name: agent.name, ok: false, error: err?.message || 'poll failed' });
    }
  }
  return c.json({ polled: results.length, results });
});

usage.get('/:id/usage', async (c) => {
  const accountId = c.get('accountId');
  const agent = await db.getAgent(accountId, c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const days = parseInt(c.req.query('days') || '30', 10);
  const summary = await db.getAgentUsageSummary(agent.id, days);
  return c.json(summary);
});

usage.post('/:id/usage/poll', async (c) => {
  const accountId = c.get('accountId');
  const agent = await db.getAgent(accountId, c.req.param('id'));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const result = await pollAndStoreAgentUsage(agent);
  return c.json({ success: true, rows: result.count, usage: result.rows });
});

export default usage;
