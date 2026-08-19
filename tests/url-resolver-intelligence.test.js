'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeNet = require('node:net');
const nodeUrl = require('node:url');

const { extractEntities } = require('../scripts/entity-intelligence');

const root = path.resolve(__dirname, '..');
const resolverPath = path.join(root, 'n8n', 'workflows', 'url-resolver-intelligence-v1.json');
const mainPath = path.join(root, 'n8n', 'workflows', 'text-analysis-main-v2.json');
const entityPath = path.join(root, 'n8n', 'workflows', 'entity-intelligence-lookup-v1.json');
const resolver = JSON.parse(fs.readFileSync(resolverPath, 'utf8'));
const main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
const entity = JSON.parse(fs.readFileSync(entityPath, 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function node(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, 'Missing node: ' + name);
  return found;
}

function createRuntime(options = {}) {
  const dnsAnswers = options.dnsAnswers || {};
  const routes = options.routes || {};
  const calls = [];
  const dnsCalls = [];
  const dnsModule = {
    promises: {
      lookup: async (hostname, lookupOptions) => {
        dnsCalls.push({ hostname, lookupOptions });
        const answer = dnsAnswers[hostname];
        if (answer instanceof Error) throw answer;
        if (!answer) return [{ address: '8.8.8.8', family: 4 }];
        return structuredClone(answer);
      }
    }
  };

  function transport(protocol) {
    return {
      request(requestOptions, callback) {
        const listeners = {};
        let timeoutCallback = null;
        const request = {
          setTimeout(milliseconds, handler) {
            assert.equal(milliseconds, 4000);
            timeoutCallback = handler;
          },
          on(event, handler) {
            listeners[event] = handler;
          },
          destroy(error) {
            if (error && listeners.error) listeners.error(error);
          },
          end() {
            let pinnedLookupResult;
            requestOptions.lookup(requestOptions.hostname, { all: true }, (error, addresses) => {
              assert.equal(error, null);
              pinnedLookupResult = addresses;
            });
            assert.equal(Array.isArray(pinnedLookupResult), true);
            assert.equal(pinnedLookupResult.length, 1);
            assert.equal(nodeNet.isIP(pinnedLookupResult[0].address), pinnedLookupResult[0].family);
            if (protocol === 'https:') {
              assert.equal(requestOptions.servername, requestOptions.hostname);
              assert.equal(requestOptions.rejectUnauthorized, true);
            }
            assert.equal(requestOptions.autoSelectFamily, false);
            if (listeners.socket) {
              listeners.socket({ once(_event, handler) { handler(); } });
            }
            const port = requestOptions.port ? ':' + requestOptions.port : '';
            const key = protocol + '//' + requestOptions.hostname + port + requestOptions.path;
            calls.push({ key, options: requestOptions });
            const route = routes[key];
            if (route && route.timeout) {
              timeoutCallback();
              return;
            }
            if (route && route.error) {
              listeners.error(route.error);
              return;
            }
            const response = route || { statusCode: 200, headers: {} };
            callback({
              statusCode: response.statusCode,
              headers: response.headers || {},
              destroy() {}
            });
          }
        };
        return request;
      }
    };
  }

  const modules = {
    dns: dnsModule,
    net: nodeNet,
    http: transport('http:'),
    https: transport('https:'),
    url: nodeUrl
  };

  return {
    calls,
    dnsCalls,
    requireModule(name) {
      if (!Object.prototype.hasOwnProperty.call(modules, name)) throw new Error('Unexpected module: ' + name);
      return modules[name];
    }
  };
}

async function resolveContent(content, runtimeOptions = {}) {
  const runtime = createRuntime(runtimeOptions);
  const code = node(resolver, 'Resolve URLs Safely').parameters.jsCode;
  const execute = new AsyncFunction('$input', 'require', code);
  const input = {
    first: () => ({
      json: {
        ok: true,
        context: {
          request_id: 'resolver-test',
          analysis_id: 'ana-resolver-test',
          content
        }
      }
    })
  };
  const output = await execute(input, runtime.requireModule);
  return { result: output[0].json, runtime };
}

function edges(workflow, name) {
  return (workflow.connections[name]?.main || []).flat().filter(Boolean).map((edge) => edge.node);
}

test('resolver workflow parses, has no public response node, and uses no HTTP Request node', () => {
  assert.equal(resolver.name, 'URL Resolver Intelligence V1');
  assert.equal(resolver.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 0);
  assert.equal(resolver.nodes.filter((entry) => entry.type === 'n8n-nodes-base.httpRequest').length, 0);
  for (const entry of resolver.nodes.filter((item) => item.type === 'n8n-nodes-base.code')) {
    if (entry.parameters.jsCode.includes('await ')) {
      assert.doesNotThrow(() => new AsyncFunction('$input', 'require', entry.parameters.jsCode), entry.name);
    } else {
      assert.doesNotThrow(() => new Function('$input', entry.parameters.jsCode), entry.name);
    }
  }
});

test('strict resolver adapter accepts only the context envelope', () => {
  const code = node(resolver, 'Validate Resolver Input').parameters.jsCode;
  const run = (json) => new Function('$input', code)({ first: () => ({ json }) })[0].json;
  const valid = run({ context: { request_id: null, analysis_id: 'ana-1', content: 'https://bit.ly/test' } });
  assert.equal(valid.ok, true);
  assert.deepEqual(Object.keys(valid.context), ['request_id', 'analysis_id', 'content']);
  const invalid = run({ context: valid.context, provider: 'client-choice' });
  assert.equal(invalid.ok, false);
});

test('controlled short URL resolves manually to a normalized final scam domain', async () => {
  const { result, runtime } = await resolveContent('เปิด https://short.example/test', {
    routes: {
      'https://short.example/test': { statusCode: 301, headers: { location: 'https://redirect.example/a' } },
      'https://redirect.example/a': { statusCode: 302, headers: { location: 'https://SCAM-DEMO.EXAMPLE:443/login?q=1#fragment' } },
      'https://scam-demo.example/login?q=1': { statusCode: 200, headers: {} }
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.url_intelligence.results[0], {
    original_domain: 'short.example',
    final_domain: 'scam-demo.example',
    is_short_url: true,
    resolved: true,
    redirect_count: 2,
    resolution_status: 'resolved'
  });
  assert.equal(runtime.calls.length, 3);
  assert.ok(runtime.calls.every((call) => typeof call.options.lookup === 'function'));
  assert.ok(runtime.calls.every((call) => call.options.agent === false));
  assert.ok(runtime.dnsCalls.filter((call) => call.hostname === 'redirect.example').length >= 2);
  assert.ok(runtime.dnsCalls.filter((call) => call.hostname === 'scam-demo.example').length >= 2);
});

test('Bitly redirect keeps the original HTTPS hostname while using an all-mode compatible pinned lookup', async () => {
  const { result, runtime } = await resolveContent('https://bit.ly/techtalkthai', {
    dnsAnswers: {
      'bit.ly': [
        { address: '67.199.248.10', family: 4 },
        { address: '67.199.248.11', family: 4 }
      ],
      'www.techtalkthai.com': [{ address: '104.21.1.100', family: 4 }]
    },
    routes: {
      'https://bit.ly/techtalkthai': { statusCode: 301, headers: { location: 'https://www.techtalkthai.com/' } },
      'https://www.techtalkthai.com/': { statusCode: 200, headers: {} }
    }
  });
  assert.deepEqual(result.url_intelligence, {
    urls_detected: 1,
    urls_attempted: 1,
    urls_resolved: 1,
    results: [{
      original_domain: 'bit.ly',
      final_domain: 'www.techtalkthai.com',
      is_short_url: true,
      resolved: true,
      redirect_count: 1,
      resolution_status: 'resolved'
    }]
  });
  assert.deepEqual(runtime.calls.map((call) => call.options.hostname), ['bit.ly', 'www.techtalkthai.com']);
  assert.deepEqual(runtime.calls.map((call) => call.options.servername), ['bit.ly', 'www.techtalkthai.com']);
  assert.ok(runtime.calls.every((call) => call.options.rejectUnauthorized === true));
});

test('short URL may resolve to a benign domain without creating any resolver classification', async () => {
  const { result } = await resolveContent('https://bit.ly/benign', {
    routes: {
      'https://bit.ly/benign': { statusCode: 302, headers: { location: 'https://www.example.com/watch' } },
      'https://www.example.com/watch': { statusCode: 200, headers: {} }
    }
  });
  assert.equal(result.url_intelligence.results[0].final_domain, 'www.example.com');
  assert.equal(result.url_intelligence.results[0].resolved, true);
  assert.doesNotMatch(JSON.stringify(result), /KNOWN_SCAM_DOMAIN|risk_score|indicators/);
});

test('relative redirects are resolved against the current safe URL and unsupported redirect schemes are rejected', async () => {
  const relative = await resolveContent('https://bit.ly/relative', {
    routes: {
      'https://bit.ly/relative': { statusCode: 302, headers: { location: '/final' } },
      'https://bit.ly/final': { statusCode: 200, headers: {} }
    }
  });
  assert.equal(relative.result.url_intelligence.results[0].resolution_status, 'resolved');
  assert.equal(relative.result.url_intelligence.results[0].redirect_count, 1);

  const invalid = await resolveContent('https://bit.ly/invalid-location', {
    routes: {
      'https://bit.ly/invalid-location': { statusCode: 302, headers: { location: 'file:///etc/passwd' } }
    }
  });
  assert.equal(invalid.result.url_intelligence.results[0].resolution_status, 'invalid_redirect');
  assert.equal(invalid.runtime.calls.length, 1);
});

test('HEAD fallback uses GET with a one-byte Range and never downloads a body', async () => {
  const { result, runtime } = await resolveContent('https://bit.ly/head-fallback', {
    routes: {
      'https://bit.ly/head-fallback': { statusCode: 405, headers: {} }
    }
  });
  assert.equal(result.url_intelligence.results[0].resolved, true);
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[0].options.method, 'HEAD');
  assert.equal(runtime.calls[1].options.method, 'GET');
  assert.equal(runtime.calls[1].options.headers.Range, 'bytes=0-0');
});

test('localhost, loopback, private IPv4, metadata IP, and IPv6 loopback are blocked without outbound HTTP', async () => {
  for (const target of [
    'http://localhost:5678/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://[::1]/'
  ]) {
    const { result, runtime } = await resolveContent(target);
    assert.equal(result.url_intelligence.results[0].resolution_status, 'blocked_destination', target);
    assert.equal(runtime.calls.length, 0, target);
  }
});

test('alternate numeric loopback representations are canonicalized and blocked', async () => {
  for (const target of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/']) {
    const { result, runtime } = await resolveContent(target);
    assert.equal(result.url_intelligence.results[0].resolution_status, 'blocked_destination', target);
    assert.equal(runtime.calls.length, 0, target);
  }
});

test('a shortener hostname resolving to any private address is blocked before HTTP', async () => {
  const { result, runtime } = await resolveContent('https://bit.ly/private-dns', {
    dnsAnswers: {
      'bit.ly': [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.8', family: 4 }
      ]
    }
  });
  assert.equal(result.url_intelligence.results[0].resolution_status, 'blocked_destination');
  assert.equal(runtime.calls.length, 0);
});

test('a public first hop redirecting to a private destination never connects to that destination', async () => {
  const { result, runtime } = await resolveContent('https://bit.ly/private-hop', {
    routes: {
      'https://bit.ly/private-hop': { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
    }
  });
  assert.equal(result.url_intelligence.results[0].resolution_status, 'blocked_destination');
  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].key, 'https://bit.ly/private-hop');
});

test('URL credentials and unsupported protocols are rejected without a request', async () => {
  const credentials = await resolveContent('https://user:password@bit.ly/secret');
  assert.equal(credentials.result.url_intelligence.results[0].resolution_status, 'blocked_destination');
  assert.equal(credentials.runtime.calls.length, 0);

  const unsupported = await resolveContent('file:///etc/passwd');
  assert.equal(unsupported.result.url_intelligence.results[0].resolution_status, 'unsupported');
  assert.equal(unsupported.runtime.calls.length, 0);
});

test('too many redirects, DNS failures, network failures, and timeouts are normalized', async () => {
  const tooMany = await resolveContent('https://bit.ly/loop', {
    routes: {
      'https://bit.ly/loop': { statusCode: 302, headers: { location: 'https://a.example/1' } },
      'https://a.example/1': { statusCode: 302, headers: { location: 'https://b.example/2' } },
      'https://b.example/2': { statusCode: 302, headers: { location: 'https://c.example/3' } },
      'https://c.example/3': { statusCode: 302, headers: { location: 'https://d.example/4' } }
    }
  });
  assert.equal(tooMany.result.url_intelligence.results[0].resolution_status, 'too_many_redirects');
  assert.equal(tooMany.runtime.calls.length, 4);

  const dnsFailure = await resolveContent('https://bit.ly/dns', { dnsAnswers: { 'bit.ly': new Error('ENOTFOUND') } });
  assert.equal(dnsFailure.result.url_intelligence.results[0].resolution_status, 'dns_failure');

  const timeout = await resolveContent('https://bit.ly/timeout', {
    routes: { 'https://bit.ly/timeout': { timeout: true } }
  });
  assert.equal(timeout.result.url_intelligence.results[0].resolution_status, 'timeout');

  const network = await resolveContent('https://bit.ly/network', {
    routes: { 'https://bit.ly/network': { error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) } }
  });
  assert.equal(network.result.url_intelligence.results[0].resolution_status, 'network_error');
  assert.deepEqual(network.result.internal_diagnostics.url_resolver.failures, [{
    stage: 'http_request',
    code: 'ECONNRESET',
    name: 'Error',
    message: 'HTTP request failed.'
  }]);
  assert.doesNotMatch(JSON.stringify(network.result.internal_diagnostics), /"message":"reset"|stack|https:\/\//i);
});

test('URL extraction deduplicates normalized URLs and enforces detected/resolved limits', async () => {
  const urls = ['https://bit.ly/a', 'https://bit.ly/a#fragment'];
  for (let index = 0; index < 14; index += 1) urls.push('https://tinyurl.com/' + index);
  const { result } = await resolveContent(urls.join(' '));
  assert.equal(result.url_intelligence.urls_detected, 10);
  assert.equal(result.url_intelligence.urls_attempted, 5);
  assert.equal(result.url_intelligence.results.length, 10);
});

test('normal public URLs are not resolved indiscriminately and direct scam-domain extraction is unchanged', async () => {
  const { result, runtime } = await resolveContent('https://scam-demo.example/login');
  assert.equal(result.url_intelligence.results[0].resolution_status, 'not_required');
  assert.equal(runtime.calls.length, 0);
  assert.deepEqual(
    extractEntities('https://scam-demo.example/login').filter((entry) => entry.entity_type === 'domain'),
    [{ entity_type: 'domain', normalized_value: 'scam-demo.example' }]
  );
});

test('trusted resolved domains are added to entity candidates without duplicating the original domain', () => {
  const entities = extractEntities('เปิด https://bit.ly/example', ['scam-demo.example', 'scam-demo.example']);
  const domains = entities.filter((entry) => entry.entity_type === 'domain').map((entry) => entry.normalized_value);
  assert.deepEqual(domains, ['scam-demo.example', 'bit.ly']);
});

test('Main builds a strict resolver input and passes only successful final domains to Entity Intelligence', () => {
  const context = {
    request_id: 'main-url-test',
    analysis_id: 'ana-main-url-test',
    input_type: 'text',
    content: 'เปิด https://bit.ly/example',
    language: 'th',
    metadata: {},
    accepted_at: '2026-08-18T00:00:00.000Z',
    accepted_epoch_ms: 1787011200000,
    requested_output_language: 'th'
  };
  const buildResolver = node(main, 'Build URL Resolver Input').parameters.jsCode;
  const resolverInput = new Function('$input', buildResolver)({ first: () => ({ json: { ok: true, context } }) })[0].json;
  assert.deepEqual(resolverInput, {
    context: {
      request_id: context.request_id,
      analysis_id: context.analysis_id,
      content: context.content
    }
  });
  assert.deepEqual(Object.keys(resolverInput.context), ['request_id', 'analysis_id', 'content']);
  assert.equal(Object.prototype.hasOwnProperty.call(resolverInput.context, 'language'), false);

  const validateResolverInput = node(resolver, 'Validate Resolver Input').parameters.jsCode;
  const validatedResolverInput = new Function('$input', validateResolverInput)({
    first: () => ({ json: resolverInput })
  })[0].json;
  assert.equal(validatedResolverInput.ok, true);
  assert.equal(validatedResolverInput.resolver_input_valid, true);
  assert.deepEqual(validatedResolverInput.context, resolverInput.context);

  const buildEntity = node(main, 'Build Intelligence Lookup Input').parameters.jsCode;
  const entityInput = new Function('$input', buildEntity)({
    first: () => ({ json: {
      ok: true,
      context,
      url_intelligence: {
        results: [
          { resolved: true, final_domain: 'scam-demo.example' },
          { resolved: true, final_domain: 'scam-demo.example' },
          { resolved: false, final_domain: null }
        ]
      }
    } })
  })[0].json;
  assert.deepEqual(entityInput.trusted_domain_candidates, ['scam-demo.example']);
  assert.equal(entityInput.context.content, context.content);
});

test('resolver failure is optional while authoritative Entity Intelligence failure remains fail-closed', () => {
  const validateResolver = node(main, 'Validate URL Resolver Result').parameters.jsCode;
  const canonical = {
    ok: true,
    context: {
      request_id: 'fail-open',
      analysis_id: 'ana-fail-open',
      input_type: 'text',
      content: 'https://bit.ly/fail',
      language: 'th',
      metadata: {},
      accepted_at: '2026-08-18T00:00:00.000Z',
      accepted_epoch_ms: 1787011200000,
      requested_output_language: 'th'
    }
  };
  const references = {
    'Build URL Resolver Input': { context: {
      request_id: canonical.context.request_id,
      analysis_id: canonical.context.analysis_id,
      content: canonical.context.content
    } },
    'Prepare Input': canonical
  };
  const $ = (name) => ({ first: () => ({ json: structuredClone(references[name]) }) });
  const output = new Function('$input', '$', validateResolver)(
    { first: () => ({ json: { error: { message: 'subworkflow unavailable' } } }) },
    $
  )[0].json;
  assert.equal(output.ok, true);
  assert.equal(output.url_intelligence.available, false);
  assert.equal(output.context.content, canonical.context.content);

  const validateEntity = node(main, 'Validate Intelligence Lookup Result').parameters.jsCode;
  const entityReferences = {
    'Build Intelligence Lookup Input': { context: canonical.context, trusted_domain_candidates: [] },
    'Validate URL Resolver Result': output
  };
  const entity$ = (name) => ({ first: () => ({ json: structuredClone(entityReferences[name]) }) });
  const failure = new Function('$input', '$', validateEntity)(
    { first: () => ({ json: { ok: false, status_code: 503 } }) },
    entity$
  )[0].json;
  assert.equal(failure.status_code, 503);
  assert.equal(failure.public_response.error.code, 'INTELLIGENCE_LOOKUP_UNAVAILABLE');
});

test('Main has one Respond node and every canonical input path passes through URL Resolver before Entity Intelligence', () => {
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
  assert.deepEqual(edges(main, 'Build URL Resolver Input'), ['Execute URL Resolver Intelligence V1']);
  assert.deepEqual(edges(main, 'Execute URL Resolver Intelligence V1'), ['Validate URL Resolver Result']);
  assert.deepEqual(edges(main, 'Validate URL Resolver Result'), ['Build Intelligence Lookup Input']);
  assert.ok(edges(main, 'Preparation Successful?').includes('Build URL Resolver Input'));
  assert.ok(edges(main, 'Image Text Ready?').includes('Build URL Resolver Input'));
  assert.deepEqual(edges(main, 'Normalize Audio Transcript'), ['Build URL Resolver Input']);
  assert.deepEqual(edges(main, 'Build Intelligence Lookup Input'), ['Execute Entity Intelligence Lookup V1']);
});

test('Main public response and scoring implementation remain unchanged by resolver intelligence', () => {
  const publicBuilder = node(main, 'Build Public Response').parameters.jsCode;
  assert.doesNotMatch(publicBuilder, /url_intelligence|redirect|dns/i);
  const scoring = node(main, 'Score Risk Deterministically').parameters.jsCode;
  assert.doesNotMatch(scoring, /url_intelligence|redirect_count|final_domain/i);
  const source = fs.readFileSync(mainPath, 'utf8');
  assert.match(source, /taxonomy_version:\s*'1\.1\.0'/);
  assert.match(source, /scoring_version:\s*'1\.1\.0'/);
});

test('resolver true branch runs safe resolution before normalization and blocked IP results normalize successfully', () => {
  const branchOutputs = resolver.connections['Resolver Input Valid?'].main;
  assert.deepEqual(branchOutputs[0], [{ node: 'Resolve URLs Safely', type: 'main', index: 0 }]);
  assert.deepEqual(branchOutputs[1], [{ node: 'Normalize URL Intelligence Result', type: 'main', index: 0 }]);
  assert.deepEqual(resolver.connections['Resolve URLs Safely'].main[0], [
    { node: 'Normalize URL Intelligence Result', type: 'main', index: 0 }
  ]);

  const normalize = node(resolver, 'Normalize URL Intelligence Result').parameters.jsCode;
  const raw = {
    ok: true,
    context: { request_id: 'blocked-ip', analysis_id: 'ana-blocked-ip', content: 'http://127.0.0.1/' },
    url_intelligence: {
      urls_detected: 1,
      urls_attempted: 0,
      urls_resolved: 0,
      results: [{
        original_domain: '127.0.0.1',
        final_domain: null,
        is_short_url: false,
        resolved: false,
        redirect_count: 0,
        resolution_status: 'blocked_destination'
      }]
    }
  };
  const normalized = new Function('$input', normalize)({ first: () => ({ json: raw }) })[0].json;
  assert.equal(normalized.ok, true);
  assert.equal(normalized.status_code, undefined);
  assert.deepEqual(normalized.url_intelligence, raw.url_intelligence);
});

test('resolver internals, queries, DNS data, and redirect chains are not public fields', async () => {
  const { result } = await resolveContent('https://bit.ly/private-hop', {
    routes: { 'https://bit.ly/private-hop': { statusCode: 302, headers: { location: 'http://10.0.0.1/admin?token=secret' } } }
  });
  const serialized = JSON.stringify(result.url_intelligence);
  assert.doesNotMatch(serialized, /token=secret|redirect_chain|response_body|cookies|8\.8\.8\.8/);
  assert.deepEqual(Object.keys(result.url_intelligence.results[0]), [
    'original_domain', 'final_domain', 'is_short_url', 'resolved', 'redirect_count', 'resolution_status'
  ]);
});

test('workflow uses fixed security policy, no automatic redirects, and no credentials', () => {
  const code = node(resolver, 'Resolve URLs Safely').parameters.jsCode;
  assert.match(code, /MAX_DETECTED_URLS = 10/);
  assert.match(code, /MAX_RESOLVED_URLS = 5/);
  assert.match(code, /MAX_REDIRECTS = 3/);
  assert.match(code, /REQUEST_TIMEOUT_MS = 4000/);
  assert.match(code, /automatic_redirects: false/);
  assert.match(code, /lookup: \(_hostname, lookupOptions, callback\)/);
  assert.match(code, /lookupOptions\.all === true/);
  assert.match(code, /callback\(null, \[selected\]\)/);
  assert.match(code, /autoSelectFamily: false/);
  assert.match(code, /rejectUnauthorized = true/);
  assert.match(code, /await validateTarget\(parsedDestination\.parsed\)/);
  assert.doesNotMatch(code, /followRedirect|followAllRedirect|maxRedirects|cookies|Authorization/i);
  assert.equal(resolver.nodes.some((entry) => entry.credentials), false);
});

test('Entity workflow accepts only normalized trusted domain candidates and remains read-only', () => {
  const validate = node(entity, 'Validate Lookup Input').parameters.jsCode;
  assert.match(validate, /trusted_domain_candidates/);
  assert.match(validate, /length > 5/);
  const extract = node(entity, 'Extract and Normalize Entities').parameters.jsCode;
  assert.match(extract, /trustedDomainCandidates/);
  const postgres = entity.nodes.find((entry) => entry.type === 'n8n-nodes-base.postgres');
  assert.ok(postgres);
  assert.doesNotMatch(postgres.parameters.query, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|DROP|ALTER)\b/i);
});

test('Docker Compose allowlists only the required resolver built-ins', () => {
  const compose = fs.readFileSync(path.join(root, 'n8n', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /NODE_FUNCTION_ALLOW_BUILTIN=dns,net,http,https,url/);
  assert.doesNotMatch(compose, /NODE_FUNCTION_ALLOW_BUILTIN=\*/);
});
