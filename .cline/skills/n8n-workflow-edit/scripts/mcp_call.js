#!/usr/bin/env node
'use strict';
/**
 * mcp_call.js — универсальный вызов инструмента MCP-сервера n8n-workflow-builder
 * (JSON-RPC 2.0 over stdio). Часть skill n8n-workflow-edit.
 *
 * Использование:
 *   node mcp_call.js <tool> ['{"arg":"value"}'] [timeoutSec]
 *
 * Примеры:
 *   node mcp_call.js list_workflows '{}'
 *   node mcp_call.js get_workflow '{"id":"MJWXeH2Ohk1zcTlr","full":true}'
 *
 * N8N_HOST / N8N_API_KEY: если не заданы в окружении, скрипт сам читает их из
 * Roo Cline mcp_settings.json (env перекрывает конфиг). N8N_HOST обязан
 * содержать /api/v1 — сервер добавляет к базе "/workflows", иначе будет
 * ошибка "workflows.map is not a function".
 *
 * Ответы сопоставляются по id (сервер может отвечать не по порядку — см. skill, грабли №2).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERVER = 'C:\\WorkPlace\\n8n-builder\\n8n-workflow-builder\\build\\server.cjs';
const CONFIG_CANDIDATES = [
  path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage',
    'rooveterinaryinc.roo-cline', 'mcp_settings.json'),
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

function parseArgsJson(s) {
  if (!s || s === '{}') return {};
  try { return JSON.parse(s); } catch (e) { fail('argsJson не парсится: ' + e.message, 2); }
}

const [, , tool, argsJson, timeoutArg] = process.argv;
if (!tool) fail('Usage: node mcp_call.js <tool> [argsJson] [timeoutSec]');

const cfgEnv = loadMcpEnv() || {};
const host = process.env.N8N_HOST || cfgEnv.N8N_HOST;
const key = process.env.N8N_API_KEY || cfgEnv.N8N_API_KEY;
if (!host || !key) fail('N8N_HOST / N8N_API_KEY не найдены ни в env, ни в mcp_settings.json');
if (!host.includes('/api/v1')) fail('N8N_HOST должен содержать "/api/v1" (сейчас: ' + host + ')');

const TIMEOUT_MS = (parseInt(timeoutArg, 10) || 90) * 1000;

const child = spawn(process.execPath, [SERVER], {
  env: Object.assign({}, process.env, { N8N_HOST: host, N8N_API_KEY: key }),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
child.on('error', e => fail('не удалось запустить сервер: ' + e.message, 2));
child.stderr.on('data', d => process.stderr.write('[server] ' + String(d)));
child.stdin.on('error', () => { /* EPIPE при смерти сервера — не роняем скрипт */ });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', d => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; } // не-JSON строки игнорируем
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, { resolve });
    child.stdin.write(JSON.stringify(Object.assign(
      { jsonrpc: '2.0', id, method },
      params !== undefined ? { params } : {})) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify(Object.assign(
    { jsonrpc: '2.0', method },
    params !== undefined ? { params } : {})) + '\n');
}

function withTimeout(promise, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('таймаут "' + what + '" (' + TIMEOUT_MS + ' мс)')), TIMEOUT_MS)),
  ]);
}

function shutdown(code) { try { child.kill(); } catch (_) {} process.exit(code); }

(async () => {
  const init = await withTimeout(request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp_call', version: '1.0.0' },
  }), 'initialize');
  if (init.error) fail('initialize: ' + JSON.stringify(init.error), 2);
  notify('notifications/initialized', {});

  const res = await withTimeout(
    request('tools/call', { name: tool, arguments: parseArgsJson(argsJson) }), tool);
  if (res.error) fail('tools/call: ' + JSON.stringify(res.error), 3);

  const result = res.result;
  if (!result) fail('пустой result: ' + JSON.stringify(res), 3);
  if (result.isError) {
    fail((result.content || []).map(c => c.text || '').join('\n') ||
      'инструмент сообщил об ошибке', 3);
  }
  const text = (result.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text).join('\n');
  if (text) process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  shutdown(0);
})().catch(e => { console.error('ERROR: ' + e.message); shutdown(4); });