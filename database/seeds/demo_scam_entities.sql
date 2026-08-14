BEGIN;

INSERT INTO scam_entities (
    entity_type,
    normalized_value,
    status,
    report_count,
    confidence_score,
    source,
    first_reported_at,
    last_reported_at,
    is_active,
    notes
)
VALUES
    (
        'domain', 'scam-demo.example', 'confirmed_scam', 15, 0.9800,
        'development_seed', '2026-01-10T00:00:00Z', '2026-07-20T00:00:00Z', TRUE,
        'Synthetic development-only domain. The .example TLD is reserved for documentation.'
    ),
    (
        'phone', '0810000000', 'confirmed_scam', 12, 0.9500,
        'development_seed', '2026-02-01T00:00:00Z', '2026-07-18T00:00:00Z', TRUE,
        'Synthetic development-only Thai-format phone used solely for local testing.'
    ),
    (
        'bank_account', '9999999999', 'suspected', 4, 0.7200,
        'development_seed', '2026-03-05T00:00:00Z', '2026-07-11T00:00:00Z', TRUE,
        'Synthetic development-only bank-account value; it does not identify a real account.'
    ),
    (
        'domain', 'review-demo.example', 'reported', 2, 0.5500,
        'development_seed', '2026-04-08T00:00:00Z', '2026-06-21T00:00:00Z', TRUE,
        'Synthetic development-only reported domain using the reserved .example TLD.'
    ),
    (
        'domain', 'cleared-demo.example', 'cleared', 0, 0.1000,
        'development_seed', '2026-01-15T00:00:00Z', '2026-05-10T00:00:00Z', TRUE,
        'Synthetic development-only cleared entity using the reserved .example TLD.'
    )
ON CONFLICT (entity_type, normalized_value) DO UPDATE
SET
    status = EXCLUDED.status,
    report_count = EXCLUDED.report_count,
    confidence_score = EXCLUDED.confidence_score,
    source = EXCLUDED.source,
    first_reported_at = EXCLUDED.first_reported_at,
    last_reported_at = EXCLUDED.last_reported_at,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    updated_at = CURRENT_TIMESTAMP;

COMMIT;
