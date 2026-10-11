// scripts/test_url_copy.cjs — A/B-тест: копирует ли модель длинный Medium-URL
// в JSON-поле original_url без искажений.
//   node scripts/test_url_copy.cjs                          (обе модели, 2 прогона)
//   node scripts/test_url_copy.cjs Qwen3.5-9B 3
//   node scripts/test_url_copy.cjs Qwen3.5-9B 2 '{"dry_multiplier":0}'   (проверка гипотезы DRY)
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = process.env.LLM_BASE || 'http://192.168.88.88:6789/v1';
const ROOT = path.join(__dirname, '..');

const URLS = [
  'https://medium.com/@xhinker/qwen3-8-flash-next-40-tokens-second-on-an-m4-max-macbook-4-27-bpw-quant-168k-context-a8e594e0bb87?source=email-18625c4d638c-1790378766666-digest.reader--a8e594e0bb87----0-98------------------852f48fc_adec_463d_bb16_7e3d139d4d13-1',
  'https://medium.com/@malexandersalazar/i-benchmarked-every-mtp-depth-on-qwen3-8-27b-ud-q4-here-you-are-10f621e07456?source=email-18625c4d638c-1790378766666',
  'https://medium.com/@mbonsign/the-best-model-for-a-16-gb-graphics-card-does-not-exist-yet-2c11a0f68a10',
];

// Максимально близко к реальному заданию ноды "AI Agent" (v2).
const SYS = 'Ты извлекаешь ссылки из HTML-письма и возвращаешь ТОЛЬКО JSON вида '
  + '{"details":[{"title":"...","original_url":"..."}]}. '
  + 'ВАЖНО: оригинальные URL копируй СИМВОЛ В СИМВОЛ из письма, НЕ сокращай, НЕ меняй и НЕ выдумывай.';

const USER = 'Письмо (HTML):\n'
  + '<div class="digest">Today\'s highlights</div>\n'
  + URLS.map((u, i) => `<a href="${u}"><h2 class="t">Article ${i + 1} title</h2></a>`).join('\n')
  + '\nВерни JSON со всеми тремя ссылками в том же виде, как в письме.';

async function ask(model, temperature, maxTokens, extra) {
  const body = {
    model,
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }],
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(extra || {}),
  };
  const t0 = Date.now();
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return {
    ms: Date.now() - t0,
    finish: j.choices && j.choices[0] && j.choices[0].finish_reason,
    usage: j.usage,
    reasoning: msg.reasoning_content || msg.reasoning || null,
    content: msg.content || '',
  };
}

function report(model, res) {
  const urls = [...res.content.matchAll(/https?:\/\/[^\s"'\\)]+/g)].map((m) => m[0]);
  const ok = URLS.map((u) => urls.includes(u));
  console.log('\n=== ' + model + ' | finish=' + res.finish + ' | ' + res.ms + 'ms | usage=' +
    JSON.stringify(res.usage) + (res.reasoning ? ' | reasoning=YES(' + res.reasoning.length + ')' : ' | reasoning=no'));
  console.log('    точных совпадений: ' + ok.filter(Boolean).length + '/' + URLS.length);
  ok.forEach((v, i) => console.log('      ' + (v ? 'OK  ' : 'БИТ') + ' #' + (i + 1) + ' -> ' +
    (urls[i] || '<нет URL в ответе>').slice(0, 120)));
  console.log('    content: ' + res.content.replace(/\s+/g, ' ').slice(0, 300));
}

(async () => {
  const models = process.argv[2] ? [process.argv[2]] : ['Qwen3.5-9B', 'Qwen3.5-4B'];
  const runs = Number(process.argv[3] || 2);
  const extra = process.argv[4] ? JSON.parse(process.argv[4]) : null;
  console.log('extra params: ' + JSON.stringify(extra));
  for (const model of models) {
    for (let i = 0; i < runs; i++) {
      try {
        const res = await ask(model, 0.2, -1, extra);
        report(model + ' run' + (i + 1), res);
      } catch (e) {
        console.log('\n=== ' + model + ' run' + (i + 1) + ' FAIL: ' + e.message);
      }
    }
  }
})();
