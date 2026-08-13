'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDirectory = path.join(__dirname, '..', 'public');
const appSource = fs.readFileSync(path.join(publicDirectory, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');

test('frontend text request uses the public API shape and local proxy endpoint', () => {
  assert.match(appSource, /input_type:\s*'text'/);
  assert.match(appSource, /metadata:\s*\{ source: 'web-demo' \}/);
  assert.match(appSource, /fetch\('\/api\/analyze'/);
  assert.doesNotMatch(appSource, /localhost:5678|\/webhook\/api\/v1\/analyze|generativelanguage/i);
});

test('frontend image request removes the data URI prefix', () => {
  assert.match(appSource, /readAsDataURL\(file\)/);
  assert.match(appSource, /const base64 = dataUrl\.slice\(separator \+ 1\)/);
  assert.match(appSource, /content:\s*\{ mime_type: selectedImage\.type, data: base64 \}/);
});

test('unsupported image MIME types are rejected before submission', () => {
  assert.match(appSource, /new Set\(\['image\/png', 'image\/jpeg', 'image\/webp'\]\)/);
  assert.match(appSource, /!ACCEPTED_IMAGE_TYPES\.has\(file\.type\)/);
  assert.match(htmlSource, /accept="\.png,\.jpg,\.jpeg,\.webp,image\/png,image\/jpeg,image\/webp"/);
});

test('images over 5 MiB are rejected in the browser', () => {
  assert.match(appSource, /const MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(appSource, /file\.size > MAX_IMAGE_BYTES/);
  assert.match(appSource, /ไฟล์มีขนาดใหญ่เกิน 5 MiB/);
});

test('documented API failures map to safe Thai messages', () => {
  assert.match(appSource, /ข้อมูลที่ส่งไม่ถูกต้อง/);
  assert.match(appSource, /ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด/);
  assert.match(appSource, /ไม่สามารถอ่านข้อความจากภาพได้/);
  assert.match(appSource, /ระบบวิเคราะห์ไม่พร้อมใช้งานชั่วคราว/);
  assert.match(appSource, /เกิดข้อผิดพลาดภายในระบบ/);
});

test('API strings use safe DOM text rendering and browser source contains no secrets', () => {
  assert.match(appSource, /\.textContent\s*=/);
  assert.match(appSource, /replaceChildren\(\)/);
  assert.doesNotMatch(appSource, /\.innerHTML\s*=|\beval\s*\(|new Function\s*\(/);
  assert.doesNotMatch(`${appSource}\n${htmlSource}`, /x-goog-api-key|AIza[0-9A-Za-z_-]{20,}|authorization:\s*bearer/i);
});
