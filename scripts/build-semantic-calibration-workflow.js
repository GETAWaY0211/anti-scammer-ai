'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const datasetPath = path.join(root, 'tests', 'fixtures', 'semantic-calibration-cases.json');
const outputPath = path.join(root, 'n8n', 'workflows', 'semantic-pattern-calibration-v1.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

const loadCode = `const DATASET = ${JSON.stringify(dataset)};
// Trusted operator-only filter. Empty means all cases; for a smoke test use ['prize_fee_02'].
const CALIBRATION_CASE_IDS = [];
const requested = new Set(CALIBRATION_CASE_IDS);
const selectedCases = requested.size === 0
  ? DATASET.cases
  : DATASET.cases.filter((testCase) => requested.has(testCase.case_id));
if (requested.size > 0 && selectedCases.length !== requested.size) throw new Error('Unknown calibration case_id in operator filter.');
return selectedCases.map((testCase) => ({
  json: {
    case_id: testCase.case_id,
    input_text: testCase.input_text,
    expected_pattern: testCase.expected_pattern,
    case_type: testCase.case_type,
    notes: testCase.notes,
    context: {
      request_id: testCase.case_id,
      analysis_id: 'calibration-' + testCase.case_id,
      content: testCase.input_text,
      language: 'th'
    }
  }
}));`;

const buildLookupInputCode = `return $input.all().map((item) => {
  const calibration = item.json || {};
  if (
    typeof calibration.case_id !== 'string' || !calibration.case_id ||
    typeof calibration.input_text !== 'string' || !calibration.input_text.trim()
  ) throw new Error('Calibration case cannot be adapted to semantic lookup input.');
  return {
    json: {
      context: {
        request_id: calibration.case_id,
        analysis_id: 'calibration-' + calibration.case_id,
        content: calibration.input_text,
        language: 'th'
      }
    }
  };
});`;

const reattachCode = `const lookup = JSON.parse(JSON.stringify($input.first().json || {}));
const request = $('Loop Over Calibration Cases').item.json;
const caseId = request && request.context && request.context.request_id;
if (typeof caseId !== 'string' || !caseId) throw new Error('Calibration correlation key is missing.');
const returnedId = lookup.context && lookup.context.request_id
  ? lookup.context.request_id
  : lookup.public_response && lookup.public_response.request_id
    ? lookup.public_response.request_id
    : null;
if (returnedId !== null && returnedId !== caseId) throw new Error('Semantic lookup correlation key mismatch.');
return [{ json: { case_id: caseId, lookup_result: lookup } }];`;

const collectCode = `const definitions = $('Load Calibration Cases').all().map((item) => item.json);
const definitionById = new Map(definitions.map((item) => [item.case_id, item]));
const results = $input.all().map((item) => item.json || {}).map((correlated) => {
  const caseId = correlated.case_id;
  const lookup = correlated.lookup_result || {};
  const definition = definitionById.get(caseId);
  if (!definition) throw new Error('Semantic calibration returned an unknown case.');
  if (lookup.ok !== true || !lookup.semantic_intelligence || !Array.isArray(lookup.semantic_intelligence.patterns)) {
    return {
      case_id: caseId,
      input_text: definition.input_text,
      expected_pattern: definition.expected_pattern,
      case_type: definition.case_type,
      notes: definition.notes,
      ok: false,
      patterns: [],
      status_code: Number.isInteger(Number(lookup.status_code)) ? Number(lookup.status_code) : null,
      semantic_error_code: lookup.public_response && lookup.public_response.error && typeof lookup.public_response.error.code === 'string'
        ? lookup.public_response.error.code
        : 'SEMANTIC_LOOKUP_FAILED',
      error_category: lookup.internal_diagnostics && lookup.internal_diagnostics.semantic_lookup
        ? lookup.internal_diagnostics.semantic_lookup.error_category || 'lookup_failed'
        : 'lookup_failed'
    };
  }
  return {
    case_id: caseId,
    input_text: definition.input_text,
    expected_pattern: definition.expected_pattern,
    case_type: definition.case_type,
    notes: definition.notes,
    ok: true,
    patterns: lookup.semantic_intelligence.patterns.map((pattern) => ({
      pattern_code: pattern.pattern_code,
      category: pattern.category,
      best_similarity: pattern.best_similarity,
      average_similarity: pattern.average_similarity,
      matched_example_count: pattern.matched_example_count
    }))
  };
}).sort((a, b) => a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0);
if (results.length !== definitions.length) throw new Error('Semantic calibration result count mismatch.');
return [{ json: { dataset_version: '${dataset.dataset_version}', results } }];`;

const workflow = {
  name: 'Semantic Pattern Calibration V1',
  nodes: [
    {
      parameters: {},
      id: '5dd00000-0000-4000-8000-000000000001',
      name: 'Manual Calibration Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-600, 0]
    },
    {
      parameters: { jsCode: loadCode },
      id: '5dd00000-0000-4000-8000-000000000002',
      name: 'Load Calibration Cases',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-360, 0],
      notesInFlow: true,
      notes: 'Generated from tests/fixtures/semantic-calibration-cases.json. Rebuild this workflow after changing the dataset.'
    },
    {
      parameters: { jsCode: buildLookupInputCode },
      id: '5dd00000-0000-4000-8000-000000000006',
      name: 'Build Semantic Lookup Input',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [-120, 0],
      notesInFlow: true,
      notes: 'Constructs a fresh allowlisted object containing only context. Calibration labels and notes never enter the production semantic lookup.'
    },
    {
      parameters: { batchSize: 1, options: {} },
      id: '5dd00000-0000-4000-8000-000000000007',
      name: 'Loop Over Calibration Cases',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [120, 0],
      notesInFlow: true,
      notes: 'Processes one case at a time to preserve deterministic correlation and avoid provider concurrency spikes.'
    },
    {
      parameters: {
        workflowId: { __rl: true, value: '', mode: 'list', cachedResultName: 'Semantic Pattern Lookup V1' },
        workflowInputs: {
          mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [],
          attemptToConvertTypes: false, convertFieldsToString: true
        },
        mode: 'once',
        options: { waitForSubWorkflow: true }
      },
      id: '5dd00000-0000-4000-8000-000000000003',
      name: 'Execute Semantic Pattern Lookup V1',
      type: 'n8n-nodes-base.executeWorkflow',
      typeVersion: 1.3,
      position: [380, 100],
      onError: 'continueRegularOutput',
      notesInFlow: true,
      notes: 'After import, select Semantic Pattern Lookup V1. One synthetic calibration case produces one normalized lookup result.'
    },
    {
      parameters: { jsCode: reattachCode },
      id: '5dd00000-0000-4000-8000-000000000008',
      name: 'Reattach Calibration Correlation',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [640, 100],
      notesInFlow: true,
      notes: 'Reattaches only case_id after the strict production sub-workflow returns. Evaluation labels remain in Load Calibration Cases.'
    },
    {
      parameters: { jsCode: collectCode },
      id: '5dd00000-0000-4000-8000-000000000004',
      name: 'Collect Calibration Results',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [400, -140]
    },
    {
      parameters: {
        content: '## Phase 5D-D calibration harness\nRuns the synthetic repository dataset through Semantic Pattern Lookup V1. Export the single normalized output as `tests/results/semantic-calibration-raw.json`, then run `node scripts/run-semantic-calibration.js`. No webhook, database write, Main integration, scoring, or threshold is present.',
        height: 250, width: 700, color: 5
      },
      id: '5dd00000-0000-4000-8000-000000000005',
      name: 'Phase 5D-D Notes',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-600, -340]
    }
  ],
  connections: {
    'Manual Calibration Trigger': { main: [[{ node: 'Load Calibration Cases', type: 'main', index: 0 }]] },
    'Load Calibration Cases': { main: [[{ node: 'Build Semantic Lookup Input', type: 'main', index: 0 }]] },
    'Build Semantic Lookup Input': { main: [[{ node: 'Loop Over Calibration Cases', type: 'main', index: 0 }]] },
    'Loop Over Calibration Cases': {
      main: [
        [{ node: 'Collect Calibration Results', type: 'main', index: 0 }],
        [{ node: 'Execute Semantic Pattern Lookup V1', type: 'main', index: 0 }]
      ]
    },
    'Execute Semantic Pattern Lookup V1': { main: [[{ node: 'Reattach Calibration Correlation', type: 'main', index: 0 }]] },
    'Reattach Calibration Correlation': { main: [[{ node: 'Loop Over Calibration Cases', type: 'main', index: 0 }]] }
  },
  pinData: {},
  settings: { executionOrder: 'v1' },
  active: false,
  versionId: '5dd00000-0000-4000-8000-000000000099',
  meta: { templateCredsSetupCompleted: false },
  tags: []
};

const rendered = `${JSON.stringify(workflow, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== rendered) {
    process.stderr.write('semantic-pattern-calibration-v1.json is out of date.\n');
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, rendered, 'utf8');
  process.stdout.write(`Generated ${path.relative(root, outputPath)} with ${dataset.cases.length} cases.\n`);
}
