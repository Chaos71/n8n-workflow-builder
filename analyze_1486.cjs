'use strict';
const fs = require('fs');
const e = JSON.parse(fs.readFileSync('workflows/exec_1486_full.json', 'utf8'));
const rd = e.data.resultData.runData;
const l = rd['LLM2'];
function getGen(r) {
  try { return r.data.ai_languageModel[0][0].json; } catch (x) { return null; }
}
l.forEach((r, i) => {
  const g = getGen(r);
  if (!g) { console.log('run' + i + ' NO DATA'); return; }
  const gen = g.response && g.response.generations && g.response.generations[0] && g.response.generations[0][0];
  if (!gen) { console.log('run' + i + ' no gen keys=' + Object.keys(g).join(',')); return; }
  const gi = gen.generationInfo || {};
  const fr = gi.finish_reason;
  const text = gen.text || '';
  console.log('===== LLM2 run' + i + ' finish=' + fr + ' textLen=' + text.length + ' giKeys=' + Object.keys(gi).join(','));
  if (gi.tool_calls) {
    console.log('  TOOLCALLS(gi)=' + JSON.stringify(gi.tool_calls).slice(0, 800));
  }
  const msg = gen.message;
  if (msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const fn = tc.function || {};
      console.log('  CALL name=' + fn.name + ' argsLen=' + (fn.arguments || '').length + ' argsHead=' + JSON.stringify((fn.arguments || '').slice(0, 120)));
    }
  }
  if (fr !== 'tool_calls' && text) {
    console.log('  TEXT=' + JSON.stringify(text.slice(0, 260)));
  }
});
