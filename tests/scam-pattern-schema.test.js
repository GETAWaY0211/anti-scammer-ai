'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const migration = read('database', 'migrations', '002_enable_pgvector_and_create_scam_patterns.sql');

test('Compose uses the PostgreSQL 17 pgvector image and preserves the named data volume', () => {
  const compose = read('n8n', 'docker-compose.yml');
  assert.match(compose, /image:\s*pgvector\/pgvector:pg17\b/);
  assert.match(compose, /-\s*postgres_data:\/var\/lib\/postgresql\/data/);
  assert.match(compose, /^\s{2}postgres_data:\s*$/m);
  assert.match(compose, /container_name:\s*anti-scammer-postgres/);
});

test('migration enables pgvector without choosing a vector dimension', () => {
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector\s*;/i);
  assert.doesNotMatch(migration, /\bVECTOR\s*\(\s*\d+/i);
  assert.doesNotMatch(migration, /\b(?:HNSW|IVFFLAT)\b/i);
});

test('migration creates both verified-pattern relational tables and required fields', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS scam_patterns\s*\(/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS scam_pattern_examples\s*\(/i);
  for (const field of [
    'id BIGSERIAL PRIMARY KEY', 'pattern_code TEXT', 'name TEXT', 'scam_category TEXT',
    'description TEXT', 'status TEXT', 'confidence_score NUMERIC', 'source TEXT',
    'verified_at TIMESTAMPTZ', 'is_active BOOLEAN', 'created_at TIMESTAMPTZ',
    'updated_at TIMESTAMPTZ'
  ]) assert.match(migration, new RegExp(field, 'i'));
  for (const field of [
    'pattern_id BIGINT', 'example_text TEXT', 'language TEXT', 'example_status TEXT',
    'embedding_model TEXT', 'embedding_dimensions INTEGER'
  ]) assert.match(migration, new RegExp(field, 'i'));
});

test('pattern codes, statuses, confidence, and the cascading foreign key are constrained', () => {
  assert.match(migration, /CHECK \(BTRIM\(pattern_code\) <> ''\)/i);
  assert.match(migration, /UNIQUE \(pattern_code\)/i);
  assert.match(migration, /status IN \('draft', 'verified', 'disabled'\)/i);
  assert.match(migration, /example_status IN \('draft', 'verified', 'disabled'\)/i);
  assert.match(migration, /confidence_score IS NULL OR \(confidence_score >= 0 AND confidence_score <= 1\)/i);
  assert.match(migration, /FOREIGN KEY \(pattern_id\)\s+REFERENCES scam_patterns\(id\) ON DELETE CASCADE/i);
});

test('migration adds active verified pattern and example indexes', () => {
  assert.match(migration, /ON scam_patterns \(scam_category, status\)\s+WHERE is_active = TRUE AND status = 'verified'/i);
  assert.match(migration, /ON scam_pattern_examples \(pattern_id, language\)\s+WHERE is_active = TRUE AND example_status = 'verified'/i);
});

test('runtime n8n PostgreSQL nodes remain lookup-only outside the isolated curated embedding generator', () => {
  const workflowDir = path.join(root, 'n8n', 'workflows');
  for (const file of fs.readdirSync(workflowDir).filter((name) => name.endsWith('.json'))) {
    const workflow = JSON.parse(fs.readFileSync(path.join(workflowDir, file), 'utf8'));
    for (const node of workflow.nodes || []) {
      if (node.type !== 'n8n-nodes-base.postgres') continue;
      if (file === 'generate-curated-pattern-embeddings-v1.json' && node.name === 'Store Curated Embedding') continue;
      const query = String(node.parameters?.query || '').replace(/--.*$/gm, '');
      assert.doesNotMatch(
        query,
        /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|CREATE|ALTER|DROP)\b/i,
        `${file}/${node.name} must remain read-only`
      );
    }
  }
});

test('semantic pattern migration does not create request-history or raw-input storage', () => {
  assert.doesNotMatch(migration, /CREATE TABLE[^;]*(?:analysis_history|user_requests|raw_screenshots|provider_outputs)/i);
  assert.doesNotMatch(migration, /\b(?:base64_data|raw_image|raw_prompt|provider_output)\b/i);
});
