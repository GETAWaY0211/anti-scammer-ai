'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_ENTITIES_PER_TYPE,
  MAX_ENTITIES_TOTAL,
  extractEntities,
  normalizeBankAccount,
  normalizeDomain,
  normalizePhone,
  redactEntity
} = require('../scripts/entity-intelligence');

const repositoryRoot = path.resolve(__dirname, '..');
const workflowPath = path.join(repositoryRoot, 'n8n', 'workflows', 'entity-intelligence-lookup-v1.json');

function values(entities, type) {
  return entities.filter((entity) => entity.entity_type === type).map((entity) => entity.normalized_value);
}

test('1. no entity returns an empty array', () => {
  assert.deepEqual(extractEntities('พรุ่งนี้ประชุมทีมเวลาเก้าโมง'), []);
});

test('2. Thai local mobile phone is extracted', () => {
  assert.deepEqual(values(extractEntities('ติดต่อ 0810000000 ได้ทันที'), 'phone'), ['0810000000']);
});

test('3. +66 mobile phone is normalized to local form', () => {
  assert.equal(normalizePhone('+66 81 000 0000'), '0810000000');
  const entities = extractEntities('โทร +66 81 000 0000');
  assert.deepEqual(values(entities, 'phone'), ['0810000000']);
  assert.deepEqual(values(entities, 'bank_account'), []);
});

test('4. phone spaces, hyphens, and parentheses are removed', () => {
  assert.equal(normalizePhone('(081) 000-0000'), '0810000000');
});

test('5. OTP-like short numeric values are not treated as phones', () => {
  assert.deepEqual(extractEntities('OTP 123456 และรหัสยืนยัน 987654'), []);
});

test('6. bank accounts are conservatively normalized', () => {
  assert.equal(normalizeBankAccount('999-9-99999-9'), '9999999999');
  assert.deepEqual(values(extractEntities('เลขบัญชี 999-9-99999-9 สำหรับโอนเงิน'), 'bank_account'), ['9999999999']);
});

test('7. domains are extracted from HTTP and HTTPS URLs', () => {
  assert.deepEqual(
    values(extractEntities('ดู https://Scam-Demo.Example/pay?q=1 และ http://reported-shop.example:8080/x'), 'domain'),
    ['scam-demo.example', 'reported-shop.example']
  );
});

test('8. plain domain-like strings are extracted', () => {
  assert.deepEqual(values(extractEntities('เปิด scam-demo.example เพื่อดูข้อมูล'), 'domain'), ['scam-demo.example']);
});

test('9. uppercase domains are normalized to lowercase', () => {
  assert.equal(normalizeDomain('HTTPS://SCAM-DEMO.EXAMPLE./path'), 'scam-demo.example');
});

test('10. duplicate normalized entities are removed', () => {
  const entities = extractEntities('0810000000, +66 81 000 0000, SCAM-DEMO.EXAMPLE และ https://scam-demo.example/x');
  assert.deepEqual(values(entities, 'phone'), ['0810000000']);
  assert.deepEqual(values(entities, 'domain'), ['scam-demo.example']);
});

test('11. extraction enforces the per-type limit', () => {
  const domains = Array.from({ length: 14 }, (_, index) => `demo-${index}.example`).join(' ');
  const entities = values(extractEntities(domains), 'domain');
  assert.equal(entities.length, MAX_ENTITIES_PER_TYPE);
  assert.equal(new Set(entities).size, MAX_ENTITIES_PER_TYPE);
});

test('12. extraction enforces the total entity limit', () => {
  const phones = Array.from({ length: 10 }, (_, index) => `08${index}0000000`).join(' ');
  const domains = Array.from({ length: 10 }, (_, index) => `total-${index}.example`).join(' ');
  const accounts = Array.from({ length: 10 }, (_, index) => `เลขบัญชี 77777-${String(index).padStart(5, '0')}`).join(' ');
  const entities = extractEntities(`${phones} ${domains} ${accounts}`);
  assert.equal(entities.length, MAX_ENTITIES_TOTAL);
});

test('13. localhost hosts are rejected', () => {
  assert.equal(normalizeDomain('http://localhost:3000/path'), null);
  assert.equal(normalizeDomain('http://api.localhost/path'), null);
});

test('14. private and loopback IP addresses are rejected', () => {
  for (const value of ['http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.8/x', 'http://[::1]/x']) {
    assert.equal(normalizeDomain(value), null);
  }
});

test('15. SQL-injection-like text is extracted only as data', () => {
  const entities = extractEntities("https://evil.example/x'); DROP TABLE scam_entities; --");
  assert.deepEqual(values(entities, 'domain'), ['evil.example']);
  assert.ok(!JSON.stringify(entities).includes('DROP TABLE'));
});

test('16. phone values are redacted', () => {
  assert.equal(redactEntity('phone', '0810000000'), '081***0000');
});

test('17. bank-account values are redacted', () => {
  assert.equal(redactEntity('bank_account', '9999999999'), '******9999');
});

test('18. workflow contains zero Respond to Webhook nodes', () => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.respondToWebhook').length, 0);
});

test('19. workflow JSON parses and all Code node JavaScript compiles', () => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.name, 'Entity Intelligence Lookup V1');
  for (const node of workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new Function(node.parameters.jsCode), node.name);
  }
});

test('20. workflow embeds no credentials, password, public webhook, or raw SQL interpolation', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');
  const workflow = JSON.parse(source);
  assert.equal(workflow.nodes.some((node) => Object.prototype.hasOwnProperty.call(node, 'credentials')), false);
  assert.doesNotMatch(source, /POSTGRES_PASSWORD|password\s*[:=]|api[_-]?key/i);
  assert.equal(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.webhook'), false);
  const postgres = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.postgres');
  assert.ok(postgres);
  assert.match(postgres.parameters.query, /\$1::jsonb/);
  assert.match(postgres.parameters.query, /scam_entities\.source/);
  assert.doesNotMatch(postgres.parameters.query, /\{\{|\$json/);
  assert.match(postgres.parameters.options.queryReplacement, /JSON\.stringify\(\$json\.entities\)/);
});

test('21. normalized output omits submitted content and every execution path reaches the normalizer', () => {
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const normalizeNode = workflow.nodes.find((node) => node.name === 'Normalize Intelligence Result');
  assert.ok(normalizeNode);
  assert.match(normalizeNode.parameters.jsCode, /context: safeContext/);
  assert.doesNotMatch(normalizeNode.parameters.jsCode, /safeContext\s*=\s*\{[^}]*content:/s);

  const executableNodes = workflow.nodes.filter((node) => node.type !== 'n8n-nodes-base.stickyNote');
  const canReachNormalizer = (start) => {
    const queue = [start];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (current === 'Normalize Intelligence Result') return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const branch of workflow.connections[current]?.main || []) {
        for (const edge of branch || []) queue.push(edge.node);
      }
    }
    return false;
  };
  for (const node of executableNodes) assert.equal(canReachNormalizer(node.name), true, node.name);
});
