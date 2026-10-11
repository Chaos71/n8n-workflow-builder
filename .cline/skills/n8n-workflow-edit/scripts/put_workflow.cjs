#!/usr/bin/env node
'use strict';
/**
 * put_workflow.js — прямое обновление воркфлоу через n8n REST API (PUT),
 * с адаптивной чисткой settings. Часть skill n8n-workflow-edit.
 *
 * Обход известного бага: n8n подставляет settings.binaryMode в ответе GET,
 * но отклоняет его в PUT -> 400 "request/body/settings must NOT have
 * additional properties". Скрипт пробует лестницу вариантов settings,
 * пока одна из попыток не пройдёт.
 *
 * Использование:
 *   node put_workflow.js <workflowId> <patch.json> [--dry-run] [--base URL] [--key KEY]
 *
 * Формат patch.json:
 * {
 *   "nodeUpdates": [
 *     {
 *       "node": "AI Agent1",     // имя ноды в воркфлоу (точно, как в GET)
 *       "set":   { "parameters.options.systemMessage": "@C:\\temp\\prompt.md" },
 *       "remove": ["parameters.options.maxIterations"]
 *     }
 *   ],
 *   "settings": { "executionOrder": "v1" }, // необязательные оверрайды settings
 *   "name": "новое имя"                     // необязательно
 * }
 *
 * Пути — dot-path внутрь объекта ноды (name/type/parameters/credentials...).
 * Строковое значение с префиксом "@" = прочитать файл (UTF-8), trim по краям —
 * так передают длинные промпты (см. skill, грабли №6).
 * Хост/ключ: env N8N_HOST / N8N_API_KEY или mcp_settings.json (как в mcp_call.js).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
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
      if (p && p.trim() && fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const env = j && j.mcpServers && j.mcpServers['n8n-workflow-builder'] &&
          j.mcpServers['n8n-workflow-builder'].env;
        if (env && env.N8N_HOST && env.N8N_API_KEY) return env;
      }
    } catch (_) { /* пробуем следующий путь */ }
  }
  return null;
}

// Лестница вариантов settings: (1) всё из GET минус binaryMode, (2) только
// белый список, (3) {executionOrder}, (4) {}. Дедуп повторов.
function settingsLadder(getSettings, overrides) {
  const base = Object.assign({}, getSettings, overrides || {});
  delete base.binaryMode;
  const allowlisted = {};
  for (const k of SETTINGS_ALLOWLIST) if (k in base) allowlisted[k] = base[k];
  const list = [base, allowlisted,
    'executionOrder' in base ? { executionOrder: base.executionOrder } : {}, {}];
  const seen = new Set();
  return list.filter(s => {
    const j = JSON.stringify(s);
    if (seen.has(j)) return false;
    seen.add(j);
    return true;
  });
}

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  let o = obj;
  for (const k of ks) {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[last] = v;
}
function delPath(obj, p) {
  const ks = p.split('.');
  const last = ks.pop();
  let o = obj;
  for (const k of ks) {
    if (o[k] == null || typeof o[k] !== 'object') return;
    o = o[k];
  }
  delete o[last];
}

// Значение с "@" — прочитать файл (UTF-8) и trim.
function resolveValue(v) {
  if (typeof v === 'string' && v.startsWith('@')) {
    const f = v.slice(1);
    if (!fs.existsSync(f)) fail('файл не найден: ' + f);
    return fs.readFileSync(f, 'utf8').trim();
  }
  return v;
}

function brief(v) {
  if (typeof v === 'string') {
    return v.length > 60
      ? v.slice(0, 57) + '... (' + v.length + ' симв.)'
      : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

const argv = process.argv.slice(2);
const id = argv[0];
const patchPath = argv[1];
if (!id || !patchPath) {
  fail('Usage: node put_workflow.js <workflowId> <patch.json> [--dry-run] [--base URL] [--key KEY]');
}
const dryRun = argv.includes('--dry-run');
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

(async () => {
  const cfg = loadMcpEnv() || {};
  const baseRaw = flagValue('--base') || process.env.N8N_HOST || cfg.N8N_HOST;
  const key0 = flagValue('--key') || process.env.N8N_API_KEY || cfg.N8N_API_KEY;
  if (!baseRaw || !key0) fail('нет base/key (env, mcp_settings.json или --base/--key)');
  const base = baseRaw.replace(/\/+$/, '');
  if (!base.includes('/api/v1')) fail('base должен содержать /api/v1 (сейчас: ' + base + ')');
  const H = { 'X-N8N-API-KEY': key0, 'Content-Type': 'application/json', accept: 'application/json' };

  // 1. GET — свежие nodes/connections/settings
  const gr = await fetch(base + '/workflows/' + id, { headers: H });
  const wf = await gr.json();
  if (!gr.ok || !wf || !wf.id) fail('workflow ' + id + ' не прочитан: HTTP ' + gr.status +
    ' ' + JSON.stringify(wf).slice(0, 300));

  // 2. Патчим ноды
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const nodes = JSON.parse(JSON.stringify(wf.nodes || []));
  const changed = [];
  for (const upd of patch.nodeUpdates || []) {
    const n = nodes.find(x => x.name === upd.node);
    if (!n) fail('нода не найдена: "' + upd.node + '" (есть: ' +
      nodes.map(x => x.name).join(', ') + ')');
    const touched = [];
    for (const [p, raw] of Object.entries(upd.set || {})) {
      const v = resolveValue(raw);
      setPath(n, p, v);
      touched.push(p + ' = ' + brief(v));
    }
    for (const p of upd.remove || []) {
      if (getPath(n, p) === undefined) console.error('[warn] "' + p + '" у ноды ' + upd.node + ' и так нет');
      delPath(n, p);
      touched.push(p + ' (удалён)');
    }
    if (touched.length) changed.push(n.name + ': ' + touched.join('; '));
  }

  // 3. Тело PUT: settings не трогаем сверх GET (чистку делает лестница)
  const bodyCore = {
    name: patch.name || wf.name,
    nodes,
    connections: wf.connections || {},
  };
  if (wf.staticData !== undefined && wf.staticData !== null) bodyCore.staticData = wf.staticData;
  const hasPin = wf.pinData && Object.keys(wf.pinData).length > 0;
  const cores = hasPin ? [Object.assign({}, bodyCore, { pinData: wf.pinData }), bodyCore] : [bodyCore];
  const attempts = [].concat(...cores.map(core =>
    settingsLadder(wf.settings, patch.settings).map(s => Object.assign({}, core, { settings: s }))));

  if (dryRun) {
    console.log('DRY-RUN — PUT не выполнялся');
    console.log('base: ' + base);
    console.log('workflow: ' + wf.id + ' "' + wf.name + '" (versionId ' + wf.versionId + '), узлов: ' + nodes.length);
    console.log('изменения:');
    console.log(changed.length ? changed.map(c => '  - ' + c).join('\n') : '  (нет)');
    console.log('settings, попытка 1: ' + JSON.stringify(attempts[0].settings));
    console.log('всего попыток в лестнице: ' + attempts.length +
      (hasPin ? ' (первый проход с pinData, затем без)' : ''));
    process.exit(0);
  }

  // 4. PUT по лестнице
  let lastErr = '';
  for (const b of attempts) {
    const r = await fetch(base + '/workflows/' + id, {
      method: 'PUT', headers: H, body: JSON.stringify(b),
    });
    const txt = await r.text();
    if (r.ok) {
      let saved = {};
      try { saved = JSON.parse(txt); } catch (_) { /* пустой ответ */ }
      console.log('OK: PUT ' + r.status + ', versionId ' + wf.versionId + ' -> ' + (saved.versionId || '?'));
      if (changed.length) console.log('изменено:\n' + changed.map(c => '  - ' + c).join('\n'));
      console.log('settings отправлены: ' + JSON.stringify(b.settings));
      process.exit(0);
    }
    lastErr = r.status + ' ' + txt.slice(0, 300);
    const settings400 = r.status === 400 && /settings must NOT have additional properties/.test(txt);
    if (!settings400) fail('PUT не принят: ' + lastErr, 5);
    console.error('[retry] 400 на settings=' + JSON.stringify(b.settings) + ' — следующая попытка лестницы');
  }
  fail('PUT не удался ни с одной попыткой settings; последняя ошибка: ' + lastErr, 5);
})().catch(e => fail(e.message, 6));