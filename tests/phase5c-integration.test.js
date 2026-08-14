'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
const main = readJson('n8n', 'workflows', 'text-analysis-main-v2.json');
const lookup = readJson('n8n', 'workflows', 'entity-intelligence-lookup-v1.json');
const routerSource = fs.readFileSync(path.join(root, 'n8n', 'workflows', 'model-router-v1.json'), 'utf8');

function node(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, `Missing node: ${name}`);
  return found;
}

function runCode(name, input, references = {}) {
  const code = node(main, name).parameters.jsCode;
  const $input = { first: () => ({ json: structuredClone(input) }) };
  const $ = (referenceName) => ({ first: () => ({ json: structuredClone(references[referenceName]) }) });
  return new Function('$input', '$', code)($input, $);
}

const context = {
  request_id: 'phase5c-test', analysis_id: 'ana-phase5c-test', input_type: 'text',
  content: 'message content', language: 'en', metadata: { source: 'test' },
  accepted_at: '2026-08-13T00:00:00.000Z', accepted_epoch_ms: 1786579200000,
  requested_output_language: 'en'
};
const analysis = {
  summary: 'Neutral model summary.', scam_categories: ['unclear'],
  indicators: [{ code: 'URGENCY_PRESSURE', title: 'Urgency', severity: 'high', evidence: 'message', explanation: 'Pressure.' }],
  recommended_actions: [], confidence: 0.9
};

function merge(entities, analysisOutput = analysis) {
  return runCode('Merge Intelligence Indicators', {
    ok: true, context, analysis_output: analysisOutput, internal_diagnostics: {}
  }, {
    'Validate Intelligence Lookup Result': {
      ok: true, intelligence: { entities }, internal_diagnostics: { entity_lookup: { matched_count: entities.filter((e) => e.matched).length } }
    }
  })[0].json;
}

function validateModelEvidence(content, evidence) {
  return runCode('Validate LLM Output', {
    context: { ...context, content },
    analysis_output: {
      summary: 'Evidence grounding test.',
      scam_categories: ['unclear'],
      indicators: [{
        code: 'URGENCY_PRESSURE',
        title: 'Test indicator',
        severity: 'high',
        evidence,
        explanation: 'Test explanation.'
      }],
      recommended_actions: [],
      confidence: 0.9
    }
  })[0].json;
}

test('strict grounding redacts formatted Thai local and international phone forms deterministically', () => {
  for (const phone of ['081-000-0000', '081 000 0000', '081.000.0000', '(081) 000-0000', '+66 81 000 0000', '0066 81 000 0000']) {
    const result = validateModelEvidence(`ติดต่อ ${phone} เพื่อรับสิทธิ์`, 'ติดต่อ [REDACTED] เพื่อรับสิทธิ์');
    assert.equal(result.ok, true, phone);
    assert.equal(result.analysis_output.indicators[0].evidence, 'ติดต่อ [REDACTED] เพื่อรับสิทธิ์', phone);
  }
});

test('exact original phone evidence passes grounding and is sanitized before downstream use', () => {
  const result = validateModelEvidence('ติดต่อ 081-000-0000 เพื่อรับสิทธิ์', 'ติดต่อ 081-000-0000 เพื่อรับสิทธิ์');
  assert.equal(result.ok, true);
  assert.equal(result.analysis_output.indicators[0].evidence, 'ติดต่อ [REDACTED] เพื่อรับสิทธิ์');
});

test('a different phone value is not accepted as grounded evidence', () => {
  const result = validateModelEvidence('ติดต่อ 081-000-0000 เพื่อรับสิทธิ์', 'ติดต่อ 089-999-9999 เพื่อรับสิทธิ์');
  assert.equal(result.ok, false);
  assert.equal(result.status_code, 422);
});

test('redacted marker is not a wildcard when source has no deterministic redaction', () => {
  const result = validateModelEvidence('ติดต่อฝ่ายบริการเพื่อรับสิทธิ์', '[REDACTED]');
  assert.equal(result.ok, false);
  assert.equal(result.status_code, 422);
});

test('exact normal evidence and grounded URL evidence pass unchanged', () => {
  for (const evidence of ['ข้อความทั่วไปสำหรับตรวจสอบ', 'https://safe-demo.example/path?q=1']) {
    const result = validateModelEvidence(`โปรดตรวจสอบ ${evidence} ก่อนดำเนินการ`, evidence);
    assert.equal(result.ok, true, evidence);
    assert.equal(result.analysis_output.indicators[0].evidence, evidence);
  }
});

test('phone redaction does not turn unrelated short digits into phone evidence', () => {
  const exact = validateModelEvidence('หมายเลขอ้างอิง 123456 ใช้ตรวจสอบรายการ', 'หมายเลขอ้างอิง 123456 ใช้ตรวจสอบรายการ');
  assert.equal(exact.ok, true);
  const inventedRedaction = validateModelEvidence('หมายเลขอ้างอิง 123456 ใช้ตรวจสอบรายการ', 'หมายเลขอ้างอิง [REDACTED] ใช้ตรวจสอบรายการ');
  assert.equal(inventedRedaction.ok, false);
  assert.equal(inventedRedaction.status_code, 422);
});

test('existing account redaction remains active after phone redaction', () => {
  const source = 'บัญชี 1234567890 สำหรับทดสอบ';
  const raw = validateModelEvidence(source, source);
  assert.equal(raw.ok, true);
  assert.equal(raw.analysis_output.indicators[0].evidence, 'บัญชี [REDACTED_ACCOUNT] สำหรับทดสอบ');
  const alreadyRedacted = validateModelEvidence(source, 'บัญชี [REDACTED_ACCOUNT] สำหรับทดสอบ');
  assert.equal(alreadyRedacted.ok, true);
});

test('existing OTP, password, API-key, and token redaction remains active', () => {
  for (const [source, sanitized] of [
    ['รหัส OTP 123456', 'รหัส OTP [REDACTED]'],
    ['password=secret-value', 'password=[REDACTED]'],
    ['api_key=secret-value', 'api_key=[REDACTED]'],
    ['access_token=secret-value', 'access_token=[REDACTED]']
  ]) {
    const result = validateModelEvidence(source, source);
    assert.equal(result.ok, true, source);
    assert.equal(result.analysis_output.indicators[0].evidence, sanitized, source);
  }
});

test('no entity match adds no database indicator and preserves model output', () => {
  const result = merge([{ entity_type: 'domain', redacted_value: 'unknown.example', matched: false, status: null, report_count: null, confidence_score: null }]);
  assert.deepEqual(result.analysis_output.indicators, analysis.indicators);
});

test('confirmed entities create safe authoritative indicators deterministically', () => {
  const result = merge([
    { entity_type: 'domain', redacted_value: 'scam-demo.example', matched: true, status: 'confirmed_scam', report_count: 15, confidence_score: 0.98 },
    { entity_type: 'phone', redacted_value: '081***0000', matched: true, status: 'confirmed_scam', report_count: 12, confidence_score: 0.95 },
    { entity_type: 'bank_account', redacted_value: '******9999', matched: true, status: 'confirmed_scam', report_count: 9, confidence_score: 0.94 }
  ]);
  const database = result.analysis_output.indicators.slice(1);
  assert.deepEqual(database.map((entry) => entry.code), ['KNOWN_SCAM_DOMAIN', 'KNOWN_SCAM_PHONE', 'KNOWN_SCAM_BANK_ACCOUNT']);
  assert.equal(database.find((entry) => entry.code === 'KNOWN_SCAM_PHONE').evidence, '081***0000');
  assert.equal(database.find((entry) => entry.code === 'KNOWN_SCAM_BANK_ACCOUNT').evidence, '******9999');
  assert.doesNotMatch(JSON.stringify(result), /9999999999|0810000000/);
  assert.equal(result.analysis_output.recommended_actions.length, 1);
});

test('reported and suspected matches produce one representative indicator by confidence, count, then order', () => {
  const result = merge([
    { entity_type: 'domain', redacted_value: 'reported-low.example', matched: true, status: 'reported', report_count: 99, confidence_score: 0.5 },
    { entity_type: 'bank_account', redacted_value: '******2222', matched: true, status: 'suspected', report_count: 4, confidence_score: 0.8 },
    { entity_type: 'phone', redacted_value: '089***3333', matched: true, status: 'reported', report_count: 4, confidence_score: 0.8 }
  ]);
  const indicators = result.analysis_output.indicators.filter((entry) => entry.code === 'REPORTED_SUSPICIOUS_ENTITY');
  assert.equal(indicators.length, 1);
  assert.equal(indicators[0].evidence, '******2222');
});

test('cleared matches create no indicator and never suppress a model indicator', () => {
  const result = merge([{ entity_type: 'domain', redacted_value: 'cleared-demo.example', matched: true, status: 'cleared', report_count: 0, confidence_score: 0.1 }]);
  assert.deepEqual(result.analysis_output.indicators, analysis.indicators);
});

test('database-owned codes replace theoretical model duplicates', () => {
  const withInjectedDatabaseCode = structuredClone(analysis);
  withInjectedDatabaseCode.indicators.push({
    code: 'KNOWN_SCAM_DOMAIN', title: 'Untrusted', severity: 'high', evidence: 'wrong.example', explanation: 'Model supplied.'
  });
  const result = merge([
    { entity_type: 'domain', redacted_value: 'first.example', matched: true, status: 'confirmed_scam', report_count: 2, confidence_score: 0.8 },
    { entity_type: 'domain', redacted_value: 'winner.example', matched: true, status: 'confirmed_scam', report_count: 5, confidence_score: 0.9 }
  ], withInjectedDatabaseCode);
  const matches = result.analysis_output.indicators.filter((entry) => entry.code === 'KNOWN_SCAM_DOMAIN');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].evidence, 'winner.example');
});

test('lookup database failure is normalized to safe 503', () => {
  const result = runCode('Validate Intelligence Lookup Result', {
    ok: false, status_code: 503,
    public_response: { error: { code: 'INTELLIGENCE_LOOKUP_UNAVAILABLE' } }
  }, { 'Build Intelligence Lookup Input': { context } })[0].json;
  assert.equal(result.status_code, 503);
  assert.equal(result.public_response.error.code, 'INTELLIGENCE_LOOKUP_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result.public_response), /postgres|sql|password|stack/i);
});

test('embedded scoring 1.1.0 scores merged intelligence and review policy', () => {
  const merged = merge([{ entity_type: 'domain', redacted_value: 'review-demo.example', matched: true, status: 'reported', report_count: 2, confidence_score: 0.55 }], {
    ...analysis, indicators: []
  });
  const result = runCode('Score Risk Deterministically', merged)[0].json;
  assert.equal(result.scoring.scoring_version, '1.1.0');
  assert.equal(result.scoring.taxonomy_version, '1.1.0');
  assert.equal(result.scoring.risk_score, 12);
  assert.equal(result.scoring.needs_human_review, true);
});

test('public success response shape is unchanged and excludes intelligence internals', () => {
  const merged = merge([{ entity_type: 'domain', redacted_value: 'scam-demo.example', matched: true, status: 'confirmed_scam', report_count: 15, confidence_score: 0.98 }], {
    ...analysis, indicators: []
  });
  const scored = runCode('Score Risk Deterministically', merged)[0].json;
  const result = runCode('Build Public Response', scored)[0].json;
  assert.deepEqual(Object.keys(result.public_response), [
    'api_version', 'taxonomy_version', 'scoring_version', 'analysis_id', 'timestamp',
    'risk_score', 'risk_level', 'summary', 'scam_categories', 'indicators',
    'recommended_actions', 'confidence', 'needs_human_review', 'processing_time_ms'
  ]);
  assert.equal(result.public_response.scoring_version, '1.1.0');
  assert.equal(result.public_response.taxonomy_version, '1.1.0');
  assert.equal(result.public_response.indicators[0].code, 'KNOWN_SCAM_DOMAIN');
  assert.doesNotMatch(JSON.stringify(result.public_response), /internal_diagnostics|report_count|confidence_score|database_matches|lookup_result|database_status/);
});

test('workflow structure preserves single response, isolated lookup, image boundary, and read-only SQL', () => {
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
  assert.equal(lookup.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 0);
  assert.ok(node(main, 'Execute Entity Intelligence Lookup V1'));
  assert.ok(node(main, 'Merge Intelligence Indicators'));
  const strictValidator = node(main, 'Validate LLM Output').parameters.jsCode;
  for (const backendCode of ['KNOWN_SCAM_PHONE', 'KNOWN_SCAM_BANK_ACCOUNT', 'KNOWN_SCAM_DOMAIN', 'REPORTED_SUSPICIOUS_ENTITY']) {
    assert.doesNotMatch(strictValidator, new RegExp(backendCode));
  }
  const imageNormalize = node(main, 'Normalize Extracted Text').parameters.jsCode;
  const lookupInput = node(main, 'Build Intelligence Lookup Input').parameters.jsCode;
  assert.doesNotMatch(imageNormalize, /base64_data|raw image bytes/i);
  assert.doesNotMatch(lookupInput, /base64_data/);
  assert.doesNotMatch(routerSource, /postgres|scam_entities|KNOWN_SCAM_/i);
  const postgres = lookup.nodes.find((entry) => entry.type === 'n8n-nodes-base.postgres');
  assert.ok(postgres);
  assert.match(postgres.parameters.query, /^\s*WITH\s+input_entities/i);
  assert.doesNotMatch(postgres.parameters.query, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|DROP|ALTER)\b/i);
  assert.equal(main.nodes.some((entry) => entry.credentials), false);
  assert.equal(lookup.nodes.some((entry) => entry.credentials), false);
});

test('both text and image paths reach lookup, router, finalizer, and the single response node', () => {
  const edges = (name) => (main.connections[name]?.main || []).flat().filter(Boolean).map((edge) => edge.node);
  assert.ok(edges('Preparation Successful?').includes('Build Intelligence Lookup Input'));
  assert.ok(edges('Image Text Ready?').includes('Build Intelligence Lookup Input'));
  assert.ok(edges('Intelligence Lookup Succeeded?').includes('Execute Model Router V1'));
  assert.ok(edges('Intelligence Lookup Succeeded?').includes('Finalize Response'));
  assert.deepEqual(edges('Finalize Response'), ['Respond']);
});
