'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8'));
const main = readJson('n8n', 'workflows', 'text-analysis-main-v2.json');
const semanticLookup = readJson('n8n', 'workflows', 'semantic-pattern-lookup-v1.json');

function node(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, `Missing node: ${name}`);
  return found;
}

function runCode(name, input, references = {}) {
  const code = node(main, name).parameters.jsCode;
  const $input = { first: () => ({ json: structuredClone(input) }) };
  const $ = (referenceName) => ({ first: () => ({ json: structuredClone(references[referenceName]) }) });
  return new Function('$input', '$', code)($input, $)[0].json;
}

const context = {
  request_id: 'phase5de-test', analysis_id: 'analysis-phase5de-test', input_type: 'text',
  content: 'ธนาคารไม่มีนโยบายขอ OTP กรุณาอย่าส่งรหัสให้ผู้อื่น', language: 'th',
  metadata: { source: 'test' }, accepted_at: '2026-08-17T00:00:00.000Z',
  accepted_epoch_ms: 1786924800000, requested_output_language: 'th'
};
const entityResult = {
  ok: true, context, intelligence: { entities: [] },
  internal_diagnostics: { entity_lookup: { lookup_performed: true, matched_count: 0 } }
};
const semanticSuccess = {
  ok: true,
  context: { request_id: context.request_id, analysis_id: context.analysis_id, language: 'th' },
  semantic_intelligence: {
    top_k: 5,
    patterns: [{
      pattern_code: 'BANK_OTP_IMPERSONATION', category: 'bank_impersonation',
      best_similarity: 0.91, average_similarity: 0.84, matched_example_count: 2,
      matched_examples: [{ similarity: 0.91, example_rank: 1 }, { similarity: 0.77, example_rank: 4 }]
    }]
  },
  internal_diagnostics: { semantic_lookup: { lookup_performed: true, retrieved_example_count: 2, aggregated_pattern_count: 1 } }
};
const emptyAnalysis = {
  summary: 'No supported scam behavior was established.', scam_categories: ['unclear'],
  indicators: [], recommended_actions: [], confidence: 0.9
};

test('semantic adapter creates only the strict allowlisted context envelope', () => {
  const built = runCode('Build Semantic Lookup Input', {
    ...entityResult,
    context: { ...context, base64_data: 'SHOULD_NOT_PASS', raw_request: { provider: 'client-value' } },
    provider: 'client-value', intelligence: { entities: [{ raw: 'not-forwarded' }] }
  });
  assert.deepEqual(Object.keys(built), ['context']);
  assert.deepEqual(Object.keys(built.context), ['request_id', 'analysis_id', 'content', 'language']);
  assert.equal(built.context.content, context.content);
  assert.doesNotMatch(JSON.stringify(built), /base64|provider|intelligence|raw_request/i);
});

test('valid semantic output is strictly normalized and source examples are discarded', () => {
  const result = runCode('Validate Semantic Pattern Result', semanticSuccess, {
    'Validate Intelligence Lookup Result': entityResult
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.semantic_pattern_intelligence, {
    available: true,
    patterns: [{
      pattern_code: 'BANK_OTP_IMPERSONATION', category: 'bank_impersonation',
      best_similarity: 0.91, average_similarity: 0.84, matched_example_count: 2
    }]
  });
  assert.doesNotMatch(JSON.stringify(result.semantic_pattern_intelligence), /matched_examples|embedding|provider|database_id|example_id/i);
});

test('invalid, unavailable, or unsafe semantic output becomes optional unavailable intelligence', () => {
  for (const raw of [
    { ok: false, status_code: 503, public_response: { error: { code: 'SEMANTIC_LOOKUP_UNAVAILABLE' } } },
    { ...semanticSuccess, embedding: [0.1, 0.2] },
    { ...semanticSuccess, semantic_intelligence: { top_k: 5, patterns: [{ ...semanticSuccess.semantic_intelligence.patterns[0], best_similarity: 1.2 }] } },
    { ...semanticSuccess, semantic_intelligence: { top_k: 5, patterns: [{ pattern_code: 'UNKNOWN_PATTERN', category: 'unclear', best_similarity: 0.8, average_similarity: 0.7, matched_example_count: 1 }] } }
  ]) {
    const result = runCode('Validate Semantic Pattern Result', raw, {
      'Validate Intelligence Lookup Result': entityResult
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.semantic_pattern_intelligence, { available: false, patterns: [] });
    assert.equal(result.internal_diagnostics.semantic_lookup.available, false);
    assert.ok(result.context);
    assert.ok(result.intelligence);
  }
});

test('semantic ordering and pattern count are enforced deterministically', () => {
  const reversed = structuredClone(semanticSuccess);
  reversed.semantic_intelligence.patterns = [
    { pattern_code: 'PRIZE_FEE', category: 'prize_lottery_scam', best_similarity: 0.7, average_similarity: 0.7, matched_example_count: 1 },
    { pattern_code: 'BANK_OTP_IMPERSONATION', category: 'bank_impersonation', best_similarity: 0.9, average_similarity: 0.8, matched_example_count: 1 }
  ];
  const result = runCode('Validate Semantic Pattern Result', reversed, {
    'Validate Intelligence Lookup Result': entityResult
  });
  assert.equal(result.semantic_pattern_intelligence.available, false);
  assert.equal(result.internal_diagnostics.semantic_lookup.error_category, 'non_deterministic_pattern_order');
});

test('high semantic similarity for legitimate negation creates no indicator and no score', () => {
  const normalized = runCode('Validate Semantic Pattern Result', semanticSuccess, {
    'Validate Intelligence Lookup Result': entityResult
  });
  const merged = {
    ok: true, context, analysis_output: structuredClone(emptyAnalysis), intelligence: { entities: [] }, internal_diagnostics: {}
  };
  const attached = runCode('Attach Semantic Pattern Intelligence', merged, {
    'Validate Semantic Pattern Result': normalized
  });
  assert.deepEqual(attached.analysis_output.indicators, []);
  assert.equal(attached.semantic_pattern_intelligence.patterns[0].pattern_code, 'BANK_OTP_IMPERSONATION');
  const scored = runCode('Score Risk Deterministically', attached);
  assert.equal(scored.scoring.risk_score, 0);
  assert.equal(scored.scoring.risk_level, 'low');
});

test('investment-warning semantic match cannot synthesize guaranteed-return behavior', () => {
  const investment = structuredClone(semanticSuccess);
  investment.semantic_intelligence.patterns[0] = {
    pattern_code: 'INVESTMENT_GUARANTEED_RETURN', category: 'investment_scam',
    best_similarity: 0.89, average_similarity: 0.82, matched_example_count: 2
  };
  const normalized = runCode('Validate Semantic Pattern Result', investment, {
    'Validate Intelligence Lookup Result': { ...entityResult, context: { ...context, content: 'การลงทุนมีความเสี่ยงและไม่รับประกันผลตอบแทน' } }
  });
  const attached = runCode('Attach Semantic Pattern Intelligence', {
    ok: true, context: { ...context, content: 'การลงทุนมีความเสี่ยงและไม่รับประกันผลตอบแทน' },
    analysis_output: structuredClone(emptyAnalysis), intelligence: { entities: [] }, internal_diagnostics: {}
  }, { 'Validate Semantic Pattern Result': normalized });
  assert.deepEqual(attached.analysis_output.indicators, []);
  assert.equal(runCode('Score Risk Deterministically', attached).scoring.risk_score, 0);
});

test('semantic attachment leaves deterministic scoring identical', () => {
  const analysis = {
    ...emptyAnalysis,
    scam_categories: ['bank_impersonation'],
    indicators: [{ code: 'OTP_REQUEST', title: 'OTP request', severity: 'critical', evidence: 'OTP', explanation: 'Requests OTP.' }]
  };
  const base = { ok: true, context, analysis_output: analysis, intelligence: { entities: [] }, internal_diagnostics: {} };
  const normalized = runCode('Validate Semantic Pattern Result', semanticSuccess, {
    'Validate Intelligence Lookup Result': entityResult
  });
  const attached = runCode('Attach Semantic Pattern Intelligence', base, {
    'Validate Semantic Pattern Result': normalized
  });
  assert.deepEqual(runCode('Score Risk Deterministically', attached).scoring, runCode('Score Risk Deterministically', base).scoring);
});

test('public response remains unchanged and excludes all semantic intelligence', () => {
  const scoringInput = { ok: true, context, analysis_output: emptyAnalysis, semantic_pattern_intelligence: { available: true, patterns: semanticSuccess.semantic_intelligence.patterns } };
  const scored = runCode('Score Risk Deterministically', scoringInput);
  const response = runCode('Build Public Response', scored).public_response;
  assert.deepEqual(Object.keys(response), [
    'api_version', 'taxonomy_version', 'scoring_version', 'analysis_id', 'timestamp',
    'risk_score', 'risk_level', 'summary', 'scam_categories', 'indicators',
    'recommended_actions', 'confidence', 'needs_human_review', 'processing_time_ms'
  ]);
  assert.doesNotMatch(JSON.stringify(response), /semantic|similarity|embedding|pattern_code|pgvector/i);
});

test('workflow structure preserves authoritative entity failure and optional semantic continuation', () => {
  const edges = (name, output = 0) => (main.connections[name]?.main?.[output] || []).map((edge) => edge.node);
  assert.deepEqual(edges('Intelligence Lookup Succeeded?', 0), ['Build Semantic Lookup Input']);
  assert.deepEqual(edges('Intelligence Lookup Succeeded?', 1), ['Finalize Response']);
  assert.deepEqual(edges('Build Semantic Lookup Input'), ['Execute Semantic Pattern Lookup V1']);
  assert.deepEqual(edges('Execute Semantic Pattern Lookup V1'), ['Validate Semantic Pattern Result']);
  assert.deepEqual(edges('Validate Semantic Pattern Result'), ['Execute Model Router V1']);
  assert.deepEqual(edges('Merge Intelligence Indicators'), ['Attach Semantic Pattern Intelligence']);
  assert.deepEqual(edges('Attach Semantic Pattern Intelligence'), ['Score Risk Deterministically']);
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
  assert.equal(semanticLookup.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 0);
});

test('every functional Main branch can reach the single Respond node', () => {
  const adjacency = new Map(Object.entries(main.connections).map(([name, value]) => [
    name,
    (value.main || []).flat().filter(Boolean).map((edge) => edge.node)
  ]));
  const canReachRespond = (start) => {
    const pending = [start];
    const visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (current === 'Respond') return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(adjacency.get(current) || []));
    }
    return false;
  };
  for (const workflowNode of main.nodes.filter((entry) => entry.type !== 'n8n-nodes-base.stickyNote')) {
    assert.equal(canReachRespond(workflowNode.name), true, `${workflowNode.name} cannot reach Respond`);
  }
  const terminals = main.nodes
    .filter((entry) => entry.type !== 'n8n-nodes-base.stickyNote' && (adjacency.get(entry.name) || []).length === 0)
    .map((entry) => entry.name);
  assert.deepEqual(terminals, ['Respond']);
});

test('semantic integration is read-only and does not alter scoring or taxonomy versions', () => {
  const serializedMain = JSON.stringify(main);
  const serializedLookup = JSON.stringify(semanticLookup);
  assert.doesNotMatch(serializedMain, /KNOWN_SCAM_PATTERN|SIMILAR_TO_VERIFIED_SCAM_PATTERN/);
  assert.doesNotMatch(serializedLookup, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE)\b/i);
  assert.match(node(main, 'Score Risk Deterministically').parameters.jsCode, /scoring_version:'1\.1\.0',taxonomy_version:'1\.1\.0'/);
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.executeWorkflow' && entry.name === 'Execute Semantic Pattern Lookup V1').length, 1);
});
