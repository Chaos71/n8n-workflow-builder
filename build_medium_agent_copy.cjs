// build_medium_agent_copy.js
// Строит workflow "Medium Agent main copy" на основе "Medium Agent main"
// и создаёт его в n8n через REST API.
// Добавленные этапы: перевод статьи на русский (web-proxy MCP), сохранение
// перевода в NAS-архив, векторизация через mcp-rag (HTTP: start_indexing + polling).
// Запуск: node build_medium_agent_copy.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC_PATH = path.join(ROOT, 'workflows', 'Medium Agent main.json');
const OUT_PATH = path.join(ROOT, 'workflows', 'Medium Agent main copy.json');
const SETTINGS_PATH =
  'C:/Users/chaos/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json';

const src = JSON.parse(fs.readFileSync(SRC_PATH, 'utf8'));
const byName = Object.fromEntries(src.nodes.map((n) => [n.name, n]));

const uuid = () => crypto.randomUUID();

function cloneNode(name, position) {
  const node = JSON.parse(JSON.stringify(byName[name]));
  if (position) node.position = position;
  return node;
}

// ---------------------------------------------------------------------------
// Промпт агента-оценщика (AI Agent1): загрузка -> оценка -> сохранение оригинала
// ---------------------------------------------------------------------------
const EVAL_LINES = [
  '# РОЛЬ И КОНТЕКСТ',
  'Ты — агент оценки технических статей для локальной базы знаний (n8n + MCP web-proxy).',
  'На вход приходит ОДНА статья. Твоя задача:',
  '1. Загрузить содержимое статьи через MCP web-proxy.',
  '2. Оценить практическую ценность (score 0..10).',
  '3. При score >= 6 сохранить ОРИГИНАЛ статьи в архив знаний (NAS) через save_knowledge_article.',
  '4. Перевод выполняет ДРУГОЙ агент этого workflow — тебе переводить НЕ нужно.',
  '5. Вернуть СТРОГО валидный JSON, без какого-либо текста до или после.',
  '',
  '# ВХОДНЫЕ ДАННЫЕ',
  'На вход ты получаешь JSON со следующей структурой:',
  '{',
  '  "article_id": "Идентификатор статьи",',
  '  "document_id": "Идентификатор документа для сохранения (используй как есть)",',
  '  "email_id": "ID письма",',
  '  "title": "Заголовок",',
  '  "author": "Автор",',
  '  "source": "reddit|medium|linkedin|habr",',
  '  "original_url": "https://...",',
  '  "processed_date": "2026-07-12 12:45",',
  '  "language": "en",',
  '  "summary": "Краткое описание"',
  '}',
  '',
  '# АЛГОРИТМ РАБОТЫ (СТРОГО ПО ШАГАМ)',
  '',
  '## ШАГ 1: ЗАГРУЗКА КОНТЕНТА',
  '1.1. Вызови list_sessions → выбери service_id подходящей браузерной сессии (по домену статьи, иначе первую). Используй этот service_id во ВСЕХ последующих вызовах.',
  '1.2. Вызови browser_login (service_id, article_id) → дождись статуса browser_ready. Если вернул ошибку (например, Chrome не запущен) — не прерывай работу, продолжай.',
  '1.3. Вызови save_session (service_id, article_id).',
  '1.4. Вызови fetch_markdown (url = original_url из входа, service_id, article_id = document_id).',
  '   - Успех → переходи к ШАГУ 2.',
  '   - Ошибка или пустой результат → установи status = "fetch_error" и переходи к ШАГУ 4.',
  '',
  'ВАЖНО: Для Reddit загружай ТОЛЬКО основной пост и комментарии пользователей. Не переходи по внешним ссылкам внутри поста.',
];
EVAL_LINES.push(
  '',
  '## ШАГ 2: ОЦЕНКА ПРАКТИЧЕСКОЙ ЦЕННОСТИ',
  'Оцени статью по пяти критериям от 0 до 2:',
  '- relevance: отношение к локальным LLM, AI-агентам, MCP, n8n, RAG, автоматизации и домашней инфраструктуре;',
  '- practicality: наличие пошаговых действий и применимых рекомендаций;',
  '- technical_depth: архитектурные и технические детали;',
  '- reproducibility: наличие команд, кода, конфигурации или проверяемого процесса;',
  '- originality: наличие нового полезного опыта, а не общих советов.',
  'Итоговый score — сумма критериев от 0 до 10.',
  '',
  '### ПОЛЕЗНЫЙ МАТЕРИАЛ (повышают score):',
  '✅ команды терминала, конфигурационные файлы, исходный код (Python, JavaScript)',
  '✅ AI-разработка: настройка open-source агентов кодирования (OpenCode, Kilo Code)',
  '✅ Настройка локальных LLM (llama.cpp, Ollama, LM Studio)',
  '✅ Open-source MCP-серверы и их интеграция',
  '✅ Практические советы по n8n (workflow, интеграции)',
  '✅ OCR-технологии и их применение',
  '✅ AI-агенты (OpenClaw, мультиагентные системы)',
  '✅ Prompt-engineering (практические техники)',
  '✅ RAG (архитектура, векторные БД, chunking)',
  '✅ SDD (Spec-Driven Development), Text-To-SQL',
  '✅ Open-source инструменты для AI-разработки',
  '✅ Пошаговые инструкции по настройке, описание архитектуры с диаграммами',
  '✅ Навыки агентов SKILLS',
  '✅ Полезные обсуждения в комментариях (опыт пользователей, решения проблем)',
  '',
  '### КРИТЕРИИ БЕСПОЛЕЗНОСТИ (понижают score):',
  '❌ маркетинг, новости без практических деталей',
  '❌ "Мысли вслух", философские рассуждения без практики',
  '❌ Банальные советы ("используйте ChatGPT для написания текстов")',
  '❌ Маркетинговые материалы, новости компаний',
  '❌ Чисто теоретические статьи без примеров кода или инструкций',
  '❌ Повторение общеизвестных фактов',
  '❌ Короткие посты без содержательных комментариев',
  '',
  '### ПОРОГ СОХРАНЕНИЯ:',
  '- Score ≥ 6 → переходи к ШАГУ 3',
  '- Score < 6 → переходи к ШАГУ 4 со статусом "skipped_low_score"',
  '',
  '## ШАГ 3: СОХРАНЕНИЕ ОРИГИНАЛА (для score ≥ 6)',
  '3.1. Вызови cache_save_article:',
  '   - url = original_url, service_id, format = "markdown"',
  '   - content = ПОЛНЫЙ markdown-текст, полученный из fetch_markdown',
  '   - article_id = document_id',
  '3.2. Вызови save_knowledge_article с параметрами:',
  '   - document_id = document_id из входного JSON (ТОЧНО, не придумывай свой)',
  '   - original_url = original_url из входного JSON (ТОЧНО, без изменений — по нему сверяется перевод)',
  '   - original_language = language из входного JSON',
  '   - service_id = выбранный на шаге 1 service_id',
  '   - tags = 2-6 осмысленных тегов (например ["RAG", "локальные-LLM"])',
  '   - article_id = article_id из входного JSON',
  '   Если инструмент вернул ошибку → status = "save_error", error_details = текст ошибки, переходи к ШАГУ 4.',
  '',
  '## ШАГ 4: ФИНАЛЬНЫЙ ОТВЕТ',
  'Если была ошибка загрузки (fetch_error) — СНАЧАЛА отправь email через Gmail-инструмент:',
  '- to: rev1_71@mail.ru',
  '- subject: "Ошибка обработки статьи: <original_url>"',
  '- message: "Не удалось обработать статью. URL: <original_url>. Причина: <описание ошибки>"',
  '',
  'Затем верни СТРОГО JSON (без markdown-обёрток, без текста до/после):',
  '{',
  '  "article_id": "...",',
  '  "document_id": "...",',
  '  "status": "successfully_processed | skipped_low_score | fetch_error | save_error",',
  '  "title": "...",',
  '  "author": "...",',
  '  "source": "...",',
  '  "original_url": "https://...",',
  '  "processed_date": "YYYY-MM-DD HH:MM",',
  '  "language": "...",',
  '  "service_id": "использованный service_id или null",',
  '  "score": 8,',
  '  "tags": ["RAG", "MCP"],',
  '  "summary_ru": "Развёрнутое резюме на русском языке (3-5 предложений)",',
  '  "has_code": true,',
  '  "programm_language": ["python"],',
  '  "has_discussion": true,',
  '  "action_taken": "original_saved | skipped | error",',
  '  "error_details": null',
  '}',
  '',
  '# ПРАВИЛА',
  '1. document_id и original_url передавай в инструменты БЕЗ изменений — по ним связываются оригинал, перевод и векторный индекс.',
  '2. Используй инструменты последовательно, дождись ответа каждого перед вызовом следующего.',
  '3. Для Reddit загружай ТОЛЬКО пост + комментарии, не переходи по внешним ссылкам.',
  '4. Статус "successfully_processed" ставь ТОЛЬКО если save_knowledge_article вернул успех.',
  '5. Выводи ответ СТРОГО в формате JSON, без текста до или после, без markdown-обёрток.'
);
const EVAL_SYSTEM = '=' + EVAL_LINES.join('\n');

// ---------------------------------------------------------------------------
// Промпт агента-переводчика (AI Agent2): cache_get_article -> перевод -> save
// ---------------------------------------------------------------------------
const TRANSLATOR_LINES = [
  '# РОЛЬ И КОНТЕКСТ',
  'Ты — агент-переводчик технических статей для локальной базы знаний (n8n + MCP web-proxy).',
  'Оригинал статьи уже сохранён в архив знаний другим агентом. Твоя задача:',
  '1. Получить Markdown-текст оригинала статьи из кэша web-proxy.',
  '2. Перевести его на русский язык, сохранив Markdown-структуру.',
  '3. Сохранить перевод через save_knowledge_article_translation.',
  '4. Вернуть СТРОГО валидный JSON, без какого-либо текста до или после.',
  '',
  '# ВХОДНЫЕ ДАННЫЕ',
  'На вход ты получаешь JSON:',
  '{',
  '  "article_id": "Идентификатор статьи",',
  '  "document_id": "Идентификатор документа (папки) статьи в архиве",',
  '  "title": "Заголовок",',
  '  "original_url": "https://...",',
  '  "service_id": "Идентификатор браузерной сессии, использованной при загрузке оригинала",',
  '  "language": "en"',
  '}',
  '',
  '# АЛГОРИТМ РАБОТЫ (СТРОГО ПО ШАГАМ)',
  '',
  '## ШАГ 1: ПОЛУЧЕНИЕ ОРИГИНАЛА',
  '1.1. Вызови cache_get_article:',
  '   - url = original_url из входа (ТОЧНО)',
  '   - service_id = service_id из входа',
  '   - format = "markdown"',
  '   - article_id = document_id',
  '1.2. Если инструмент вернул ошибку (статьи нет в кэше) — сделай повторную загрузку:',
  '   1.2.1. Вызови list_sessions → выбери service_id (приоритет — service_id из входа, если он есть в списке).',
  '   1.2.2. Вызови browser_login (service_id), затем save_session (service_id).',
  '   1.2.3. Вызови fetch_markdown (url = original_url, service_id, article_id = document_id).',
  '1.3. Если и это не удалось → верни JSON со status = "translation_failed" и заполненным error_details, НЕ вызывая другие инструменты.',
  '',
  '## ШАГ 2: ПЕРЕВОД НА РУССКИЙ',
  'Переведи ПОЛНЫЙ текст Markdown статьи на русский язык:',
  '- Сохраняй структуру Markdown: заголовки (#), списки, таблицы, цитаты, горизонтальные линии.',
  '- Блоки кода и inline-код НЕ переводи (можно переводить только комментарии в коде, если они на английском).',
  '- Ссылки [текст](URL): URL оставляй без изменений, переводите только текст ссылки.',
  '- Технические термины и названия продуктов (RAG, pgvector, llama.cpp и т.п.) оставляй в оригинале; при первом упоминании можно добавить русский эквивалент в скобках.',
  '- НЕ сокращай текст, НЕ пересказывай, НЕ добавляй своих комментариев и примечаний вроде "Вот перевод статьи".',
  '- Если статья длинная — всё равно переводи ЦЕЛИКОМ, все разделы подряд.',
  '- Если исходная статья уже на русском — используй её текст как перевод без изменений.',
  '',
  '## ШАГ 3: СОХРАНЕНИЕ ПЕРЕВОДА',
  'Вызови save_knowledge_article_translation:',
  '- document_id = document_id из входа (ТОЧНО)',
  '- translation_markdown = ПОЛНЫЙ переведённый Markdown-текст из ШАГА 2',
  '- language = "ru"',
  '- original_url = original_url из входа (ТОЧНО — сверяется с манифестом статьи)',
  '- translator_model = "Qwen3.5-4B (llama-swap)"',
  '- article_id = article_id из входа',
  '- НЕ передавай параметр original_content_hash (сервис вычисляет хеш оригинала сам; передача любого значения, особенно пустого или из кэша, вызовет ошибку сверки)',
  'Если инструмент вернул ошибку → status = "translation_failed", error_details = текст ошибки.',
  '',
  '## ШАГ 4: ОТВЕТ',
  'Верни СТРОГО JSON, без текста до или после:',
  '{',
  '  "article_id": "...",',
  '  "document_id": "...",',
  '  "status": "translation_saved | translation_failed",',
  '  "ru_path": "ru/content.md",',
  '  "chars_translated": 12345,',
  '  "error_details": null',
  '}',
  '',
  'ВАЖНО: status = "translation_saved" ставь ТОЛЬКО если save_knowledge_article_translation вернул успешный результат (в ответе есть путь ru/content.md). Если инструмент вернул ошибку — СНАЧАЛА исправь аргументы и повтори вызов, и только если повторный вызов тоже не удался, верни status = "translation_failed" с текстом ошибки в error_details. НЕ выдумывай успех.',
  '',
  '# ПРАВИЛА',
  '1. document_id, original_url и service_id передавай в инструменты БЕЗ изменений.',
  '2. Перевод передавай в save_knowledge_article_translation ЦЕЛИКОМ одним вызовом, без сокращений.',
  '3. Не отправляй email и не выполняй действий сверх шагов 1-4.',
  '4. Выводи ответ СТРОГО в формате JSON, без текста до или после.',
];
const TRANSLATOR_SYSTEM = '=' + TRANSLATOR_LINES.join('\n');

// --emit-prompts: выгрузить свежие промпты в файлы (для put_workflow.js) и выйти
if (process.argv[2] === '--emit-prompts') {
  fs.writeFileSync(path.join(ROOT, 'workflows', 'evaluator_system.txt'), EVAL_SYSTEM, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'workflows', 'translator_system.txt'), TRANSLATOR_SYSTEM, 'utf8');
  console.log('Промпты выгружены: workflows/evaluator_system.txt, workflows/translator_system.txt');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Код-ноды
// ---------------------------------------------------------------------------
const FLATTEN_CODE = [
  '// Разворачиваем output.details каждого письма в отдельные n8n-items,',
  '// чтобы Loop Over Items мог обрабатывать статьи строго по одной.',
  '// (замена Split Out — здесь же присваиваем article_id и document_id)',
  'const results = [];',
  '',
  'for (const item of $input.all()) {',
  '  // Определяем, где лежат данные: напрямую в json или во вложенном output',
  '  const data = item.json.output ?? item.json;',
  '',
  '  const emailId = data.email_id;',
  '',
  '  if (Array.isArray(data.details)) {',
  '    data.details.forEach((detail, index) => {',
  '      const articleId = `${emailId}-${index}`;',
  '      results.push({',
  '        json: {',
  '          article_id: articleId,',
  '          document_id: articleId,',
  '          email_id: emailId,',
  '          ...detail',
  '        }',
  '      });',
  '    });',
  '  }',
  '}',
  '',
  'return results;',
].join('\n');

const PARSE_EVAL_CODE = [
  '// Нормализуем результат агента-оценщика: парсим JSON, переносим метаданные,',
  '// вычисляем флаг accepted (индексировать статью или пропустить).',
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
  'const data = parseAgentJson(raw);',
  'const loopItem = $("Loop Over Items").first().json;',
  '',
  'const result = {',
  '  article_id: loopItem.article_id,',
  '  document_id: loopItem.document_id,',
  '  email_id: loopItem.email_id,',
  '  title: loopItem.title,',
  '  author: loopItem.author ?? null,',
  '  source: loopItem.source ?? null,',
  '  original_url: loopItem.original_url,',
  '  language: loopItem.language ?? "en",',
  '  processed_date: loopItem.processed_date ?? null,',
  '};',
  '',
  'if (data && typeof data === "object") {',
  '  Object.assign(result, data);',
  '}',
  '',
  '// Гарантируем ключевые поля связи с NAS и векторным индексом (агент мог их потерять)',
  'result.article_id = result.article_id ?? loopItem.article_id;',
  'result.document_id = result.document_id ?? loopItem.document_id;',
  'result.original_url = result.original_url ?? loopItem.original_url;',
  'result.title = result.title ?? loopItem.title;',
  'result.status = result.status ?? "error";',
  'result.score = typeof result.score === "number" ? result.score : 0;',
  'result.service_id = result.service_id ?? null;',
  '',
  '// Индексируем только статьи, чей оригинал успешно сохранён в архив знаний (NAS)',
  'result.accepted = result.status === "successfully_processed" && Boolean(result.document_id);',
  '',
  'return [{ json: result }];',
].join('\n');

const PARSE_TRANSLATION_CODE = [
  '// Нормализуем результат агента-переводчика.',
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
  'const raw = $input.first().json.output ?? $input.first().json;',
  'const data = parseAgentJson(raw);',
  'const prev = $("Parse Evaluator Output").first().json;',
  '',
  'const result = Object.assign({}, prev, data && typeof data === "object" ? data : {});',
  '',
  'result.document_id = result.document_id ?? prev.document_id;',
  'result.original_url = result.original_url ?? prev.original_url;',
  '// Перевод мог не удаться — оригинал всё равно индексируем (ingest идемпотентен по языковым версиям)',
  'result.translation_status = result.status ?? "translation_failed";',
  '',
  'return [{ json: result }];',
].join('\n');

const PARSE_START_CODE = [
  '// Достаём payload MCP-инструмента start_indexing из JSON-RPC ответа mcp-rag.',
  'function extractToolPayload(r) {',
  '  const result = r && (r.result ?? r);',
  '  const content = result && result.content;',
  '  if (Array.isArray(content)) {',
  '    const textPart = content.find((c) => c && c.type === "text");',
  '    if (textPart && typeof textPart.text === "string") {',
  '      try {',
  '        return JSON.parse(textPart.text);',
  '      } catch (e) {',
  '        return { status: "failed", error: "Не удалось разобрать ответ mcp-rag" };',
  '      }',
  '    }',
  '  }',
  '  if (result && typeof result === "object" && ("status" in result || "error" in result)) {',
  '    return result;',
  '  }',
  '  return null;',
  '}',
  '',
  'const tool = extractToolPayload($input.first().json);',
  'const prev = $("Parse Translator Output").first().json;',
  '',
  'const requestStatus = (tool && tool.status) || "failed";',
  'const jobId = (tool && tool.job_id) ?? null;',
  '',
  'return [{',
  '  json: Object.assign({}, prev, {',
  '    index_request_status: requestStatus,',
  '    job_id: jobId,',
  '    has_job: jobId !== null && jobId !== undefined,',
  '    index_error: (tool && tool.error) || (tool ? null : "Пустой или невалидный ответ mcp-rag"),',
  '    poll_deadline: Date.now() + 30 * 60 * 1000,',
  '  }),',
  '}];',
].join('\n');

const PARSE_POLL_CODE = [
  '// Достаём payload MCP-инструмента get_index_job_status из JSON-RPC ответа',
  '// и решаем: индексация завершена (или лимит ожидания 30 мин исчерпан).',
  'function extractToolPayload(r) {',
  '  const result = r && (r.result ?? r);',
  '  const content = result && result.content;',
  '  if (Array.isArray(content)) {',
  '    const textPart = content.find((c) => c && c.type === "text");',
  '    if (textPart && typeof textPart.text === "string") {',
  '      try {',
  '        return JSON.parse(textPart.text);',
  '      } catch (e) {',
  '        return null;',
  '      }',
  '    }',
  '  }',
  '  if (result && typeof result === "object" && ("status" in result || "error" in result)) {',
  '    return result;',
  '  }',
  '  return null;',
  '}',
  '',
  'const tool = extractToolPayload($input.first().json);',
  'const startInfo = $("Parse Start Indexing").first().json;',
  '',
  'const jobStatus = (tool && tool.status) || "unknown";',
  'const terminalStatuses = ["completed", "failed", "not_found"];',
  'const timedOut = Date.now() > (startInfo.poll_deadline ?? 0);',
  'const done = terminalStatuses.includes(jobStatus) || timedOut;',
  '',
  'return [{',
  '  json: Object.assign({}, startInfo, {',
  '    job_status: jobStatus,',
  '    index_result: (tool && tool.result) ?? null,',
  '    index_duration_ms: (tool && tool.duration_ms) ?? null,',
  '    index_error: (tool && tool.error) || startInfo.index_error || null,',
  '    indexing_done: done,',
  '    polling_timed_out: timedOut && !terminalStatuses.includes(jobStatus),',
  '    polled_at: new Date().toISOString(),',
  '  }),',
  '}];',
].join('\n');

// ---------------------------------------------------------------------------
// Ноды workflow
// ---------------------------------------------------------------------------
function boolIfNode(name, leftValue) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [
          {
            id: uuid(),
            leftValue: '=' + leftValue,
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
    position: [0, 0],
    id: uuid(),
    name,
  };
}

function codeNode(name, jsCode) {
  return {
    parameters: { jsCode },
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [0, 0],
    id: uuid(),
    name,
  };
}

const MCP_RAG_URL = 'http://192.168.88.17:20100/';
const MCP_HEADERS = [{ name: 'Accept', value: 'application/json, text/event-stream' }];

const nodes = [
  cloneNode('Gmail Trigger', [-800, 32]),
  cloneNode('When Executed by Another Workflow', [-800, -208]),
  cloneNode('AI Agent', [-528, 32]),
  cloneNode('LLM', [-624, 320]),
  cloneNode('Get a message in Gmail', [-704, 320]),
  cloneNode('Mark a message as read in Gmail', [-544, 320]),
  cloneNode('Structured Output Parser', [-368, 336]),
  cloneNode('If', [-224, 32]),
  (() => {
    const n = cloneNode('Code in JavaScript', [0, 16]);
    n.parameters = { jsCode: FLATTEN_CODE };
    return n;
  })(),
  cloneNode('Loop Over Items', [208, 16]),
  (() => {
    const n = cloneNode('AI Agent1', [448, 32]);
    n.parameters = {
      promptType: 'define',
      text: '=Обработай статью "{{ $json.title }}" (document_id "{{ $json.document_id }}") по адресу "{{ $json.original_url }}".',
      options: { systemMessage: EVAL_SYSTEM, maxIterations: 25 },
    };
    n.onError = 'continueRegularOutput';
    return n;
  })(),
  cloneNode('Send a message in Gmail', [528, 304]),
  cloneNode('MCP Client', [672, 304]),
  Object.assign(codeNode('Parse Evaluator Output', PARSE_EVAL_CODE), { position: [672, 16] }),
  Object.assign(boolIfNode('Article Accepted', '{{ $json.accepted }}'), { position: [864, 16] }),
  {
    parameters: {
      promptType: 'define',
      text:
        '=Переведи на русский язык и сохрани в архив статью "{{ $json.title }}" — document_id "{{ $json.document_id }}", article_id "{{ $json.article_id }}", original_url "{{ $json.original_url }}", service_id "{{ $json.service_id }}".',
      options: { systemMessage: TRANSLATOR_SYSTEM, maxIterations: 25 },
    },
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 3.1,
    position: [1072, 16],
    id: uuid(),
    name: 'AI Agent2',
    onError: 'continueRegularOutput',
  },
  {
    parameters: {
      endpointUrl: 'http://192.168.88.17:20001/sse',
      include: 'selected',
      includeTools: [
        'cache_get_article',
        'fetch_markdown',
        'list_sessions',
        'browser_login',
        'save_session',
        'save_knowledge_article_translation',
      ],
      options: { timeout: 120000 },
    },
    type: '@n8n/n8n-nodes-langchain.mcpClientTool',
    typeVersion: 1.2,
    position: [1104, 304],
    id: uuid(),
    name: 'MCP Client2',
  },
  Object.assign(codeNode('Parse Translator Output', PARSE_TRANSLATION_CODE), { position: [1280, 16] }),
  {
    parameters: {
      method: 'POST',
      url: MCP_RAG_URL,
      sendHeaders: true,
      headerParameters: { parameters: MCP_HEADERS },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'start_indexing', arguments: { document_id: $json.document_id, force: false } } }) }}",
      options: { timeout: 60000, response: { response: { neverError: true } } },
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1488, 16],
    id: uuid(),
    name: 'Start Indexing',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
  },
  Object.assign(codeNode('Parse Start Indexing', PARSE_START_CODE), { position: [1696, 16] }),
  Object.assign(boolIfNode('Has Index Job', '{{ $json.has_job }}'), { position: [1904, 16] }),
  {
    parameters: { resume: 'timeInterval', amount: 3, unit: 'seconds' },
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: [2112, 16],
    id: uuid(),
    name: 'Wait 3 Seconds',
    webhookId: uuid(),
  },
  {
    parameters: {
      method: 'POST',
      url: MCP_RAG_URL,
      sendHeaders: true,
      headerParameters: { parameters: MCP_HEADERS },
      sendBody: true,
      specifyBody: 'json',
      jsonBody:
        "={{ JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_index_job_status', arguments: { job_id: $json.job_id } } }) }}",
      options: { timeout: 60000, response: { response: { neverError: true } } },
    },
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [2320, 16],
    id: uuid(),
    name: 'Poll Index Job',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
  },
  Object.assign(codeNode('Parse Job Status', PARSE_POLL_CODE), { position: [2528, 16] }),
  Object.assign(boolIfNode('Indexing Done', '{{ $json.indexing_done }}'), { position: [2736, 16] }),
];

// ---------------------------------------------------------------------------
// Связи
// ---------------------------------------------------------------------------
const link = (node, type = 'main', index = 0) => ({ node, type, index });

const connections = {
  'Gmail Trigger': { main: [[link('AI Agent')]] },
  'When Executed by Another Workflow': { main: [[link('AI Agent')]] },
  LLM: {
    ai_languageModel: [[link('AI Agent', 'ai_languageModel'), link('AI Agent1', 'ai_languageModel'), link('AI Agent2', 'ai_languageModel')]],
  },
  'Get a message in Gmail': { ai_tool: [[link('AI Agent', 'ai_tool')]] },
  'Mark a message as read in Gmail': { ai_tool: [[link('AI Agent', 'ai_tool')]] },
  'Structured Output Parser': { ai_outputParser: [[link('AI Agent', 'ai_outputParser')]] },
  'AI Agent': { main: [[link('If')]] },
  If: { main: [[link('Code in JavaScript')]] },
  'Code in JavaScript': { main: [[link('Loop Over Items')]] },
  'Loop Over Items': { main: [[], [link('AI Agent1')]] },
  'MCP Client': { ai_tool: [[link('AI Agent1', 'ai_tool')]] },
  'Send a message in Gmail': { ai_tool: [[link('AI Agent1', 'ai_tool')]] },
  'AI Agent1': { main: [[link('Parse Evaluator Output')]] },
  'Parse Evaluator Output': { main: [[link('Article Accepted')]] },
  'Article Accepted': { main: [[link('AI Agent2')], [link('Loop Over Items')]] },
  'MCP Client2': { ai_tool: [[link('AI Agent2', 'ai_tool')]] },
  'AI Agent2': { main: [[link('Parse Translator Output')]] },
  'Parse Translator Output': { main: [[link('Start Indexing')]] },
  'Start Indexing': { main: [[link('Parse Start Indexing')]] },
  'Parse Start Indexing': { main: [[link('Has Index Job')]] },
  'Has Index Job': { main: [[link('Wait 3 Seconds')], [link('Loop Over Items')]] },
  'Wait 3 Seconds': { main: [[link('Poll Index Job')]] },
  'Poll Index Job': { main: [[link('Parse Job Status')]] },
  'Parse Job Status': { main: [[link('Indexing Done')]] },
  'Indexing Done': { main: [[link('Loop Over Items')], [link('Wait 3 Seconds')]] },
};

// ---------------------------------------------------------------------------
// Проверки целостности
// ---------------------------------------------------------------------------
const names = new Set(nodes.map((n) => n.name));
if (nodes.length !== names.size) {
  throw new Error('Дубликаты имён нод');
}
const ids = new Set(nodes.map((n) => n.id));
if (nodes.length !== ids.size) {
  throw new Error('Дубликаты id нод');
}
for (const [from, outputs] of Object.entries(connections)) {
  if (!names.has(from)) throw new Error('Связь от несуществующей ноды: ' + from);
  for (const conns of Object.values(outputs)) {
    for (const arr of conns) {
      for (const c of arr) {
        if (!names.has(c.node)) {
          throw new Error('Связь ' + from + ' → несуществующая нода ' + c.node);
        }
      }
    }
  }
}
console.log('Нод:', nodes.length, '| Имена:', nodes.map((n) => n.name).join(', '));

// ---------------------------------------------------------------------------
// Сборка payload и создание workflow в n8n
// ---------------------------------------------------------------------------
const payload = {
  name: 'Medium Agent main copy',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};

// pinData Gmail Trigger — для удобного ручного теста в редакторе (может быть отклонён API)
const pinData =
  src.pinData && src.pinData['Gmail Trigger']
    ? { 'Gmail Trigger': src.pinData['Gmail Trigger'] }
    : null;
if (pinData) payload.pinData = pinData;

fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
console.log('Файл сохранён:', OUT_PATH);

const mcpSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
const env = mcpSettings.mcpServers['n8n-workflow-builder'].env;
const base = (env.N8N_HOST || 'http://192.168.88.221:5678/api/v1').replace(/\/+$/, '');
const apiKey = env.N8N_API_KEY;
if (!apiKey) throw new Error('N8N_API_KEY не найден в mcp_settings.json');

async function postWorkflow(body) {
  const resp = await fetch(base + '/workflows', {
    method: 'POST',
    headers: {
      'X-N8N-API-KEY': apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* ignore */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

(async () => {
  let res = await postWorkflow(payload);
  if (!res.ok && payload.pinData) {
    console.log('POST с pinData отклонён (' + res.status + '), повторяю без pinData…');
    delete payload.pinData;
    fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
    res = await postWorkflow(payload);
  }
  if (!res.ok) {
    console.error('ОШИБКА создания workflow:', res.status, (res.text || '').slice(0, 600));
    process.exit(1);
  }
  console.log('Workflow создан: id=' + (res.json && res.json.id) + ' name=' + (res.json && res.json.name));
})().catch((e) => {
  console.error('Сбой:', e.message);
  process.exit(1);
});







