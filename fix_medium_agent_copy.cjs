// fix_medium_agent_copy.cjs
// Правит workflow "Medium Agent main copy" в n8n (id по умолчанию ioZNo5bkS04OIiAL).
//
// Что исправляется:
//   1) AI Agent1 больше не «оценивает загрузку» и не отправляет письма.
//      Из системного промпта убраны правила про fetch_ok/fetch_error и отправку email,
//      из шаблона пользовательского сообщения — поля fetch_ok/fetch_error/document_id,
//      а сам агент лишён Gmail-инструмента (LLM выдумывал письма об ошибке даже при
//      успешной загрузке статьи; воспроизведено локально на Qwen3.5-9B).
//   2) Письмо об ошибке отправляет ТОЛЬКО workflow и ТОЛЬКО когда fetch_markdown реально
//      не смог отдать текст: новая нода-IF "Fetch OK?" -> "Send Error Email" (обычная
//      Gmail-нода вместо AI-инструмента). Статья, не прошедшая порог score, письма не шлёт.
//   3) Parse Evaluator Output больше не верит status из ответа LLM: статус вычисляется
//      из фактического fetch_ok и суммы критериев.
//   4) MCP fetch_markdown получил retryOnFail + error output, поэтому сбой MCP
//      превращается в fetch_error, а не в падение всего запуска.
//
// Запуск:
//   node fix_medium_agent_copy.cjs            # применить (GET -> patch -> PUT)
//   node fix_medium_agent_copy.cjs --dry-run  # показать план без записи
//   node fix_medium_agent_copy.cjs --id <workflowId>
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const OUT_PATH = path.join(ROOT, 'workflows', 'Medium Agent main copy.json');
const BACKUP_DIR = path.join(ROOT, 'workflows', 'backup');
const SETTINGS_PATH =
  'C:/Users/chaos/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const idIdx = args.indexOf('--id');
const WORKFLOW_ID = idIdx === -1 ? 'ioZNo5bkS04OIiAL' : args[idIdx + 1];

// Обрезка текста, отдаваемого 9B-модели, чтобы не выйти за размер контекста.
const MAX_MARKDOWN_CHARS = 60000;

// Идентификатор новой ноды-IF (фиксирован, чтобы повторный запуск скрипта не плодил ноды)
const FETCH_OK_NODE_ID = 'b7f1c1a4-9d2e-4c3b-8f10-5a6c7d8e9f01';

// ---------------------------------------------------------------------------
// Новый системный промпт AI Agent1: только оценка, без email и без fetch_error
// ---------------------------------------------------------------------------
const EVAL_SYSTEM_LINES = [
  '# РОЛЬ',
  'Ты — оценщик технических статей для локальной базы знаний (n8n + MCP web-proxy).',
  'Текст статьи уже загружен workflow и полностью приведён в сообщении пользователя:',
  'метаданные статьи + раздел «ТЕКСТ СТАТЬИ (markdown)».',
  'У тебя нет инструментов и нет доступа к сети: загружать статью не нужно и невозможно.',
  '',
  '# ЗАДАЧА',
  'Оцени статью по пяти критериям, каждый от 0 до 2:',
  '- relevance: отношение к локальным LLM, AI-агентам, MCP, n8n, RAG, автоматизации и домашней инфраструктуре;',
  '- practicality: наличие пошаговых действий и применимых рекомендаций;',
  '- technical_depth: архитектурные и технические детали;',
  '- reproducibility: наличие команд, кода, конфигурации или проверяемого процесса;',
  '- originality: наличие нового полезного опыта, а не общих советов.',
  '',
  '# ЧТО ПОВЫШАЕТ ОЦЕНКУ',
  'команды терминала и конфиги; исходный код; настройка локальных LLM (llama.cpp, Ollama, LM Studio);',
  'open-source MCP-серверы и их интеграция; практические советы по n8n; RAG (архитектура, векторные БД, chunking);',
  'AI-агенты и мультиагентные системы; prompt-engineering; OCR; SDD/Text-to-SQL; пошаговые инструкции;',
  'описание архитектуры со схемами; полезные обсуждения в комментариях.',
  '',
  '# ЧТО ПОНИЖАЕТ ОЦЕНКУ',
  'маркетинг и новости без практических деталей; «мысли вслух» и философия без практики;',
  'банальные советы; чистая теория без примеров; повторение общеизвестного; короткие посты без содержания.',
  '# КАЛИБРОВКА БАЛЛОВ (не завышай)',
  '2 ставь только за явные проверяемые детали, а не за интересную тему.',
  '0 — признака нет; 1 — есть частично или поверхностно; 2 — есть конкретно и применимо.',
  'Ориентиры по итоговой сумме:',
  '- 9-10: есть код/команды/конфиги, которые можно выполнить и проверить;',
  '- 7-8: есть понятная пошаговая методика или архитектура с техническими деталями;',
  '- 5-6: полезные идеи и структура, но без воспроизводимых деталей;',
  '- 3-4: обзор или новость с отдельными техническими деталями;',
  '- 0-2: маркетинг, рассуждения, философия, вода.',
  'Если в статье нет ни одного конкретного факта (команды, параметра, значения, названия инструмента) — practicality и reproducibility не выше 0.',
  '',

  '',
  '# ФОРМАТ ОТВЕТА',
  'Верни СТРОГО один JSON-объект: без текста до и после, без markdown-обёрток, без пояснений.',
  '{',
  '  "relevance": 2,',
  '  "practicality": 2,',
  '  "technical_depth": 2,',
  '  "reproducibility": 1,',
  '  "originality": 1,',
  '  "tags": ["RAG", "локальные-LLM"],',
  '  "summary_ru": "Развёрнутое резюме на русском языке, 3-5 предложений.",',
  '  "has_code": true,',
  '  "programm_language": ["python"],',
  '  "has_discussion": true',
  '}',
  '',
  '# ЗАПРЕТЫ И ПРАВИЛА',
  '1. Только итоговый JSON: никаких рассуждений, планов и пояснений, никаких обёрток ```json.',
  '2. НИКОГДА не добавляй поля article_id, document_id, original_url, service_id, status, email_id, score, accepted, action_taken, error_details — их подставляет workflow. Лишнее поле считается ошибкой.',
  '3. Никогда не выдумывай URL, названия, идентификаторы и факты: используй только то, что есть в тексте статьи. Если данных нет — не упоминай их.',
  '4. Если раздел «ТЕКСТ СТАТЬИ» пуст или содержит только заголовок, автора и навигацию — верни все пять критериев 0, tags [], has_code false, programm_language [], has_discussion false, summary_ru "Текст статьи отсутствует или не содержит содержательного контента.".',
  '5. Сумму баллов (score) не считай и не возвращай — её считает workflow.',
  '6. Письма и уведомления не отправляй: у тебя нет для этого инструментов, отправкой занимается workflow.',
];
const EVAL_SYSTEM = '=' + EVAL_SYSTEM_LINES.join('\n');



// ---------------------------------------------------------------------------
// Новый шаблон сообщения AI Agent1: метаданные + полный текст статьи
// ---------------------------------------------------------------------------
const META_LINE =
  '{"title":{{ JSON.stringify($json.title ?? null) }},"author":{{ JSON.stringify($json.author ?? null) }}' +
  ',"source":{{ JSON.stringify($json.source ?? null) }},"original_url":{{ JSON.stringify($json.original_url ?? null) }}' +
  ',"language":{{ JSON.stringify($json.language ?? null) }},"text_chars":{{ $json.markdown_chars }}' +
  ',"truncated":{{ $json.markdown_chars > ' + MAX_MARKDOWN_CHARS + ' }} }';

const MARKDOWN_EXPR =
  '{{ $json.markdown.length > ' + MAX_MARKDOWN_CHARS +
  ' ? $json.markdown.slice(0, ' + MAX_MARKDOWN_CHARS +
  ') + "\\n\\n[... текст статьи обрезан на ' + MAX_MARKDOWN_CHARS +
  ' символах ...]" : $json.markdown }}';

const EVAL_TEXT_LINES = [
  'Оцени техническую статью. Полный текст статьи уже загружен workflow и приведён ниже — загружать ничего не нужно.',
  '',
  'Метаданные статьи:',
  META_LINE,
  '',
  'ТЕКСТ СТАТЬИ (markdown):',
  MARKDOWN_EXPR,
  '',
  'КОНЕЦ ТЕКСТА СТАТЬИ. Верни только JSON-оценку по схеме из системного сообщения.',
];
const EVAL_TEXT = '=' + EVAL_TEXT_LINES.join('\n');

// ---------------------------------------------------------------------------
// Письмо об ошибке загрузки — отправляет workflow, а не LLM
// ---------------------------------------------------------------------------
const ERROR_EMAIL_SUBJECT = '=Ошибка загрузки статьи: {{ $json.title ?? $json.original_url }}';
const ERROR_EMAIL_MESSAGE = '=' + [
  'Не удалось загрузить текст статьи, поэтому оценка и индексация не выполнялись.',
  '',
  'Название: {{ $json.title ?? "—" }}',
  'Источник: {{ $json.source ?? "—" }}',
  'Автор: {{ $json.author ?? "—" }}',
  'URL: {{ $json.original_url }}',
  'article_id: {{ $json.article_id }}',
  'document_id: {{ $json.document_id ?? "—" }}',
  'service_id: {{ $json.service_id ?? "—" }}',
  'HTTP статус загрузки: {{ $json.fetched_status ?? "—" }}',
  'Ошибка: {{ $json.fetch_error ?? "неизвестная ошибка" }}',
  '',
  'Execution: {{ $execution.id }} | {{ $now.toISO() }}',
].join('\n');

// ---------------------------------------------------------------------------
// Новый код ноды Parse Evaluator Output.
// Статус статьи определяет ТОЛЬКО workflow: fetch_ok из Build Eval Input и
// сумма критериев из ответа LLM. Ответу LLM по status/accepted не доверяем.
// ---------------------------------------------------------------------------
const PARSE_EVAL_CODE = [
  '// Нормализуем ответ агента-оценщика и определяем судьбу статьи.',
  '// status/accepted/action_taken вычисляет ТОЛЬКО workflow: LLM их прислать не может.',
  'function parseAgentJson(raw) {',
  '  if (raw && typeof raw === "object") return raw;',
  '  if (typeof raw !== "string") return null;',
  '  let s = raw.trim();',
  '  try { return JSON.parse(s); } catch (e) {}',
  '  s = s.replace(/^```(?:json)?\\s*/i, "").replace(/```\\s*$/, "").trim();',
  '  try { return JSON.parse(s); } catch (e) {}',
  '  const start = s.indexOf("{");',
  '  const end = s.lastIndexOf("}");',
  '  if (start !== -1 && end > start) {',
  '    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}',
  '  }',
  '  return null;',
  '}',
  '',
  'const item = $input.first();',
  'const raw = item.json.output ?? item.json;',
  '',
  '// Метаданные берём ТОЛЬКО из данных workflow, из ответа LLM — только оценку.',
  'const loopItem = $("Loop Over Items").first().json;',
  'let evalItem = {};',
  'try { evalItem = $("Build Eval Input").first().json ?? {}; } catch (e) { evalItem = {}; }',
  'const fetchOk = evalItem.fetch_ok === true;',
  '',
  'const data = parseAgentJson(raw);',
  'const llmFailed = !(data && typeof data === "object");',
  '',
  'const result = {',
  '  article_id: loopItem.article_id,',
  '  document_id: evalItem.document_id ?? loopItem.document_id ?? null,',
  '  email_id: loopItem.email_id,',
  '  title: loopItem.title,',
  '  author: loopItem.author ?? null,',
  '  source: loopItem.source ?? null,',
  '  original_url: loopItem.original_url,',
  '  language: loopItem.language ?? "en",',
  '  processed_date: loopItem.processed_date ?? null,',
  '  service_id: evalItem.service_id ?? null,',
  '  markdown_chars: evalItem.markdown_chars ?? null,',
  '};',
  '',
  '// Из ответа LLM переносим только поля оценки (белый список)',
  'const LLM_FIELDS = [',
  '  "relevance", "practicality", "technical_depth", "reproducibility", "originality",',
  '  "tags", "summary_ru", "has_code", "programm_language", "has_discussion",',
  '];',
  'if (data && typeof data === "object") {',
  '  for (const key of LLM_FIELDS) {',
  '    if (data[key] !== undefined) result[key] = data[key];',
  '  }',
  '  const llmScore = Number(data.score);',
  '  if (Number.isFinite(llmScore)) result.llm_score = llmScore;',
  '  const note = [data.status, data.error_details].filter((v) => typeof v === "string" && v).join(": ");',
  '  if (note) result.llm_note = note;',
  '}',
  '',
  '// Сумму баллов считаем сами как сумму пяти критериев (каждый 0..2)',
  'const criteriaKeys = ["relevance", "practicality", "technical_depth", "reproducibility", "originality"];',
  'const criteria = criteriaKeys.map((k) => Number(result[k]));',
  'if (criteria.every((v) => Number.isFinite(v))) {',
  '  let sum = 0;',
  '  criteriaKeys.forEach((k, i) => {',
  '    const v = Math.max(0, Math.min(2, criteria[i]));',
  '    result[k] = v;',
  '    sum += v;',
  '  });',
  '  result.score = sum;',
  '} else {',
  '  const s = Number(result.score);',
  '  result.score = Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 0;',
  '}',
  '',
  'result.tags = Array.isArray(result.tags) ? result.tags.slice(0, 6) : [];',
  'result.has_code = result.has_code === true;',
  'result.programm_language = Array.isArray(result.programm_language) ? result.programm_language : [];',
  'result.has_discussion = result.has_discussion === true;',
  'result.summary_ru = typeof result.summary_ru === "string" ? result.summary_ru : "";',
  '',
  '// Статус определяет workflow, а не LLM',
  'let accepted = false;',
  'if (!fetchOk) {',
  '  result.status = "fetch_error";',
  '  result.score = 0;',
  '  result.error_details = evalItem.fetch_error || "не удалось загрузить текст статьи";',
  '} else if (llmFailed) {',
  '  result.status = "llm_error";',
  '  result.score = 0;',
  '  result.error_details = typeof raw === "string" ? raw.slice(0, 300) : "пустой ответ агента-оценщика";',
  '} else if (result.score >= 6 && result.document_id) {',
  '  result.status = "successfully_processed";',
  '  result.action_taken = "original_saved";',
  '  result.error_details = null;',
  '  accepted = true;',
  '} else {',
  '  result.status = "skipped_low_score";',
  '  result.action_taken = "skipped";',
  '  result.error_details = null;',
  '}',
  'result.accepted = accepted;',
  '',
  'return [{ json: result }];',
].join('\n');


// ---------------------------------------------------------------------------
// Правка графа и нод
// ---------------------------------------------------------------------------
const link = (name, index) => ({ node: name, type: 'main', index: index ?? 0 });

function patchWorkflow(wf) {
  const nodes = JSON.parse(JSON.stringify(wf.nodes));
  const connections = JSON.parse(JSON.stringify(wf.connections || {}));
  const log = [];
  const find = (name) => {
    const n = nodes.find((x) => x.name === name);
    if (!n) throw new Error('нода не найдена: ' + name);
    return n;
  };

  // 1. AI Agent1 — только оценка статьи: ни инструментов, ни правил про письма
  const agent1 = find('AI Agent1');
  agent1.parameters.text = EVAL_TEXT;
  agent1.parameters.options = { systemMessage: EVAL_SYSTEM };
  log.push('AI Agent1: новый промпт (оценка без email/fetch_error), options перезаписаны');

  // 2. Снимаем Gmail-инструмент с агента: LLM больше не может «выдумать» письмо
  if (connections['Send a message in Gmail']) {
    delete connections['Send a message in Gmail'];
    log.push('AI Agent1: удалён ai_tool "Send a message in Gmail"');
  } else {
    log.push('[warn] связь ai_tool "Send a message in Gmail" уже отсутствует');
  }

  // 3. Gmail-инструмент -> обычная Gmail-нода с детерминированным письмом
  const mail = find('Send a message in Gmail');
  mail.name = 'Send Error Email';
  mail.type = 'n8n-nodes-base.gmail';
  mail.typeVersion = 2.2;
  mail.position = [2576, 1104];
  mail.parameters = {
    resource: 'message',
    operation: 'send',
    sendTo: 'rev1_71@mail.ru',
    subject: ERROR_EMAIL_SUBJECT,
    emailType: 'text',
    message: ERROR_EMAIL_MESSAGE,
    options: {},
  };
  log.push('"Send a message in Gmail" -> "Send Error Email" (gmail v2.2, operation=send, текст)');

  // 4. Новая нода-развилка: fetch_ok?
  if (!nodes.some((n) => n.name === 'Fetch OK?')) {
    nodes.push({
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
          conditions: [
            {
              id: 'c1a2b3d4-0001-4000-8000-000000000001',
              leftValue: '={{ $json.fetch_ok }}',
              rightValue: '',
              operator: { type: 'boolean', operation: 'true', singleValue: true },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.3,
      position: [2576, 912],
      id: FETCH_OK_NODE_ID,
      name: 'Fetch OK?',
    });
    log.push('добавлена нода-развилка "Fetch OK?" (boolean: {{ $json.fetch_ok }} === true)');
  } else {
    log.push('[warn] нода "Fetch OK?" уже есть — пропускаю добавление');
  }

  // 5. Переключение связей: загрузка -> развилка -> оценка/письмо
  connections['Build Eval Input'] = { main: [[link('Fetch OK?')]] };
  connections['Fetch OK?'] = { main: [[link('AI Agent1')], [link('Send Error Email')]] };
  connections['Send Error Email'] = { main: [[link('Loop Over Items')]] };
  // 6. Ошибка MCP на error-выходе fetch_markdown тоже идёт в Build Eval Input (fetch_ok=false)
  connections['MCP fetch_markdown'] = { main: [[link('Build Eval Input')], [link('Build Eval Input')]] };
  log.push('связи: Build Eval Input -> Fetch OK? -> AI Agent1 | Send Error Email -> Loop Over Items');
  log.push('связи: MCP fetch_markdown error output -> Build Eval Input');

  // 7. Fetch OK? false прекращает оценку: статус и письмо отдаём workflow
  const evalCode = find('Parse Evaluator Output');
  evalCode.parameters.jsCode = PARSE_EVAL_CODE;
  log.push('Parse Evaluator Output: статус считается из fetch_ok и суммы критериев (LLM не решает)');

  // 8. Устойчивость загрузки: повтор и error output вместо падения запуска
  const fetchNode = find('MCP fetch_markdown');
  fetchNode.onError = 'continueErrorOutput';
  fetchNode.retryOnFail = true;
  fetchNode.maxTries = 2;
  fetchNode.waitBetweenTries = 3000;
  log.push('MCP fetch_markdown: retryOnFail=true(maxTries=2), onError=continueErrorOutput');

  // Проверки целостности
  const names = new Set(nodes.map((n) => n.name));
  if (names.size !== nodes.length) throw new Error('дубликаты имён нод после патча');
  for (const [from, outputs] of Object.entries(connections)) {
    if (!names.has(from)) throw new Error('связь от несуществующей ноды: ' + from);
    for (const arr of Object.values(outputs)) {
      for (const conns of arr) {
        for (const c of conns) {
          if (!names.has(c.node)) throw new Error('связь ' + from + ' -> несуществующая нода ' + c.node);
        }
      }
    }
  }
  return { nodes, connections, log };
}

// ---------------------------------------------------------------------------
// REST: GET / PUT с лестницей settings (n8n подставляет binaryMode в GET, но
// отклоняет его в PUT: "request/body/settings must NOT have additional properties")
// ---------------------------------------------------------------------------
const SETTINGS_ALLOWLIST = [
  'executionOrder', 'availableInMCP', 'timezone', 'errorWorkflow',
  'saveDataErrorExecution', 'saveDataSuccessExecution', 'saveManualExecutions',
  'saveExecutionProgress', 'callerPolicy', 'callerIds',
];

function settingsLadder(getSettings) {
  const base = Object.assign({}, getSettings || {});
  delete base.binaryMode;
  const allow = {};
  for (const k of SETTINGS_ALLOWLIST) if (k in base) allow[k] = base[k];
  const list = [base, allow,
    'executionOrder' in base ? { executionOrder: base.executionOrder } : {}, {}];
  const seen = new Set();
  return list.filter((s) => {
    const j = JSON.stringify(s);
    if (seen.has(j)) return false;
    seen.add(j);
    return true;
  });
}

// --print: выгрузить итоговые промпты/код в файлы, не обращаясь к n8n.
// (process.exit + pipe обрезает stdout, поэтому пишем файлы и завершаемся)
if (args.includes('--print')) {
  const promptPath = path.join(ROOT, 'workflows', 'prompt_ai_agent1_evaluator.md');
  const codePath = path.join(ROOT, 'workflows', 'parse_evaluator_output.js');
  fs.writeFileSync(promptPath,
    '<!-- AI Agent1: systemMessage (options.systemMessage) -->\n' +
    EVAL_SYSTEM.replace(/^=/, '') + '\n\n' +
    '<!-- AI Agent1: text (шаблон сообщения) -->\n' +
    EVAL_TEXT.replace(/^=/, '') + '\n\n' +
    '<!-- Send Error Email -->\n' +
    'subject: ' + ERROR_EMAIL_SUBJECT.replace(/^=/, '') + '\n\n' + ERROR_EMAIL_MESSAGE.replace(/^=/, '') + '\n',
    'utf8');
  fs.writeFileSync(codePath, PARSE_EVAL_CODE + '\n', 'utf8');
  process.stdout.write('written: ' + promptPath + '\nwritten: ' + codePath + '\n');
  process.exit(0);
}

const mcpSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
const env = mcpSettings.mcpServers['n8n-workflow-builder'].env;
const BASE = (env.N8N_HOST || 'http://192.168.88.221:5678/api/v1').replace(/\/+$/, '');
const API_KEY = env.N8N_API_KEY;
if (!API_KEY) throw new Error('N8N_API_KEY не найден в mcp_settings.json');

const HEADERS = { 'X-N8N-API-KEY': API_KEY, 'Content-Type': 'application/json', accept: 'application/json' };

async function getWorkflow(id) {
  const r = await fetch(BASE + '/workflows/' + id, { headers: HEADERS });
  const j = await r.json();
  if (!r.ok || !j || !j.id) throw new Error('workflow не прочитан: HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}

(async () => {
  const wf = await getWorkflow(WORKFLOW_ID);
  console.log('workflow: ' + wf.id + ' "' + wf.name + '" versionId=' + wf.versionId +
    ' нод=' + wf.nodes.length);
  const { nodes, connections, log } = patchWorkflow(wf);
  console.log('изменения:');
  console.log(log.map((l) => '  - ' + l).join('\n'));
  console.log('нод после патча: ' + nodes.length);

  // Локальная копия (в том же формате, что build_medium_agent_copy.cjs)
  const local = { name: wf.name, nodes, connections, settings: { executionOrder: 'v1' } };
  const hasPin = wf.pinData && Object.keys(wf.pinData).length > 0;
  if (hasPin) local.pinData = wf.pinData;

  if (DRY_RUN) {
    console.log('\nDRY-RUN: запись в n8n не выполнялась.');
    console.log('было бы записано: ' + OUT_PATH);
    console.log('PUT settings (попытка 1): ' + JSON.stringify(local.settings));
    console.log('pinData: ' + (hasPin ? Object.keys(wf.pinData).join(', ') : 'нет'));
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, 'Medium Agent main copy.' + wf.versionId + '.json');
  fs.writeFileSync(backupPath, JSON.stringify(wf, null, 2), 'utf8');
  fs.writeFileSync(OUT_PATH, JSON.stringify(local, null, 2), 'utf8');
  console.log('бэкап: ' + backupPath);
  console.log('локальная копия: ' + OUT_PATH);

  const bodyCore = { name: wf.name, nodes, connections };
  if (wf.staticData !== undefined && wf.staticData !== null) bodyCore.staticData = wf.staticData;
  const cores = hasPin
    ? [Object.assign({}, bodyCore, { pinData: wf.pinData }), bodyCore]
    : [bodyCore];
  const attempts = [].concat(...cores.map((core) =>
    settingsLadder(wf.settings).map((s) => Object.assign({}, core, { settings: s }))));

  let lastErr = '';
  for (const body of attempts) {
    const r = await fetch(BASE + '/workflows/' + WORKFLOW_ID, {
      method: 'PUT', headers: HEADERS, body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (r.ok) {
      let saved = {};
      try { saved = JSON.parse(txt); } catch (e) { /* пустой ответ */ }
      console.log('\nOK: PUT ' + r.status + ', versionId ' + wf.versionId + ' -> ' + (saved.versionId || '?'));
      console.log('settings отправлены: ' + JSON.stringify(body.settings));
      const check = await getWorkflow(WORKFLOW_ID);
      const names = check.nodes.map((n) => n.name);
      console.log('\nпроверка сохранённого workflow:');
      console.log('  нод: ' + check.nodes.length + ' | Fetch OK?: ' + names.includes('Fetch OK?') +
        ' | Send Error Email: ' + names.includes('Send Error Email'));
      console.log('  connections["Build Eval Input"]: ' + JSON.stringify(check.connections['Build Eval Input']));
      console.log('  connections["Fetch OK?"]: ' + JSON.stringify(check.connections['Fetch OK?']));
      console.log('  connections["MCP fetch_markdown"]: ' + JSON.stringify(check.connections['MCP fetch_markdown']));
      console.log('  ai_tool у "Send Error Email": ' + JSON.stringify((check.connections['Send Error Email'] || {}).ai_tool));
      const a1 = check.nodes.find((n) => n.name === 'AI Agent1');
      console.log('  AI Agent1 options.systemMessage содержит "fetch_error": ' +
        /fetch_error/.test(a1.parameters.options.systemMessage));
      const pe = check.nodes.find((n) => n.name === 'Parse Evaluator Output');
      console.log('  Parse Evaluator Output доверяет data.status: ' +
        /data\.status === "fetch_error"/.test(pe.parameters.jsCode));
      return;
    }
    lastErr = r.status + ' ' + txt.slice(0, 300);
    const settings400 = r.status === 400 && /settings must NOT have additional properties/.test(txt);
    if (!settings400) throw new Error('PUT не принят: ' + lastErr);
    console.error('[retry] 400 на settings=' + JSON.stringify(body.settings));
  }
  throw new Error('PUT не удался ни с одной попыткой settings; последняя: ' + lastErr);
})().catch((e) => {
  console.error('СБОЙ: ' + e.message);
  process.exit(1);
});

