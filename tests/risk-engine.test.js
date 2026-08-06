'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scoreAnalysis, loadScoringConfig } = require('../scripts/risk-engine');

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'risk-engine-cases.json'), 'utf8')
);
const config = loadScoringConfig();

function fixture(id) {
  const match = fixtures.find((entry) => entry.id === id);
  assert.ok(match, `Missing fixture: ${id}`);
  return match;
}

function assertScoreRange(result, expected) {
  if (expected.min_score !== undefined) {
    assert.ok(result.risk_score >= expected.min_score, `${result.risk_score} is below ${expected.min_score}`);
  }
  if (expected.max_score !== undefined) {
    assert.ok(result.risk_score <= expected.max_score, `${result.risk_score} is above ${expected.max_score}`);
  }
}

test('1. Confidence 0.90 with no review indicator returns score 0, low risk, and no review', () => {
  const scenario = fixture('empty-indicators');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
  assert.deepEqual(result.scored_indicators, []);
});

test('2. OTP_REQUEST creates a high or critical result', () => {
  const scenario = fixture('otp-request');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.ok(scenario.expected.risk_levels.includes(result.risk_level));
  assert.deepEqual(result.scored_indicators.map((entry) => entry.code), ['OTP_REQUEST']);
});

test('3. BANK_IMPERSONATION alone does not automatically reach critical', () => {
  const scenario = fixture('bank-impersonation-alone');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.notEqual(result.risk_level, scenario.expected.excluded_level);
});

test('4. BANK_IMPERSONATION plus OTP_REQUEST plus URGENCY_PRESSURE is stronger than any one indicator', () => {
  const scenario = fixture('bank-otp-urgency-combination');
  const combined = scoreAnalysis(scenario.input);
  const individualScores = scenario.input.indicators.map((indicator) => scoreAnalysis({
    indicators: [indicator],
    scam_categories: scenario.input.scam_categories,
    confidence: scenario.input.confidence
  }).risk_score);
  assertScoreRange(combined, scenario.expected);
  assert.equal(combined.risk_level, scenario.expected.risk_level);
  assert.ok(combined.risk_score < config.final_score_cap);
  assert.ok(individualScores.every((score) => combined.risk_score > score));
});

test('5. Duplicate OTP_REQUEST is counted once', () => {
  const scenario = fixture('duplicate-otp');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.scored_indicators.filter((entry) => entry.code === 'OTP_REQUEST').length, scenario.expected.scored_code_count);
  assert.ok(result.ignored_indicators.some((entry) => entry.code === 'OTP_REQUEST' && entry.reason === 'duplicate_code'));
});

test('6. CREDENTIAL_REQUEST is suppressed for the same request when OTP_REQUEST is present', () => {
  const scenario = fixture('credential-suppressed-by-otp');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.ok(!result.scored_indicators.some((entry) => entry.code === scenario.expected.suppressed_code));
  assert.ok(result.ignored_indicators.some((entry) => (
    entry.code === scenario.expected.suppressed_code
    && entry.reason === 'suppressed_by_specific_indicator'
    && entry.preferred_code === 'OTP_REQUEST'
  )));
});

test('7. Quality-only indicators add zero risk points', () => {
  const scenario = fixture('quality-only');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
  assert.deepEqual(result.scored_indicators, []);
});

test('8. POSSIBLE_PROMPT_INJECTION adds zero risk and does not force review by default', () => {
  const scenario = fixture('prompt-injection-only');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
});

test('9. Client-supplied risk_score is ignored', () => {
  const scenario = fixture('client-risk-score-ignored');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
  assert.notEqual(result.risk_score, scenario.input.risk_score);
});

test('10. Unsupported indicator codes are ignored and trigger human review', () => {
  const scenario = fixture('unsupported-indicator');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
  assert.ok(result.ignored_indicators.some((entry) => (
    entry.code === scenario.expected.ignored_code && entry.reason === 'unsupported_indicator'
  )));
});

test('11. Group caps prevent excessive double-counting', () => {
  const scenario = fixture('credential-group-cap');
  const result = scoreAnalysis(scenario.input);
  const group = config.scoring_groups.find((entry) => entry.id === scenario.expected.group);
  const rawWeight = result.scored_indicators
    .filter((entry) => entry.group === scenario.expected.group)
    .reduce((sum, entry) => sum + entry.weight, 0);
  const groupScore = result.group_scores.find((entry) => entry.group === scenario.expected.group);
  assert.ok(rawWeight > group.score_cap);
  assert.deepEqual(groupScore, {
    group: scenario.expected.group,
    raw_score: rawWeight,
    cap: group.score_cap,
    applied_score: group.score_cap
  });
  assert.equal(result.scoring_summary.base_score, group.score_cap);
  assert.equal(result.scoring_summary.group_capped_base_score, group.score_cap);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
});

test('12. Combination bonus is applied only when every required code is present', () => {
  const scenario = fixture('combination-bonus-all-required');
  const complete = scoreAnalysis(scenario.input);
  const partial = scoreAnalysis(scenario.comparison_input);
  const applied = complete.applied_bonuses.find((entry) => entry.id === scenario.expected.bonus_id);
  assert.ok(applied);
  assert.equal(applied.points, scenario.expected.bonus_points);
  assert.equal(partial.applied_bonuses.length, scenario.expected.partial_bonus_count);
});

test('13. Final score never exceeds 100', () => {
  const scenario = fixture('final-score-cap');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.risk_level, scenario.expected.risk_level);
  assert.equal(result.risk_score, config.final_score_cap);
  assert.ok(result.scoring_summary.pre_final_cap_score >= scenario.expected.pre_final_cap_min);
  assert.equal(
    result.scoring_summary.pre_final_cap_score,
    result.scoring_summary.group_capped_base_score + result.scoring_summary.bonus_score
  );
  assert.equal(
    result.scoring_summary.group_capped_base_score,
    result.group_scores.reduce((sum, entry) => sum + entry.applied_score, 0)
  );
  assert.equal(result.scoring_summary.final_score, config.final_score_cap);
  assert.equal(result.scoring_summary.capped_score, result.scoring_summary.final_score);
});

test('14. Confidence 0.55 triggers human review below the 0.65 threshold', () => {
  const scenario = fixture('low-confidence-review');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
});

test('15. CONFLICTING_EVIDENCE triggers human review without adding risk', () => {
  const scenario = fixture('conflicting-evidence-review');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
  assert.deepEqual(result.scored_indicators, []);
});

test('16. Scam categories never change the score', () => {
  const scenario = fixture('categories-do-not-score');
  const first = scoreAnalysis(scenario.input);
  const second = scoreAnalysis(scenario.comparison_input);
  assertScoreRange(first, scenario.expected);
  assert.equal(first.risk_score, second.risk_score);
  assert.deepEqual(first.scoring_summary, second.scoring_summary);
});

test('17. The input object is not mutated', () => {
  const scenario = fixture('input-not-mutated');
  const input = structuredClone(scenario.input);
  const before = structuredClone(input);
  const result = scoreAnalysis(input);
  assertScoreRange(result, scenario.expected);
  assert.deepEqual(input, before);
  assert.notStrictEqual(result, input);
});

test('18. Scoring output is deterministic across repeated calls', () => {
  const scenario = fixture('deterministic-repeat');
  const first = scoreAnalysis(scenario.input);
  const second = scoreAnalysis(scenario.input);
  assertScoreRange(first, scenario.expected);
  assert.deepEqual(first, second);
});

test('19. Indicator evidence must be a non-empty string to contribute', () => {
  const scenario = fixture('missing-evidence');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.ok(result.ignored_indicators.some((entry) => entry.reason === scenario.expected.ignored_reason));
  assert.equal(result.needs_human_review, scenario.expected.needs_human_review);
  assert.deepEqual(result.scored_indicators, []);
});

test('20. Severity mismatch emits a warning and triggers review without changing configured weight', () => {
  const scenario = fixture('severity-mismatch');
  const mismatched = scoreAnalysis(scenario.input);
  const configured = scoreAnalysis(scenario.comparison_input);
  assertScoreRange(mismatched, scenario.expected);
  assert.equal(mismatched.risk_score, configured.risk_score);
  assert.equal(mismatched.needs_human_review, scenario.expected.needs_human_review);
  assert.deepEqual(mismatched.validation_warnings, [
    {
      code: 'OTP_REQUEST',
      warning: scenario.expected.warning,
      supplied_severity: 'low',
      expected_severity: scenario.expected.expected_severity
    }
  ]);
  assert.deepEqual(configured.validation_warnings, []);
});

test('21. INSUFFICIENT_CONTEXT forces human review at confidence 0.90 without adding risk', () => {
  const scenario = fixture('insufficient-context-review');
  const result = scoreAnalysis(scenario.input);
  assertScoreRange(result, scenario.expected);
  assert.equal(result.needs_human_review, true);
  assert.deepEqual(result.scored_indicators, []);
});
