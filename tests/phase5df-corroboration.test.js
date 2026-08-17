'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'text-analysis-main-v2.json'), 'utf8'));

function node(name) {
  const found = main.nodes.find((entry) => entry.name === name);
  assert.ok(found, `Missing node: ${name}`);
  return found;
}

function runCode(name, input) {
  const $input = { first: () => ({ json: structuredClone(input) }) };
  return new Function('$input', node(name).parameters.jsCode)($input)[0].json;
}

const context = {
  request_id: 'phase5df-test', analysis_id: 'analysis-phase5df-test', input_type: 'text',
  content: 'synthetic test content', language: 'th', metadata: {},
  accepted_at: '2026-08-17T00:00:00.000Z', accepted_epoch_ms: 1786924800000,
  requested_output_language: 'th'
};

function input(patternCodes, indicatorCodes, available = true) {
  return {
    ok: true,
    context,
    analysis_output: {
      summary: 'Synthetic test summary.', scam_categories: ['unclear'],
      indicators: indicatorCodes.map((code) => ({ code })),
      recommended_actions: [], confidence: 0.9
    },
    semantic_pattern_intelligence: {
      available,
      patterns: patternCodes.map((pattern_code) => ({
        pattern_code, category: 'test_category', best_similarity: 0.9,
        average_similarity: 0.8, matched_example_count: 2
      }))
    },
    internal_diagnostics: {}
  };
}

function evaluate(patternCodes, indicatorCodes, available = true) {
  return runCode('Evaluate Semantic Corroboration', input(patternCodes, indicatorCodes, available));
}

test('bank OTP pattern corroborates only with a required validated indicator', () => {
  const result = evaluate(
    ['BANK_OTP_IMPERSONATION'],
    ['BANK_IMPERSONATION', 'OTP_REQUEST', 'URGENCY_PRESSURE']
  );
  assert.deepEqual(result.semantic_corroboration, {
    evaluated: true,
    matches: [{
      pattern_code: 'BANK_OTP_IMPERSONATION', corroborated: true,
      required_indicator_match: true,
      matched_required_indicators: ['OTP_REQUEST'],
      matched_supporting_indicators: ['BANK_IMPERSONATION', 'URGENCY_PRESSURE']
    }]
  });
});

test('legitimate bank OTP warning and supporting-only evidence do not corroborate', () => {
  for (const indicators of [[], ['BANK_IMPERSONATION', 'URGENCY_PRESSURE']]) {
    const match = evaluate(['BANK_OTP_IMPERSONATION'], indicators).semantic_corroboration.matches[0];
    assert.equal(match.corroborated, false);
    assert.equal(match.required_indicator_match, false);
    assert.deepEqual(match.matched_required_indicators, []);
  }
});

test('investment pattern corroborates with guaranteed-return evidence but not a risk warning', () => {
  const scam = evaluate(
    ['INVESTMENT_GUARANTEED_RETURN'],
    ['GUARANTEED_RETURN', 'PAYMENT_REQUEST']
  ).semantic_corroboration.matches[0];
  assert.equal(scam.corroborated, true);
  assert.deepEqual(scam.matched_required_indicators, ['GUARANTEED_RETURN']);
  assert.deepEqual(scam.matched_supporting_indicators, ['PAYMENT_REQUEST']);

  const warning = evaluate(
    ['INVESTMENT_GUARANTEED_RETURN'],
    ['PAYMENT_REQUEST', 'URGENCY_PRESSURE']
  ).semantic_corroboration.matches[0];
  assert.equal(warning.corroborated, false);
  assert.deepEqual(warning.matched_required_indicators, []);
});

test('cross-pattern scam patterns corroborate independently', () => {
  const result = evaluate(
    ['BANK_OTP_IMPERSONATION', 'REMOTE_SUPPORT'],
    ['OTP_REQUEST', 'REMOTE_ACCESS_REQUEST', 'SCREEN_SHARE_REQUEST']
  );
  assert.deepEqual(result.semantic_corroboration.matches.map((match) => ({
    code: match.pattern_code,
    corroborated: match.corroborated,
    required: match.matched_required_indicators
  })), [
    { code: 'BANK_OTP_IMPERSONATION', corroborated: true, required: ['OTP_REQUEST'] },
    { code: 'REMOTE_SUPPORT', corroborated: true, required: ['REMOTE_ACCESS_REQUEST', 'SCREEN_SHARE_REQUEST'] }
  ]);
});

test('all eight pattern policies use required-any and supporting indicators deterministically', () => {
  const cases = [
    ['BANK_OTP_IMPERSONATION', 'VERIFICATION_CODE_FORWARDING', 'COMPANY_IMPERSONATION'],
    ['PRIZE_FEE', 'PRIZE_FEE_REQUEST', 'UNSOLICITED_PRIZE'],
    ['FAKE_JOB_RECHARGE', 'TASK_RECHARGE_REQUEST', 'PAYMENT_REQUEST'],
    ['INVESTMENT_GUARANTEED_RETURN', 'UNREALISTIC_RETURN', 'URGENCY_PRESSURE'],
    ['PARCEL_FEE', 'FAKE_DELIVERY_FEE', 'PAYMENT_REQUEST'],
    ['REMOTE_SUPPORT', 'DISABLE_SECURITY_REQUEST', 'COMPANY_IMPERSONATION'],
    ['GOVERNMENT_THREAT', 'FAKE_AUTHORITY_CLAIM', 'THREAT_OR_INTIMIDATION'],
    ['ROMANCE_EMERGENCY', 'EMOTIONAL_MANIPULATION', 'ISOLATION_FROM_TRUSTED_CONTACTS']
  ];
  for (const [pattern, required, supporting] of cases) {
    const match = evaluate([pattern], [required, supporting]).semantic_corroboration.matches[0];
    assert.equal(match.corroborated, true, pattern);
    assert.deepEqual(match.matched_required_indicators, [required], pattern);
    assert.deepEqual(match.matched_supporting_indicators, [supporting], pattern);
  }
});

test('semantic unavailable is not evaluated', () => {
  const result = evaluate([], ['OTP_REQUEST'], false);
  assert.deepEqual(result.semantic_corroboration, { evaluated: false, matches: [] });
  assert.equal(result.internal_diagnostics.semantic_corroboration.evaluated, false);
});

test('unknown semantic pattern fails closed and is ignored safely', () => {
  const result = evaluate(['UNKNOWN_PATTERN'], ['OTP_REQUEST']);
  assert.deepEqual(result.semantic_corroboration, { evaluated: true, matches: [] });
  assert.equal(result.internal_diagnostics.semantic_corroboration.ignored_unknown_pattern_count, 1);
});

test('corroboration never creates or changes indicators and does not mutate input', () => {
  const original = input(['BANK_OTP_IMPERSONATION'], ['BANK_IMPERSONATION', 'URGENCY_PRESSURE']);
  const snapshot = structuredClone(original);
  const result = runCode('Evaluate Semantic Corroboration', original);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(result.analysis_output.indicators, snapshot.analysis_output.indicators);
  assert.equal(result.semantic_corroboration.matches[0].corroborated, false);
});

test('identical validated indicator sets produce exactly the same scoring result', () => {
  const analysisOutput = {
    summary: 'Synthetic scam message.', scam_categories: ['bank_impersonation'],
    indicators: [
      { code: 'OTP_REQUEST', title: 'OTP request', severity: 'critical', evidence: 'OTP', explanation: 'Requests an OTP.' },
      { code: 'BANK_IMPERSONATION', title: 'Bank impersonation', severity: 'high', evidence: 'bank', explanation: 'Claims to be a bank.' },
      { code: 'URGENCY_PRESSURE', title: 'Urgency', severity: 'high', evidence: 'now', explanation: 'Creates urgency.' }
    ],
    recommended_actions: [], confidence: 0.95
  };
  const before = { ok: true, context, analysis_output: analysisOutput };
  const withSemantic = {
    ...before,
    semantic_pattern_intelligence: input(['BANK_OTP_IMPERSONATION'], []).semantic_pattern_intelligence,
    internal_diagnostics: {}
  };
  const afterCorroboration = runCode('Evaluate Semantic Corroboration', withSemantic);
  const beforeScore = runCode('Score Risk Deterministically', before).scoring;
  const afterScore = runCode('Score Risk Deterministically', afterCorroboration).scoring;
  assert.deepEqual(afterScore, beforeScore);
  assert.equal(afterScore.scoring_version, '1.1.0');
  assert.equal(afterScore.taxonomy_version, '1.1.0');
});

test('public API response does not expose semantic corroboration', () => {
  const base = {
    ok: true, context,
    analysis_output: {
      summary: 'Synthetic normal message.', scam_categories: ['unclear'], indicators: [],
      recommended_actions: [], confidence: 0.9
    },
    semantic_pattern_intelligence: input(['BANK_OTP_IMPERSONATION'], []).semantic_pattern_intelligence,
    internal_diagnostics: {}
  };
  const corroborated = runCode('Evaluate Semantic Corroboration', base);
  const scored = runCode('Score Risk Deterministically', corroborated);
  const response = runCode('Build Public Response', scored).public_response;
  assert.doesNotMatch(JSON.stringify(response), /semantic_corroboration|pattern_code|similarity|matched_required/i);
  assert.deepEqual(Object.keys(response), [
    'api_version', 'taxonomy_version', 'scoring_version', 'analysis_id', 'timestamp',
    'risk_score', 'risk_level', 'summary', 'scam_categories', 'indicators',
    'recommended_actions', 'confidence', 'needs_human_review', 'processing_time_ms'
  ]);
});

test('Main graph places deterministic corroboration immediately before scoring', () => {
  const edges = (name) => (main.connections[name]?.main || []).flat().filter(Boolean).map((edge) => edge.node);
  assert.deepEqual(edges('Attach Semantic Pattern Intelligence'), ['Evaluate Semantic Corroboration']);
  assert.deepEqual(edges('Evaluate Semantic Corroboration'), ['Score Risk Deterministically']);
  assert.equal(node('Evaluate Semantic Corroboration').type, 'n8n-nodes-base.code');
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
});
