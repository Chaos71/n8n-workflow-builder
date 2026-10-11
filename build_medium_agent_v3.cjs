// build_medium_agent_v3.cjs
// Строит workflow "Medium Agent v3" на основе экспорта "Medium Agent main v2"
// (workflows/medium-agent-v3-source.json) и сохраняет его в
// workflows/Medium Agent v3.json для загрузки через upload_workflow.
//
// ОПТИМИЗАЦИЯ v3: вызовы MCP list_sessions → Pick Session → MCP browser_login →
// MCP save_session перенесены из цикла по статьям на уровень письма — теперь
// каждый метод вызывается РОВНО ОДИН РАЗ на входящее email вместо одного раза
// на каждую статью дайджеста.
//
// Что меняется относительно v2:
//   1) Связи: If → MCP list_sessions → Pick Session → MCP browser_login →
//      MCP save_session → Code in JavaScript → Loop Over Items →
//      MCP fetch_markdown → ... (цепочка сессий — ДО разбивки письма на статьи).
//   2) jsonInput сессийных нод: article_id берётся из письма
//      (email_id + "-0" — формат article_id из Code in JavaScript,
//      совпадает с id первой статьи details[0]), т.к. Loop Over Items ещё
//      не выполнялся и ссылаться на него нельзя.
//   3) Pick Session (workflows/pick_session_v3.js): service_id выбирается по
//      домену ПЕРВОЙ статьи дайджеста details[0] вместо текущей статьи цикла.
//   4) Code in JavaScript (workflows/split_email_articles_v3.js): данные письма
//      читаются из $(), "If", т.к. на входе теперь ответ MCP save_session.
//   5) Перенесённые ноды перемещены на свободный ряд y=-440.
//
// Без изменений: MCP fetch_markdown вызывается в цикле для КАЖДОЙ статьи.
//
// Запуск:
//   node build_medium_agent_v3.cjs                        # сборка + валидация
//   node build_medium_agent_v3.cjs --verify <path.json>   # проверка экспорта из n8n
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC_PATH = path.join(ROOT, 'workflows', 'medium-agent-v3-source.json');
const OUT_PATH = path.join(ROOT, 'workflows', 'Medium Agent v3.json');
const PICK_PATH = path.join(ROOT, 'workflows', 'pick_session_v3.js');
const SPLIT_PATH = path.join(ROOT, 'workflows', 'split_email_articles_v3.js');

const NEW_NAME = 'Medium Agent v3';

// Сырые строковые значения параметров (без экранирования JSON.stringify —
// иначе проверки $() -ссылок не найдут кавычки внутри jsCode/expressions).
function stringValues(obj, out) {
  out = out || [];
  if (typeof obj === 'string') out.push(obj);
  else if (Array.isArray(obj)) obj.forEach((v) => stringValues(v, out));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => stringValues(v, out));
  return out;
}

// ---------------------------------------------------------------------------
// Валидация: одинакова для собираемого payload и скачанного из n8n экспорта
// ---------------------------------------------------------------------------
function validate(wf) {
  if (wf.name !== NEW_NAME) throw new Error('Ожидалось имя "' + NEW_NAME + '", получено "' + wf.name + '"');

  const names = new Set(wf.nodes.map((n) => n.name));
  if (names.size !== wf.nodes.length) throw new Error('Дубликаты имён нод');
  const ids = new Set(wf.nodes.map((n) => n.id));
  if (ids.size !== wf.nodes.length) throw new Error('Дубликаты id нод');

  for (const [from, outputs] of Object.entries(wf.connections)) {
    if (!names.has(from)) throw new Error('Связь от несуществующей ноды: ' + from);
    for (const conns of Object.values(outputs)) {
      for (const arr of conns) {
        for (const c of arr) {
          if (!names.has(c.node)) throw new Error('Связь ' + from + ' → несуществующая нода ' + c.node);
        }
      }
    }
  }

  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const expectEdge = (from, idx, expected) => {
    const arr = (wf.connections[from] && wf.connections[from].main[idx]) || [];
    const got = arr.map((c) => c.node).join(',');
    if (got !== expected) {
      throw new Error('Связь ' + from + '[' + idx + ']: ожидалось "' + expected + '", получено "' + got + '"');
    }
  };

  // Цепочка однократных вызовов сессий и вход в цикл статей.
  expectEdge('If', 0, 'MCP list_sessions');
  expectEdge('MCP list_sessions', 0, 'Pick Session');
  expectEdge('Pick Session', 0, 'MCP browser_login');
  expectEdge('MCP browser_login', 0, 'MCP save_session');
  expectEdge('MCP save_session', 0, 'Code in JavaScript');
  expectEdge('Code in JavaScript', 0, 'Loop Over Items');
  expectEdge('Loop Over Items', 1, 'MCP fetch_markdown');
  expectEdge('Loop Over Items', 0, '');
  expectEdge('MCP fetch_markdown', 0, 'Build Eval Input');

  // Каждый сессийный метод — ровно одна входящая связь (вызов на письмо, не на статью).
  const incoming = {};
  for (const outputs of Object.values(wf.connections)) {
    for (const conns of Object.values(outputs)) {
      for (const arr of conns) {
        for (const c of arr) incoming[c.node] = (incoming[c.node] || 0) + 1;
      }
    }
  }
  for (const name of ['MCP list_sessions', 'MCP browser_login', 'MCP save_session']) {
    const n = incoming[name] || 0;
    if (n !== 1) throw new Error(name + ': ожидалась ровно 1 входящая связь, найдено ' + n);
  }

  // До цикла не должно оставаться ссылок на узел Loop Over Items / $json.article_id.
  const PRE_LOOP = ['MCP list_sessions', 'Pick Session', 'MCP browser_login', 'MCP save_session', 'Code in JavaScript'];
  const loopRef = /\$\(\s*['"]Loop Over Items['"]\s*\)/;
  for (const name of PRE_LOOP) {
    const node = byName[name];
    if (!node) throw new Error('Нет ноды: ' + name);
    const blob = stringValues(node.parameters).join('\n');
    if (loopRef.test(blob)) throw new Error(name + ': осталась ссылка на $(), "Loop Over Items" до цикла');
    if (blob.includes('$json.article_id')) throw new Error(name + ': осталась ссылка на $json.article_id');
  }

  // Сессийные ноды идентифицируют вызов через email_id (уровень письма).
  for (const name of ['MCP list_sessions', 'MCP browser_login', 'MCP save_session']) {
    const ji = byName[name].parameters.jsonInput || '';
    if (!ji.includes('email_id')) throw new Error(name + ': jsonInput должен ссылаться на email_id');
  }

  // Новые jsCode на месте.
  if (!(byName['Pick Session'].parameters.jsCode || '').includes('details[0]')) {
    throw new Error('Pick Session: не тот jsCode (нет выбора по details[0])');
  }
  if (!byName['Code in JavaScript'].parameters.jsCode.includes('$(' + '"If"' + ')')) {
    throw new Error('Code in JavaScript: не тот jsCode (нет чтения из If)');
  }

  // Все $('...') / $() -ссылки указывают на существующие ноды.
  const refRe = /\$\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const n of wf.nodes) {
    const blob = stringValues(n.parameters).join('\n');
    let m;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(blob))) {
      if (!names.has(m[1])) throw new Error(n.name + ': ссылка на несуществующую ноду $(' + m[1] + ')');
    }
  }

  return {
    nodeCount: wf.nodes.length,
    chain:
      'If → MCP list_sessions → Pick Session → MCP browser_login → MCP save_session → ' +
      'Code in JavaScript → Loop Over Items → MCP fetch_markdown → ...',
  };
}

// ---------------------------------------------------------------------------
// Режим проверки скачанного из n8n workflow
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const vIdx = args.indexOf('--verify');
if (vIdx !== -1) {
  const wf = JSON.parse(fs.readFileSync(args[vIdx + 1], 'utf8'));
  const res = validate(wf);
  console.log('VERIFY OK:', args[vIdx + 1], '| нод:', res.nodeCount);
  console.log('Цепочка:', res.chain);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Сборка Medium Agent v3 из экспорта v2
// ---------------------------------------------------------------------------
const src = JSON.parse(fs.readFileSync(SRC_PATH, 'utf8'));

src.name = NEW_NAME;
// Поле description не принимается REST API n8n (400: Unrecognized key), поэтому
// в payload оно не включается — назначение зафиксировано в комментариях скрипта.

// 1) Связи: цепочка сессий переносится между If и Code in JavaScript.
const link = (node) => ({ node, type: 'main', index: 0 });
src.connections['If'].main[0] = [link('MCP list_sessions')];
src.connections['MCP save_session'].main[0] = [link('Code in JavaScript')];
src.connections['Loop Over Items'].main[1] = [link('MCP fetch_markdown')];

// 2) jsonInput: вместо статьи цикла — идентификатор уровня письма.
const byName = Object.fromEntries(src.nodes.map((n) => [n.name, n]));
const need = (name) => {
  if (!byName[name]) throw new Error('Нет ноды: ' + name);
  return byName[name];
};
need('MCP list_sessions').parameters.jsonInput =
  "={{ JSON.stringify({ article_id: ($json.output.email_id ?? 'email') + '-0' }) }}";
const sessionInput =
  "={{ JSON.stringify({ service_id: $('Pick Session').first().json.service_id, " +
  "article_id: ($('If').first().json.output.email_id ?? 'email') + '-0' }) }}";
need('MCP browser_login').parameters.jsonInput = sessionInput;
need('MCP save_session').parameters.jsonInput = sessionInput;

// 3) Новые jsCode (чтение из файлов — по прецеденту workflows/parse_evaluator_output.js).
need('Pick Session').parameters.jsCode = fs.readFileSync(PICK_PATH, 'utf8').replace(/\s+$/, '');
need('Code in JavaScript').parameters.jsCode = fs.readFileSync(SPLIT_PATH, 'utf8').replace(/\s+$/, '');

// 4) Позиции перенесённых нод — свободный ряд выше триггеров.
need('MCP list_sessions').position = [-224, -440];
need('Pick Session').position = [0, -440];
need('MCP browser_login').position = [224, -440];
need('MCP save_session').position = [448, -440];

// 5) Payload в формате, принимаемом REST API (см. build_medium_agent_copy.cjs).
const payload = {
  name: src.name,
  nodes: src.nodes,
  connections: src.connections,
  settings: src.settings,
};

const res = validate(payload);
fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
console.log('Собрано. Нод:', res.nodeCount, '| файл:', OUT_PATH);
console.log('Цепочка:', res.chain);