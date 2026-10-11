// analyze_exec.cjs — диагностика воркфлоу/исполнений Medium Agent:
//   node analyze_exec.cjs wf <path-to-workflow.json>
//   node analyze_exec.cjs exec <path-to-execution.json>
'use strict';
const fs = require('fs');

const mode = process.argv[2];
const file = process.argv[3];
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));

if (mode === 'wf') {
  console.log('WF: ' + doc.name + '  id=' + doc.id + '  updated=' + doc.updatedAt);
  for (const n of doc.nodes) {
    const type = n.type.replace('@n8n/n8n-nodes-langchain.', 'L:').replace('n8n-nodes-base.', 'B:');
    let extra = '';
    if (n.parameters && n.parameters.model) {
      extra += ' model=' + (n.parameters.model.value || n.parameters.model.cachedResultName);
    }
    if (n.parameters && n.parameters.options) {
      const o = { ...n.parameters.options };
      for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 40) o[k] = '<len ' + o[k].length + '>';
      extra += ' opts=' + JSON.stringify(o);
    }
    if (n.parameters && n.parameters.jsCode) extra += ' jsCode=<len ' + n.parameters.jsCode.length + '>';
    if (n.credentials && n.credentials.openAiApi) extra += ' cred=' + n.credentials.openAiApi.name;
    if (n.parameters && n.parameters.endpointUrl) extra += ' url=' + n.parameters.endpointUrl;
    console.log('  ' + type.padEnd(16) + ' ' + n.name.padEnd(26) + extra);
  }
  console.log('--- connections ---');
  for (const [from, chans] of Object.entries(doc.connections)) {
    const parts = [];
    for (const [chanType, groups] of Object.entries(chans)) {
      for (const g of groups || []) {
        for (const link of g || []) parts.push(chanType + '->' + link.node);
      }
    }
    console.log('  ' + from.padEnd(26) + parts.join(', '));
  }
} else if (mode === 'wexec') {
  // Настройки воркфлоу, фактически исполнявшегося в этом запуске
  const wf = doc.workflowData || {};
  console.log('EXEC ' + doc.id + ' -> WF version=' + (doc.workflowVersionId || wf.versionId) + ' name=' + wf.name);
  for (const n of wf.nodes || []) {
    const type = n.type.replace('@n8n/n8n-nodes-langchain.', 'L:').replace('n8n-nodes-base.', 'B:');
    let extra = '';
    if (n.parameters && n.parameters.model) {
      extra += ' model=' + (n.parameters.model.value || n.parameters.model.cachedResultName);
    }
    if (n.parameters && n.parameters.options) {
      const o = { ...n.parameters.options };
      for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 40) o[k] = '<len ' + o[k].length + '>';
      extra += ' opts=' + JSON.stringify(o);
    }
    if (n.credentials && n.credentials.openAiApi) extra += ' cred=' + n.credentials.openAiApi.name;
    console.log('  ' + type.padEnd(16) + ' ' + n.name.padEnd(26) + extra);
  }
  const want = process.argv[4];
  if (want) {
    for (const n of wf.nodes || []) {
      if (n.name !== want) continue;
      console.log('\n===== PROMPT ' + want + ' =====');
      console.log((n.parameters.options && n.parameters.options.systemMessage) || '');
    }
  }
} else if (mode === 'prompt') {
  // Печать системного промпта ноды из файла воркфлоу
  const name = process.argv[4];
  const n = (doc.nodes || []).find((x) => x.name === name);
  if (!n) {
    console.log('node not found: ' + name);
  } else {
    console.log((n.parameters.options && n.parameters.options.systemMessage) || '(no systemMessage)');
  }
} else if (mode === 'text') {
  // Сырые строки, содержащие шаблон (для проверки, что видел агент в письме)
  const needle = process.argv[4] || '';
  const raw = JSON.stringify(doc);
  let idx = 0;
  let n = 0;
  while ((idx = raw.indexOf(needle, idx)) !== -1 && n < 20) {
    console.log('--- hit ' + n + ' @' + idx + ' ---');
    console.log(raw.slice(Math.max(0, idx - 300), idx + 400).replace(/\\n/g, '\n'));
    idx += needle.length;
    n++;
  }
  console.log('hits=' + n);
} else if (mode === 'exec') {
  const rd = (doc.data && doc.data.resultData && doc.data.resultData.runData) || {};
  const err0 = doc.data && doc.data.resultData && doc.data.resultData.error;
  if (err0) {
    console.log('EXEC-ERROR: ' + JSON.stringify(err0).slice(0, 500));
  }

  console.log('EXEC ' + doc.id + ' status=' + doc.status + ' started=' + doc.createdAt +
    ' wfVersion=' + (doc.workflowVersionId || '?'));
  for (const [name, runs] of Object.entries(rd)) {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const err = run.error ? (' ERROR: ' + String(run.error.message || '').slice(0, 160)) : '';
      const counts = (run.data && run.data.main) ? run.data.main.map((b) => (b ? b.length : -1)).join('/') : 'n/a';
      console.log('  node[' + name + '] run' + i + ' main=[' + counts + ']' + err);
    }
  }
  const dump = (key, max) => {
    if (!rd[key]) return;
    const out = JSON.stringify(rd[key][0].data && rd[key][0].data.main);
    console.log('\n===== ' + key + ' OUTPUT (len ' + (out ? out.length : 0) + ') =====');
    console.log(out.slice(0, max || 3000));
  };
  if (process.argv.includes('--dump')) dump('AI Agent', 5000);
}
