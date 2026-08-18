'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readWorkflow = (name) => JSON.parse(
  fs.readFileSync(path.join(root, 'n8n', 'workflows', name), 'utf8')
);

const workflows = {
  provider: readWorkflow('provider-gemini-v1.json'),
  router: readWorkflow('model-router-v1.json'),
  image: readWorkflow('image-preprocessor-v1.json'),
  stt: readWorkflow('speech-to-text-provider-v1.json'),
  semantic: readWorkflow('semantic-pattern-lookup-v1.json'),
  main: readWorkflow('text-analysis-main-v2.json')
};

function workflowNode(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, 'Missing node: ' + name);
  return found;
}

function runCode(workflow, name, input, references = {}) {
  const $input = { first: () => ({ json: structuredClone(input) }) };
  const $ = (referenceName) => ({
    first: () => {
      if (!Object.prototype.hasOwnProperty.call(references, referenceName)) {
        throw new Error('Node did not execute: ' + referenceName);
      }
      return { json: structuredClone(references[referenceName]) };
    }
  });
  return new Function('$input', '$', workflowNode(workflow, name).parameters.jsCode)(
    $input,
    $
  )[0].json;
}

const usageMetadata = {
  promptTokenCount: 1234,
  candidatesTokenCount: 321,
  totalTokenCount: 1575,
  cachedContentTokenCount: 20,
  thoughtsTokenCount: 20,
  toolUsePromptTokenCount: 7
};

const normalizedUsage = {
  input_tokens: 1234,
  output_tokens: 321,
  total_tokens: 1575,
  cached_input_tokens: 20,
  thinking_tokens: 20,
  tool_input_tokens: 7
};

function successfulProviderResult(diagnosticKey) {
  return {
    ok: true,
    internal_diagnostics: {
      [diagnosticKey]: {
        provider_name: 'gemini',
        provider_http_status: 200,
        failure_stage: null,
        error_category: null
      }
    }
  };
}

test('final analysis captures provider-reported token usage including optional fields', () => {
  const output = runCode(
    workflows.provider,
    'Attach Gemini Usage',
    successfulProviderResult('provider'),
    {
      'Call Gemini API': {
        statusCode: 200,
        body: { candidates: [], usageMetadata }
      }
    }
  );
  assert.equal(output.internal_diagnostics.provider.provider_call_performed, true);
  assert.deepEqual(output.internal_diagnostics.provider.token_usage, normalizedUsage);
  assert.equal(JSON.stringify(output.internal_diagnostics).includes('usageMetadata'), false);
  assert.equal(output.internal_diagnostics.provider.token_usage.tool_input_tokens, 7);
});

test('image preprocessing and speech-to-text capture their own normalized usage', () => {
  const image = runCode(
    workflows.image,
    'Attach Image Usage',
    successfulProviderResult('image_preprocessor'),
    { 'Call Gemini Image Extraction': { body: { usageMetadata } } }
  );
  const stt = runCode(
    workflows.stt,
    'Attach STT Usage',
    successfulProviderResult('audio_transcription'),
    { 'Call Gemini Speech-to-Text': { body: { usageMetadata } } }
  );
  assert.deepEqual(image.internal_diagnostics.image_preprocessor.token_usage, normalizedUsage);
  assert.deepEqual(stt.internal_diagnostics.audio_transcription.token_usage, normalizedUsage);
});

test('embedding usage is captured when returned and derives total only when omitted', () => {
  const output = runCode(
    workflows.semantic,
    'Attach Embedding Usage',
    successfulProviderResult('semantic_lookup'),
    {
      'Generate Query Embedding': {
        body: { usageMetadata: { promptTokenCount: 200 } }
      }
    }
  );
  assert.equal(output.internal_diagnostics.semantic_lookup.embedding_call_performed, true);
  assert.deepEqual(output.internal_diagnostics.semantic_lookup.embedding_usage, {
    input_tokens: 200,
    output_tokens: 0,
    total_tokens: 200,
    cached_input_tokens: 0,
    thinking_tokens: 0
  });
});

test('missing or malformed usage metadata becomes null without failing successful workflows', () => {
  const missing = runCode(
    workflows.provider,
    'Attach Gemini Usage',
    successfulProviderResult('provider'),
    { 'Call Gemini API': { statusCode: 200, body: { candidates: [] } } }
  );
  const malformed = runCode(
    workflows.image,
    'Attach Image Usage',
    successfulProviderResult('image_preprocessor'),
    {
      'Call Gemini Image Extraction': {
        body: {
          usageMetadata: {
            promptTokenCount: -1,
            candidatesTokenCount: 1,
            totalTokenCount: 0
          }
        }
      }
    }
  );
  assert.equal(missing.ok, true);
  assert.equal(missing.internal_diagnostics.provider.token_usage, null);
  assert.equal(malformed.ok, true);
  assert.equal(malformed.internal_diagnostics.image_preprocessor.token_usage, null);
});

test('Gemini 503 behavior is preserved and no usage is invented', () => {
  const failure = {
    ok: false,
    provider_output_parsed: false,
    status_code: 503,
    public_response: {
      error: {
        code: 'ANALYSIS_SERVICE_UNAVAILABLE',
        message: 'The analysis service is temporarily unavailable.',
        details: []
      },
      request_id: 'usage-503',
      timestamp: '2026-08-18T00:00:00.000Z'
    },
    internal_diagnostics: {
      provider: {
        provider_name: 'gemini',
        provider_http_status: 503,
        provider_error_category: 'provider_unavailable',
        failure_stage: 'provider_request'
      }
    }
  };
  const output = runCode(
    workflows.provider,
    'Attach Gemini Usage',
    failure,
    { 'Call Gemini API': { statusCode: 503, body: { error: {} } } }
  );
  assert.equal(output.status_code, 503);
  assert.deepEqual(output.public_response, failure.public_response);
  assert.equal(output.internal_diagnostics.provider.provider_error_category, 'provider_unavailable');
  assert.equal(output.internal_diagnostics.provider.token_usage, null);
});

test('router preserves analysis usage without changing routing output', () => {
  const adapter = runCode(
    workflows.provider,
    'Attach Gemini Usage',
    successfulProviderResult('provider'),
    { 'Call Gemini API': { body: { usageMetadata } } }
  );
  const routerInput = {
    ok: true,
    provider_output_parsed: true,
    context: {},
    analysis_output: {},
    internal_diagnostics: {
      provider: { provider_name: 'gemini', provider_http_status: 200 },
      router: { selected_provider: 'gemini', routing_version: '1.0.0' }
    }
  };
  const output = runCode(
    workflows.router,
    'Preserve Router Usage',
    routerInput,
    { 'Execute Provider Gemini V1': adapter }
  );
  assert.equal(output.ok, true);
  assert.equal(output.internal_diagnostics.provider.provider_call_performed, true);
  assert.deepEqual(output.internal_diagnostics.provider.token_usage, normalizedUsage);
});

test('Main aggregates only calls that occurred and sums available usage deterministically', () => {
  const finalized = {
    status_code: 200,
    public_response: {
      api_version: 'v1',
      taxonomy_version: '1.1.0',
      scoring_version: '1.1.0',
      analysis_id: 'ana_usage',
      timestamp: '2026-08-18T00:00:00.000Z',
      risk_score: 0,
      risk_level: 'low',
      summary: 'No supported risk indicator.',
      scam_categories: ['unclear'],
      indicators: [],
      recommended_actions: [],
      confidence: 0.9,
      needs_human_review: false,
      processing_time_ms: 100
    }
  };
  const embeddingUsage = {
    input_tokens: 200,
    output_tokens: 0,
    total_tokens: 200,
    cached_input_tokens: 0,
    thinking_tokens: 0
  };
  const result = runCode(
    workflows.main,
    'Aggregate AI Usage',
    finalized,
    {
      'Execute Semantic Pattern Lookup V1': {
        internal_diagnostics: {
          semantic_lookup: {
            provider_name: 'gemini',
            embedding_call_performed: true,
            embedding_usage: embeddingUsage
          }
        }
      },
      'Execute Model Router V1': {
        internal_diagnostics: {
          provider: {
            provider_name: 'gemini',
            provider_call_performed: true,
            token_usage: normalizedUsage
          }
        }
      }
    }
  );
  assert.deepEqual(result.public_response, finalized.public_response);
  assert.deepEqual(
    result.internal_diagnostics.usage.calls.map((entry) => entry.component),
    ['semantic_embedding', 'final_analysis']
  );
  assert.deepEqual(result.internal_diagnostics.usage.total, {
    input_tokens: 1434,
    output_tokens: 321,
    total_tokens: 1775,
    cached_input_tokens: 20,
    thinking_tokens: 20
  });
});

test('image and audio calls aggregate only on their respective executed paths', () => {
  const base = { status_code: 200, public_response: { ok: true } };
  const imageResult = runCode(workflows.main, 'Aggregate AI Usage', base, {
    'Execute Image Preprocessor V1': {
      internal_diagnostics: {
        image_preprocessor: {
          provider_name: 'gemini',
          provider_call_performed: true,
          token_usage: normalizedUsage
        }
      }
    }
  });
  const audioResult = runCode(workflows.main, 'Aggregate AI Usage', base, {
    'Execute Speech-to-Text Provider V1': {
      internal_diagnostics: {
        audio_transcription: {
          provider_name: 'gemini',
          provider_call_performed: true,
          token_usage: normalizedUsage
        }
      }
    }
  });
  assert.deepEqual(imageResult.internal_diagnostics.usage.calls.map((entry) => entry.component), ['image_preprocessor']);
  assert.deepEqual(audioResult.internal_diagnostics.usage.calls.map((entry) => entry.component), ['speech_to_text']);
});

test('public response and Respond expression cannot expose usage diagnostics', () => {
  const respond = workflowNode(workflows.main, 'Respond');
  assert.equal(respond.parameters.responseBody, '={{ $json.public_response }}');
  const buildPublic = workflowNode(workflows.main, 'Build Public Response').parameters.jsCode;
  assert.equal(buildPublic.includes('token_usage'), false);
  assert.equal(buildPublic.includes('usageMetadata'), false);
  const aggregate = workflowNode(workflows.main, 'Aggregate AI Usage').parameters.jsCode;
  assert.equal(aggregate.includes('public_response.'), false);
  assert.equal(aggregate.includes('base64_data'), false);
  assert.equal(aggregate.includes('gemini_request'), false);
});

test('workflow models and public/scoring versions remain unchanged', () => {
  const analysisRequest = workflowNode(workflows.provider, 'Build Gemini Request').parameters.jsCode;
  const imageRequest = workflowNode(workflows.image, 'Build Image Extraction Request').parameters.jsCode;
  const sttRequest = workflowNode(workflows.stt, 'Build Gemini Audio Request').parameters.jsCode;
  const embeddingRequest = workflowNode(workflows.semantic, 'Build Embedding Request').parameters.jsCode;
  assert.match(analysisRequest, /GEMINI_MODEL = 'gemini-3\.5-flash-lite'/);
  assert.match(imageRequest, /GEMINI_VISION_MODEL = 'gemini-3\.6-flash-lite'/);
  assert.match(sttRequest, /GEMINI_STT_MODEL = 'gemini-3\.6-flash-lite'/);
  assert.match(embeddingRequest, /EMBEDDING_MODEL = 'gemini-embedding-2'/);
  assert.match(workflowNode(workflows.main, 'Score Risk Deterministically').parameters.jsCode, /scoring_version:'1\.1\.0'/);
  assert.equal(workflows.main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
});

test('runtime workflows contain no price or cost calculation', () => {
  for (const workflow of Object.values(workflows)) {
    const source = JSON.stringify(workflow);
    assert.equal(/\bcost_(?:usd|thb)\b/i.test(source), false);
    assert.equal(/price_per|pricing_rate/i.test(source), false);
  }
});
