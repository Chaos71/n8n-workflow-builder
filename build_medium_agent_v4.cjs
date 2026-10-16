// build_medium_agent_v4.cjs — создаёт "Medium Agent v4" как копию "Medium Agent v3"
// с исправлением зависания на узле Loop Over Items для писем без интересных статей.
//
// КОРНЕВАЯ ПРИЧИНА (execution #1567 / #1563):
//   AI Agent вернул { status: "processed", details: [] } для письма без статей.
//   Узел "If" проверял ТОЛЬКО status == "processed" -> пропускал дальше,
//   "Code in JavaScript" разворачивал details: [] -> возвращал 0 items,
//   "Loop Over Items" получал пустой датасет и НЕ выполнялся,
//   под-workflow возвращал вызывающему 0 items,
//   родительский Loop Over Items (Backfill на 15 писем) получал 0 items и замирал.
//
// ИСПРАВЛЕНИЕ:
//   1) "If" получает второе условие (and): length(details) > 0.
//   2) Новый терминальный узел "Build Skip Result" (Code) возвращает РОВНО 1 item,
//      чтобы вызывающий Loop Over Items получил данные и продолжил итерацию.
//   3) If output 1 (false) -> "Build Skip Result".
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'workflows', 'Medium-Agent-v3.json');
const DST = path.join(__dirname, 'workflows', 'Medium-Agent-v4.json');

const SKIP_NODE_NAME = 'Build Skip Result';
const SKIP_NODE_POSITION = [-608, 224];

const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// --- 0. Гигиена: оставляем только данные, нужные для создания нового workflow ---
for (const k of [
  'id', 'active', 'activeVersionId', 'activeVersion', 'createdAt', 'updatedAt',
  'isArchived', 'versionId', 'versionCounter', 'sourceWorkflowId', 'triggerCount',
  'shared', 'staticData', 'meta', 'nodeGroups', 'tags',
]) delete wf[k];

wf.name = 'Medium Agent v4';
// NB: n8n POST /workflows (strict schema) не принимает 'description' и 'tags' —
// описание устанавливается отдельным PATCH см. upload_v4.cjs.
delete wf.description;

// --- 1. Узел If: добавляем второе условие "есть хотя бы одна статья" ------------
const ifNode = wf.nodes.find((n) => n.name === 'If');
if (!ifNode) throw new Error('Узел "If" не найден');
if (ifNode.type !== 'n8n-nodes-base.if') throw new Error('Неожиданный тип узла "If"');

const conditions = ifNode.parameters.conditions;
if (conditions.conditions.length !== 1) {
  throw new Error('Ожидалось ровно 1 условие в "If", получено: ' + conditions.conditions.length);
}
conditions.combinator = 'and';
conditions.conditions.push({
  id: 'c4a91f7e-2f5d-4b8a-9a13-7e6c0d5b2a41',
  leftValue: '={{ (($json.output || {}).details || []).length > 0 }}',
  rightValue: '',
  operator: { type: 'boolean', operation: 'true', singleValue: true },
});

const codeNode = wf.nodes.find((n) => n.name === 'Code in JavaScript');
if (!codeNode) throw new Error('Узел "Code in JavaScript" не найден');
// --- 2. Новый терминальный узел "Build Skip Result" ----------------------------
const SKIP_JS = [
  '// v4: терминальный узел для писем, которые НЕ идут по конвейеру статей.',
  '// Сюда попадают оба случая (узел "If", combinator = and):',
  '//   1) status !== "processed"  — письмо отклонено фильтром домена/отправителя;',
  '//   2) status === "processed", но details пуст — интересных статей нет.',
  '//',
  '// ГЛАВНОЕ: узел возвращает РОВНО ОДИН item.',
  '// Раньше такая ветка заканчивалась пустым датасетом: "Code in JavaScript"',
  '// давал 0 items -> "Loop Over Items" не выполнялся -> под-workflow возвращал',
  '// вызывающему workflow 0 items -> родительский Loop Over Items замирал',
  '// (см. execution #1567 -> остановка Backfill-прогона #1563 на 4-м письме из 15).',
  'const src = $input.first().json;',
  'const out = src.output || src;',
  'const details = Array.isArray(out.details) ? out.details : [];',
  'const processedByAgent = out.status === "processed";',
  '',
  'return [',
  '  {',
  '    json: {',
  '      email_id: out.email_id || null,',
  '      status: out.status || "unknown",',
  '      sender_domain: out.sender_domain || null,',
  '      sender_email: out.sender_email || null,',
  '      articles_found: processedByAgent ? details.length : out.articles_found || 0,',
  '      action: processedByAgent ? "skipped_no_articles" : "skipped_filtered",',
  '      processed: false,',
  '      message: processedByAgent',
  "        ? 'Письмо обработано агентом, но интересных статей не найдено — конвейер пропущен.'",
  "        : 'Письмо отклонено фильтром (домен/отправитель не в разрешённом списке) — конвейер пропущен.',",
  '      execution_id: $execution.id,',
  '      timestamp: $now.toISO(),',
  '    },',
  '  },',
  '];',
  '',
].join('\n');

wf.nodes.push({
  parameters: { jsCode: SKIP_JS },
  id: 'b6e2d8c4-91a7-4f30-8e5b-3c9a71d04f26',
  name: SKIP_NODE_NAME,
  type: 'n8n-nodes-base.code',
  typeVersion: codeNode.typeVersion, // та же версия Code, что и у "Code in JavaScript"
  position: SKIP_NODE_POSITION,
});

// --- 3. Соединение: If output 1 (false) -> Build Skip Result -------------------
const ifConns = wf.connections['If'];
if (!ifConns || !Array.isArray(ifConns.main)) throw new Error('Нет connections у узла "If"');
while (ifConns.main.length < 2) ifConns.main.push([]);
if (!Array.isArray(ifConns.main[1])) ifConns.main[1] = [];
ifConns.main[1].push({ node: SKIP_NODE_NAME, type: 'main', index: 0 });

fs.writeFileSync(DST, JSON.stringify(wf, null, 2) + '\n', 'utf8');
console.log('OK written: ' + DST);

// ============================================================================
//                              В А Л И Д А Ц И Я
// ============================================================================
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name);
  else {
    failed++;
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

console.log('\n--- structure ---');
const v4 = JSON.parse(fs.readFileSync(DST, 'utf8'));
check('name === "Medium Agent v4"', v4.name === 'Medium Agent v4', v4.name);
check('node count === 35', v4.nodes.length === 35, v4.nodes.length);
const names = v4.nodes.map((n) => n.name);
check('unique node names', new Set(names).size === names.length);

const known = new Set(names);
const badConn = [];
for (const [src, outs] of Object.entries(v4.connections)) {
  if (!known.has(src)) badConn.push('missing source ' + src);
  for (const arr of Object.values(outs)) {
    for (const branch of arr || []) {
      for (const t of branch || []) if (t && !known.has(t.node)) badConn.push(src + ' -> ' + t.node);
    }
  }
}
check('all connection endpoints exist', badConn.length === 0, badConn.join(', '));
check('payload has no read-only "tags" key (n8n create -> 400)', !('tags' in v4), Object.keys(v4).join(','));

console.log('\n--- If node conditions ---');
const if2 = v4.nodes.find((n) => n.name === 'If');
const cc = if2.parameters.conditions;
check('combinator === and', cc.combinator === 'and', cc.combinator);
check('2 conditions', cc.conditions.length === 2, cc.conditions.length);
const c1 = cc.conditions[0];
const c2 = cc.conditions[1];
check('cond1 unchanged (status==processed)',
  c1.leftValue === '={{ $json.output.status }}' && c1.rightValue === 'processed' &&
  c1.operator.operation === 'equals', JSON.stringify(c1));
check('cond2 boolean/true singleValue',
  c2.operator.type === 'boolean' && c2.operator.operation === 'true' && c2.operator.singleValue === true,
  JSON.stringify(c2.operator));

// Вычисляем выражение условия так же, как это сделает n8n
function evalExpr(expr, json) {
  const body = expr.replace(/^=/, '').replace(/^\{\{/, '').replace(/\}\}$/, '');
  return new Function('$json', 'return (' + body + ');')(json);
}
const noArticles = { output: { email_id: 'e1', status: 'processed', articles_found: 0, details: [], errors: [] } };
const filtered   = { output: { email_id: 'e2', status: 'skipped', articles_found: 0, details: [], errors: [] } };
const withArt    = { output: { email_id: 'e3', status: 'processed', articles_found: 2, details: [{ title: 'a' }, { title: 'b' }], errors: [] } };
const noWrapper  = { email_id: 'e4', status: 'processed', details: [] };
const ifResult = (j) => evalExpr(c1.leftValue, j) && evalExpr(c2.leftValue, j);

check('FALSE for processed & 0 articles (exec #1567)', ifResult(noArticles) === false);
check('FALSE for filtered email', ifResult(filtered) === false);
check('TRUE for processed & 2 articles', ifResult(withArt) === true);
// cond1 ($json.output.status) в v3 небезопасен при отсутствии "output" — это его
// исходное поведение (всегда есть output), здесь проверяем только НОВОЕ условие.
check('NEW cond2 null-safe: no exception & FALSE without "output"',
  evalExpr(c2.leftValue, noWrapper) === false);
check('NEW cond2 null-safe: FALSE when details undefined',
  evalExpr(c2.leftValue, { output: { status: 'processed' } }) === false);
check('NEW cond2 TRUE when details has 1 element',
  evalExpr(c2.leftValue, { output: { status: 'processed', details: [{}] } }) === true);

console.log('\n--- Build Skip Result code node ---');
const skip = v4.nodes.find((n) => n.name === SKIP_NODE_NAME);
check('skip node exists', !!skip);
check('skip node type === code', !!skip && skip.type === 'n8n-nodes-base.code');
check('skip typeVersion matches "Code in JavaScript"', !!skip && skip.typeVersion === codeNode.typeVersion,
  skip && skip.typeVersion + ' vs ' + codeNode.typeVersion);

function runSkipNode(inputJson) {
  const shim = {
    $input: { first: () => ({ json: inputJson }) },
    $execution: { id: 4242 },
    $now: { toISO: () => '2026-10-15T00:00:00.000Z' },
  };
  const fn = new Function(...Object.keys(shim), skip.parameters.jsCode);
  return fn(...Object.values(shim));
}

const r1 = runSkipNode(noArticles);
check('exactly 1 item for no-articles email', Array.isArray(r1) && r1.length === 1, JSON.stringify(r1));
check('action === skipped_no_articles', r1[0].json.action === 'skipped_no_articles', r1[0].json.action);
check('email_id preserved', r1[0].json.email_id === 'e1', r1[0].json.email_id);
check('processed === false', r1[0].json.processed === false);
check('message is non-empty string', typeof r1[0].json.message === 'string' && r1[0].json.message.length > 0);
check('execution_id present', r1[0].json.execution_id === 4242);

const r2 = runSkipNode(filtered);
check('exactly 1 item for filtered email', Array.isArray(r2) && r2.length === 1, JSON.stringify(r2));
check('action === skipped_filtered', r2[0].json.action === 'skipped_filtered', r2[0].json.action);

const r3 = runSkipNode({ output: { email_id: 'e9', status: 'processed', articles_found: 3, details: [{}, {}, {}] } });
check('articles_found === 3 when details present', r3[0].json.articles_found === 3, r3[0].json.articles_found);

const r4 = runSkipNode(noWrapper);
check('works when payload has no "output" wrapper', Array.isArray(r4) && r4.length === 1, JSON.stringify(r4));

console.log('\n--- "Code in JavaScript" (не изменялся) ---');
const splitter = v4.nodes.find((n) => n.name === 'Code in JavaScript');
check('$("If") reference still valid', splitter.parameters.jsCode.includes('$("If")'));
function runSplitter(ifJson) {
  const shim = { $: () => ({ first: () => ({ json: ifJson }) }) };
  const fn = new Function(...Object.keys(shim), splitter.parameters.jsCode);
  return fn(...Object.values(shim));
}
check('splitter -> 2 items for 2 articles', runSplitter(withArt).length === 2, runSplitter(withArt).length);
check('splitter -> 0 items for 0 articles (unchanged)', runSplitter(noArticles).length === 0);

console.log('\n--- routing ---');
check('If true -> MCP list_sessions (unchanged)',
  (v4.connections['If'].main[0] || []).some((t) => t.node === 'MCP list_sessions'));
check('If false -> ' + SKIP_NODE_NAME,
  (v4.connections['If'].main[1] || []).some((t) => t.node === SKIP_NODE_NAME));
check('Build Skip Result has no outgoing connections',
  !v4.connections[SKIP_NODE_NAME]);
check('Loop Over Items: out1(loop)->MCP fetch_markdown, out0(done) unconnected',
  (v4.connections['Loop Over Items'].main[1] || []).some((t) => t.node === 'MCP fetch_markdown') &&
  (v4.connections['Loop Over Items'].main[0] || []).length === 0);

console.log('\n--- нетронутые ядровые узлы ---');
for (const n of ['Loop Over Items', 'AI Agent', 'AI Agent1', 'AI Agent2', 'Send Error Email',
  'MCP fetch_markdown', 'Gmail Trigger', 'When Executed by Another Workflow', 'Structured Output Parser']) {
  check(n + ' present', names.includes(n));
}
check('Gmail trigger credentials kept', !!v4.nodes.find((n) => n.name === 'Gmail Trigger').credentials);

console.log(failed === 0 ? '\nALL CHECKS PASSED' : '\n' + failed + ' CHECK(S) FAILED');
process.exit(failed === 0 ? 0 : 1);