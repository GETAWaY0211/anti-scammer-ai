BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS scam_patterns (
    id BIGSERIAL PRIMARY KEY,
    pattern_code TEXT NOT NULL,
    name TEXT NOT NULL,
    scam_category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    confidence_score NUMERIC(5, 4),
    source TEXT NOT NULL,
    verified_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT scam_patterns_pattern_code_nonempty CHECK (BTRIM(pattern_code) <> ''),
    CONSTRAINT scam_patterns_name_nonempty CHECK (BTRIM(name) <> ''),
    CONSTRAINT scam_patterns_category_nonempty CHECK (BTRIM(scam_category) <> ''),
    CONSTRAINT scam_patterns_description_nonempty CHECK (BTRIM(description) <> ''),
    CONSTRAINT scam_patterns_source_nonempty CHECK (BTRIM(source) <> ''),
    CONSTRAINT scam_patterns_status_allowed CHECK (status IN ('draft', 'verified', 'disabled')),
    CONSTRAINT scam_patterns_confidence_range CHECK (
        confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
    ),
    CONSTRAINT scam_patterns_pattern_code_unique UNIQUE (pattern_code)
);

CREATE TABLE IF NOT EXISTS scam_pattern_examples (
    id BIGSERIAL PRIMARY KEY,
    pattern_id BIGINT NOT NULL,
    example_text TEXT NOT NULL,
    language TEXT NOT NULL,
    example_status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    verified_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT scam_pattern_examples_text_nonempty CHECK (BTRIM(example_text) <> ''),
    CONSTRAINT scam_pattern_examples_language_nonempty CHECK (BTRIM(language) <> ''),
    CONSTRAINT scam_pattern_examples_source_nonempty CHECK (BTRIM(source) <> ''),
    CONSTRAINT scam_pattern_examples_status_allowed CHECK (
        example_status IN ('draft', 'verified', 'disabled')
    ),
    CONSTRAINT scam_pattern_examples_dimensions_positive CHECK (
        embedding_dimensions IS NULL OR embedding_dimensions > 0
    ),
    CONSTRAINT scam_pattern_examples_pattern_fk FOREIGN KEY (pattern_id)
        REFERENCES scam_patterns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scam_patterns_active_verified_category
    ON scam_patterns (scam_category, status)
    WHERE is_active = TRUE AND status = 'verified';

CREATE INDEX IF NOT EXISTS idx_scam_pattern_examples_active_verified_pattern_language
    ON scam_pattern_examples (pattern_id, language)
    WHERE is_active = TRUE AND example_status = 'verified';

CREATE OR REPLACE FUNCTION set_scam_pattern_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scam_patterns_updated_at ON scam_patterns;
CREATE TRIGGER trg_scam_patterns_updated_at
BEFORE UPDATE ON scam_patterns
FOR EACH ROW
EXECUTE FUNCTION set_scam_pattern_updated_at();

DROP TRIGGER IF EXISTS trg_scam_pattern_examples_updated_at ON scam_pattern_examples;
CREATE TRIGGER trg_scam_pattern_examples_updated_at
BEFORE UPDATE ON scam_pattern_examples
FOR EACH ROW
EXECUTE FUNCTION set_scam_pattern_updated_at();

COMMIT;
