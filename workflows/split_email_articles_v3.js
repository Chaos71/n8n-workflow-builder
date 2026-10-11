// Разворачиваем output.details каждого письма в отдельные n8n-items,
// чтобы Loop Over Items мог обрабатывать статьи строго по одной.
// (замена Split Out — здесь же присваиваем article_id и document_id)
//
// v3: узел выполняется ПОСЛЕ одноразовой цепочки сессий
// (MCP list_sessions -> Pick Session -> MCP browser_login -> MCP save_session),
// поэтому его $input — это ответ save_session, а исходные данные письма
// берём из узла If (он выполняется до цепочки сессий).
const results = [];

const emailItem = $("If").first().json;
const data = emailItem.output ?? emailItem;

const emailId = data.email_id;

if (Array.isArray(data.details)) {
  data.details.forEach((detail, index) => {
    const articleId = `${emailId}-${index}`;
    results.push({
      json: {
        article_id: articleId,
        email_id: emailId,
        ...detail
      }
    });
  });
}

return results;