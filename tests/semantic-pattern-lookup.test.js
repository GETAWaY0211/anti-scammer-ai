'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const parseWorkflow = (name) => JSON.parse(read('n8n', 'workflows', name));
const migration = read('database', 'migrations', '003_add_scam_pattern_embeddings.sql');
const generator = parseWorkflow('generate-curated-pattern-embeddings-v1.json');
const lookup = parseWorkflow('semantic-pattern-lookup-v1.json');
const fixtures = JSON.parse(read('tests', 'fixtures', 'semantic-pattern-cases.json'));
const node = (workflow, name) => workflow.nodes.find((item) => item.name === name);

test('migration fixes gemini-embedding-2 storage at the selected 768 dimensions', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS embedding vector\(768\)/i);
  assert.match(migration, /embedding_model = 'gemini-embedding-2'/i);
  assert.match(migration, /embedding_dimensions = 768/i);
  assert.match(migration, /vector_dims\(embedding\) = 768/i);
  assert.doesNotMatch(migration, /\b(?:HNSW|IVFFLAT)\b/i);
});

test('embedding metadata constraint rejects null mismatches and wrong model or dimensions', () => {
  assert.match(migration, /embedding IS NULL\s+AND embedding_model IS NULL\s+AND embedding_dimensions IS NULL/s);
  assert.match(migration, /embedding IS NOT NULL\s+AND embedding_model = 'gemini-embedding-2'\s+AND embedding_dimensions = 768/s);
});

test('curated generator selects only verified active curated examples needing embeddings', () => {
  const query = node(generator, 'Load Verified Curated Examples').parameters.query;
  assert.match(query, /example\.example_status = 'verified'/);
  assert.match(query, /example\.is_active = TRUE/);
  assert.match(query, /pattern\.status = 'verified'/);
  assert.match(query, /pattern\.is_active = TRUE/);
  assert.match(query, /example\.source = 'development_curated_seed'/);
  assert.match(query, /example\.embedding IS NULL/);
});

test('curated generator updates only embedding fields on existing curated rows with parameters', () => {
  const update = node(generator, 'Store Curated Embedding');
  const query = update.parameters.query;
  assert.match(query, /^UPDATE scam_pattern_examples/m);
  assert.match(query, /embedding = \$1::vector/);
  assert.match(query, /embedding_model = \$2/);
  assert.match(query, /embedding_dimensions = \$3/);
  assert.match(query, /WHERE id = \$4/);
  assert.match(query, /example_status = 'verified'/);
  assert.match(query, /source = 'development_curated_seed'/);
  assert.doesNotMatch(query, /\bINSERT\b/i);
  assert.match(update.parameters.options.queryReplacement, /embedding_literal/);
});

test('wrong-length provider vectors are rejected before curated storage and runtime lookup', () => {
  const parseCode = node(lookup, 'Parse Embedding Response').parameters.jsCode;
  const execute = new Function('$input', '$', parseCode);
  const result = execute(
    { first: () => ({ json: { statusCode: 200, body: { embedding: { values: [0.1, 0.2] } } } }) },
    () => ({ first: () => ({ json: { context: { request_id: 'test' } } }) })
  );
  assert.equal(result[0].json.ok, false);
  assert.equal(result[0].json.internal_diagnostics.semantic_lookup.error_category, 'invalid_embedding_dimension');
  assert.match(node(generator, 'Validate Curated Embedding').parameters.jsCode, /values\.length !== EMBEDDING_DIMENSIONS/);
});

test('semantic lookup uses parameterized exact cosine search over verified active rows with top-k five', () => {
  const postgres = node(lookup, 'PostgreSQL Cosine Lookup');
  const query = postgres.parameters.query;
  assert.match(query, /embedding <=> \$1::vector/);
  assert.match(query, /embedding_model = \$2/);
  assert.match(query, /embedding_dimensions = \$3/);
  assert.match(query, /example\.example_status = 'verified'/);
  assert.match(query, /example\.is_active = TRUE/);
  assert.match(query, /pattern\.status = 'verified'/);
  assert.match(query, /pattern\.is_active = TRUE/);
  assert.match(query, /LIMIT 5/);
  assert.match(postgres.parameters.options.queryReplacement, /query_embedding_literal/);
  assert.doesNotMatch(query, /\$json|context\.content|\+\s*(?:content|vector)/i);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
});

test('pattern aggregation is deterministic and emits no raw embeddings', () => {
  const normalizeCode = node(lookup, 'Normalize Semantic Intelligence Result').parameters.jsCode;
  const execute = new Function('$input', '$', normalizeCode);
  const rows = [
    { pattern_code: 'PRIZE_FEE', category: 'prize_lottery_scam', similarity: '0.81', example_rank: 2 },
    { pattern_code: 'BANK_OTP_IMPERSONATION', category: 'bank_impersonation', similarity: '0.91', example_rank: 1 },
    { pattern_code: 'PRIZE_FEE', category: 'prize_lottery_scam', similarity: '0.79', example_rank: 3 }
  ];
  const parsed = { context: { request_id: 'r1', analysis_id: 'a1', language: 'th' } };
  const result = execute(
    { all: () => rows.map((json) => ({ json })) },
    () => ({ first: () => ({ json: parsed }) })
  )[0].json;
  assert.deepEqual(result.semantic_intelligence.patterns.map((item) => item.pattern_code), [
    'BANK_OTP_IMPERSONATION', 'PRIZE_FEE'
  ]);
  assert.equal(result.semantic_intelligence.patterns[1].best_similarity, 0.81);
  assert.equal(result.semantic_intelligence.patterns[1].average_similarity, 0.8);
  assert.equal(result.semantic_intelligence.patterns[1].matched_example_count, 2);
  assert.doesNotMatch(JSON.stringify(result), /query_embedding|embedding_literal|\[(?:0\.\d+,){10}/);
});

test('lookup rejects client-controlled model, vector, top-k, and threshold fields', () => {
  const code = node(lookup, 'Validate Semantic Lookup Input').parameters.jsCode;
  const execute = new Function('$input', code);
  for (const forbidden of ['model', 'embedding_model', 'vector', 'embedding', 'top_k', 'similarity_threshold', 'threshold']) {
    const result = execute({ first: () => ({ json: { context: { content: 'ข้อความทดสอบ', [forbidden]: 'client-value' } } }) });
    assert.equal(result[0].json.ok, false, `${forbidden} must be rejected`);
  }
});

test('both semantic workflows parse, compile, embed no credentials, and contain zero response nodes', () => {
  for (const workflow of [generator, lookup]) {
    assert.equal(workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.respondToWebhook').length, 0);
    assert.equal(workflow.active, false);
    for (const codeNode of workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new Function(codeNode.parameters.jsCode), `${workflow.name}/${codeNode.name}`);
    }
    const serialized = JSON.stringify(workflow);
    assert.doesNotMatch(serialized, /AIza[0-9A-Za-z_-]{20,}|api[_-]?key["']?\s*[:=]\s*["'][^"']+/i);
  }
});

test('semantic test fixture covers three paraphrases and two benign cases without a threshold', () => {
  assert.equal(fixtures.embedding_model, 'gemini-embedding-2');
  assert.equal(fixtures.embedding_dimensions, 768);
  assert.equal(fixtures.top_k, 5);
  assert.equal(fixtures.cases.length, 5);
  assert.equal(fixtures.cases.filter((item) => item.expected_candidate_pattern).length, 3);
  assert.equal(fixtures.cases.filter((item) => item.expected_candidate_pattern === null).length, 2);
  assert.ok(fixtures.cases.every((item) => item.observed_similarity_distribution === null || Array.isArray(item.observed_similarity_distribution)));
  assert.equal(Object.prototype.hasOwnProperty.call(fixtures, 'similarity_threshold'), false);
});

test('lookup graph terminal paths normalize once and never reach Main or scoring', () => {
  const response = node(lookup, 'Normalize Semantic Intelligence Result');
  const usage = node(lookup, 'Attach Embedding Usage');
  assert.ok(response);
  assert.deepEqual(lookup.connections[response.name].main[0].map((edge) => edge.node), ['Attach Embedding Usage']);
  assert.equal(lookup.connections[usage.name], undefined);
  const serialized = JSON.stringify(lookup);
  assert.doesNotMatch(serialized, /text-analysis-main-v2|Score Risk|risk_score|KNOWN_SCAM_PATTERN/);
  for (const gate of ['Semantic Input Valid?', 'Embedding Request Ready?', 'Embedding Parsed?']) {
    const branches = lookup.connections[gate].main;
    assert.equal(branches.length, 2);
    assert.equal(branches[1][0].node, 'Normalize Semantic Intelligence Result');
  }
});
