'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'scoring-v1.json');

function loadScoringConfig(configPath = DEFAULT_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

const DEFAULT_CONFIG = loadScoringConfig();

function normalizeEvidence(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    : '';
}

function evidenceMatches(left, right, mode) {
  const normalizedLeft = normalizeEvidence(left);
  const normalizedRight = normalizeEvidence(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (mode === 'normalized_equal_or_containment') {
    return normalizedLeft === normalizedRight
      || normalizedLeft.includes(normalizedRight)
      || normalizedRight.includes(normalizedLeft);
  }
  return false;
}

function buildConfigIndexes(config) {
  return {
    weights: new Map(config.indicator_weights.map((entry) => [entry.code, entry])),
    nonScoring: new Map(config.non_scoring_indicators.map((entry) => [entry.code, entry]))
  };
}

function collectIndicators(inputIndicators, indexes) {
  const accepted = [];
  const ignored = [];
  const validationWarnings = [];
  const seenCodes = new Set();
  let unsupportedFound = false;
  let malformedSupportedIndicatorFound = false;
  let severityMismatchFound = false;

  for (const rawIndicator of inputIndicators) {
    const code = rawIndicator && typeof rawIndicator.code === 'string'
      ? rawIndicator.code
      : null;

    if (!code || (!indexes.weights.has(code) && !indexes.nonScoring.has(code))) {
      unsupportedFound = true;
      ignored.push({ code, reason: 'unsupported_indicator' });
      continue;
    }

    const evidence = rawIndicator && typeof rawIndicator.evidence === 'string'
      ? rawIndicator.evidence.trim()
      : '';
    if (!evidence) {
      malformedSupportedIndicatorFound = true;
      ignored.push({ code, reason: 'missing_evidence' });
      continue;
    }

    if (seenCodes.has(code)) {
      ignored.push({ code, reason: 'duplicate_code' });
      continue;
    }

    seenCodes.add(code);
    const configuredIndicator = indexes.weights.get(code) || indexes.nonScoring.get(code);
    if (
      Object.prototype.hasOwnProperty.call(rawIndicator, 'severity')
      && rawIndicator.severity !== configuredIndicator.severity
    ) {
      severityMismatchFound = true;
      validationWarnings.push({
        code,
        warning: 'severity_mismatch',
        supplied_severity: typeof rawIndicator.severity === 'string'
          ? rawIndicator.severity
          : String(rawIndicator.severity),
        expected_severity: configuredIndicator.severity
      });
    }
    accepted.push({ code, evidence });
  }

  return {
    accepted,
    ignored,
    validationWarnings,
    unsupportedFound,
    malformedSupportedIndicatorFound,
    severityMismatchFound
  };
}

function applySpecificityRules(accepted, ignored, rules) {
  const suppressedCodes = new Set();

  for (const rule of rules) {
    const generic = accepted.find((entry) => entry.code === rule.generic_code);
    if (!generic) {
      continue;
    }

    const preferred = accepted.find((entry) => (
      rule.prefer_codes.includes(entry.code)
      && evidenceMatches(generic.evidence, entry.evidence, rule.evidence_match)
    ));
    if (preferred) {
      suppressedCodes.add(generic.code);
      ignored.push({
        code: generic.code,
        reason: 'suppressed_by_specific_indicator',
        preferred_code: preferred.code
      });
    }
  }

  return accepted.filter((entry) => !suppressedCodes.has(entry.code));
}

function calculateBaseScore(activeIndicators, indexes, config) {
  const scoredIndicators = activeIndicators
    .filter((entry) => indexes.weights.has(entry.code))
    .map((entry) => {
      const configured = indexes.weights.get(entry.code);
      return {
        code: entry.code,
        weight: configured.weight,
        group: configured.group
      };
    })
    .sort((left, right) => left.code.localeCompare(right.code));

  const rawGroupScores = new Map();
  for (const indicator of scoredIndicators) {
    rawGroupScores.set(
      indicator.group,
      (rawGroupScores.get(indicator.group) || 0) + indicator.weight
    );
  }

  const groupScores = config.scoring_groups.map((group) => {
    const rawScore = rawGroupScores.get(group.id) || 0;
    return {
      group: group.id,
      raw_score: rawScore,
      cap: group.score_cap,
      applied_score: Math.min(rawScore, group.score_cap)
    };
  });
  const baseScore = groupScores.reduce((sum, group) => sum + group.applied_score, 0);

  return { scoredIndicators, groupScores, baseScore };
}

function calculateBonuses(activeCodes, config) {
  const appliedBonuses = [];
  let bonusScore = 0;

  for (const bonus of config.combination_bonuses) {
    if (!bonus.indicators.every((code) => activeCodes.has(code))) {
      continue;
    }
    const available = config.combination_bonus_cap - bonusScore;
    if (available <= 0) {
      break;
    }
    const appliedPoints = Math.min(bonus.points, available);
    if (appliedPoints > 0) {
      appliedBonuses.push({ id: bonus.id, points: appliedPoints });
      bonusScore += appliedPoints;
    }
  }

  return { appliedBonuses, bonusScore };
}

function getRiskLevel(score, riskLevels) {
  const match = riskLevels.find((entry) => score >= entry.min && score <= entry.max);
  if (!match) {
    throw new Error(`No risk level configured for score ${score}.`);
  }
  return match.level;
}

function deriveHumanReview({
  input,
  activeCodes,
  unsupportedFound,
  malformedSupportedIndicatorFound,
  severityMismatchFound,
  score,
  config
}) {
  const review = config.human_review;
  const confidence = input && input.confidence;
  const confidenceIsValid = typeof confidence === 'number'
    && Number.isFinite(confidence)
    && confidence >= 0
    && confidence <= 1;

  if (!confidenceIsValid && review.invalid_confidence) {
    return true;
  }
  if (confidenceIsValid && confidence < review.confidence_below) {
    return true;
  }
  if (unsupportedFound && review.unsupported_indicator) {
    return true;
  }
  if (malformedSupportedIndicatorFound && review.malformed_supported_indicator) {
    return true;
  }
  if (severityMismatchFound && review.severity_mismatch) {
    return true;
  }
  if (activeCodes.has('CONFLICTING_EVIDENCE') && review.conflicting_evidence) {
    return true;
  }
  if (activeCodes.has('INSUFFICIENT_CONTEXT') && score >= review.insufficient_context_min_score) {
    return true;
  }
  if (review.quality_indicator_codes.some((code) => activeCodes.has(code))) {
    return true;
  }
  if (review.always_review_indicator_codes.some((code) => activeCodes.has(code))) {
    return true;
  }
  if (activeCodes.has('POSSIBLE_PROMPT_INJECTION') && review.possible_prompt_injection) {
    return true;
  }
  return false;
}

function scoreAnalysis(input, config = DEFAULT_CONFIG) {
  const safeInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const inputIndicators = Array.isArray(safeInput.indicators) ? safeInput.indicators : [];
  const indexes = buildConfigIndexes(config);

  const collected = collectIndicators(inputIndicators, indexes);
  const activeIndicators = applySpecificityRules(
    collected.accepted,
    collected.ignored,
    config.specificity_rules
  );
  const activeCodes = new Set(activeIndicators.map((entry) => entry.code));

  const { scoredIndicators, groupScores, baseScore } = calculateBaseScore(
    activeIndicators,
    indexes,
    config
  );
  const { appliedBonuses, bonusScore } = calculateBonuses(activeCodes, config);
  const preFinalCapScore = baseScore + bonusScore;
  const cappedScore = Math.min(config.final_score_cap, preFinalCapScore);
  const riskLevel = getRiskLevel(cappedScore, config.risk_levels);
  const needsHumanReview = deriveHumanReview({
    input: safeInput,
    activeCodes,
    unsupportedFound: collected.unsupportedFound,
    malformedSupportedIndicatorFound: collected.malformedSupportedIndicatorFound,
    severityMismatchFound: collected.severityMismatchFound,
    score: cappedScore,
    config
  });

  return {
    scoring_version: config.scoring_version,
    taxonomy_version: config.taxonomy_version,
    risk_score: cappedScore,
    risk_level: riskLevel,
    needs_human_review: needsHumanReview,
    scored_indicators: scoredIndicators,
    group_scores: groupScores,
    applied_bonuses: appliedBonuses,
    ignored_indicators: collected.ignored,
    validation_warnings: collected.validationWarnings,
    scoring_summary: {
      base_score: baseScore,
      bonus_score: bonusScore,
      capped_score: cappedScore,
      group_capped_base_score: baseScore,
      pre_final_cap_score: preFinalCapScore,
      final_score: cappedScore
    }
  };
}

module.exports = {
  loadScoringConfig,
  scoreAnalysis
};
