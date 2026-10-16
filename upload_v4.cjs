// upload_v4.cjs — загрузка Medium Agent v4 в n8n с выводом тела ошибки API.
'use strict';
const fs = require('fs');
const path = require('path');

function loadMcpEnv() {
  const p = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers['n8n-workflow-builder'].env;
}

const V4_DESCRIPTION =
  'Копия Medium Agent v3 с исправлением: письмо без интересных статей (details=[]) ' +
  'больше не упирается в пустой Loop Over Items — ветка завершается узлом ' +
  '"Build Skip Result", который возвращает 1 item вызывающему workflow.';

(async () => {
  const env = loadMcpEnv();
  const base = env.N8N_HOST.replace(/\/+$/, '');
  const wf = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'workflows', 'Medium-Agent-v4.json'), 'utf8'));

  const r = await fetch(base + '/workflows', {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': env.N8N_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(wf),
  });
  const text = await r.text();
  console.log('CREATE HTTP', r.status);
  console.log(text.slice(0, 2000));
  if (!r.ok) process.exit(1);

  const j = JSON.parse(text);
  fs.writeFileSync(path.join(__dirname, 'workflows', 'uploaded_v4_id.txt'), String(j.id), 'utf8');
  console.log('\nCREATED id=' + j.id + ' name=' + j.name + ' nodes=' + ((j.nodes || []).length));

  // Описание — отдельным PATCH (в create-схеме оно запрещено)
  const p = await fetch(base + '/workflows/' + j.id, {
    method: 'PATCH',
    headers: {
      'X-N8N-API-KEY': env.N8N_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ description: V4_DESCRIPTION }),
  });
  console.log('PATCH description HTTP', p.status, (await p.text()).slice(0, 500));
})().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1); });