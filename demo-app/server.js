'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const UPSTREAM_STATUSES = new Set([200, 400, 413, 422, 500, 503]);
const PUBLIC_FIELDS = new Set(['input_type', 'content', 'request_id', 'language', 'metadata']);
const IMAGE_FIELDS = new Set(['mime_type', 'data']);
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function loadEnvironmentFile(filePath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function safeRequestId(body) {
  return isPlainObject(body)
    && typeof body.request_id === 'string'
    && body.request_id.length <= 128
    ? body.request_id
    : null;
}

function errorEnvelope(code, message, requestId = null, details = []) {
  return {
    error: { code, message, details },
    request_id: requestId,
    timestamp: new Date().toISOString()
  };
}

function validatePublicRequest(body) {
  const details = [];
  if (!isPlainObject(body)) {
    return [{ field: 'body', issue: 'Must be a JSON object.' }];
  }

  for (const key of Object.keys(body)) {
    if (!PUBLIC_FIELDS.has(key)) details.push({ field: key, issue: 'Unknown top-level field.' });
  }
  if (body.input_type !== 'text' && body.input_type !== 'image') {
    details.push({ field: 'input_type', issue: 'Must equal text or image.' });
  }
  if (body.request_id !== undefined && (
    typeof body.request_id !== 'string'
    || !body.request_id.trim()
    || body.request_id.length > 128
  )) {
    details.push({ field: 'request_id', issue: 'Must be a non-empty string no longer than 128 characters.' });
  }
  if (body.language !== undefined && typeof body.language !== 'string') {
    details.push({ field: 'language', issue: 'Must be a string.' });
  }
  if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
    details.push({ field: 'metadata', issue: 'Must be a plain JSON object.' });
  }

  if (body.input_type === 'text') {
    if (typeof body.content !== 'string' || !body.content.trim()) {
      details.push({ field: 'content', issue: 'Must be a non-empty string.' });
    } else if (body.content.length > 10_000) {
      details.push({ field: 'content', issue: 'Must not exceed 10000 characters.', status: 413 });
    }
  }

  if (body.input_type === 'image') {
    if (!isPlainObject(body.content)) {
      details.push({ field: 'content', issue: 'Must be an image object.' });
    } else {
      for (const key of Object.keys(body.content)) {
        if (!IMAGE_FIELDS.has(key)) details.push({ field: `content.${key}`, issue: 'Unknown image field.' });
      }
      if (!IMAGE_MIME_TYPES.has(body.content.mime_type)) {
        details.push({ field: 'content.mime_type', issue: 'Must be image/png, image/jpeg, or image/webp.' });
      }
      if (typeof body.content.data !== 'string' || !body.content.data) {
        details.push({ field: 'content.data', issue: 'Must be non-empty Base64 data.' });
      } else if (body.content.data.length > MAX_BASE64_LENGTH) {
        details.push({ field: 'content.data', issue: 'Encoded image exceeds the configured limit.', status: 413 });
      } else if (
        /^data:/i.test(body.content.data)
        || body.content.data.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content.data)
      ) {
        details.push({ field: 'content.data', issue: 'Must be canonical Base64 data without a data URI prefix.' });
      } else {
        const decoded = Buffer.from(body.content.data, 'base64');
        if (!decoded.length || decoded.toString('base64') !== body.content.data) {
          details.push({ field: 'content.data', issue: 'Base64 data is malformed.' });
        } else if (decoded.length > MAX_IMAGE_BYTES) {
          details.push({ field: 'content.data', issue: 'Decoded image exceeds 5 MiB.', status: 413 });
        }
      }
    }
  }
  return details;
}

function normalizeUpstreamStatus(status) {
  if (UPSTREAM_STATUSES.has(status)) return status;
  if (status >= 500) return 503;
  return 500;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createApp(options = {}) {
  const app = express();
  const analyzeUrl = options.analyzeUrl ?? process.env.N8N_ANALYZE_URL ?? '';
  const timeoutMs = options.timeoutMs ?? parsePositiveInteger(process.env.N8N_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const staticDirectory = options.staticDirectory ?? path.join(__dirname, 'public');

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    next();
  });
  app.use(express.json({ limit: '8mb', strict: true, type: ['application/json', 'application/*+json'] }));

  app.post('/api/analyze', async (request, response) => {
    const requestId = safeRequestId(request.body);
    if (!request.is('application/json') && !request.is('application/*+json')) {
      return response.status(400).json(errorEnvelope(
        'VALIDATION_ERROR',
        'The request must use application/json.',
        requestId,
        [{ field: 'Content-Type', issue: 'Must be application/json.' }]
      ));
    }

    const validationDetails = validatePublicRequest(request.body);
    if (validationDetails.length) {
      const status = validationDetails.some((detail) => detail.status === 413) ? 413 : 400;
      const publicDetails = validationDetails.map(({ field, issue }) => ({ field, issue }));
      return response.status(status).json(errorEnvelope(
        status === 413 ? 'CONTENT_TOO_LARGE' : 'VALIDATION_ERROR',
        status === 413 ? 'The submitted content exceeds the configured limit.' : 'The request contains invalid fields.',
        requestId,
        publicDetails
      ));
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(analyzeUrl);
      if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') throw new Error('Unsupported protocol.');
    } catch {
      return response.status(503).json(errorEnvelope(
        'ANALYSIS_SERVICE_UNAVAILABLE',
        'The analysis service is temporarily unavailable.',
        requestId
      ));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const upstreamResponse = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      const responseText = await upstreamResponse.text();
      let publicBody;
      try {
        publicBody = JSON.parse(responseText);
      } catch {
        return response.status(503).json(errorEnvelope(
          'ANALYSIS_SERVICE_UNAVAILABLE',
          'The analysis service is temporarily unavailable.',
          requestId
        ));
      }
      if (!isPlainObject(publicBody)) {
        return response.status(503).json(errorEnvelope(
          'ANALYSIS_SERVICE_UNAVAILABLE',
          'The analysis service is temporarily unavailable.',
          requestId
        ));
      }
      const normalizedStatus = normalizeUpstreamStatus(upstreamResponse.status);
      if (!UPSTREAM_STATUSES.has(upstreamResponse.status)) {
        return response.status(normalizedStatus).json(errorEnvelope(
          normalizedStatus === 503 ? 'ANALYSIS_SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
          normalizedStatus === 503
            ? 'The analysis service is temporarily unavailable.'
            : 'An unexpected internal error occurred.',
          requestId
        ));
      }
      return response.status(normalizedStatus).json(publicBody);
    } catch (error) {
      const timedOut = controller.signal.aborted || (error && error.name === 'AbortError');
      return response.status(503).json(errorEnvelope(
        timedOut ? 'ANALYSIS_TIMEOUT' : 'ANALYSIS_SERVICE_UNAVAILABLE',
        'The analysis service is temporarily unavailable.',
        requestId
      ));
    } finally {
      clearTimeout(timeout);
    }
  });

  app.all('/api/analyze', (request, response) => response.status(405).json(errorEnvelope(
    'METHOD_NOT_ALLOWED',
    'Only POST is supported for this endpoint.'
  )));

  app.use(express.static(staticDirectory, { extensions: ['html'], index: 'index.html' }));

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const requestId = safeRequestId(request.body);
    if (error && error.type === 'entity.too.large') {
      return response.status(413).json(errorEnvelope(
        'CONTENT_TOO_LARGE',
        'The submitted content exceeds the configured limit.',
        requestId
      ));
    }
    if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
      return response.status(400).json(errorEnvelope(
        'VALIDATION_ERROR',
        'The request body is not valid JSON.',
        requestId
      ));
    }
    return response.status(500).json(errorEnvelope(
      'INTERNAL_ERROR',
      'An unexpected internal error occurred.',
      requestId
    ));
  });

  return app;
}

function startServer() {
  loadEnvironmentFile();
  const port = parsePositiveInteger(process.env.DEMO_PORT, DEFAULT_PORT);
  const app = createApp();
  return app.listen(port, () => {
    console.log(`Anti-Scammer demo is available at http://localhost:${port}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  createApp,
  errorEnvelope,
  loadEnvironmentFile,
  validatePublicRequest
};
