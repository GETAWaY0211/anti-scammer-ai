BEGIN;

-- Serialize this development seed so concurrent reruns cannot race between
-- the example existence check and insert.
SELECT pg_advisory_xact_lock(hashtextextended('demo_scam_patterns_seed_v1', 0));

-- Synthetic, curated development intelligence only. These rows are not derived
-- from user requests, real victims, or runtime analysis data.
INSERT INTO scam_patterns (
    pattern_code,
    name,
    scam_category,
    description,
    status,
    confidence_score,
    source,
    verified_at,
    is_active
)
VALUES
    ('BANK_OTP_IMPERSONATION', 'Bank OTP impersonation', 'bank_impersonation', 'Impersonation of a bank or its security staff to obtain a one-time verification code.', 'verified', 0.98, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('PRIZE_FEE', 'Prize fee request', 'prize_lottery_scam', 'An unsolicited prize or reward is conditioned on paying a fee, tax, or delivery cost.', 'verified', 0.96, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('FAKE_JOB_RECHARGE', 'Fake job recharge', 'job_scam', 'A supposed online job requires deposits or account recharges before earnings can be withdrawn.', 'verified', 0.97, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('INVESTMENT_GUARANTEED_RETURN', 'Guaranteed investment return', 'investment_scam', 'An investment solicitation promises guaranteed or impossible returns and requests funds.', 'verified', 0.97, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('PARCEL_FEE', 'Parcel delivery fee', 'parcel_delivery_scam', 'A delivery notice demands a fee or payment before a supposed parcel can be released.', 'verified', 0.95, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('REMOTE_SUPPORT', 'Remote support access', 'tech_support_scam', 'Fake technical support pressures a person to install remote-control software or share device access.', 'verified', 0.97, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('GOVERNMENT_THREAT', 'Government authority threat', 'government_impersonation', 'A false authority claim uses arrest, legal, or account-freeze threats to demand immediate action.', 'verified', 0.97, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE),
    ('ROMANCE_EMERGENCY', 'Romance emergency request', 'romance_scam', 'An online romantic relationship is used to request urgent financial help for a fabricated emergency.', 'verified', 0.95, 'development_curated_seed', TIMESTAMPTZ '2026-08-14 00:00:00+00', TRUE)
ON CONFLICT (pattern_code) DO UPDATE
SET
    name = EXCLUDED.name,
    scam_category = EXCLUDED.scam_category,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    confidence_score = EXCLUDED.confidence_score,
    source = EXCLUDED.source,
    verified_at = EXCLUDED.verified_at,
    is_active = EXCLUDED.is_active;

CREATE TEMP TABLE demo_scam_pattern_example_seed (
    pattern_code TEXT NOT NULL,
    example_text TEXT NOT NULL,
    language TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO demo_scam_pattern_example_seed (pattern_code, example_text, language)
VALUES
    ('BANK_OTP_IMPERSONATION', 'ธนาคารตัวอย่างแจ้งว่าบัญชีจะถูกระงับ ให้ส่งรหัสโอทีพีกลับทันทีเพื่อยืนยันตัวตน', 'th'),
    ('BANK_OTP_IMPERSONATION', 'มีผู้โทรอ้างว่าเป็นฝ่ายความปลอดภัยของธนาคาร ขอให้บอกรหัสยืนยันที่เพิ่งส่งมา มิฉะนั้นเงินอาจสูญหาย', 'th'),
    ('BANK_OTP_IMPERSONATION', 'เพื่อยกเลิกรายการที่คุณไม่ได้ทำ โปรดอ่านข้อความรหัสจากโทรศัพท์ให้เจ้าหน้าที่ฟังเดี๋ยวนี้', 'th'),
    ('BANK_OTP_IMPERSONATION', 'บัญชีของคุณพบความผิดปกติ กรุณาส่งรหัสใช้ครั้งเดียวในแชตเพื่อปลดล็อกบัญชี', 'th'),

    ('PRIZE_FEE', 'คุณได้รับรางวัลพิเศษจากกิจกรรมสุ่ม กรุณาชำระค่าธรรมเนียมก่อนหมดเวลารับสิทธิ์', 'th'),
    ('PRIZE_FEE', 'ของรางวัลกำลังรอจัดส่ง แต่ผู้รับต้องโอนค่าดำเนินการล่วงหน้าจึงจะส่งได้', 'th'),
    ('PRIZE_FEE', 'ยินดีด้วย คุณเป็นผู้โชคดี โปรดจ่ายภาษีรางวัลก่อนแล้วทีมงานจะดำเนินการให้', 'th'),
    ('PRIZE_FEE', 'ระบบเลือกชื่อคุณให้รับของฟรี ยืนยันสิทธิ์วันนี้ด้วยการชำระค่าจัดส่ง', 'th'),

    ('FAKE_JOB_RECHARGE', 'งานกดถูกใจทำจากบ้านได้ แต่ต้องเติมเงินสำรองเพื่อปลดล็อกค่าจ้างของภารกิจแรก', 'th'),
    ('FAKE_JOB_RECHARGE', 'ยอดงานออนไลน์ของคุณติดลบ กรุณาเติมเครดิตเข้าระบบก่อนจึงจะถอนรายได้ได้', 'th'),
    ('FAKE_JOB_RECHARGE', 'บริษัทตัวอย่างรับพนักงานแพ็กสินค้า ผู้สมัครต้องชำระค่าอุปกรณ์ก่อนเริ่มงาน', 'th'),
    ('FAKE_JOB_RECHARGE', 'ทำภารกิจครบแล้ว เหลือเพียงโอนเงินเพิ่มเพื่อเปิดรอบสุดท้ายและรับคอมมิชชั่นทั้งหมด', 'th'),

    ('INVESTMENT_GUARANTEED_RETURN', 'ลงทุนกับโครงการนี้รับประกันกำไรทุกเดือน ไม่มีโอกาสขาดทุน เพียงโอนเงินเพื่อเริ่มพอร์ต', 'th'),
    ('INVESTMENT_GUARANTEED_RETURN', 'ฝากเงินวันนี้แล้วรับผลตอบแทนแน่นอน ผู้ดูแลยืนยันว่าถอนทุนคืนได้ทุกเวลา', 'th'),
    ('INVESTMENT_GUARANTEED_RETURN', 'ผู้เชี่ยวชาญจะเทรดแทนและการันตีคืนทุนพร้อมกำไร ขอให้ส่งเงินเข้ากองทุนก่อนปิดรอบ', 'th'),
    ('INVESTMENT_GUARANTEED_RETURN', 'โอกาสลงทุนลับมีจำนวนจำกัด กำไรสูงแน่นอนและไม่มีความเสี่ยง ต้องตัดสินใจทันที', 'th'),

    ('PARCEL_FEE', 'พัสดุของคุณค้างที่ศูนย์คัดแยก กรุณาจ่ายค่าปลดปล่อยเพื่อให้จัดส่งต่อวันนี้', 'th'),
    ('PARCEL_FEE', 'บริษัทขนส่งตัวอย่างแจ้งว่าที่อยู่ไม่สมบูรณ์ ต้องชำระค่าจัดส่งใหม่ก่อนแก้ไขข้อมูล', 'th'),
    ('PARCEL_FEE', 'มีของส่งถึงคุณแต่ยังไม่ได้ชำระค่าธรรมเนียม ผู้รับต้องโอนก่อนเจ้าหน้าที่จึงนำจ่ายได้', 'th'),
    ('PARCEL_FEE', 'หากไม่ยืนยันค่าฝากเก็บภายในวันนี้ พัสดุจะถูกส่งคืน กรุณาดำเนินการชำระทันที', 'th'),

    ('REMOTE_SUPPORT', 'เครื่องของคุณติดไวรัส ให้ติดตั้งโปรแกรมควบคุมระยะไกลแล้วแจ้งรหัสเชื่อมต่อแก่เจ้าหน้าที่', 'th'),
    ('REMOTE_SUPPORT', 'ฝ่ายสนับสนุนขอแชร์หน้าจอเพื่อตรวจสอบบัญชี กรุณาอนุญาตการควบคุมอุปกรณ์เดี๋ยวนี้', 'th'),
    ('REMOTE_SUPPORT', 'เพื่อรับเงินคืน คุณต้องดาวน์โหลดแอปช่วยเหลือและเปิดสิทธิ์ให้ผู้ดูแลเข้าถึงโทรศัพท์', 'th'),
    ('REMOTE_SUPPORT', 'ระบบความปลอดภัยขัดข้อง โปรดปิดการป้องกันชั่วคราวแล้วให้ช่างเชื่อมต่อเข้ามาแก้ไข', 'th'),

    ('GOVERNMENT_THREAT', 'เจ้าหน้าที่หน่วยงานรัฐแจ้งว่าคุณเกี่ยวข้องกับคดี หากไม่ให้ข้อมูลทันทีจะออกหมายจับ', 'th'),
    ('GOVERNMENT_THREAT', 'บัญชีของคุณกำลังถูกตรวจสอบตามคำสั่งทางกฎหมาย ต้องโอนเงินไปพักไว้เพื่อพิสูจน์ความบริสุทธิ์', 'th'),
    ('GOVERNMENT_THREAT', 'ศูนย์ราชการตัวอย่างอ้างว่ามีหนี้ค้างและจะอายัดทรัพย์ ให้ชำระด่วนเพื่อยุติเรื่อง', 'th'),
    ('GOVERNMENT_THREAT', 'มีหนังสือเรียกที่ยังไม่ได้รับ เจ้าหน้าที่ขู่ดำเนินคดีหากไม่ทำตามขั้นตอนผ่านแชตทันที', 'th'),

    ('ROMANCE_EMERGENCY', 'คนรักที่รู้จักกันทางออนไลน์บอกว่าประสบอุบัติเหตุอยู่ต่างประเทศและขอเงินค่ารักษาด่วน', 'th'),
    ('ROMANCE_EMERGENCY', 'หลังพูดคุยกันมานาน เขาอ้างว่าติดอยู่ที่ด่านและต้องการให้ช่วยจ่ายค่าเดินทางฉุกเฉิน', 'th'),
    ('ROMANCE_EMERGENCY', 'เธอสัญญาว่าจะมาเจอแต่เกิดเหตุไม่คาดคิด จึงขอให้โอนเงินช่วยครอบครัวก่อน', 'th'),
    ('ROMANCE_EMERGENCY', 'คนที่เรียกคุณว่าที่รักบอกว่ากระเป๋าหายระหว่างทำงานต่างประเทศ และเร่งขอยืมเงินทันที', 'th');

-- Reconcile previously seeded rows so reruns restore the deterministic
-- development state without creating duplicates.
UPDATE scam_pattern_examples AS existing
SET
    example_status = 'verified',
    source = 'development_curated_seed',
    verified_at = TIMESTAMPTZ '2026-08-14 00:00:00+00',
    is_active = TRUE
FROM demo_scam_pattern_example_seed AS seed
JOIN scam_patterns AS pattern
    ON pattern.pattern_code = seed.pattern_code
WHERE existing.pattern_id = pattern.id
  AND existing.example_text = seed.example_text
  AND existing.language = seed.language;

INSERT INTO scam_pattern_examples (
    pattern_id,
    example_text,
    language,
    example_status,
    source,
    embedding_model,
    embedding_dimensions,
    verified_at,
    is_active
)
SELECT
    pattern.id,
    seed.example_text,
    seed.language,
    'verified',
    'development_curated_seed',
    NULL,
    NULL,
    TIMESTAMPTZ '2026-08-14 00:00:00+00',
    TRUE
FROM demo_scam_pattern_example_seed AS seed
JOIN scam_patterns AS pattern
    ON pattern.pattern_code = seed.pattern_code
WHERE NOT EXISTS (
    SELECT 1
    FROM scam_pattern_examples AS existing
    WHERE existing.pattern_id = pattern.id
      AND existing.example_text = seed.example_text
      AND existing.language = seed.language
);

COMMIT;
