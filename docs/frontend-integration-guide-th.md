# คู่มือเชื่อมต่อ Frontend กับ Anti-Scammer AI API

คู่มือนี้สรุปการเชื่อมต่อสำหรับทีม Frontend ของเดโม โดยอ้างอิงสัญญา API ปัจจุบัน ไม่จำเป็นต้องทราบรายละเอียดภายในของ n8n

> **สถานะ Endpoint**
>
> ชื่อโฮสต์ API แบบถาวรยังไม่ได้ข้อสรุป เอกสารนี้จึงใช้ <code>{API_BASE_URL}</code> แทนทุกตำแหน่ง ขณะนี้ทีม Backend กำลังประเมินการนำระบบไปติดตั้งบน VM
>
> Frontend ต้องอ่านค่า API base URL จาก environment หรือ runtime configuration เพื่อให้เปลี่ยนปลายทางภายหลังได้โดยไม่แก้ application logic

## 1. ภาพรวม

API รองรับอินพุต 3 ประเภทผ่าน endpoint เดียว:

~~~text
POST {API_BASE_URL}/webhook/api/v1/analyze
~~~

| <code>input_type</code> | ขั้นตอนโดยสรุป |
| --- | --- |
| <code>text</code> | ข้อความ → วิเคราะห์ |
| <code>image</code> | ภาพ Base64 → อ่านข้อความจากภาพ → วิเคราะห์ |
| <code>audio</code> | เสียง Base64 → Speech-to-Text → วิเคราะห์ |

Frontend ไม่ต้องเรียก OCR หรือ Speech-to-Text แยกเอง

## 2. กฎร่วมของ Request

โครงสร้างพื้นฐาน:

~~~json
{
  "input_type": "text | image | audio",
  "content": "...",
  "request_id": "optional client-generated string",
  "language": "th",
  "metadata": {}
}
~~~

| Field | การใช้งาน |
| --- | --- |
| <code>input_type</code> | จำเป็น ต้องเป็น <code>text</code>, <code>image</code> หรือ <code>audio</code> เท่านั้น |
| <code>content</code> | จำเป็น รูปแบบขึ้นอยู่กับ <code>input_type</code> |
| <code>request_id</code> | ไม่บังคับ แต่แนะนำให้สร้างเพื่อใช้ติดตาม request; ต้องเป็น string ที่ไม่ว่างและยาวไม่เกิน 128 ตัวอักษร |
| <code>language</code> | ไม่บังคับ สำหรับเดโมภาษาไทยควรส่ง <code>"th"</code> |
| <code>metadata</code> | ไม่บังคับ ต้องเป็น JSON object และควรมีเฉพาะบริบทที่ไม่อ่อนไหว |

Request ต้องเป็น JSON และส่ง header:

~~~http
Content-Type: application/json
~~~

ห้ามเพิ่ม field ระดับบนที่สัญญา API ไม่รองรับ และอย่าใส่รหัสผ่าน ค่า OTP, API key, access token หรือเลขบัญชีธนาคารเต็มลงใน <code>metadata</code>

แนะนำรูปแบบ <code>request_id</code>:

~~~text
demo-<timestamp>-<random>
~~~

ตัวอย่างฟังก์ชัน:

~~~javascript
function createRequestId(prefix = "demo") {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);

  return prefix + "-" + Date.now() + "-" + randomPart;
}
~~~

<code>request_id</code> ใช้ติดตาม request เท่านั้น ไม่ใช่ authentication token และไม่ควรใช้แทนกลไกป้องกันการส่งซ้ำ

## 3. Text Input

รูปแบบ request:

~~~json
{
  "input_type": "text",
  "content": "ข้อความที่ต้องการตรวจสอบ",
  "request_id": "demo-text-001",
  "language": "th"
}
~~~

<code>content</code> ต้องเป็น string ที่ไม่ว่างหลังตัดช่องว่างหัวท้าย และยาวไม่เกิน 10,000 ตัวอักษร

ตัวอย่าง JavaScript:

~~~javascript
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

const response = await fetch(
  API_BASE_URL + "/webhook/api/v1/analyze",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_type: "text",
      content:
        "เจ้าหน้าที่ธนาคารแจ้งว่าบัญชีถูกระงับ กรุณาส่ง OTP กลับทันที",
      request_id: "demo-text-001",
      language: "th"
    })
  }
);

const result = await response.json();
~~~

อย่า hard-code hostname ของ Backend ไว้ใน source code

## 4. Image Input

MIME type ที่รองรับ:

- <code>image/png</code>
- <code>image/jpeg</code>
- <code>image/webp</code>

ขนาดไฟล์หลังถอดรหัสสูงสุด: **5 MiB (5,242,880 bytes)**

รูปแบบ request:

~~~json
{
  "input_type": "image",
  "content": {
    "mime_type": "image/jpeg",
    "data": "<BASE64_DATA_ONLY>"
  },
  "request_id": "demo-image-001",
  "language": "th"
}
~~~

Frontend ต้องแปลงไฟล์เป็น Base64 และส่งเฉพาะข้อมูลหลังเครื่องหมายจุลภาค ห้ามส่ง Data URI prefix

ผิด:

~~~text
data:image/jpeg;base64,/9j/4AAQ...
~~~

ถูก:

~~~text
/9j/4AAQ...
~~~

ฟังก์ชันช่วยแปลงไฟล์:

~~~javascript
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result);
      const base64 = result.split(",")[1];
      resolve(base64);
    };

    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
~~~

ตัวอย่างส่งภาพจาก <code>File</code> ที่ผู้ใช้เลือก:

~~~javascript
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp"
]);

async function analyzeImage(file) {
  if (!IMAGE_TYPES.has(file.type)) {
    throw new Error("ชนิดไฟล์ภาพไม่รองรับ");
  }

  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error("ไฟล์ภาพมีขนาดเกิน 5 MiB");
  }

  const base64 = await fileToBase64(file);

  const response = await fetch(
    API_BASE_URL + "/webhook/api/v1/analyze",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input_type: "image",
        content: {
          mime_type: file.type,
          data: base64
        },
        request_id: createRequestId("demo-image"),
        language: "th"
      })
    }
  );

  return { response, result: await response.json() };
}
~~~

ควรตรวจ MIME type และ <code>file.size &lt;= 5 MiB</code> ก่อนส่งเพื่อ UX ที่ดี แต่ Backend ยังคงเป็นผู้ตรวจสอบที่มีผลจริง รวมถึงตรวจ signature ของไฟล์

## 5. Audio Input

MIME type ที่รองรับ:

- <code>audio/mpeg</code>
- <code>audio/wav</code>
- <code>audio/webm</code>
- <code>audio/mp4</code>

ขนาดไฟล์หลังถอดรหัสสูงสุด: **5 MiB (5,242,880 bytes)**

รูปแบบ request:

~~~json
{
  "input_type": "audio",
  "content": {
    "mime_type": "audio/mpeg",
    "data": "<BASE64_DATA_ONLY>"
  },
  "request_id": "demo-audio-001",
  "language": "th"
}
~~~

Frontend อัปโหลดไฟล์เสียงเท่านั้น Backend จะถอดเสียงและนำ transcript ไปวิเคราะห์ให้อัตโนมัติ ใช้ฟังก์ชัน <code>fileToBase64()</code> เดียวกับภาพได้

~~~javascript
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/mp4"
]);

async function analyzeAudio(file) {
  if (!AUDIO_TYPES.has(file.type)) {
    throw new Error("ชนิดไฟล์เสียงไม่รองรับ");
  }

  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error("ไฟล์เสียงมีขนาดเกิน 5 MiB");
  }

  const base64 = await fileToBase64(file);

  const response = await fetch(
    API_BASE_URL + "/webhook/api/v1/analyze",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input_type: "audio",
        content: {
          mime_type: file.type,
          data: base64
        },
        request_id: createRequestId("demo-audio"),
        language: "th"
      })
    }
  );

  return { response, result: await response.json() };
}
~~~

อย่าถอดเสียงใน Frontend อย่าส่ง transcript ที่ Client สร้างแทนไฟล์เสียง และอย่าเติม prefix รูปแบบ <code>data:audio/...;base64,</code>

## 6. Success Response

เมื่อสำเร็จจะได้ HTTP 200 และ response รูปแบบปัจจุบันดังนี้:

~~~json
{
  "api_version": "v1",
  "taxonomy_version": "1.1.0",
  "scoring_version": "1.1.0",
  "analysis_id": "ana_xxx",
  "timestamp": "2026-08-17T08:54:08.795Z",
  "risk_score": 92,
  "risk_level": "critical",
  "summary": "ข้อความแอบอ้างเป็นธนาคารและเร่งให้ส่งรหัส OTP",
  "scam_categories": [
    "bank_impersonation",
    "account_takeover"
  ],
  "indicators": [
    {
      "code": "BANK_IMPERSONATION",
      "title": "มีการแอบอ้างเป็นธนาคาร",
      "severity": "high",
      "evidence": "จากธนาคารกรุงไทย",
      "explanation": "ข้อความอ้างตัวเป็นธนาคารเพื่อให้ผู้รับเชื่อถือ"
    }
  ],
  "recommended_actions": [
    "อย่าส่งรหัส OTP และติดต่อธนาคารผ่านช่องทางทางการ"
  ],
  "confidence": 0.95,
  "needs_human_review": false,
  "processing_time_ms": 27622
}
~~~

| Field | Frontend ควรใช้ |
| --- | --- |
| <code>api_version</code> | รุ่นของ public API |
| <code>taxonomy_version</code> | รุ่นชุดหมวดหมู่และ indicator |
| <code>scoring_version</code> | รุ่นกติกาคะแนนแบบ deterministic |
| <code>analysis_id</code> | รหัสผลวิเคราะห์ที่ Backend สร้าง |
| <code>timestamp</code> | เวลาที่วิเคราะห์เสร็จในรูปแบบ ISO 8601 UTC |
| <code>risk_score</code> | คะแนนความเสี่ยงจำนวนเต็ม 0–100 |
| <code>risk_level</code> | ระดับ <code>low</code>, <code>medium</code>, <code>high</code> หรือ <code>critical</code> |
| <code>summary</code> | สรุปผลแบบภาษาคน |
| <code>scam_categories</code> | หมวดรูปแบบกลโกง อาจมีหลายค่า; ค่าแรกเป็นหมวดหลัก |
| <code>indicators</code> | เหตุผล/หลักฐานที่ผ่านการตรวจสอบ อาจเป็น array ว่าง |
| <code>recommended_actions</code> | คำแนะนำที่ควรแสดงแก่ผู้ใช้ อาจเป็น array ว่าง |
| <code>confidence</code> | ความมั่นใจของการวิเคราะห์ 0.0–1.0 ไม่ใช่การรับประกันว่าผลถูกต้อง |
| <code>needs_human_review</code> | บอกว่าผลมีเงื่อนไขที่ควรตรวจทานเพิ่มเติม ไม่ได้ยืนยันว่าจะมีเจ้าหน้าที่ตรวจจริง |
| <code>processing_time_ms</code> | เวลาประมวลผลฝั่ง Backend หน่วยมิลลิวินาที ไม่รวมเวลาเครือข่ายฝั่ง Client |

ระดับคะแนนปัจจุบัน:

| ช่วงคะแนน | <code>risk_level</code> |
| --- | --- |
| 0–29 | <code>low</code> |
| 30–59 | <code>medium</code> |
| 60–79 | <code>high</code> |
| 80–100 | <code>critical</code> |

Frontend ควรใช้ <code>risk_level</code> ที่ Backend ส่งกลับมา ไม่คำนวณระดับใหม่เอง เพราะกติกาอาจเปลี่ยนตาม <code>scoring_version</code>

## 7. คำแนะนำการแสดงผล UI

หน้า/การ์ดผลลัพธ์ควรแบ่งอย่างน้อยเป็น:

1. **Risk** — แสดง <code>risk_score</code> และ <code>risk_level</code> ให้เด่น
2. **Summary** — แสดง <code>summary</code>
3. **Reasons** — วนแสดงทุก item ใน <code>indicators</code> ได้แก่:
   - <code>title</code>
   - <code>severity</code>
   - <code>evidence</code>
   - <code>explanation</code>
4. **Recommended actions** — แสดงรายการ <code>recommended_actions</code>
5. **ข้อมูลเสริม (ไม่บังคับ)** — แสดง <code>confidence</code> และคำเตือนที่เหมาะสมเมื่อ <code>needs_human_review</code> เป็น <code>true</code>

ควรรองรับกรณี <code>indicators</code> หรือ <code>recommended_actions</code> เป็น array ว่าง และต้องแสดงข้อความจาก API ด้วย text-safe DOM API เช่น <code>textContent</code> ไม่ใช่ HTML ที่ประกอบจาก string โดยตรง

Frontend ไม่ควรสร้างหมวดกลโกงจากเนื้อหาเอง และไม่ควรทำสำเนากติกาคะแนนของ Backend ให้ใช้ response ที่ได้รับเป็นผลวิเคราะห์

## 8. Error Handling

| HTTP | ความหมายสำหรับ Frontend |
| --- | --- |
| <code>200</code> | วิเคราะห์สำเร็จ |
| <code>400</code> | Request ไม่ถูกต้อง, ชนิดข้อมูลไม่รองรับ หรือ media/Base64 ไม่ผ่านการตรวจสอบ |
| <code>413</code> | ข้อมูลหรือไฟล์ใหญ่เกินกำหนด |
| <code>422</code> | รับข้อมูลได้ แต่ไม่สามารถอ่านข้อความ/เสียงที่ใช้ได้ หรือผลวิเคราะห์ภายในไม่ผ่านสัญญา |
| <code>500</code> | เกิดข้อผิดพลาดภายใน |
| <code>503</code> | Backend, provider หรือบริการ intelligence ไม่พร้อมใช้งานชั่วคราว |

Error response ใช้โครงสร้างหลัก:

~~~json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid fields.",
    "details": []
  },
  "request_id": "demo-text-001",
  "timestamp": "2026-08-17T08:54:08.795Z"
}
~~~

<code>error.details</code> อาจไม่มีในบาง error ดังนั้น Frontend ต้องรองรับทั้งกรณีมีและไม่มี field นี้

Error code ที่ควรรู้:

| Code | กรณีโดยย่อ |
| --- | --- |
| <code>VALIDATION_ERROR</code> | Request, Base64, MIME type หรือ signature ไม่ถูกต้อง |
| <code>CONTENT_TOO_LARGE</code> | ข้อมูลเกินข้อจำกัด |
| <code>IMAGE_TEXT_EXTRACTION_FAILED</code> | ไม่พบข้อความที่ใช้วิเคราะห์ได้จากภาพ |
| <code>IMAGE_PREPROCESSOR_UNAVAILABLE</code> | บริการอ่านข้อความจากภาพไม่พร้อม |
| <code>AUDIO_TEXT_EXTRACTION_FAILED</code> | ไม่พบเสียงพูดที่ถอดเป็นข้อความใช้งานได้ |
| <code>AUDIO_TRANSCRIPTION_UNAVAILABLE</code> | บริการถอดเสียงไม่พร้อม |
| <code>ANALYSIS_SERVICE_UNAVAILABLE</code> | บริการวิเคราะห์ไม่พร้อม |
| <code>INTELLIGENCE_LOOKUP_UNAVAILABLE</code> | บริการตรวจสอบข้อมูล intelligence ไม่พร้อม |

ตัวอย่างจัดการ response:

~~~javascript
const errorLabels = {
  400: "ข้อมูลที่ส่งไม่ถูกต้อง",
  413: "ไฟล์หรือข้อมูลมีขนาดใหญ่เกินกำหนด",
  422: "ไม่สามารถประมวลผลเนื้อหานี้ได้",
  500: "เกิดข้อผิดพลาดภายในระบบ",
  503: "ระบบวิเคราะห์ไม่พร้อมใช้งานชั่วคราว"
};

const response = await fetch(
  API_BASE_URL + "/webhook/api/v1/analyze",
  fetchOptions
);
const body = await response.json();

if (!response.ok) {
  const safeTitle =
    errorLabels[response.status] ?? "ไม่สามารถวิเคราะห์ได้";
  const safeMessage =
    typeof body?.error?.message === "string"
      ? body.error.message
      : "กรุณาลองใหม่ภายหลัง";

  showError({
    title: safeTitle,
    code: body?.error?.code,
    message: safeMessage
  });
}
~~~

Frontend ควรใช้ HTTP status, <code>error.code</code> และ <code>error.message</code> เป็นหลัก ไม่ควรผูก UI กับข้อความภายในทุกรูปแบบ และต้องไม่แสดง raw object, stack trace หรือข้อมูล debug แก่ผู้ใช้

## 9. Loading และ Timeout UX

ภาพและเสียงอาจใช้เวลานานกว่าข้อความ โดยเฉพาะ audio pipeline ซึ่งอาจใช้เวลาหลายสิบวินาทีตาม provider และเครือข่าย

แนะนำให้:

- แสดงสถานะ “กำลังวิเคราะห์...”
- ปิดปุ่ม Submit ระหว่าง request เพื่อป้องกันการส่งซ้ำ
- อย่าถือว่า request ล้มเหลวเพียงเพราะผ่านไปไม่กี่วินาที
- สำหรับเดโม ใช้ client timeout ประมาณ 60 วินาทีเป็นจุดเริ่มต้น เว้นแต่ทีมกำหนดนโยบายอื่นจากผลทดสอบจริง
- เมื่อ timeout ให้ยกเลิกการรอด้วย <code>AbortController</code> และแสดงข้อความที่ปลอดภัย

ไม่ควร retry อัตโนมัติเป็นค่าเริ่มต้น เพราะอาจสร้างการเรียก AI ราคาแพงซ้ำซ้อน ผู้ใช้ควรเป็นผู้กดลองอีกครั้ง

## 10. Security และ Privacy ฝั่ง Frontend

- ห้ามใส่ Gemini key, API/provider credential หรือ n8n credential ใน Frontend
- Frontend เรียกเฉพาะ Anti-Scammer API
- อย่า log Base64 ของภาพ/เสียงลง browser console ในเดโมหรือ production build
- หลีกเลี่ยงการเก็บข้อความ ภาพ เสียง หรือ Base64 ที่ผู้ใช้ส่งไว้ใน <code>localStorage</code>
- อย่าใส่เนื้อหาอ่อนไหวใน URL หรือ query string
- ใช้ HTTPS เสมอเมื่อเชื่อมต่อ API ที่ deploy ภายนอก
- อย่าส่ง field เพื่อเลือก provider, model, route, backend, OCR หรือ Speech-to-Text
- แสดง string จาก API ผ่าน <code>textContent</code> หรือกลไก escaping ของ framework
- อย่า log request body ที่มีข้อมูลผู้ใช้โดยไม่จำเป็น

<code>API_BASE_URL</code> ต้องมาจาก environment/runtime configuration ค่า URL ไม่จำเป็นต้องเป็น secret แต่ credential ทั้งหมดต้องอยู่ฝั่ง Backend เท่านั้น

## 11. Frontend Environment Config

ตัวอย่าง Vite:

ไฟล์ <code>.env</code>:

~~~dotenv
VITE_API_BASE_URL={API_BASE_URL}
~~~

JavaScript:

~~~javascript
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE_URL) {
  throw new Error("VITE_API_BASE_URL is not configured");
}
~~~

สำหรับ React/Next.js หรือ framework อื่น ให้ใช้ระบบ environment/runtime configuration ของ framework นั้น โดยเลือกชื่อ variable ที่เปิดเผยต่อ browser ตามกลไกของ framework เท่าที่จำเป็น

อย่า commit secret ลง repository แม้ <code>API_BASE_URL</code> เองจะไม่จำเป็นต้องเป็น secret

## 12. หมายเหตุเรื่อง CORS

หากเรียกด้วย curl/Postman สำเร็จ แต่ <code>fetch</code> ใน browser แจ้ง CORS error ให้ส่งข้อมูลต่อไปนี้แก่ทีม Backend:

- frontend origin
- API endpoint ที่เรียก
- error จาก browser console

นโยบาย CORS อาจต้องปรับตามโดเมนหรือสถาปัตยกรรม VM สุดท้าย ห้ามแก้ปัญหาด้วยการปิด browser security หรือใช้ <code>--disable-web-security</code>

## 13. Demo Checklist

- [ ] ตั้งค่า <code>API_BASE_URL</code> แล้ว
- [ ] ทดสอบ request แบบ text
- [ ] ทดสอบ request แบบ image
- [ ] ทดสอบ request แบบ audio
- [ ] Loading state และการป้องกัน submit ซ้ำทำงาน
- [ ] รองรับ error 400, 413, 422, 500 และ 503
- [ ] ตัด Data URI prefix ออกจาก Base64 แล้ว
- [ ] ตรวจ MIME type และขนาดไฟล์ก่อนส่ง
- [ ] แสดง indicators และ recommended actions ได้
- [ ] ไม่ hard-code API hostname
- [ ] ไม่มี provider/API credential ใน Frontend
- [ ] ทดสอบ CORS จาก origin ที่ใช้เดโมจริง

## 14. สถานะ Endpoint

ชื่อโฮสต์ API แบบถาวรยังไม่ได้ข้อสรุป เอกสารนี้ใช้:

~~~text
{API_BASE_URL}
~~~

ทีม Backend กำลังประเมินการ deploy ไปยัง VM ดังนั้น Frontend ต้องเก็บ base URL เป็นค่าที่ปรับได้ เพื่อเปลี่ยน endpoint ภายหลังโดยไม่แก้ logic ของแอป

Endpoint สำหรับการวิเคราะห์:

~~~text
POST {API_BASE_URL}/webhook/api/v1/analyze
~~~

## 15. สิ่งที่ Frontend ไม่ต้องทำ

Backend รับผิดชอบงานต่อไปนี้อยู่แล้ว:

- OCR / อ่านข้อความจากภาพ
- Speech-to-Text
- การคำนวณคะแนนความเสี่ยงและระดับความเสี่ยง
- semantic matching
- entity intelligence lookup
- การเลือก Gemini, model หรือ provider

Frontend มีหน้าที่ตรวจรูปแบบเบื้องต้น ส่ง request ตามสัญญา แสดงสถานะระหว่างรอ และนำผลหรือ error ที่ปลอดภัยจาก Backend มาแสดงเท่านั้น
