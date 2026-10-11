// Нормализуем результат сохранения перевода (MCP save_knowledge_article_translation).
// Статус перевода определяется ФАКТОМ сохранения в архиве (ответ инструмента),
// а не ответом LLM — модель больше не участвует в формировании статуса.
function extractToolPayload(raw) {
  const result = raw && (raw.result ?? raw);
  const content = result && result.content;
  if (Array.isArray(content)) {
    const textPart = content.find((c) => c && c.type === "text");
    if (textPart && typeof textPart.text === "string") {
      try {
        return JSON.parse(textPart.text);
      } catch (e) {
        return null;
      }
    }
  }
  if (result && typeof result === "object" && ("status" in result || "error" in result)) {
    return result;
  }
  return null;
}

const tool = extractToolPayload($input.first().json);
const prev = $("Parse Evaluator Output").first().json;

let translatedText = "";
try {
  translatedText = String($("AI Agent2").first().json.output ?? "");
} catch (e) {
  translatedText = "";
}

const saved = Boolean(tool && tool.status === "ok" && tool.file_path);

const result = Object.assign({}, prev);
result.document_id = (tool && tool.document_id) || prev.document_id || null;
result.original_url = prev.original_url ?? null;
result.translation_status = saved ? "translation_saved" : "translation_failed";
result.ru_path = saved ? `${tool.language || "ru"}/content.md` : null;
result.chars_translated = saved ? translatedText.length : 0;
result.translation_error = saved
  ? null
  : (tool ? JSON.stringify(tool).slice(0, 500) : "Пустой или невалидный ответ save_knowledge_article_translation");

return [{ json: result }];