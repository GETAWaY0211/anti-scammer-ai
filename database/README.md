# Local PostgreSQL Scam Intelligence

Phase 5A/5B established the local PostgreSQL 17 database and **Entity Intelligence Lookup V1**. Phase 5C connects that read-only sub-workflow to Text Analysis Main V2 and merges backend-derived indicators before deterministic scoring version 1.1.0, without adding public database fields. Phase 5D-A changes the same PostgreSQL 17 service to the pgvector-enabled image and adds a relational foundation for curated semantic scam patterns; it does not add embeddings or a runtime semantic lookup.

## Intelligence data boundaries

- **Entity Intelligence** (`scam_entities`) supports deterministic exact matching of normalized phones, bank accounts, and domains in the current read-only analysis path.
- **Semantic Pattern Intelligence** (`scam_patterns` and `scam_pattern_examples`) stores curated, synthetic, or independently verified pattern definitions and examples prepared outside the analysis request path.

Phase 5D-A enables the `vector` extension so the database is ready for a later phase, but deliberately creates no vector column, embedding job, similarity query, HNSW/IVFFlat index, or fixed embedding dimension. `embedding_model` and `embedding_dimensions` are nullable provenance fields only. A vector dimension will be chosen after an embedding model is selected.

User requests, screenshots, Base64 data, extracted user text, prompts, provider output, and analysis history must never be inserted into `scam_pattern_examples`. No n8n runtime database-write path is introduced in this phase.

## Phase 5D-C semantic retrieval foundation

Phase 5D-C fixes the server-side embedding configuration to **`gemini-embedding-2` at 768 dimensions**. Google documents the model as supporting more than 100 languages and lists 768 as a recommended output size. The model and dimension are trusted workflow constants and cannot be selected by lookup input. See the [official Gemini embedding documentation](https://ai.google.dev/gemini-api/docs/embeddings).

Migration `003_add_scam_pattern_embeddings.sql` adds `embedding vector(768)` and a consistency constraint requiring a populated vector to use exactly `gemini-embedding-2` and 768-dimensional metadata. There is deliberately no HNSW or IVFFlat index: the curated hackathon dataset is small, so the first implementation performs exact cosine-distance search.

Document and query inputs use the provider's asymmetric retrieval convention consistently:

- curated example: `title: <pattern name> | text: <example text>`
- runtime query: `task: search result | query: <submitted text>`

`Generate Curated Pattern Embeddings V1` is manual/operator-only. It reads verified active rows whose source is `development_curated_seed`, generates missing or outdated embeddings, and updates only `embedding`, `embedding_model`, and `embedding_dimensions` on those existing rows. It never creates examples and never receives runtime user requests.

`Semantic Pattern Lookup V1` is an isolated sub-workflow. Runtime content and its vector exist transiently in workflow memory only. Its parameterized PostgreSQL query reads the five nearest verified active examples using cosine distance (`<=>`), then groups them by `pattern_code` and reports best similarity, average similarity, matched-example count, and safe example ranks. Patterns are sorted by best similarity, average similarity, count, then code. No similarity threshold or scam conclusion is applied in this phase, and the result has no scoring or public API effect.

Phase 5D-E calls that existing sub-workflow from Main V2 as optional supporting intelligence. Main validates and reduces its output to safe pattern-level metrics; semantic failure does not stop analysis, while authoritative Entity Intelligence failure still does. Similarity never creates indicators or changes the deterministic score, is never exposed publicly, and must not be interpreted as scam probability. Runtime text and query embeddings remain transient and are never inserted into PostgreSQL.

Phase 5D-F adds a deterministic in-memory corroboration check in Main. It compares each retrieved pattern with indicators already accepted by the strict LLM validator; PostgreSQL similarity and example counts cannot corroborate a pattern alone. This layer performs no database write, adds no scoring weight, and stores no runtime input or result.

## Start PostgreSQL locally

From the repository root:

```powershell
Copy-Item n8n\.env.example n8n\.env
```

Edit `n8n\.env` and replace the development password. Do not commit this file.

```powershell
Set-Location n8n
docker compose up -d postgres
docker compose ps
```

The Compose service uses `pgvector/pgvector:pg17`, stores database files in the existing named `postgres_data` volume, publishes `${POSTGRES_PORT:-5432}`, and requires `POSTGRES_PASSWORD` from `n8n/.env`. Updating the image recreates the container when necessary but preserves the named volume. Do not run `docker compose down -v` or manually delete `postgres_data`.

## Apply the migration and development seed

Run from `n8n/` after PostgreSQL is healthy:

```powershell
Get-Content -Raw ..\database\migrations\001_create_scam_entities.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

Get-Content -Raw ..\database\migrations\002_enable_pgvector_and_create_scam_patterns.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

Get-Content -Raw ..\database\migrations\003_add_scam_pattern_embeddings.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

Get-Content -Raw ..\database\seeds\demo_scam_entities.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

Get-Content -Raw ..\database\seeds\demo_scam_patterns.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The migration files use guarded DDL. Both development seeds are idempotent: entity rows use deterministic conflict updates, while pattern examples are reconciled by pattern, language, and exact curated text before missing rows are inserted.

Check the development rows without printing full phone or account values:

```powershell
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT entity_type, status, report_count, source FROM scam_entities ORDER BY entity_type, status;"'
```

All seed rows use `source = 'development_seed'`. Domains use the reserved `.example` TLD. Phone and bank-account values are synthetic and intended only for local testing.

### Curated semantic-pattern examples

`demo_scam_patterns.sql` adds eight verified, active development patterns with four synthetic Thai examples each. The examples vary wording, urgency, sentence order, organization claims, and how credential, payment, or device-access requests are expressed. They are authored test intelligence—not real victim conversations and not data collected from API requests or n8n execution history.

New rows created by the seed leave `embedding_model`, `embedding_dimensions`, and `embedding` as `NULL`. Rerunning the seed preserves embeddings already generated for an unchanged curated example. After migration `003`, the separate operator-run generation workflow may populate missing embedding fields. Loading the seed alone does not make semantic search available.

Check the curated row counts without printing example text:

```powershell
'SELECT p.pattern_code, p.status, p.is_active, COUNT(e.id) AS example_count FROM scam_patterns p LEFT JOIN scam_pattern_examples e ON e.pattern_id = p.id AND e.is_active = TRUE WHERE p.source = ''development_curated_seed'' GROUP BY p.id, p.pattern_code, p.status, p.is_active ORDER BY p.pattern_code;' |
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## Schema

`scam_entities` enforces:

- entity types `phone`, `bank_account`, and `domain`
- statuses `reported`, `suspected`, `confirmed_scam`, and `cleared`
- unique `(entity_type, normalized_value)`
- non-negative `report_count`
- nullable `confidence_score` constrained to `0..1`
- automatically maintained `updated_at`

Indexes support active `(entity_type, normalized_value)` lookup and active status/type filtering.

`scam_patterns` enforces a unique non-empty `pattern_code`, the statuses `draft`, `verified`, and `disabled`, and a nullable `confidence_score` constrained to `0..1`. `scam_pattern_examples` belongs to a pattern through an `ON DELETE CASCADE` foreign key and enforces the same lifecycle statuses for examples. Partial relational indexes support active verified patterns by category/status and active verified examples by pattern/language.

Verify Phase 5D-A manually after applying migration `002`:

```powershell
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT extname, extversion FROM pg_extension WHERE extname = ''vector'';"'
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d scam_patterns"'
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d scam_pattern_examples"'
```

These commands are required runtime checks. Static repository tests alone do not prove that the extension has loaded in a running container.

### Configure and test Phase 5D-C workflows

Import in this order:

1. `n8n/workflows/generate-curated-pattern-embeddings-v1.json`
2. `n8n/workflows/semantic-pattern-lookup-v1.json`

For both workflows, select the local PostgreSQL credential on every Postgres node. Select an HTTP Header Auth credential with header name `x-goog-api-key` on each Gemini embedding HTTP node. Credentials and workflow IDs are not embedded in the exports.

Run **Generate Curated Pattern Embeddings V1** manually after migration `003` and the curated seed. A first successful run should update the verified active curated examples; an immediate rerun should find no rows needing regeneration. Confirm coverage without printing vectors or example text:

```powershell
'SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, COUNT(*) AS total FROM scam_pattern_examples WHERE example_status = ''verified'' AND is_active = TRUE AND source = ''development_curated_seed'';' |
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Test **Semantic Pattern Lookup V1** as a sub-workflow with one `context` item. Use the five cases in `tests/fixtures/semantic-pattern-cases.json`. Save the returned per-pattern similarity arrays into each case's `observed_similarity_distribution` for later calibration. Do not infer or add a threshold from this small dataset; threshold calibration is deferred to Phase 5D-D. These distributions intentionally remain `null` until manual runtime testing.

Production privacy settings should minimize n8n execution-data retention: runtime text, provider request payloads, responses, and query vectors may be visible transiently in authorized execution data even though PostgreSQL never persists them.

## Phase 5D-D semantic calibration harness

Phase 5D-D keeps semantic retrieval isolated from Main and scoring. The synthetic dataset at `tests/fixtures/semantic-calibration-cases.json` contains 52 cases: multiple paraphrases for every verified pattern, cross-pattern messages, benign messages, legitimate scam-like warnings, sparse text, informal Thai, and mixed Thai/English. It contains no real PII, account, URL, or victim conversation.

Run the harness as follows:

1. Confirm all curated examples have embeddings.
2. Import `n8n/workflows/semantic-pattern-calibration-v1.json`.
3. In **Execute Semantic Pattern Lookup V1**, select the imported standalone lookup workflow.
4. Smoke-test one case first: temporarily set the trusted `CALIBRATION_CASE_IDS` constant in **Load Calibration Cases** to `['prize_fee_02']`, save, and execute. **Build Semantic Lookup Input** must output exactly one top-level `context` object; the lookup should proceed past input validation and the result should correlate through `context.request_id = case_id`.
5. Restore `CALIBRATION_CASE_IDS = []`, then execute all 52 cases. **Loop Over Calibration Cases** processes one case at a time to avoid provider concurrency spikes. A failed lookup remains an explicit failed calibration result with its case ID and expected pattern.
6. Export that final node's JSON as `tests/results/semantic-calibration-raw.json` without copying any intermediate provider response or vector.
7. From the repository root, run:

```powershell
node scripts/run-semantic-calibration.js --input tests/results/semantic-calibration-raw.json
```

The deterministic runner writes `tests/results/semantic-calibration.json` and `tests/results/semantic-calibration-summary.md`. It records top pattern, top-k ranking, best/average similarity, retrieved example count, top-one/top-two margin, Top-1 accuracy, Top-3 recall, observed ranges by case type, and ambiguous low-margin cases. The committed result remains `pending_runtime` until a real n8n execution is exported; no values are fabricated.

The report's candidate bands summarize observed regions only. The diagnostic margin of `0.05` identifies close rankings and is not a scam threshold. Phase 5D-D does not select a threshold, create a risk indicator, persist runtime input, or affect the public API. Production calibration requires a larger representative dataset and false-positive review.

## Configure the n8n Postgres credential

1. Import `n8n/workflows/entity-intelligence-lookup-v1.json`.
2. Open **PostgreSQL Lookup** and create/select a Postgres credential.
3. When n8n and PostgreSQL use this Compose stack, use:
   - Host: `postgres`
   - Port: `5432`
   - Database: value of `POSTGRES_DB`
   - User: value of `POSTGRES_USER`
   - Password: value of `POSTGRES_PASSWORD`
   - SSL: disabled for this local-only Compose connection
4. Save the node and workflow.

If n8n runs in a container while PostgreSQL runs on the host-published port, use `host.docker.internal` where Docker supports it. Do not use `localhost` from inside an n8n container to mean the host; container-local `localhost` refers to that container itself.

The exported workflow contains no credential reference or password. Its SQL is fixed and binds the extracted entity array through `$1::jsonb`; submitted values are not concatenated into SQL.

## Internal result contract

The sub-workflow always returns one normalized item. A successful lookup resembles:

```json
{
  "ok": true,
  "context": {
    "request_id": "entity-demo-001",
    "analysis_id": "ana-entity-demo-001",
    "input_type": "text",
    "language": "th"
  },
  "intelligence": {
    "entities": [
      {
        "entity_type": "phone",
        "redacted_value": "081***0000",
        "matched": true,
        "status": "confirmed_scam",
        "report_count": 12,
        "confidence_score": 0.95
      }
    ]
  },
  "internal_diagnostics": {
    "entity_lookup": {
      "lookup_performed": true,
      "entity_count": 1,
      "matched_count": 1
    }
  }
}
```

Unmatched entities retain the redacted value and use `null` for status, report count, and confidence. Database unavailability returns one safe internal `503 INTELLIGENCE_LOOKUP_UNAVAILABLE` result. It contains only `failure_stage: "database_lookup"` and `error_category: "database_unavailable"` diagnostics—not SQL, connection data, credentials, stack traces, or the raw database error.

## Manual n8n runtime tests

Use **Execute Workflow** testing with one input item shaped like:

```json
{
  "context": {
    "request_id": "entity-demo-001",
    "analysis_id": "ana-entity-demo-001",
    "input_type": "text",
    "content": "ติดต่อ +66 81 000 0000 หรือเปิด https://scam-demo.example/pay เลขบัญชี 999-9-99999-9",
    "language": "th",
    "metadata": {},
    "accepted_at": "2026-08-13T00:00:00.000Z",
    "accepted_epoch_ms": 1786579200000,
    "requested_output_language": "th"
  }
}
```

Verify:

- the phone is returned only as `081***0000`
- the bank account is returned only as `******9999`
- `scam-demo.example` remains visible
- seeded entities show their expected status/count/confidence
- an unseeded `.example` domain returns `matched: false` with nullable intelligence fields
- input with no entities returns `ok: true`, `lookup_performed: false`, and an empty entity array
- stopping PostgreSQL returns one safe `503 INTELLIGENCE_LOOKUP_UNAVAILABLE` result without raw database errors
- SQL-like content remains data and does not alter the database

These manual checks must be performed in the target n8n instance before claiming PostgreSQL runtime success.

## Boundaries and limitations

- Extraction is deterministic and limited to 10 entities per type and 20 total.
- Bank-account extraction is conservative and requires account context or visibly grouped digits.
- Domains are parsed locally; there is no DNS, WHOIS, HTTP request, crawling, RAG, vector search, or embedding.
- The component performs read-only lookup. It does not accept reports or write user-submitted data.
- Full normalized phone and bank-account values exist transiently inside the isolated workflow to perform exact matching. Restrict n8n execution-history access and retention accordingly.
- The final normalized result omits submitted `context.content` and client metadata. It returns only operational context fields plus redacted entities; database `source` is queried for internal compatibility but is not exposed.
- Phase 5C connects this read-only lookup to Text Analysis Main V2. Only the normalized match result is merged after strict LLM validation; no request-path database writes were added.
