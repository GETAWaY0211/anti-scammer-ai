'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../server');

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function validTextRequest(overrides = {}) {
  return {
    input_type: 'text',
    content: 'ข้อความทดสอบ',
    request_id: 'demo-test-001',
    language: 'th',
    metadata: { source: 'web-demo' },
    ...overrides
  };
}

async function postJson(baseUrl, body) {
  return fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('static index and browser assets load from one origin', async () => {
  await withServer(createApp({ analyzeUrl: '' }), async (baseUrl) => {
    const index = await fetch(baseUrl);
    const script = await fetch(`${baseUrl}/app.js`);
    const styles = await fetch(`${baseUrl}/style.css`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Anti-Scammer AI/);
    assert.equal(script.status, 200);
    assert.equal(styles.status, 200);
  });
});

test('POST /api/analyze rejects malformed JSON without a stack trace', async () => {
  await withServer(createApp({ analyzeUrl: 'http://n8n.invalid/webhook/api/v1/analyze' }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input_type":'
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'VALIDATION_ERROR');
    assert.doesNotMatch(JSON.stringify(payload), /SyntaxError|stack|n8n\.invalid/i);
  });
});

test('missing N8N_ANALYZE_URL fails safely without exposing configuration', async () => {
  await withServer(createApp({ analyzeUrl: '' }), async (baseUrl) => {
    const response = await postJson(baseUrl, validTextRequest());
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 'ANALYSIS_SERVICE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(payload), /N8N_ANALYZE_URL|webhook|localhost:5678/i);
  });
});

test('documented n8n statuses and public response bodies are preserved', async () => {
  const statuses = [200, 400, 413, 422, 500, 503];
  for (const status of statuses) {
    const publicBody = status === 200
      ? { api_version: 'v1', risk_score: 0, risk_level: 'low' }
      : { error: { code: `UPSTREAM_${status}`, message: 'Safe public message.', details: [] }, request_id: 'demo-test-001' };
    const app = createApp({
      analyzeUrl: 'http://n8n.test/webhook/api/v1/analyze',
      fetchImpl: async () => new Response(JSON.stringify(publicBody), {
        status,
        headers: { 'content-type': 'application/json', 'x-internal-provider': 'must-not-reflect' }
      })
    });
    await withServer(app, async (baseUrl) => {
      const response = await postJson(baseUrl, validTextRequest());
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), publicBody);
      assert.equal(response.headers.get('x-internal-provider'), null);
    });
  }
});

test('upstream timeout is normalized to a safe 503 response', async () => {
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('Internal upstream location must remain private.');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const app = createApp({
    analyzeUrl: 'http://private-n8n.test/webhook/api/v1/analyze',
    timeoutMs: 10,
    fetchImpl
  });
  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, validTextRequest());
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 'ANALYSIS_TIMEOUT');
    assert.doesNotMatch(JSON.stringify(payload), /private-n8n|upstream location|stack/i);
  });
});

test('unexpected upstream status does not expose a raw provider-style payload', async () => {
  const app = createApp({
    analyzeUrl: 'http://n8n.test/webhook/api/v1/analyze',
    fetchImpl: async () => new Response(JSON.stringify({
      provider: 'private-provider',
      raw_error: 'credential and endpoint details'
    }), { status: 502 })
  });
  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, validTextRequest());
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 'ANALYSIS_SERVICE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(payload), /private-provider|credential and endpoint/i);
  });
});

test('proxy forwards only the validated public request body', async () => {
  let forwarded;
  const app = createApp({
    analyzeUrl: 'http://n8n.test/webhook/api/v1/analyze',
    fetchImpl: async (url, options) => {
      forwarded = { url: String(url), method: options.method, headers: options.headers, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ api_version: 'v1' }), { status: 200 });
    }
  });
  const request = validTextRequest();
  await withServer(app, async (baseUrl) => {
    const response = await postJson(baseUrl, request);
    assert.equal(response.status, 200);
  });
  assert.equal(forwarded.method, 'POST');
  assert.deepEqual(forwarded.body, request);
  assert.equal(forwarded.headers['content-type'], 'application/json');
  assert.equal(Object.prototype.hasOwnProperty.call(forwarded.headers, 'authorization'), false);
});
