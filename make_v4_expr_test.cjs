// make_v4_expr_test.cjs — генерирует минимальный workflow, который проверяет в ЖИВОМ n8n,
// что условия узла "If" и код узла "Build Skip Result" из Medium Agent v4 работают.
// Побочных эффектов нет: только Manual Trigger -> Fixture -> If -> терминальные узлы.
'use strict';
const fs = require('fs');
const path = require('path');

const v4 = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'workflows', 'Medium-Agent-v4.json'), 'utf8'));

const ifNode = v4.nodes.find((n) => n.name === 'If');
const skipNode = v4.nodes.find((n) => n.name === 'Build Skip Result');

const FIXTURE = [
  '// Два фикстурных письма: без статей (как в execution #1567) и со статьями.',
  'return [',
  '  { json: { output: { email_id: "no-articles", status: "processed", articles_found: 0, details: [], sender_domain: "gmail.com" } } },',
  '  { json: { output: { email_id: "with-articles", status: "processed", articles_found: 2, details: [{ title: "a" }, { title: "b" }], sender_domain: "medium.com" } } },',
  '];',
  '',
].join('\n');

const wf = {
  name: '_v4 If/BuildSkipResult smoke test',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
      id: 'f0000001-0000-4000-8000-000000000001',
      name: 'Every Minute',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0],
    },
    {
      parameters: { jsCode: FIXTURE },
      id: 'f0000001-0000-4000-8000-000000000002',
      name: 'Fixture',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [220, 0],
    },
    {
      parameters: JSON.parse(JSON.stringify(ifNode.parameters)),
      id: 'f0000001-0000-4000-8000-000000000003',
      name: 'If',
      type: ifNode.type,
      typeVersion: ifNode.typeVersion,
      position: [440, 0],
    },
    {
      parameters: { jsCode: skipNode.parameters.jsCode },
      id: 'f0000001-0000-4000-8000-000000000004',
      name: 'Build Skip Result',
      type: skipNode.type,
      typeVersion: skipNode.typeVersion,
      position: [660, -120],
    },
    {
      parameters: {},
      id: 'f0000001-0000-4000-8000-000000000005',
      name: 'Articles Found (true branch)',
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [660, 120],
    },
  ],
  connections: {
    'Every Minute': { main: [[{ node: 'Fixture', type: 'main', index: 0 }]] },
    Fixture: { main: [[{ node: 'If', type: 'main', index: 0 }]] },
    If: {
      main: [
        [{ node: 'Articles Found (true branch)', type: 'main', index: 0 }],
        [{ node: 'Build Skip Result', type: 'main', index: 0 }],
      ],
    },
  },
  settings: { executionOrder: 'v1' },
};

const out = path.join(__dirname, 'workflows', '_v4_if_smoke_test.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2) + '\n', 'utf8');
console.log('written ' + out);
console.log('If conditions copied:', ifNode.parameters.conditions.conditions.length);
console.log('Build Skip Result jsCode len:', skipNode.parameters.jsCode.length);