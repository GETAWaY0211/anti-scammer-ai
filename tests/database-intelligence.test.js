'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('PostgreSQL 17 pgvector Compose service uses environment-based credentials and persistent storage', () => {
  const compose = read('n8n', 'docker-compose.yml');
  assert.match(compose, /^\s*postgres:\s*$/m);
  assert.match(compose, /image:\s*pgvector\/pgvector:pg17\b/);
  assert.match(compose, /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:/);
  assert.match(compose, /postgres_data:\/var\/lib\/postgresql\/data/);
  const passwordLine = compose.split(/\r?\n/).find((line) => line.includes('POSTGRES_PASSWORD:'));
  assert.match(passwordLine, /^\s*POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:/);
});

test('migration defines the required constrained scam_entities schema', () => {
  const sql = read('database', 'migrations', '001_create_scam_entities.sql');
  for (const column of [
    'id BIGSERIAL PRIMARY KEY', 'entity_type TEXT', 'normalized_value TEXT', 'status TEXT',
    'report_count INTEGER', 'confidence_score NUMERIC', 'source TEXT', 'first_reported_at TIMESTAMPTZ',
    'last_reported_at TIMESTAMPTZ', 'is_active BOOLEAN', 'notes TEXT', 'created_at TIMESTAMPTZ',
    'updated_at TIMESTAMPTZ'
  ]) assert.match(sql, new RegExp(column, 'i'));
  assert.match(sql, /entity_type IN \('phone', 'bank_account', 'domain'\)/);
  assert.match(sql, /status IN \('reported', 'suspected', 'confirmed_scam', 'cleared'\)/);
  assert.match(sql, /CHECK \(report_count >= 0\)/);
  assert.match(sql, /confidence_score IS NULL OR \(confidence_score >= 0 AND confidence_score <= 1\)/);
  assert.match(sql, /UNIQUE \(entity_type, normalized_value\)/);
});

test('migration provides active lookup and active status indexes', () => {
  const sql = read('database', 'migrations', '001_create_scam_entities.sql');
  assert.match(sql, /ON scam_entities \(entity_type, normalized_value\)\s+WHERE is_active = TRUE/i);
  assert.match(sql, /ON scam_entities \(status, entity_type\)\s+WHERE is_active = TRUE/i);
});

test('seed data is synthetic, development-only, complete, and idempotent', () => {
  const sql = read('database', 'seeds', 'demo_scam_entities.sql');
  assert.match(sql, /'domain', 'scam-demo\.example', 'confirmed_scam'/);
  assert.match(sql, /'phone', '0810000000', 'confirmed_scam'/);
  assert.match(sql, /'bank_account', '9999999999', 'suspected'/);
  assert.match(sql, /'domain', 'review-demo\.example', 'reported'/);
  assert.match(sql, /'domain', 'cleared-demo\.example', 'cleared'/);
  assert.equal((sql.match(/'development_seed'/g) || []).length, 5);
  assert.equal((sql.match(/Synthetic development-only/g) || []).length, 5);
  assert.match(sql, /ON CONFLICT \(entity_type, normalized_value\) DO UPDATE/);
});

test('example environment file contains placeholders rather than a usable password', () => {
  const env = read('n8n', '.env.example');
  assert.match(env, /^POSTGRES_PASSWORD=replace-with-a-local-development-password$/m);
  assert.doesNotMatch(env, /(?:api[_-]?key|secret|token)=\S+/i);
});
