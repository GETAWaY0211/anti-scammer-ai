# Local PostgreSQL Scam Intelligence

Phase 5A/5B established the local PostgreSQL 17 database and **Entity Intelligence Lookup V1**. Phase 5C connects that read-only sub-workflow to Text Analysis Main V2 and merges backend-derived indicators before deterministic scoring version 1.1.0, without adding public database fields.

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

The Compose service uses PostgreSQL 17, stores database files in the named `postgres_data` volume, publishes `${POSTGRES_PORT:-5432}`, and requires `POSTGRES_PASSWORD` from `n8n/.env`.

## Apply the migration and development seed

Run from `n8n/` after PostgreSQL is healthy:

```powershell
Get-Content -Raw ..\database\migrations\001_create_scam_entities.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

Get-Content -Raw ..\database\seeds\demo_scam_entities.sql |
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Both files are safe to rerun: the migration uses guarded DDL and the seed uses `ON CONFLICT ... DO UPDATE`.

Check the development rows without printing full phone or account values:

```powershell
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT entity_type, status, report_count, source FROM scam_entities ORDER BY entity_type, status;"'
```

All seed rows use `source = 'development_seed'`. Domains use the reserved `.example` TLD. Phone and bank-account values are synthetic and intended only for local testing.

## Schema

`scam_entities` enforces:

- entity types `phone`, `bank_account`, and `domain`
- statuses `reported`, `suspected`, `confirmed_scam`, and `cleared`
- unique `(entity_type, normalized_value)`
- non-negative `report_count`
- nullable `confidence_score` constrained to `0..1`
- automatically maintained `updated_at`

Indexes support active `(entity_type, normalized_value)` lookup and active status/type filtering.

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
