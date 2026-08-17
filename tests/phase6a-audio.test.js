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

function wavBytes(size = 44) {
  const bytes = Buffer.alloc(Math.max(size, 12));
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(Math.max(0, bytes.length - 8), 4);
  bytes.write('WAVE', 8, 'ascii');
  return bytes;
}

function mp3Bytes() {
  return Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function audioRequest(mimeType, bytes, extraContent = {}) {
  return {
    input_type: 'audio',
    content: { mime_type: mimeType, data: bytes.toString('base64'), ...extraContent },
    request_id: 'phase6a-audio-test',
    language: 'th',
    metadata: { source: 'test' }
  };
}

test('valid WAV is accepted and prepared outside context.content for the STT boundary', () => {
  const validated = runCode('Validate Request', audioRequest('audio/wav', wavBytes()));
  assert.equal(validated.ok, true);
  assert.equal(validated.request.input_type, 'audio');
  assert.equal(validated.audio_validation.mime_type, 'audio/wav');

  const prepared = runCode('Prepare Audio Input', validated);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.context.input_type, 'audio');
  assert.equal(Object.prototype.hasOwnProperty.call(prepared.context, 'content'), false);
  assert.equal(prepared.audio_input.mime_type, 'audio/wav');
  assert.equal(prepared.audio_input.base64_data, validated.request.content.data);

  const sttInput = runCode('Build Speech-to-Text Input', prepared);
  assert.deepEqual(Object.keys(sttInput).sort(), ['audio_input', 'context']);
  assert.deepEqual(Object.keys(sttInput.context).sort(), ['analysis_id', 'language', 'request_id']);
  assert.equal(sttInput.audio_input.base64_data, prepared.audio_input.base64_data);
});

test('valid MP3 ID3 signature follows the same strict STT input path', () => {
  const validated = runCode('Validate Request', audioRequest('audio/mpeg', mp3Bytes()));
  assert.equal(validated.ok, true);
  const sttInput = runCode('Build Speech-to-Text Input', runCode('Prepare Audio Input', validated));
  assert.equal(sttInput.audio_input.mime_type, 'audio/mpeg');
});

test('all four allowlisted audio containers have conservative signature checks', () => {
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const mp4 = Buffer.alloc(16);
  mp4.writeUInt32BE(16, 0);
  mp4.write('ftyp', 4, 'ascii');
  for (const [mime, bytes] of [
    ['audio/wav', wavBytes()],
    ['audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0x64])],
    ['audio/webm', webm],
    ['audio/mp4', mp4]
  ]) {
    assert.equal(runCode('Validate Request', audioRequest(mime, bytes)).ok, true, mime);
  }
});

test('unsupported audio MIME is rejected with safe 400 validation error', () => {
  const result = runCode('Validate Request', audioRequest('audio/ogg', Buffer.from('OggS')));
  assert.equal(result.status_code, 400);
  assert.equal(result.public_response.error.code, 'VALIDATION_ERROR');
});

test('audio MIME and signature mismatch is rejected', () => {
  const result = runCode('Validate Request', audioRequest('audio/wav', mp3Bytes()));
  assert.equal(result.status_code, 400);
  assert.equal(result.public_response.error.code, 'VALIDATION_ERROR');
  assert.match(result.public_response.error.message, /MIME type/i);
});

test('malformed Base64 and data URI audio are rejected without normalization', () => {
  for (const data of ['not+canonical===', 'SUQz\nBAAA', 'data:audio/mpeg;base64,SUQzBAAAAA==']) {
    const request = audioRequest('audio/mpeg', mp3Bytes());
    request.content.data = data;
    const result = runCode('Validate Request', request);
    assert.equal(result.status_code, 400, data);
    assert.equal(result.public_response.error.code, 'VALIDATION_ERROR', data);
  }
});

test('decoded audio larger than 5 MiB returns 413 CONTENT_TOO_LARGE', () => {
  const result = runCode('Validate Request', audioRequest('audio/wav', wavBytes((5 * 1024 * 1024) + 1)));
  assert.equal(result.status_code, 413);
  assert.equal(result.public_response.error.code, 'CONTENT_TOO_LARGE');
});

test('unknown audio fields including transcript, provider, model, and duration are rejected', () => {
  for (const field of ['transcript', 'provider', 'model', 'duration', 'url', 'path']) {
    const result = runCode('Validate Request', audioRequest('audio/mpeg', mp3Bytes(), { [field]: 'client-controlled' }));
    assert.equal(result.status_code, 400, field);
    assert.equal(result.public_response.error.code, 'VALIDATION_ERROR', field);
    assert.equal(result.public_response.error.details[0].field, `content.${field}`, field);
  }
});

test('validated audio reaches the existing canonical intelligence and scoring pipeline only after transcript normalization', () => {
  const adjacency = new Map(Object.entries(main.connections).map(([name, value]) => [
    name,
    (value.main || []).flat().filter(Boolean).map((edge) => edge.node)
  ]));
  const reachable = new Set();
  const pending = ['Prepare Audio Input'];
  while (pending.length) {
    const current = pending.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(adjacency.get(current) || []));
  }
  for (const expected of [
    'Build Intelligence Lookup Input', 'Execute Entity Intelligence Lookup V1',
    'Build Semantic Lookup Input', 'Execute Semantic Pattern Lookup V1',
    'Execute Model Router V1', 'Score Risk Deterministically'
  ]) assert.equal(reachable.has(expected), true, expected);
  assert.equal(reachable.has('Execute Speech-to-Text Provider V1'), true);
  assert.equal(reachable.has('Normalize Audio Transcript'), true);
  assert.equal(reachable.has('Finalize Response'), true);
  assert.equal(reachable.has('Respond'), true);
});

test('routing explicitly separates text, image, and audio while retaining one Respond node', () => {
  const edges = (name, output = 0) => (main.connections[name]?.main?.[output] || []).map((edge) => edge.node);
  assert.deepEqual(edges('Text Input?', 0), ['Prepare Input']);
  assert.deepEqual(edges('Text Input?', 1), ['Image Input?']);
  assert.deepEqual(edges('Image Input?', 0), ['Prepare Image Input']);
  assert.deepEqual(edges('Image Input?', 1), ['Prepare Audio Input']);
  assert.deepEqual(edges('Audio Input Prepared?', 0), ['Build Speech-to-Text Input']);
  assert.deepEqual(edges('Audio Input Prepared?', 1), ['Finalize Response']);
  assert.deepEqual(edges('Build Speech-to-Text Input'), ['Execute Speech-to-Text Provider V1']);
  assert.deepEqual(edges('Normalize Audio Transcript'), ['Build Intelligence Lookup Input']);
  assert.equal(main.nodes.filter((entry) => entry.type === 'n8n-nodes-base.respondToWebhook').length, 1);
});

test('existing text and image request validation and preparation remain compatible', () => {
  const text = runCode('Validate Request', {
    input_type: 'text', content: '  ข้อความทดสอบ  ', request_id: 'text-regression', language: 'th', metadata: {}
  });
  assert.equal(text.ok, true);
  assert.equal(text.request.input_type, 'text');
  assert.equal(text.request.content, 'ข้อความทดสอบ');

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const image = runCode('Validate Request', {
    input_type: 'image',
    content: { mime_type: 'image/png', data: png.toString('base64') },
    request_id: 'image-regression', language: 'th', metadata: {}
  });
  assert.equal(image.ok, true);
  assert.equal(image.request.input_type, 'image');
  assert.equal(image.image_validation.decoded_size_bytes, png.length);
  const preparedImage = runCode('Prepare Image Input', image);
  assert.equal(preparedImage.ok, true);
  assert.equal(preparedImage.context.input_type, 'image');
  assert.equal(Object.prototype.hasOwnProperty.call(preparedImage.context, 'content'), false);
  assert.equal(preparedImage.image_input.base64_data, png.toString('base64'));
});

test('audio validation remains deterministic and separate from transcription implementation', () => {
  const prepareSource = node('Prepare Audio Input').parameters.jsCode;
  assert.doesNotMatch(prepareSource, /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE)\b|risk_score|risk_level|httpRequest/i);
  assert.match(node('Validate Request').parameters.jsCode, /const MAX_AUDIO_BYTES = 5 \* 1024 \* 1024;/);
});
