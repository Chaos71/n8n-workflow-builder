// Нормализуем ответ агента-оценщика и определяем судьбу статьи.
// status/accepted/action_taken вычисляет ТОЛЬКО workflow: LLM их прислать не может.
function parseAgentJson(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  try { return JSON.parse(s); } catch (e) {}
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

const item = $input.first();
const raw = item.json.output ?? item.json;

// Метаданные берём ТОЛЬКО из данных workflow, из ответа LLM — только оценку.
const loopItem = $("Loop Over Items").first().json;
let evalItem = {};
try { evalItem = $("Build Eval Input").first().json ?? {}; } catch (e) { evalItem = {}; }
const fetchOk = evalItem.fetch_ok === true;

const data = parseAgentJson(raw);
const llmFailed = !(data && typeof data === "object");

const result = {
  article_id: loopItem.article_id,
  document_id: evalItem.document_id ?? loopItem.document_id ?? null,
  email_id: loopItem.email_id,
  title: loopItem.title,
  author: loopItem.author ?? null,
  source: loopItem.source ?? null,
  original_url: loopItem.original_url,
  language: loopItem.language ?? "en",
  processed_date: loopItem.processed_date ?? null,
  service_id: evalItem.service_id ?? null,
  markdown_chars: evalItem.markdown_chars ?? null,
};

// Из ответа LLM переносим только поля оценки (белый список)
const LLM_FIELDS = [
  "relevance", "practicality", "technical_depth", "reproducibility", "originality",
  "tags", "summary_ru", "has_code", "programm_language", "has_discussion",
];
if (data && typeof data === "object") {
  for (const key of LLM_FIELDS) {
    if (data[key] !== undefined) result[key] = data[key];
  }
  const llmScore = Number(data.score);
  if (Number.isFinite(llmScore)) result.llm_score = llmScore;
  const note = [data.status, data.error_details].filter((v) => typeof v === "string" && v).join(": ");
  if (note) result.llm_note = note;
}

// Сумму баллов считаем сами как сумму пяти критериев (каждый 0..2)
const criteriaKeys = ["relevance", "practicality", "technical_depth", "reproducibility", "originality"];
const criteria = criteriaKeys.map((k) => Number(result[k]));
if (criteria.every((v) => Number.isFinite(v))) {
  let sum = 0;
  criteriaKeys.forEach((k, i) => {
    const v = Math.max(0, Math.min(2, criteria[i]));
    result[k] = v;
    sum += v;
  });
  result.score = sum;
} else {
  const s = Number(result.score);
  result.score = Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 0;
}

result.tags = Array.isArray(result.tags) ? result.tags.slice(0, 6) : [];
result.has_code = result.has_code === true;
result.programm_language = Array.isArray(result.programm_language) ? result.programm_language : [];
result.has_discussion = result.has_discussion === true;
result.summary_ru = typeof result.summary_ru === "string" ? result.summary_ru : "";

// Статус определяет workflow, а не LLM
let accepted = false;
if (!fetchOk) {
  result.status = "fetch_error";
  result.score = 0;
  result.error_details = evalItem.fetch_error || "не удалось загрузить текст статьи";
} else if (llmFailed) {
  result.status = "llm_error";
  result.score = 0;
  result.error_details = typeof raw === "string" ? raw.slice(0, 300) : "пустой ответ агента-оценщика";
} else if (result.score >= 6 && result.document_id) {
  result.status = "successfully_processed";
  result.action_taken = "original_saved";
  result.error_details = null;
  accepted = true;
} else {
  result.status = "skipped_low_score";
  result.action_taken = "skipped";
  result.error_details = null;
}
result.accepted = accepted;

return [{ json: result }];
