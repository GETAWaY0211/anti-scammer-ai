'use strict';

const MAX_ENTITIES_PER_TYPE = 10;
const MAX_ENTITIES_TOTAL = 20;
const SUPPORTED_ENTITY_TYPES = new Set(['phone', 'bank_account', 'domain']);

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\s().-]/g, '');
  let normalized;
  if (compact.startsWith('+66')) normalized = `0${compact.slice(3)}`;
  else if (compact.startsWith('0066')) normalized = `0${compact.slice(4)}`;
  else normalized = compact;
  return /^0[689]\d{8}$/.test(normalized) ? normalized : null;
}

function normalizeBankAccount(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\s-]/g, '');
  return /^\d{10,15}$/.test(normalized) ? normalized : null;
}

function isIpAddress(hostname) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(':');
}

function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim().replace(/[),;!?\]}>'"]+$/g, '');
  if (!candidate) return null;
  let hostname;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      hostname = parsed.hostname;
    } else {
      hostname = candidate.split(/[/?#]/, 1)[0].split('@').pop().split(':', 1)[0];
    }
  } catch {
    return null;
  }
  hostname = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || isIpAddress(hostname)) return null;
  if (hostname.length > 253 || !hostname.includes('.')) return null;
  const labels = hostname.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z]{2,63}$/.test(labels.at(-1)) && !/^xn--[a-z0-9-]{2,59}$/.test(labels.at(-1))) return null;
  return hostname;
}

function addCandidate(candidates, entityType, normalizedValue, position) {
  if (!SUPPORTED_ENTITY_TYPES.has(entityType) || !normalizedValue) return;
  const key = `${entityType}:${normalizedValue}`;
  const existing = candidates.get(key);
  if (!existing || position < existing.position) {
    candidates.set(key, { entity_type: entityType, normalized_value: normalizedValue, position });
  }
}

function extractEntities(content, trustedDomainCandidates = []) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const candidates = new Map();
  const phoneValues = new Set();
  const phoneRanges = [];

  if (Array.isArray(trustedDomainCandidates)) {
    trustedDomainCandidates.slice(0, MAX_ENTITIES_PER_TYPE).forEach((value, index) => {
      const normalized = normalizeDomain(value);
      if (normalized) addCandidate(candidates, 'domain', normalized, -1000 + index);
    });
  }

  const phonePattern = /(?<!\d)(?:\+66|0066|0)(?:[\s().-]*\d){8,10}(?!\d)/g;
  for (const match of content.matchAll(phonePattern)) {
    const normalized = normalizePhone(match[0]);
    if (!normalized) continue;
    phoneValues.add(normalized);
    phoneRanges.push([match.index, match.index + match[0].length]);
    addCandidate(candidates, 'phone', normalized, match.index);
  }

  const bankPattern = /(?<!\d)(?:\d[\s-]*){10,15}(?!\d)/g;
  for (const match of content.matchAll(bankPattern)) {
    const overlapsPhone = phoneRanges.some(([start, end]) => (
      match.index < end && match.index + match[0].length > start
    ));
    if (overlapsPhone) continue;
    const normalized = normalizeBankAccount(match[0]);
    if (!normalized || phoneValues.has(normalized)) continue;
    const start = Math.max(0, match.index - 60);
    const end = Math.min(content.length, match.index + match[0].length + 60);
    const nearby = content.slice(start, end);
    const hasBankContext = /(เลข(?:ที่)?บัญชี|บัญชี(?:ธนาคาร)?|bank\s*account|account\s*(?:number|no\.?))/i.test(nearby);
    const visiblyGrouped = /[\s-]/.test(match[0].trim());
    if (!hasBankContext && !visiblyGrouped) continue;
    addCandidate(candidates, 'bank_account', normalized, match.index);
  }

  const schemePattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi;
  const masked = [...content];
  for (const match of content.matchAll(schemePattern)) {
    const normalized = normalizeDomain(match[0]);
    if (normalized) addCandidate(candidates, 'domain', normalized, match.index);
    for (let index = match.index; index < match.index + match[0].length; index += 1) masked[index] = ' ';
  }

  const plainText = masked.join('');
  const plainDomainPattern = /(?<![@\w-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?![\w-])/gi;
  for (const match of plainText.matchAll(plainDomainPattern)) {
    const normalized = normalizeDomain(match[0]);
    if (normalized) addCandidate(candidates, 'domain', normalized, match.index);
  }

  const typeCounts = new Map();
  const output = [];
  const ordered = [...candidates.values()].sort((left, right) => (
    left.position - right.position || left.entity_type.localeCompare(right.entity_type)
  ));
  for (const entity of ordered) {
    if (output.length >= MAX_ENTITIES_TOTAL) break;
    const count = typeCounts.get(entity.entity_type) || 0;
    if (count >= MAX_ENTITIES_PER_TYPE) continue;
    typeCounts.set(entity.entity_type, count + 1);
    output.push({ entity_type: entity.entity_type, normalized_value: entity.normalized_value });
  }
  return output;
}

function redactEntity(entityType, normalizedValue) {
  if (entityType === 'domain') return normalizedValue;
  if (entityType === 'phone') {
    return normalizedValue.length >= 7
      ? `${normalizedValue.slice(0, 3)}***${normalizedValue.slice(-4)}`
      : '[REDACTED_PHONE]';
  }
  if (entityType === 'bank_account') {
    return normalizedValue.length >= 4
      ? `${'*'.repeat(Math.max(6, normalizedValue.length - 4))}${normalizedValue.slice(-4)}`
      : '[REDACTED_ACCOUNT]';
  }
  return '[REDACTED]';
}

module.exports = {
  MAX_ENTITIES_PER_TYPE,
  MAX_ENTITIES_TOTAL,
  extractEntities,
  normalizeBankAccount,
  normalizeDomain,
  normalizePhone,
  redactEntity
};
