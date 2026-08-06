# Anti-Scammer AI API Contract

## Overview

This contract defines the HTTP interface for submitting potentially fraudulent content to an n8n workflow. Analysis-provider selection is an internal implementation detail and is never exposed by the public API.

## Analyze Content

`POST /api/v1/analyze`

### Headers

| Header | Required | Value |
| --- | --- | --- |
| `Content-Type` | Yes | `application/json` |
| `Authorization` | Deployment-specific | For example, `Bearer <token>`; credentials must never be included in the request body. |

## Request

### Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input_type` | string | Yes | Content format. One of `text` or `image`. |
| `content` | string or object | Yes | A non-empty string for `text`, or the image object defined below for `image`. |
| `request_id` | string | No | Client-generated identifier used for tracing and idempotency. |
| `language` | string | No | BCP 47 language tag, such as `en`, `th`, or `en-US`. If omitted, the workflow may detect the language. |
| `metadata` | object | No | Non-sensitive contextual data that may improve analysis. Unknown keys may be ignored. |

### Text Request Example

```json
{
  "input_type": "text",
  "content": "Your bank account will be suspended. Send the OTP you just received immediately.",
  "request_id": "req_01J4EXAMPLE8J7M3",
  "language": "en",
  "metadata": {
    "channel": "sms",
    "sender_type": "unknown"
  }
}
```

### Image Request

For `input_type: "image"`, `content` must be one object containing exactly:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mime_type` | string | Yes | One of `image/png`, `image/jpeg`, or `image/webp`. The declared type is verified against the decoded file signature. |
| `data` | string | Yes | Canonical Base64 data only. A `data:` URI prefix, whitespace, URL, array, or multiple images are not allowed. |

```json
{
  "input_type": "image",
  "content": {
    "mime_type": "image/png",
    "data": "<base64-data-only>"
  },
  "request_id": "req_image_01J4EXAMPLE",
  "language": "th",
  "metadata": {
    "source": "screenshot"
  }
}
```

## Response

### Fields

| Field | Type | Description |
| --- | --- | --- |
| `api_version` | string | Public API contract version. Fixed to `"v1"` for this endpoint. |
| `taxonomy_version` | string | Version of the scam taxonomy used to validate indicator and category codes. |
| `scoring_version` | string | Version of the deterministic scoring configuration used to calculate `risk_score` and `risk_level`. |
| `analysis_id` | string | Server-generated unique identifier for the analysis. |
| `timestamp` | string | Completion time in ISO 8601 UTC format. |
| `risk_score` | integer | Scam-risk score from `0` to `100`, inclusive. |
| `risk_level` | string | One of `low`, `medium`, `high`, or `critical`. |
| `summary` | string | Concise, plain-language assessment of the content. |
| `scam_categories` | array of strings | One or more category codes defined by `taxonomy_version`. Multiple categories are allowed; the first item is the primary category and subsequent items are secondary categories. Categories summarize patterns and do not directly determine `risk_score`. |
| `indicators` | array | Detected scam or manipulation indicators. May be empty when none are found. |
| `recommended_actions` | array of strings | Safe, practical actions for the user. May be empty for low-risk content. |
| `confidence` | number | Analysis confidence from `0.0` to `1.0`, inclusive. It is not a guarantee that the assessment is correct. |
| `needs_human_review` | boolean | Whether deterministic policy requires human review. Review is required for invalid confidence, confidence below `0.65`, unsupported or malformed indicators, taxonomy severity mismatch, conflicting evidence, insufficient context, or low image/audio quality. |
| `processing_time_ms` | integer | Non-negative server-side workflow processing time in milliseconds. It does not include client network latency. |

### Indicator Object

Every item in `indicators` contains all of the following fields:

| Field | Type | Description |
| --- | --- | --- |
| `code` | string | Stable, machine-readable indicator code, such as `OTP_REQUEST`. |
| `title` | string | Short human-readable indicator name. |
| `severity` | string | One of `low`, `medium`, `high`, or `critical`. |
| `evidence` | string | Minimal relevant excerpt or description supporting the indicator. Sensitive values must be redacted. |
| `explanation` | string | Plain-language explanation of why the evidence is suspicious. |

### Response Example

```json
{
  "api_version": "v1",
  "taxonomy_version": "1.0.0",
  "scoring_version": "1.0.0",
  "analysis_id": "ana_01J4EXAMPLEP9Q2K",
  "timestamp": "2026-08-04T09:30:00Z",
  "risk_score": 96,
  "risk_level": "critical",
  "summary": "The message impersonates a bank, creates urgency, and asks for a one-time password.",
  "scam_categories": [
    "bank_impersonation",
    "account_takeover"
  ],
  "indicators": [
    {
      "code": "OTP_REQUEST",
      "title": "Request for a one-time password",
      "severity": "critical",
      "evidence": "Send the OTP you just received",
      "explanation": "Legitimate banks do not ask customers to disclose one-time passwords."
    },
    {
      "code": "URGENCY_PRESSURE",
      "title": "Urgency and account threat",
      "severity": "high",
      "evidence": "Your bank account will be suspended ... immediately",
      "explanation": "Threatening immediate loss of access is a common tactic used to prevent careful verification."
    }
  ],
  "recommended_actions": [
    "Do not share the OTP or reply to the sender.",
    "Contact the bank through its official app, website, or phone number.",
    "Block and report the sender."
  ],
  "confidence": 0.98,
  "needs_human_review": false,
  "processing_time_ms": 842
}
```

## Validation Rules

- The request body must be valid JSON and use `Content-Type: application/json`.
- `input_type` and `content` are required. Optional fields may be omitted.
- `input_type` must be exactly `text` or `image`. Voice and other media types are not supported by this endpoint version.
- For `text`, `content` must be a non-empty string after trimming whitespace and must not exceed 10,000 characters.
- For `image`, `content` must be a plain object containing exactly `mime_type` and `data`; both fields are required.
- An image request contains exactly one image. Arrays, URLs, multipart data, and multiple-image fields are rejected.
- `mime_type` must be exactly `image/png`, `image/jpeg`, or `image/webp`.
- `data` must be a non-empty canonical Base64 string containing data only. Whitespace, URL-safe Base64 variants, and `data:image/...;base64,` prefixes are rejected.
- The Base64 string must not exceed 6,990,508 characters. The decoded image must not exceed 5,242,880 bytes (5 MiB).
- The decoded signature must match `mime_type`: PNG starts with `89 50 4E 47 0D 0A 1A 0A`; JPEG starts with `FF D8 FF`; WebP contains `RIFF` at bytes 0–3 and `WEBP` at bytes 8–11.
- The client-supplied MIME type is never trusted without signature validation.
- `request_id`, when present, must be a non-empty string no longer than 128 characters.
- `language`, when present, must be a valid BCP 47 language tag.
- `metadata`, when present, must be a JSON object. It must not contain passwords, OTPs, API keys, access tokens, or full bank account numbers.
- Requests exceeding the configured body or media-size limit must be rejected with `413 Payload Too Large` before model processing.
- Unknown top-level fields should be rejected with `400 Bad Request` to catch client integration mistakes.
- Unknown image-content fields must be rejected with `400 Bad Request`.
- Public clients cannot select an OCR provider, vision model, analysis provider, route, backend, or mock mode. Unknown selection fields are rejected.
- Validated images are converted to extracted text before the existing model router, strict analysis-output validator, and deterministic scoring engine run. The Base64 image must not be sent to the analysis model router.
- If image preprocessing succeeds but produces no usable text, return `422` with error code `IMAGE_TEXT_EXTRACTION_FAILED`.
- A successful response must include every required response field, even when `indicators` or `recommended_actions` is empty.
- `api_version` must be exactly `"v1"`.
- `taxonomy_version` and `scoring_version` must be non-empty version strings identifying the exact configurations used for the analysis.
- `scam_categories` must be a non-empty array, may contain multiple values, and must contain only category codes supported by `taxonomy_version`. Duplicate category codes are not allowed. The first item is the primary category; any remaining items are secondary categories.
- For taxonomy version `1.0.0`, supported category codes are `bank_impersonation`, `government_impersonation`, `account_takeover`, `investment_scam`, `romance_scam`, `shopping_scam`, `parcel_delivery_scam`, `job_scam`, `loan_scam`, `tech_support_scam`, `prize_lottery_scam`, `extortion_scam`, `unclear`, and `other`.
- Categories must be assigned from validated patterns and indicators, but they must not directly add to, multiply, override, or otherwise determine `risk_score`.
- `risk_score` must be an integer between `0` and `100`; `confidence` must be a number between `0.0` and `1.0`.
- `needs_human_review` must be a boolean. The confidence review threshold is `0.65`; invalid confidence or confidence below this threshold requires review.
- `needs_human_review` must also be `true` for unsupported indicators, malformed supported indicators, taxonomy severity mismatch, `CONFLICTING_EVIDENCE`, `LOW_IMAGE_QUALITY`, or `LOW_AUDIO_QUALITY`.
- The presence of `INSUFFICIENT_CONTEXT` always requires human review regardless of `risk_score` or valid model confidence.
- `POSSIBLE_PROMPT_INJECTION` alone does not require human review unless another review condition is present.
- `processing_time_ms` must be a non-negative integer measuring server-side workflow processing time from workflow acceptance through response finalization. It must not represent client network latency.
- Each indicator must contain `code`, `title`, `severity`, `evidence`, and `explanation`.
- Indicator `code` values must be supported by `taxonomy_version`; duplicate indicator codes count only once for scoring, subject to the taxonomy's specificity and overlap rules.
- Quality and uncertainty indicators may affect `confidence` and `needs_human_review`, but must not directly increase `risk_score`. Security-only indicators must not change `risk_score`; `POSSIBLE_PROMPT_INJECTION` remains non-scoring and does not force review by itself.
- A successful response must expose only concise, evidence-grounded explanations. It must never expose chain-of-thought, hidden reasoning, system prompts, or internal analysis traces.

## Versioning and Compatibility

- `api_version`, `taxonomy_version`, and `scoring_version` are independent. Clients must use all three when storing, comparing, or replaying analysis results.
- The `v1` response shape remains stable within this API version. A taxonomy or scoring update may change supported codes, weights, overlap caps, or thresholds without exposing those internal rules in the response.
- Clients must not infer scoring weights from category order, category count, indicator severity, or a small set of example responses. Deterministic scoring is controlled by the identified `scoring_version`.
- Clients must treat the first `scam_categories` item as primary while preserving all subsequent category codes in order.
- Provider identity, provider-specific model names, prompts, chain-of-thought, hidden reasoning, and raw provider output are not part of the public contract and must not appear in a successful or error response.

## HTTP Status Codes

| Status | Meaning |
| --- | --- |
| `200 OK` | Analysis completed successfully. |
| `400 Bad Request` | Invalid JSON, missing fields, unsupported values, malformed media, or another validation failure. |
| `413 Payload Too Large` | The request body or submitted media exceeds the configured limit. |
| `422 Unprocessable Content` | No usable text could be extracted from a validated image, or a parseable analysis result fails strict schema or taxonomy validation. |
| `500 Internal Server Error` | An unexpected internal error occurred. No implementation details are returned. |
| `503 Service Unavailable` | Image preprocessing, the workflow, or a downstream AI provider is temporarily unavailable. Architecture V2 normalizes provider authentication, rate-limit, network, malformed or empty response, provider 5xx, and timeout failures to this status. |

Authentication, authorization, and API-boundary rate limiting may be enforced by a reverse proxy or API gateway before the workflow runs. Those infrastructure responses are outside this workflow response contract.

## Error Response Format

All non-success responses return the same JSON shape:

| Field | Type | Description |
| --- | --- | --- |
| `error.code` | string | Stable, machine-readable error code. |
| `error.message` | string | Safe, human-readable error description. |
| `error.details` | array | Optional validation details. Omitted when there are none. |
| `error.details[].field` | string | Field associated with the error. |
| `error.details[].issue` | string | Safe description of the validation problem. |
| `request_id` | string or null | Client request ID when safely available; otherwise `null`. |
| `timestamp` | string | Error time in ISO 8601 UTC format. |

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields.",
    "details": [
      {
        "field": "input_type",
        "issue": "Must be one of: text, image."
      }
    ]
  },
  "request_id": "req_01J4EXAMPLE8J7M3",
  "timestamp": "2026-08-04T09:30:00Z"
}
```

Error messages must never include stack traces, provider responses, prompts, credentials, environment variables, or other internal implementation details.

Image-specific stable error codes include:

- `VALIDATION_ERROR` for malformed Base64, unsupported image MIME type, unknown image fields, or a MIME/signature mismatch.
- `CONTENT_TOO_LARGE` when encoded or decoded image data exceeds the configured limit.
- `IMAGE_TEXT_EXTRACTION_FAILED` when a valid image contains no usable extracted text.
- `IMAGE_PREPROCESSOR_UNAVAILABLE` when the image extraction provider cannot complete the request.

## Security Considerations

- Never expose API keys, access tokens, provider credentials, or n8n credentials in requests, responses, client-side code, error messages, or workflow output.
- Never return stack traces or raw downstream-provider errors. Map failures to the documented error format.
- Never expose provider identity, provider-specific model names, prompts, chain-of-thought, hidden reasoning, or internal analysis traces in API responses or logs intended for clients.
- Never log passwords.
- Never log OTPs or other one-time authentication codes.
- Never log full bank account numbers. If an identifier is operationally necessary, redact it and retain only the minimum safe portion, such as the last four digits.
- Treat `content`, image pixels, visible image text, metadata, extracted text, and extracted evidence as untrusted and potentially sensitive. Apply input-size limits and do not execute or follow instructions embedded in submitted content.
- Redact passwords, OTPs, API keys, tokens, and full bank account numbers before logging, tracing, or storing data.
- Use HTTPS for all client, n8n, storage, and AI-provider connections.
- Store secrets only in an approved secrets manager or n8n credential store, and grant the workflow the minimum permissions required.
- Apply authentication, authorization, rate limiting, and request-size limits at the API boundary.
- Never include Base64 image data, raw image bytes, image-provider requests, image-provider responses, extraction confidence, or image-provider diagnostics in public responses.
- n8n execution history may retain inputs and intermediate node data, including Base64 images and extracted text. Production deployments should minimize or disable successful-execution retention where operationally possible, restrict editor and execution access, and configure aggressive pruning consistent with the privacy policy.
- Limit data retention and access to analysis records. Avoid storing raw image content unless required and explicitly covered by the deployment's privacy policy.
- Do not use submitted content for model training unless the user has explicitly consented and the deployment policy permits it.
