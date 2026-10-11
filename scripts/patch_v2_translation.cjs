#!/usr/bin/env node
'use strict';
/**
 * patch_v2_translation.cjs — переводит шаг перевода статей в workflow
 * "Medium Agent main v2" (id ioZNo5bkS04OIiAL) на детерминированную схему:
 *
 *   MCP save_knowledge_article -> AI Agent2 (только перевод, БЕЗ инструментов)
 *     -> MCP save_translation (mcpClient: save_knowledge_article_translation)
 *     -> Parse Translator Output
 *
 * Причина правки: LLM2 с maxTokens=1536 обрезал перевод (finish_reason=length),
 * агент возвращал выдуманный JSON "translation_saved", а инструмент
 * save_knowledge_article_translation не вызывался ни разу.
 *
 * Скрипт обходит известный баг n8n PUT 400 (settings.binaryMode) лестницей
 * вариантов settings — см. skill n8n-workflow-edit.
 *
 * Использование:
 *   node scripts/patch_v2_translation.cjs --dry-run
 *   node scripts/patch_v2_translation.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WF_ID = 'ioZNo5bkS04OIiAL';
const ROOT = path.resolve(__dirname, '..');
const MCP_SSE_URL = 'http://192.168.88.17:20001/sse';

const SETTINGS_ALLOWLIST = [
  'executionOrder', 'availableInMCP', 'timezone', 'errorWorkflow',
  'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions',
  'saveExecutionProgress', 'callerPolicy', 'callerIds',
];

function fail(msg, code) { console.error('ERROR: ' + msg); process.exit(code || 2); }

function readText(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

const SYSTEM_PROMPT = readText(path.join(ROOT, 'workflows', 'prompt_translator_v3.txt'));
const PARSE_CODE = readText(path.join(ROOT, 'workflows', 'parse_translator_output.js'));

const USER_TEXT = [
  '=Переведи на русский язык статью и верни ТОЛЬКО текст перевода (Markdown).',
  '',
  'document_id: {{ $json.content[0].text.document_id }}',
  "title: {{ $('Article Accepted').first().json.title }}",
  '',
  '--- НАЧАЛО ОРИГИНАЛА ---',
  "{{ $json.content[0].text.normalized_text || $('MCP fetch_markdown').first().json.content[0].text.content || '' }}",
  '--- КОНЕЦ ОРИГИНАЛА ---',
].join('\n');

const SAVE_TRANSLATION_INPUT =
  "={{ JSON.stringify({ document_id: $('Article Accepted').first().json.document_id, " +
  "original_url: $('Article Accepted').first().json.original_url, language: 'ru', " +
  "article_id: $('Article Accepted').first().json.article_id, translator_model: 'Qwen3.5-9B', " +
  'translation_markdown: $json.output }) }}';

function loadEnv() {
  const cands = [
    path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
      'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
    path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
      'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
  ];
  for (const p of cands) {
    try {
      if (p && fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const env = j && j.mcpServers && j.mcpServers['n8n-workflow-builder']
          && j.mcpServers['n8n-workflow-builder'].env;
        if (env && env.N8N_HOST && env.N8N_API_KEY) return env;
      }
    } catch (_) { /* следующий кандидат */ }
  }
  const dot = path.join(ROOT, '.env');
  if (fs.existsSync(dot)) {
    const t = fs.readFileSync(dot, 'utf8');
    const g = (k) => (t.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
    if (g('N8N_HOST') && g('N8N_API_KEY')) {
      return { N8N_HOST: g('N8N_HOST').trim(), N8N_API_KEY: g('N8N_API_KEY').trim() };
    }
  }
  return null;
}

function settingsLadder(getSettings, overrides) {
  const base = Object.assign({}, getSettings, overrides || {});
  delete base.binaryMode;
  const allow = {};
  for (const k of SETTINGS_ALLOWLIST) if (k in base) allow[k] = base[k];
  const list = [base, allow, 'executionOrder' in base ? { executionOrder: base.executionOrder } : {}, {}];
  const seen = new Set();
  return list.filter((s) => {
    const j = JSON.stringify(s);
    if (seen.has(j)) return false;
    seen.add(j);
    return true;
  });
}

function transform(wf) {
  const nodes = JSON.parse(JSON.stringify(wf.nodes || []));
  const connections = JSON.parse(JSON.stringify(wf.connections || {}));
  const log = [];

  const agent = nodes.find((n) => n.name === 'AI Agent2');
  if (!agent) fail('нода "AI Agent2" не найдена');
  agent.parameters.promptType = 'define';
  agent.parameters.text = USER_TEXT;
  agent.parameters.options = agent.parameters.options || {};
  agent.parameters.options.systemMessage = '=' + SYSTEM_PROMPT;
  delete agent.parameters.options.maxIterations;
  log.push('AI Agent2: prompt -> чистый перевод без инструментов (systemMessage ' + SYSTEM_PROMPT.length + ' симв.)');

  const llm2 = nodes.find((n) => n.name === 'LLM2');
  if (!llm2) fail('нода "LLM2" не найдена');
  llm2.parameters.options = llm2.parameters.options || {};
  const oldMax = llm2.parameters.options.maxTokens;
  llm2.parameters.options.maxTokens = -1;
  log.push('LLM2: maxTokens ' + oldMax + ' -> -1 (снята обрезка вывода)');

  const iMcp2 = nodes.findIndex((n) => n.name === 'MCP Client2');
  if (iMcp2 !== -1) { nodes.splice(iMcp2, 1); log.push('MCP Client2: удалён'); }
  delete connections['MCP Client2'];

  const saveTr = {
    parameters: {
      endpointUrl: MCP_SSE_URL,
      tool: { __rl: true, mode: 'list', value: 'save_knowledge_article_translation', cachedResultName: 'save_knowledge_article_translation' },
      inputMode: 'json',
      jsonInput: SAVE_TRANSLATION_INPUT,
      options: { timeout: 600000 },
    },
    type: '@n8n/n8n-nodes-langchain.mcpClient',
    typeVersion: 1.1,
    position: [1490, 0],
    id: crypto.randomUUID(),
    name: 'MCP save_translation',
    onError: 'continueRegularOutput',
  };
  const existing = nodes.find((n) => n.name === 'MCP save_translation');
  if (existing) { Object.assign(existing, saveTr, { id: existing.id }); log.push('MCP save_translation: обновлён'); }
  else { nodes.push(saveTr); log.push('MCP save_translation: добавлен'); }

  const parse = nodes.find((n) => n.name === 'Parse Translator Output');
  if (!parse) fail('нода "Parse Translator Output" не найдена');
  parse.parameters.jsCode = PARSE_CODE;
  log.push('Parse Translator Output: jsCode обновлён (' + PARSE_CODE.length + ' симв.)');

  connections['AI Agent2'] = { main: [[{ node: 'MCP save_translation', type: 'main', index: 0 }]] };
  connections['MCP save_translation'] = { main: [[{ node: 'Parse Translator Output', type: 'main', index: 0 }]] };
  log.push('connections: AI Agent2 -> MCP save_translation -> Parse Translator Output');

  return { nodes, connections, log };
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const env = loadEnv();
  if (!env) fail('не найден N8N_HOST/N8N_API_KEY (mcp_settings.json или .env)');
  const base = env.N8N_HOST.replace(/\/+$/, '');
  const H = { 'X-N8N-API-KEY': env.N8N_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' };

  const gr = await fetch(base + '/workflows/' + WF_ID, { headers: H });
  const wf = await gr.json();
  if (!gr.ok || !wf || !wf.id) fail('workflow не прочитан: HTTP ' + gr.status + ' ' + JSON.stringify(wf).slice(0, 300));

  const { nodes, connections, log } = transform(wf);

  console.log('workflow: ' + wf.id + ' "' + wf.name + '" (versionId ' + wf.versionId + ')');
  console.log('base: ' + base);
  console.log('изменения:\n' + log.map((l) => '  - ' + l).join('\n'));
  console.log('узлов: ' + (wf.nodes || []).length + ' -> ' + nodes.length);

  if (dryRun) { console.log('DRY-RUN — PUT не выполнялся'); process.exit(0); }

  const bodyCore = { name: wf.name, nodes, connections };
  if (wf.staticData !== undefined && wf.staticData !== null) bodyCore.staticData = wf.staticData;
  const attempts = settingsLadder(wf.settings, {}).map((s) => Object.assign({}, bodyCore, { settings: s }));

  let lastErr = '';
  for (const b of attempts) {
    const r = await fetch(base + '/workflows/' + WF_ID, { method: 'PUT', headers: H, body: JSON.stringify(b) });
    const txt = await r.text();
    if (r.ok) {
      let saved = {};
      try { saved = JSON.parse(txt); } catch (_) { /* пусто */ }
      console.log('OK: PUT ' + r.status + ', versionId ' + wf.versionId + ' -> ' + (saved.versionId || '?'));
      console.log('settings отправлены: ' + JSON.stringify(b.settings));
      process.exit(0);
    }
    lastErr = r.status + ' ' + txt.slice(0, 300);
    const s400 = r.status === 400 && /settings must NOT have additional properties/.test(txt);
    if (!s400) fail('PUT не принят: ' + lastErr, 5);
    console.error('[retry] 400 на settings=' + JSON.stringify(b.settings));
  }
  fail('PUT не удался; последняя ошибка: ' + lastErr, 5);
})().catch((e) => fail(e.message, 6));