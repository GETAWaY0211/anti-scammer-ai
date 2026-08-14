'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const seed = fs.readFileSync(
  path.join(root, 'database', 'seeds', 'demo_scam_patterns.sql'),
  'utf8'
);

const REQUIRED_PATTERNS = [
  'BANK_OTP_IMPERSONATION',
  'PRIZE_FEE',
  'FAKE_JOB_RECHARGE',
  'INVESTMENT_GUARANTEED_RETURN',
  'PARCEL_FEE',
  'REMOTE_SUPPORT',
  'GOVERNMENT_THREAT',
  'ROMANCE_EMERGENCY'
];

const exampleRows = [...seed.matchAll(/\('([A-Z_]+)', '([^']+)', 'th'\)/g)]
  .map((match) => ({ patternCode: match[1], text: match[2] }));

test('seed contains every required verified active scam pattern', () => {
  for (const code of REQUIRED_PATTERNS) {
    assert.match(seed, new RegExp(`\\('${code}',[^;]+?'verified',[^;]+?'development_curated_seed',[^;]+?TRUE\\)`, 's'));
  }
  assert.equal((seed.match(/'development_curated_seed'/g) || []).length >= REQUIRED_PATTERNS.length, true);
});

test('each pattern has at least three distinct Thai curated examples', () => {
  for (const code of REQUIRED_PATTERNS) {
    const examples = exampleRows.filter((row) => row.patternCode === code).map((row) => row.text);
    assert.ok(examples.length >= 3 && examples.length <= 5, `${code} must have 3-5 examples`);
    assert.equal(new Set(examples).size, examples.length, `${code} examples must be distinct`);
    for (const example of examples) {
      assert.match(example, /[ก-๙]/, `${code} example must contain Thai text`);
      assert.ok(example.length >= 35, `${code} example should express a complete pattern`);
    }
  }
});

test('examples contain no real-looking phone, account, URL, or personal-data fixture', () => {
  for (const { patternCode, text } of exampleRows) {
    assert.doesNotMatch(text, /(?:\d[\s().-]*){8,}/, `${patternCode} contains a long numeric identifier`);
    assert.doesNotMatch(text, /(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|co\.th|th)\b)/i, `${patternCode} contains a URL or domain`);
    assert.doesNotMatch(text, /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/, `${patternCode} contains a person-like Latin name`);
  }
});

test('pattern and example lifecycle fields are deterministic and embeddings remain null', () => {
  assert.match(seed, /status = EXCLUDED\.status/);
  assert.match(seed, /is_active = EXCLUDED\.is_active/);
  assert.match(seed, /example_status = 'verified'/);
  assert.match(seed, /'verified',\s*'development_curated_seed',\s*NULL,\s*NULL,/s);
  assert.doesNotMatch(seed, /embedding_(?:model|dimensions)\s*=\s*NULL/i);
  assert.doesNotMatch(seed, /\bVECTOR\s*\(/i);
});

test('seed is idempotent for both pattern codes and examples', () => {
  assert.match(seed, /pg_advisory_xact_lock\(hashtextextended\('demo_scam_patterns_seed_v1', 0\)\)/i);
  assert.match(seed, /ON CONFLICT \(pattern_code\) DO UPDATE/i);
  assert.match(seed, /UPDATE scam_pattern_examples AS existing/i);
  assert.match(seed, /WHERE NOT EXISTS \(\s*SELECT 1\s*FROM scam_pattern_examples AS existing/s);
  assert.match(seed, /existing\.pattern_id = pattern\.id/);
  assert.match(seed, /existing\.example_text = seed\.example_text/);
  assert.match(seed, /existing\.language = seed\.language/);
});

test('the seed is explicitly curated development data and never references request storage', () => {
  assert.match(seed, /Synthetic, curated development intelligence only/i);
  assert.doesNotMatch(seed, /\b(?:user_request|analysis_history|raw_screenshot|base64_data|provider_output)\b/i);
});
