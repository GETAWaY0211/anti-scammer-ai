# Anti-Scammer AI Demo Web Client

This lightweight demo validates the browser-to-API integration for text and Base64 screenshot analysis. It uses plain HTML, CSS, and browser JavaScript behind a small Express proxy. The browser never receives the n8n endpoint or credentials.

## Architecture

```text
Browser
   |
   | POST /api/analyze
   v
Demo Express Server
   |
   | POST /webhook/api/v1/analyze
   v
n8n Anti-Scammer Workflow
   |
   v
Gemini / deterministic scoring
   |
   v
Demo Result UI
```

The Express server serves `public/`, accepts JSON at `POST /api/analyze`, applies request and size validation, and forwards the unchanged public request body to the configured n8n production webhook. It preserves documented n8n response bodies and statuses `200`, `400`, `413`, `422`, `500`, and `503`. It does not retry requests.

## Prerequisites

- Node.js 20 or later
- npm
- A running n8n instance with Text Analysis Main V2 and its dependencies imported, linked, configured, and active
- The production n8n webhook URL, normally `http://localhost:5678/webhook/api/v1/analyze` for local development

The `/webhook-test/` URL works only while n8n is listening for a test event. Use the `/webhook/` production URL for the normal demo flow.

## Configuration

Copy the example file and edit `.env`:

```powershell
cd demo-app
npm install
Copy-Item .env.example .env
```

```text
N8N_ANALYZE_URL=http://localhost:5678/webhook/api/v1/analyze
DEMO_PORT=3000
N8N_TIMEOUT_MS=45000
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `N8N_ANALYZE_URL` | Yes | Server-side n8n production webhook URL. It is never sent to browser code or included in public errors. |
| `DEMO_PORT` | No | Local Express port. Defaults to `3000`. |
| `N8N_TIMEOUT_MS` | No | Upstream timeout in milliseconds. Defaults to `45000`. |

`.env` and `node_modules/` are ignored by the repository. Do not place Gemini keys, n8n credentials, authorization tokens, or other secrets in browser files. Future API authorization headers must be added only on the server side.

## Run

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). The browser calls only `http://localhost:3000/api/analyze`; Express proxies the request to n8n.

## Supported requests

Text mode submits the unchanged API contract:

```json
{
  "input_type": "text",
  "content": "ข้อความที่ต้องการตรวจสอบ",
  "request_id": "browser-generated-uuid",
  "language": "th",
  "metadata": { "source": "web-demo" }
}
```

Image mode accepts exactly one PNG, JPEG, or WebP file no larger than 5 MiB. The browser previews the original file, reads it with `FileReader`, removes the `data:image/...;base64,` prefix, and submits only the Base64 data. It does not resize, crop, or recompress the image.

Browser validation improves usability only. Express and the n8n workflow remain authoritative and revalidate the public request.

## Automated tests

Run:

```powershell
npm test
```

The tests verify static-file delivery, malformed JSON handling, missing configuration, n8n status preservation, timeout normalization, proxy request shape, image data-URI removal, MIME/size checks, safe Thai error mapping, text-only DOM rendering, and absence of browser secrets.

These tests use a stub upstream service. They do not prove connectivity to a running n8n instance.

## Manual runtime tests

Run these only after the production webhook is active and `.env` points to it.

1. **Text scam:** submit `ธนาคารแจ้งว่าบัญชีจะถูกระงับ กรุณาส่งรหัส OTP กลับมาทันที`. Confirm the risk label, API score, indicators, and recommended actions render.
2. **Normal text:** submit `พรุ่งนี้ประชุมทีมเวลา 10 โมง กรุณานำเอกสารโครงการมาด้วย`. Confirm the low-risk layout remains readable with few or no indicators.
3. **Scam screenshot:** choose the existing screenshot. Confirm preview, filename, size, loading stages, and result display; verify no Base64 or provider fields appear in the UI.
4. **Unsupported file:** select a GIF. Confirm the browser blocks it without an API request.
5. **Oversized image:** select an image over 5 MiB. Confirm the browser blocks it with a Thai error.
6. **n8n unavailable:** stop n8n or configure an unavailable endpoint. Confirm a safe service-unavailable message with no stack trace or internal URL.
7. **Image with no readable text:** confirm `422 IMAGE_TEXT_EXTRACTION_FAILED` becomes a suggestion to use a clearer image or enter text manually.
8. **Cancel:** cancel while waiting. The browser request stops; the n8n execution may continue in the background.

## Privacy and security limitations

- The demo does not log submitted text, Base64 images, or request bodies by default.
- API-provided strings are inserted with `textContent`, not unsanitized HTML.
- The server applies an 8 MiB JSON-body limit and a 45-second upstream timeout.
- The UI warns users not to submit passwords, OTP values, or unnecessary account information.
- This demo does not claim that data is never stored. n8n execution history may retain workflow inputs depending on deployment settings.
- The Cancel button only aborts the browser request; it does not cancel an already-running n8n execution.
- Authentication, authorization, HTTPS, rate limiting, production logging/redaction, CSRF considerations, and operational monitoring are required before public deployment.
- There is no login, storage, result history, retry, streaming, provider selection, model selection, or database enrichment in this phase.
