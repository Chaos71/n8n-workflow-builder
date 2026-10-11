// scripts/probe_max_tokens.cjs — кто ограничивает длину ответа: n8n(max_tokens:-1)
// или сервер llama-swap/llama-server.
//   node scripts/probe_max_tokens.cjs
'use strict';
const BASE = process.env.LLM_BASE || 'http://192.168.88.88:6789/v1';
const MODEL = process.argv[2] || 'Qwen3.5-4B';

async function run(label, extra) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Выведи числа от 1 до 3000, каждое на новой строке. Без пояснений.' }],
    temperature: 0.2,
    stream: false,
    ...extra,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (!r.ok) return console.log(label.padEnd(26) + ' HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
    const c = j.choices[0];
    const txt = (c.message && c.message.content) || '';
    console.log(label.padEnd(26)
      + ' finish=' + c.finish_reason
      + ' completion_tokens=' + (j.usage && j.usage.completion_tokens)
      + ' predicted_n=' + (j.timings && j.timings.predicted_n)
      + ' last_num=' + (txt.trim().split('\n').pop() || '').trim()
      + ' ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    console.log(label.padEnd(26) + ' FAIL ' + e.message);
  }
}

(async () => {
  const p = await (await fetch(BASE.replace('/v1', '') + '/upstream/' + MODEL + '/props')).json();
  const pp = p.default_generation_settings.params;
  console.log('server defaults for ' + MODEL + ': n_predict=' + pp.n_predict
    + ' max_tokens=' + pp.max_tokens + ' dry_multiplier=' + pp.dry_multiplier
    + ' temp=' + pp.temperature + ' top_k=' + pp.top_k + ' n_ctx=' + p.default_generation_settings.n_ctx + '\n');
  await run('max_tokens=-1 (как n8n)', { max_tokens: -1 });
  await run('max_tokens=8192', { max_tokens: 8192 });
})();