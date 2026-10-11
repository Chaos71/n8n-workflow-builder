// exec_dump.cjs <executionId> — краткая сводка исполнения n8n без потери данных.
'use strict';
const fs = require('fs');
const path = require('path');

function loadMcpEnv() {
  const p = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers['n8n-workflow-builder'].env;
}

(async () => {
  const env = loadMcpEnv();
  const base = env.N8N_HOST.replace(/\/+$/, '');
  const id = process.argv[2];
  const r = await fetch(base + '/executions/' + id + '?includeData=true', {
    headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, accept: 'application/json' },
  });
  const e = await r.json();
  if (!r.ok) { console.error('HTTP', r.status, JSON.stringify(e).slice(0, 300)); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, 'workflows', 'exec_' + id + '_full.json'),
    JSON.stringify(e, null, 2), 'utf8');

  console.log('status=' + e.status + ' mode=' + e.mode);
  const rd = (e.data && e.data.resultData && e.data.resultData.runData) || {};
  for (const [name, runs] of Object.entries(rd)) {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const err = run.error ? (' ERROR: ' + String(run.error.message || JSON.stringify(run.error)).slice(0, 200)) : '';
      const items = (run.data && run.data.main) ? run.data.main.map((b) => (b ? b.length : -1)).join('/') : 'n/a';
      console.log('node[' + name + '] run' + i + ' main=[' + items + ']' + err);
    }
  }
  // Вывод ключевых нод целиком
  for (const key of ['AI Agent', 'If', 'Parse Evaluator Output', 'Parse Translator Output', 'Parse Start Indexing', 'Parse Job Status']) {
    if (!rd[key]) continue;
    console.log('\n===== ' + key + ' OUTPUT =====');
    console.log(JSON.stringify(rd[key][0].data && rd[key][0].data.main, null, 2).slice(0, 4000));
  }
})().catch((er) => { console.error('FAIL: ' + er.message); process.exit(1); });
