BEGIN;

CREATE TABLE IF NOT EXISTS scam_entities (
    id BIGSERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    status TEXT NOT NULL,
    report_count INTEGER NOT NULL DEFAULT 0,
    confidence_score NUMERIC(5, 4),
    source TEXT NOT NULL,
    first_reported_at TIMESTAMPTZ,
    last_reported_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT scam_entities_entity_type_check
        CHECK (entity_type IN ('phone', 'bank_account', 'domain')),
    CONSTRAINT scam_entities_status_check
        CHECK (status IN ('reported', 'suspected', 'confirmed_scam', 'cleared')),
    CONSTRAINT scam_entities_report_count_check
        CHECK (report_count >= 0),
    CONSTRAINT scam_entities_confidence_score_check
        CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
    CONSTRAINT scam_entities_entity_value_unique
        UNIQUE (entity_type, normalized_value)
);

CREATE INDEX IF NOT EXISTS scam_entities_active_lookup_idx
    ON scam_entities (entity_type, normalized_value)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS scam_entities_active_status_idx
    ON scam_entities (status, entity_type)
    WHERE is_active = TRUE;

CREATE OR REPLACE FUNCTION set_scam_entities_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scam_entities_set_updated_at ON scam_entities;

CREATE TRIGGER scam_entities_set_updated_at
BEFORE UPDATE ON scam_entities
FOR EACH ROW
EXECUTE FUNCTION set_scam_entities_updated_at();

COMMIT;
