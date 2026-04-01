import { Hono } from "hono";

const ui = new Hono();

ui.get("/", (c) => {
  return c.html(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BotBoot Test Wizard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 980px; margin: 32px auto; padding: 0 16px; background:#0b1020; color:#e8ecf3; }
    h1,h2 { margin-bottom: 8px; }
    .card { background:#121936; border:1px solid #24305e; border-radius:12px; padding:16px; margin:16px 0; }
    label { display:block; font-size:14px; margin:10px 0 6px; color:#b8c2e0; }
    input, textarea, select { width:100%; padding:10px; border-radius:8px; border:1px solid #33406f; background:#0f1730; color:#fff; box-sizing:border-box; }
    textarea { min-height:96px; font-family: ui-monospace, monospace; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .checks { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:8px; }
    .check { display:flex; gap:8px; align-items:center; background:#0f1730; border:1px solid #33406f; border-radius:8px; padding:8px 10px; }
    .check input { width:auto; }
    button { background:#5b8cff; color:#fff; border:none; border-radius:8px; padding:10px 14px; font-weight:600; cursor:pointer; margin-right:8px; }
    button.secondary { background:#24305e; }
    pre { white-space:pre-wrap; word-break:break-word; background:#08101f; border:1px solid #24305e; border-radius:8px; padding:12px; min-height:140px; }
    .muted { color:#98a3c7; font-size:14px; }
  </style>
</head>
<body>
  <h1>BotBoot test wizard</h1>
  <p class="muted">Internal test page for account secrets, exposed-secret selection, and agent launch.</p>

  <div class="card">
    <h2>1. BotBoot API</h2>
    <label>Base URL</label>
    <input id="baseUrl" value="http://localhost:3001" />
    <label>API key</label>
    <input id="apiKey" placeholder="bb_..." />
  </div>

  <div class="card">
    <h2>2. Account secrets</h2>
    <div class="row">
      <div>
        <label>ANTHROPIC_API_KEY</label>
        <input id="anthropic" placeholder="sk-ant-..." />
      </div>
      <div>
        <label>TAVILY_API_KEY</label>
        <input id="tavily" placeholder="tvly-..." />
      </div>
      <div>
        <label>OPENROUTER_API_KEY</label>
        <input id="openrouter" placeholder="sk-or-..." />
      </div>
      <div>
        <label>TELEGRAM_BOT_TOKEN</label>
        <input id="telegram" placeholder="123456:ABC..." />
      </div>
    </div>
    <label>OPENAI_AUTH_JSON / Codex auth JSON</label>
    <textarea id="openaiAuth" placeholder='{"type":"token","provider":"openai","token":"..."}'></textarea>
    <div style="margin-top:12px;">
      <button onclick="saveSecrets()">Save secrets</button>
      <button class="secondary" onclick="listSecrets()">List secret names</button>
    </div>
  </div>

  <div class="card">
    <h2>3. Create agent</h2>
    <div class="row">
      <div>
        <label>Agent name</label>
        <input id="agentName" value="test-openclaw-ui" />
      </div>
      <div>
        <label>Model</label>
        <input id="model" value="anthropic/claude-sonnet-4" />
      </div>
    </div>
    <label>Expose these secrets to the running agent</label>
    <div class="checks">
      <label class="check"><input type="checkbox" value="ANTHROPIC_API_KEY" checked /> ANTHROPIC_API_KEY</label>
      <label class="check"><input type="checkbox" value="TAVILY_API_KEY" checked /> TAVILY_API_KEY</label>
      <label class="check"><input type="checkbox" value="OPENROUTER_API_KEY" /> OPENROUTER_API_KEY</label>
      <label class="check"><input type="checkbox" value="TELEGRAM_BOT_TOKEN" /> TELEGRAM_BOT_TOKEN</label>
      <label class="check"><input type="checkbox" value="OPENAI_AUTH_JSON" /> OPENAI_AUTH_JSON</label>
    </div>
    <label>SOUL.md</label>
    <textarea id="soul">You are a concise assistant.</textarea>
    <label>USER.md</label>
    <textarea id="user">Name: Mohammed</textarea>
    <div style="margin-top:12px;">
      <button onclick="createAgent()">Create agent</button>
    </div>
  </div>

  <div class="card">
    <h2>Output</h2>
    <pre id="output"></pre>
  </div>

<script>
const out = document.getElementById('output');
function log(title, data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  out.textContent = '[' + new Date().toISOString() + '] ' + title + '\n' + text + '\n\n' + out.textContent;
}
function headers() {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + document.getElementById('apiKey').value.trim(),
  };
}
async function saveSecrets() {
  const payload = {};
  const vals = {
    ANTHROPIC_API_KEY: document.getElementById('anthropic').value.trim(),
    TAVILY_API_KEY: document.getElementById('tavily').value.trim(),
    OPENROUTER_API_KEY: document.getElementById('openrouter').value.trim(),
    TELEGRAM_BOT_TOKEN: document.getElementById('telegram').value.trim(),
    OPENAI_AUTH_JSON: document.getElementById('openaiAuth').value.trim(),
  };
  for (const [k, v] of Object.entries(vals)) if (v) payload[k] = v;
  const res = await fetch(document.getElementById('baseUrl').value + '/v1/secrets', { method:'PUT', headers: headers(), body: JSON.stringify(payload) });
  const data = await res.json();
  log('Save secrets → ' + res.status, data);
}
async function listSecrets() {
  const res = await fetch(document.getElementById('baseUrl').value + '/v1/secrets', { headers: headers() });
  const data = await res.json();
  log('List secrets → ' + res.status, data);
}
async function createAgent() {
  const exposedSecrets = Array.from(document.querySelectorAll('.checks input:checked')).map(el => el.value);
  const payload = {
    name: document.getElementById('agentName').value.trim(),
    runtime: 'openclaw',
    model: document.getElementById('model').value.trim(),
    exposedSecrets,
    files: {
      'SOUL.md': document.getElementById('soul').value,
      'USER.md': document.getElementById('user').value,
    }
  };
  const res = await fetch(document.getElementById('baseUrl').value + '/v1/agents', { method:'POST', headers: headers(), body: JSON.stringify(payload) });
  const data = await res.json();
  log('Create agent → ' + res.status, data);
}
</script>
</body>
</html>`);
});

export default ui;
