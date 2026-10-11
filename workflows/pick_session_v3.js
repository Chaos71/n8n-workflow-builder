// Детерминированно выбираем сервисную сессию (service_id) по домену статьи.
// Это делает код, а не LLM — идентификаторы от модели не зависят.
//
// v3: узел выполняется ОДИН РАЗ на письмо — цепочка сессий
// (list_sessions -> browser_login -> save_session) перенесена выше цикла статей,
// поэтому домен берётся из ПЕРВОЙ статьи дайджеста (details[0] письма),
// а не из текущей статьи цикла, как было в v2.
const first = $input.first().json ?? {};
const sessions = first.content?.[0]?.text ?? [];
const list = Array.isArray(sessions) ? sessions : [];

const emailOutput = $("If").first().json.output;
const emailData = emailOutput && typeof emailOutput === "object" ? emailOutput : {};
const details = Array.isArray(emailData.details) ? emailData.details : [];
const firstArticle = details[0] ?? {};

let host = "";
// В песочнице Code-узла n8n глобальный URL недоступен — парсим хост регуляркой
const m = String(firstArticle.original_url || "").match(/^https?:\/\/(?:www\.)?([^\/:?#]+)/i);
if (m) host = m[1].toLowerCase();

let pick = null;
if (host) {
  pick = list.find((s) => {
    const d = String((s && s.domain) || "").replace(/^www\./, "");
    return d && (host === d || host.endsWith("." + d));
  }) || null;
}
if (!pick) pick = list[0] || null;

return [{
  json: {
    email_id: emailData.email_id ?? null,
    service_id: pick ? pick.service_id : null,
    picked_domain: host || null,
    sessions_available: list.map((s) => s && s.service_id).filter(Boolean),
  },
}];