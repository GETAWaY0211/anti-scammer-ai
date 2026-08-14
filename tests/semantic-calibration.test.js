'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildCalibrationResult,
  buildMarkdownSummary,
  sortPatterns
} = require('../scripts/run-semantic-calibration');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const dataset = JSON.parse(read('tests', 'fixtures', 'semantic-calibration-cases.json'));
const workflow = JSON.parse(read('n8n', 'workflows', 'semantic-pattern-calibration-v1.json'));
const pending = JSON.parse(read('tests', 'results', 'semantic-calibration.json'));

const REQUIRED_PATTERNS = [
  'BANK_OTP_IMPERSONATION', 'PRIZE_FEE', 'FAKE_JOB_RECHARGE',
  'INVESTMENT_GUARANTEED_RETURN', 'PARCEL_FEE', 'REMOTE_SUPPORT',
  'GOVERNMENT_THREAT', 'ROMANCE_EMERGENCY'
];

test('calibration dataset contains 52 complete synthetic cases', () => {
  assert.equal(dataset.cases.length, 52);
  assert.equal(new Set(dataset.cases.map((item) => item.case_id)).size, 52);
  for (const item of dataset.cases) {
    assert.equal(typeof item.case_id, 'string');
    assert.ok(item.input_text.trim());
    assert.ok(item.expected_pattern === null || REQUIRED_PATTERNS.includes(item.expected_pattern));
    assert.ok(item.case_type.trim());
    assert.ok(item.notes.trim());
  }
});

test('every verified pattern has multiple dedicated paraphrase cases', () => {
  for (const code of REQUIRED_PATTERNS) {
    const cases = dataset.cases.filter((item) => item.expected_pattern === code && item.case_type === 'pattern_paraphrase');
    assert.ok(cases.length >= 3, `${code} must have at least three paraphrases`);
  }
});

test('dataset covers benign, borderline, cross-pattern, sparse, typo, and mixed-language cases', () => {
  const types = new Set(dataset.cases.map((item) => item.case_type));
  for (const required of [
    'cross_pattern', 'benign', 'borderline_legitimate', 'short_sparse',
    'typo_informal_thai', 'mixed_thai_english'
  ]) assert.ok(types.has(required), `missing ${required}`);
  assert.ok(dataset.cases.filter((item) => item.case_type === 'benign').length >= 5);
  assert.ok(dataset.cases.filter((item) => item.case_type === 'borderline_legitimate').length >= 5);
});

test('calibration text contains no real-looking PII, account, or URL fixture', () => {
  for (const item of dataset.cases) {
    assert.doesNotMatch(item.input_text, /(?:\d[\s().-]*){8,}/, item.case_id);
    assert.doesNotMatch(item.input_text, /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|co\.th|th)\b)/i, item.case_id);
    assert.doesNotMatch(item.input_text, /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/, item.case_id);
  }
});

test('calibration workflow embeds the repository dataset and calls only the standalone lookup', () => {
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.respondToWebhook').length, 0);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.postgres').length, 0);
  assert.equal(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.httpRequest').length, 0);
  const execute = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(execute.length, 1);
  assert.equal(execute[0].parameters.workflowId.cachedResultName, 'Semantic Pattern Lookup V1');
  const loader = workflow.nodes.find((node) => node.name === 'Load Calibration Cases');
  const loaded = new Function(loader.parameters.jsCode)().map((item) => item.json);
  assert.deepEqual(loaded.map((item) => item.case_id), dataset.cases.map((item) => item.case_id));
});

test('adapter sends only the strict context envelope and correlates case_id to request_id', () => {
  const calibration = dataset.cases[0];
  const adapter = workflow.nodes.find((node) => node.name === 'Build Semantic Lookup Input');
  const execute = new Function('$input', adapter.parameters.jsCode);
  const result = execute({ all: () => [{ json: calibration }] })[0].json;
  assert.deepEqual(Object.keys(result), ['context']);
  assert.deepEqual(Object.keys(result.context), ['request_id', 'analysis_id', 'content', 'language']);
  assert.equal(result.context.request_id, calibration.case_id);
  assert.equal(result.context.analysis_id, `calibration-${calibration.case_id}`);
  assert.equal(result.context.content, calibration.input_text);
  for (const forbidden of ['case_id', 'input_text', 'expected_pattern', 'case_type', 'notes']) {
    assert.equal(Object.prototype.hasOwnProperty.call(result, forbidden), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.context, forbidden), false);
  }
});

test('production semantic validator remains strict while adapted input succeeds', () => {
  const lookup = JSON.parse(read('n8n', 'workflows', 'semantic-pattern-lookup-v1.json'));
  const validator = lookup.nodes.find((node) => node.name === 'Validate Semantic Lookup Input');
  const validate = new Function('$input', validator.parameters.jsCode);
  const fullCase = dataset.cases[0];
  const rejected = validate({ first: () => ({ json: fullCase }) })[0].json;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.internal_diagnostics.semantic_lookup.error_category, 'invalid_envelope');
  const adapter = workflow.nodes.find((node) => node.name === 'Build Semantic Lookup Input');
  const adapted = new Function('$input', adapter.parameters.jsCode)({ all: () => [{ json: fullCase }] })[0];
  const accepted = validate({ first: () => adapted })[0].json;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.semantic_input_valid, true);
});

test('failed lookup is reattached to the correct case and preserves evaluation metadata', () => {
  const definition = dataset.cases.find((item) => item.case_id === 'prize_fee_02');
  const failure = {
    ok: false,
    status_code: 503,
    public_response: {
      error: { code: 'SEMANTIC_LOOKUP_UNAVAILABLE', message: 'Unavailable', details: [] },
      request_id: definition.case_id,
      timestamp: '2026-08-14T00:00:00.000Z'
    },
    internal_diagnostics: { semantic_lookup: { error_category: 'provider_request_failed' } }
  };
  const reattach = workflow.nodes.find((node) => node.name === 'Reattach Calibration Correlation');
  const correlated = new Function('$input', '$', reattach.parameters.jsCode)(
    { first: () => ({ json: failure }) },
    () => ({ item: { json: { context: { request_id: definition.case_id } } } })
  )[0];
  assert.equal(correlated.json.case_id, definition.case_id);
  const collect = workflow.nodes.find((node) => node.name === 'Collect Calibration Results');
  const collected = new Function('$input', '$', collect.parameters.jsCode)(
    { all: () => [correlated] },
    () => ({ all: () => [{ json: definition }] })
  )[0].json.results[0];
  assert.equal(collected.case_id, definition.case_id);
  assert.equal(collected.expected_pattern, 'PRIZE_FEE');
  assert.equal(collected.ok, false);
  assert.equal(collected.semantic_error_code, 'SEMANTIC_LOOKUP_UNAVAILABLE');
  assert.equal(collected.error_category, 'provider_request_failed');
  assert.deepEqual(collected.patterns, []);
});

test('calibration loop processes one allowlisted item at a time without deprecated each mode', () => {
  const loop = workflow.nodes.find((node) => node.name === 'Loop Over Calibration Cases');
  const execute = workflow.nodes.find((node) => node.name === 'Execute Semantic Pattern Lookup V1');
  assert.equal(loop.type, 'n8n-nodes-base.splitInBatches');
  assert.equal(loop.parameters.batchSize, 1);
  assert.equal(execute.parameters.mode, 'once');
  assert.equal(workflow.connections['Build Semantic Lookup Input'].main[0][0].node, loop.name);
  assert.equal(workflow.connections['Reattach Calibration Correlation'].main[0][0].node, loop.name);
});

test('calibration and lookup workflows contain no runtime database write operation', () => {
  const lookup = JSON.parse(read('n8n', 'workflows', 'semantic-pattern-lookup-v1.json'));
  for (const candidate of [workflow, lookup]) {
    for (const postgres of candidate.nodes.filter((node) => node.type === 'n8n-nodes-base.postgres')) {
      assert.doesNotMatch(postgres.parameters.query, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
    }
  }
});

test('ranking and summary calculations are deterministic', () => {
  const smallDataset = {
    dataset_version: 'test',
    cases: [
      { case_id: 'known', input_text: 'synthetic', expected_pattern: 'PATTERN_A', case_type: 'pattern_paraphrase', notes: 'test' },
      { case_id: 'benign', input_text: 'normal', expected_pattern: null, case_type: 'benign', notes: 'test' },
      { case_id: 'borderline', input_text: 'warning', expected_pattern: null, case_type: 'borderline_legitimate', notes: 'test' }
    ]
  };
  const raw = { results: [
    { case_id: 'known', ok: true, patterns: [
      { pattern_code: 'PATTERN_B', category: 'b', best_similarity: 0.7, average_similarity: 0.7, matched_example_count: 1 },
      { pattern_code: 'PATTERN_A', category: 'a', best_similarity: 0.9, average_similarity: 0.8, matched_example_count: 2 }
    ] },
    { case_id: 'benign', ok: true, patterns: [{ pattern_code: 'PATTERN_B', category: 'b', best_similarity: 0.4, average_similarity: 0.35, matched_example_count: 1 }] },
    { case_id: 'borderline', ok: true, patterns: [{ pattern_code: 'PATTERN_A', category: 'a', best_similarity: 0.6, average_similarity: 0.55, matched_example_count: 1 }] }
  ] };
  const first = buildCalibrationResult(smallDataset, raw, '2026-08-14T00:00:00.000Z');
  const second = buildCalibrationResult(smallDataset, raw, '2026-08-14T00:00:00.000Z');
  assert.deepEqual(first, second);
  assert.equal(first.summary.top1_accuracy, 1);
  assert.equal(first.summary.top3_recall, 1);
  assert.equal(first.summary.highest_benign_similarity, 0.4);
  assert.equal(first.summary.highest_borderline_similarity, 0.6);
  assert.equal(first.summary.lowest_correct_pattern_similarity, 0.9);
  assert.equal(first.cases[0].top1_top2_similarity_margin, 0.2);
  assert.match(buildMarkdownSummary(first), /not a production-safe scam threshold/i);
});

test('deterministic tie-breaking uses average, count, then pattern code', () => {
  const sorted = sortPatterns([
    { pattern_code: 'C', best_similarity: 0.8, average_similarity: 0.7, matched_example_count: 2 },
    { pattern_code: 'B', best_similarity: 0.8, average_similarity: 0.75, matched_example_count: 1 },
    { pattern_code: 'A', best_similarity: 0.8, average_similarity: 0.75, matched_example_count: 1 }
  ]);
  assert.deepEqual(sorted.map((item) => item.pattern_code), ['A', 'B', 'C']);
});

test('pending and generated calibration outputs contain no raw vector fields', () => {
  assert.equal(pending.status, 'pending_runtime');
  const source = `${read('scripts', 'run-semantic-calibration.js')}\n${JSON.stringify(pending)}\n${JSON.stringify(workflow)}`;
  assert.doesNotMatch(source, /"(?:embedding|query_embedding|embedding_literal|values)"\s*:/i);
  assert.doesNotMatch(JSON.stringify(pending), /\[(?:-?\d+(?:\.\d+)?,){20}/);
});

test('no scam threshold, scoring, taxonomy, or Main integration is introduced', () => {
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /KNOWN_SCAM_PATTERN|risk_score|Score Risk|text-analysis-main-v2/);
  assert.doesNotMatch(read('tests', 'results', 'semantic-calibration.json'), /"similarity_threshold"/);
});

test('Main Workflow remains byte-for-byte unchanged by the calibration fix', () => {
  const main = read('n8n', 'workflows', 'text-analysis-main-v2.json');
  const digest = crypto.createHash('sha256').update(main).digest('hex');
  assert.equal(digest, '6f88c3568cf8c5686ec48454cd827ed290bc0759571ebd68af8f791a76d10130');
  assert.doesNotMatch(main, /Semantic Pattern Calibration|Build Semantic Lookup Input/);
});
