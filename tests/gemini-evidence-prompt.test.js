'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const prompt = fs.readFileSync(path.join(root, 'prompts', 'text-analysis-system.md'), 'utf8');
const provider = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'provider-gemini-v1.json'), 'utf8'));
const main = JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', 'text-analysis-main-v2.json'), 'utf8'));

function node(workflow, name) {
  const found = workflow.nodes.find((entry) => entry.name === name);
  assert.ok(found, 'Missing node: ' + name);
  return found;
}

function buildGeminiRequest(content) {
  const source = node(provider, 'Build Gemini Request').parameters.jsCode;
  const $input = {
    first: () => ({
      json: {
        ok: true,
        context: {
          request_id: 'evidence-prompt-test',
          analysis_id: 'analysis-evidence-prompt-test',
          content,
          requested_output_language: 'th',
          metadata: {}
        }
      }
    })
  };
  return new Function('$input', source)($input)[0].json;
}

test('source prompt requires one exact contiguous character-for-character evidence substring', () => {
  for (const required of [
    'For every emitted indicator, `indicator.evidence` MUST be one exact contiguous substring copied character-for-character from `context.content`',
    'context.content.includes(indicator.evidence) === true',
    'Never paraphrase evidence.',
    'Never combine multiple spans.',
    'Never add or remove words.',
    'Never change punctuation or whitespace.',
    'Never translate evidence or correct its spelling.',
    'If one exact contiguous substring cannot support the indicator, omit the indicator.'
  ]) assert.ok(prompt.includes(required), required);
  assert.match(prompt, /text input, image-extracted text, or audio-transcribed text/);
});

test('source prompt contains the required valid and invalid urgency examples', () => {
  const canonical = 'สวัสดีค่ะ จากธนาคารกรุงไทย ตอนนี้บัญชีของคุณถูกระงับ โปรดส่งรหัส OTP ที่ได้รับบน SMS กลับทันที เพื่อยืนยันตัวตนของคุณค่ะ';
  const valid = 'โปรดส่งรหัส OTP ที่ได้รับบน SMS กลับทันที';
  const invalid = 'ตอนนี้บัญชีของคุณถูกระงับ... กลับทันที';
  assert.equal(canonical.includes(valid), true);
  assert.equal(canonical.includes(invalid), false);
  assert.ok(prompt.includes(valid));
  assert.ok(prompt.includes(invalid));
  assert.match(prompt, /invalid example combines non-contiguous spans and must never be produced/i);
});

test('Provider Gemini V1 sends the strict evidence instruction from Build Gemini Request', () => {
  const result = buildGeminiRequest('ข้อความทดสอบ');
  const instruction = result.gemini_request.system_instruction.parts[0].text;
  assert.match(instruction, /one exact contiguous substring copied character-for-character from context\.content/);
  assert.match(instruction, /context\.content\.includes\(indicator\.evidence\) === true/);
  assert.match(instruction, /Never combine multiple spans\./);
  assert.match(instruction, /Never insert "\.\.\."/);
  assert.match(instruction, /text input, image-extracted text, or audio-transcribed text/);
  assert.match(instruction, /ตอนนี้บัญชีของคุณถูกระงับ\.\.\. กลับทันที/);
});

test('privacy instruction selects a safe exact span instead of inserting a replacement marker', () => {
  const sectionStart = prompt.indexOf('## 6. Evidence-grounding rules');
  const sectionEnd = prompt.indexOf('## 7.', sectionStart);
  const section = prompt.slice(sectionStart, sectionEnd);
  assert.match(section, /Select a safe exact contiguous substring that excludes the sensitive value/);
  assert.match(section, /Do not insert a replacement marker/);
  assert.doesNotMatch(section, /replace a discovered secret value with/);
});

test('Validate LLM Output retains exact original-or-redacted substring grounding', () => {
  const source = node(main, 'Validate LLM Output').parameters.jsCode;
  assert.match(source, /originalContent\.includes\(indicator\.evidence\)/);
  assert.match(source, /redactedContent\.includes\(indicator\.evidence\)/);
  assert.doesNotMatch(source, /similarity|fuzzy|levenshtein/i);
});
