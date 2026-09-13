---
name: n8n-workflow-edit
description: >
  Чтение и редактирование воркфлоу n8n пользователя (инстанс http://192.168.88.221:5678,
  MCP-сервер n8n-workflow-builder) без повторного «нащупывания». Содержит рабочие
  проверки доступности, стандартные вызовы list_workflows/get_workflow через JSON-RPC
  over stdio, известный баг записи PUT 400 (settings.binaryMode) и его обход,
  плюс список граблей. Применять, когда нужно: посмотреть структуру воркфлоу,
  изменить промпт/параметры ноды, отладить запись через MCP-инструменты,
  проверить ключи/доступ к n8n.
---

# n8n workflow edit — накопленный опыт

## 1. Точки подключения (проверять первым делом)

| Что | Значение | Комментарий |
|---|---|---|
| Инстанс n8n | `http://192.168.88.221:5678` | Рабочий. `localhost:5678` обычно НЕ запущен. |
| healthz | `GET http://192.168.88.221:5678/healthz` | Ожидаем `{"status":"ok"}` |
| API | `GET http://192.168.88.221:5678/api/v1/workflows` + заголовок `X-N8N-API-KEY: <ключ>` | ⚠️ `/api/v1` обязателен в базе: `build/server.cjs` добавляет к ней `/workflows` |
| Актуальный ключ | `C:\Users\chaos\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\mcp_settings.json` → `mcpServers["n8n-workflow-builder"].env.N8N_API_KEY` | Ключ — JWT, со временем вращается. Ключи из `tests/*.js` (n8n.yasin.nu) — протухли, не брать. |

Быстрая проверка (PowerShell):

```powershell
Invoke-RestMethod -Uri 'http://192.168.88.221:5678/healthz'
Invoke-RestMethod -Uri 'http://192.168.88.221:5678/api/v1/workflows' -Headers @{ 'X-N8N-API-KEY' = '<ключ>' }
```

## 2. Чтение воркфлоу через MCP-сервер

Сервер: `C:\WorkPlace\n8n-builder\n8n-workflow-builder\build\server.cjs`. Готовый скрипт — `scripts\mcp_call.js` рядом с этим файлом. Env задавать не нужно: при отсутствии `N8N_HOST`/`N8N_API_KEY` скрипт сам читает их из Roo Cline `mcp_settings.json` (env перекрывает конфиг).

```powershell
node "<путь-к-эт-скиллу>\scripts\mcp_call.js" list_workflows '{}'
node "<путь-к-эт-скиллу>\scripts\mcp_call.js" get_workflow '{"id":"<workflowId>","full":true}'
```

Протокол: `initialize` → `notifications/initialized` → `tools/call`, построчный JSON-RPC по stdio. У `get_workflow {full:true}` полезные данные — JSON в `result.content[0].text` (узел: `name`, `type`, `parameters`; связи — `connections`).

## 3. Изменение параметров ноды — обходи баг PUT 400

Симптом: `update_node`/`add_node`/`remove_node`/`update_workflow_settings` → `Error: Request failed with status code 400`, тело `{"message":"request/body/settings must NOT have additional properties"}`.

Причина: n8n подставляет `binaryMode` в ответе **GET**, но отклоняет его в **PUT**. `stripWorkflowForUpdate` (`src/server.ts:939`) шлёт `settings` как есть → 400.

Пока билдер не починен, запись — напрямую через REST PUT:

1. `GET /api/v1/workflows/{id}` (получить свежие nodes/connections/staticData);
2. изменить `nodes[].parameters` (долгожданные значения читать из файла UTF-8);
3. `PUT /api/v1/workflows/{id}` с телом `{name, nodes, connections, settings, staticData}`, где
   `settings = { executionOrder: <как было>, availableInMCP: <как было> }` — БЕЗ `binaryMode`;
4. проверить через `get_workflow`: `versionId` должен измениться.

Готовый скрипт — `scripts\put_workflow.js`: сам делает GET → патч → PUT, хост/ключ берёт как `mcp_call.js`, а `settings` чистит адаптивной лестницей, поэтому баг 400 обходит без ручного подбора ключей. Перед записью запускать с `--dry-run`:

```powershell
node "<путь-к-эт-скиллу>\scripts\put_workflow.js" <workflowId> patch.json            # применить, показать versionId до/после
node "<путь-к-эт-скиллу>\scripts\put_workflow.js" <workflowId> patch.json --dry-run  # план без записи
```

`patch.json` — пути dot-path внутрь ноды; строковое значение с `@` читается из файла (UTF-8) — длинные промпты класть в файл:

```json
{
  "nodeUpdates": [
    { "node": "AI Agent1",
      "set": { "parameters.options.systemMessage": "@C:\\temp\\prompt.md" },
      "remove": [] }
  ],
  "settings": {}
}
```

Лестница `settings` в скрипте: (1) все ключи GET без `binaryMode` → (2) только белый список (`executionOrder`, `availableInMCP`, `timezone`, `save*`, `errorWorkflow`, `callerPolicy`, `callerIds`) → (3) `{executionOrder}` → (4) `{}`; при наличии `pinData` в GET — сначала попытки с ним, затем без. Первая успешная побеждает.

## 4. Грабли (проверять, чтобы не падать заново)

1. **`N8N_HOST` без `/api/v1`** → MCP-сервер бьёт в `/workflows` → `workflows.map is not a function` (или 404). Правильно: `http://192.168.88.221:5678/api/v1`.
2. **Ответы MCP приходят не по порядку**: `get_workflow` может прийти РАНЬШЕ `update_node` (PUT медленный). Ждать ВСЕ ответы по id, иначе вывод «правки не применились», хотя PUT ещё в пути.
3. `update_node` мержит `parameters` **поверхностно**: объект `options` заменяется целиком; параметры-объекты нужно передавать полными.
4. Ключи в `tests/*.js` (`n8n.yasin.nu`) — протухли (401), источник правды — `mcp_settings.json`.
5. Большие PowerShell-команды/heredoc (>~6К) в этом окружении могут «уйти в фон» и не выполниться. Для длинных текстов пиши файл через editor-инструмент, запускай короткими командами.
6. n8n принимает только валидную схему `settings` в PUT — лишние ключи роняют запрос с 400.
7. GET-запросы к воркфлоу возвращают `binaryMode` при любом раскладе — это подстановка n8n, не признак того, что он реально сохранён.

## 5. Проверка после любых правок

```powershell
node "<путь-к-эт-скиллу>\scripts\mcp_call.js" get_workflow '{"id":"<workflowId>","full":true}'
```

Ожидаем: `versionId` сменился, изменённые параметры на месте, `connections` не тронуты.

Связанные проекты: `C:\WorkPlace\n8n-builder\n8n-workflow-builder` (MCP-сервер), `C:\WorkPlace\web-proxy` (MCP-тулы браузерного прокси: fetch_markdown, save_knowledge_article и пр.).

Копия skill в репозитории: `C:\WorkPlace\n8n-builder\n8n-workflow-builder\skills\n8n-workflow-edit\` — править её и синхронизировать сюда (каноничная — эта, в `~\.claude\skills`).