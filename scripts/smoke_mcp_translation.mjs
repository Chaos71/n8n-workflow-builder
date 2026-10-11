// Смоук-тест MCP web-proxy: доступность инструмента save_knowledge_article_translation.
// Вызов с несуществующим document_id — ожидаем ошибку диспетчеризации инструмента
// (файлы архива не создаются). Запуск: node scripts/smoke_mcp_translation.mjs
// Смоук-тест MCP web-proxy: доступность инструмента save_knowledge_article_translation.
// Сервер на порту 20001 работает в режиме Streamable HTTP (unified server),
// поэтому используем StreamableHTTPClientTransport. Вызов с несуществующим
// document_id — ожидаем ошибку диспетчеризации инструмента (файлы не создаются).
// Запуск: node scripts/smoke_mcp_translation.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.MCP_BASE_URL || 'http://192.168.88.17:20001';

const client = new Client({ name: 'smoke-translation', version: '0.0.1' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(BASE + '/sse'));

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log('tools_count=' + names.length);
  console.log('has_translation_tool=' + names.includes('save_knowledge_article_translation'));

  const res = await client.callTool({
    name: 'save_knowledge_article_translation',
    arguments: { document_id: '__smoke_test__', translation_markdown: '# тест\n', language: 'ru' },
  });
  console.log('isError=' + (res.isError === true));
  console.log('payload=' + JSON.stringify(res.content).slice(0, 600));
} catch (e) {
  console.error('EXC: ' + e.message);
} finally {
  await client.close().catch(() => {});
}