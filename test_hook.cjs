// test_hook.cjs — временный тестовый вход для "Medium Agent main copy".
// install: добавляет Test Webhook -> Test Set -> AI Agent; remove: убирает их.
// Использует ту же лестницу settings, что и skill put_workflow.js (обход бага PUT 400).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WF_ID = 'ioZNo5bkS04OIiAL';
const MODE = process.argv[2] || 'install'; // install | remove
const WEBHOOK_NAME = 'Test Webhook';
const SET_NAME = 'Test Input';
const PINNED_PATH = path.join(__dirname, 'workflows', 'pinned_agent_output.json');

const CONFIG_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
];
const SETTINGS_ALLOWLIST = [
  'executionOrder', 'availableInMCP', 'timezone', 'errorWorkflow',
  'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions',
  'saveExecutionProgress', 'callerPolicy', 'callerIds',
];

function fail(msg, code) { console.error('ERROR: ' + msg); process.exit(code || 2); }

function loadMcpEnv() {
  for (const p of CONFIG_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) {
        const env = JSON.parse(fs.readFileSync(p, 'utf8'))
          .mcpServers['n8n-workflow-builder'].env;
        if (env && env.N8N_HOST && env.N8N_API_KEY) return env;
      }
    } catch (_) { /* next */ }
  }
  return null;
}

function settingsLadder(getSettings, overrides) {
  const base = Object.assign({}, getSettings, overrides || {});
  delete base.binaryMode;
  const allowlisted = {};
  for (const k of SETTINGS_ALLOWLIST) if (k in base) allowlisted[k] = base[k];
  const list = [base, allowlisted,
    'executionOrder' in base ? { executionOrder: base.executionOrder } : {}, {}];
  const seen = new Set();
  return list.filter((s) => {
    const j = JSON.stringify(s);
    if (seen.has(j)) return false;
    seen.add(j);
    return true;
  });
}

(async () => {
  const env = loadMcpEnv() || fail('нет N8N_HOST/N8N_API_KEY');
  const base = env.N8N_HOST.replace(/\/+$/, '');
  const H = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' };

  const gr = await fetch(base + '/workflows/' + WF_ID, { headers: H });
  const wf = await gr.json();
  if (!gr.ok) fail('GET не удался: ' + gr.status + ' ' + JSON.stringify(wf).slice(0, 200));

  let nodes = JSON.parse(JSON.stringify(wf.nodes || []));
  let conns = JSON.parse(JSON.stringify(wf.connections || {}));

  if (MODE === 'install') {
    if (nodes.some((n) => n.name === WEBHOOK_NAME)) fail('тестовые ноды уже установлены');
    const webhookNode = {
      parameters: { httpMethod: 'POST', path: 'medium-agent-copy-test', responseMode: 'onReceived', options: {} },
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [-1040, 32],
      id: crypto.randomUUID(),
      name: WEBHOOK_NAME,
      webhookId: crypto.randomUUID(),
    };
    const pinned = JSON.parse(fs.readFileSync(PINNED_PATH, 'utf8'));
    const setNode = {
      parameters: {
        jsCode:
          '// ТЕСТОВЫЙ ВХОД: pin-нутый вывод extraction-агента (Gmail-креденшел временно отключён)\n' +
          'const pinned = ' + JSON.stringify(pinned, null, 2) + ';\n' +
          'return [{ json: pinned }];',
      },
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-880, 32],
      id: crypto.randomUUID(),
      name: SET_NAME,
    };
    nodes.push(webhookNode, setNode);
    conns[WEBHOOK_NAME] = { main: [[{ node: SET_NAME, type: 'main', index: 0 }]] };
    conns[SET_NAME] = { main: [[{ node: 'If', type: 'main', index: 0 }]] };
    console.log('Добавлены ноды: ' + WEBHOOK_NAME + ', ' + SET_NAME + ' (-> If)');
  } else {
    nodes = nodes.filter((n) => n.name !== WEBHOOK_NAME && n.name !== SET_NAME && n.name !== 'Test Set');
    delete conns[WEBHOOK_NAME];
    delete conns[SET_NAME];
    delete conns['Test Set'];
    console.log('Удалены ноды: ' + WEBHOOK_NAME + ', ' + SET_NAME);
  }

  const bodyCore = { name: wf.name, nodes, connections: conns };
  if (wf.staticData !== undefined && wf.staticData !== null) bodyCore.staticData = wf.staticData;
  const hasPin = wf.pinData && Object.keys(wf.pinData).length > 0;
  const cores = hasPin ? [Object.assign({}, bodyCore, { pinData: wf.pinData }), bodyCore] : [bodyCore];
  const attempts = [].concat(...cores.map((core) =>
    settingsLadder(wf.settings, {}).map((s) => Object.assign({}, core, { settings: s }))));

  for (const b of attempts) {
    const r = await fetch(base + '/workflows/' + WF_ID, { method: 'PUT', headers: H, body: JSON.stringify(b) });
    const txt = await r.text();
    if (r.ok) {
      let saved = {};
      try { saved = JSON.parse(txt); } catch (_) { /* empty */ }
      console.log('OK: PUT ' + r.status + ', nodes=' + nodes.length + ', versionId -> ' + (saved.versionId || '?'));
      process.exit(0);
    }
    const settings400 = r.status === 400 && /settings must NOT have additional properties/.test(txt);
    if (!settings400) fail('PUT не принят: ' + r.status + ' ' + txt.slice(0, 300), 5);
    console.error('[retry] 400 на settings=' + JSON.stringify(b.settings));
  }
  fail('PUT не удался ни с одной попыткой', 5);
})().catch((e) => fail(e.message));
