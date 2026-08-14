'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPOSITORY_ROOT, 'config', 'scoring-v1.1.json');
const DEFAULT_TAXONOMY_PATH = path.join(REPOSITORY_ROOT, 'docs', 'scam-taxonomy.md');

function parseTaxonomy(markdown) {
  const versionMatch = markdown.match(/\| เวอร์ชัน \| `([^`]+)` \|/);
  const indicators = new Map();
  const rowPattern = /^\| `([A-Z][A-Z0-9_]+)` \|.*?\| (low|medium|high|critical) \| `(score|confidence_only|security_only)` \|/gm;

  let match;
  while ((match = rowPattern.exec(markdown)) !== null) {
    const [, code, severity, behavior] = match;
    if (indicators.has(code)) {
      throw new Error(`Taxonomy contains duplicate indicator code: ${code}`);
    }
    indicators.set(code, { severity, behavior });
  }

  if (!versionMatch) {
    throw new Error('Could not read taxonomy version.');
  }
  if (indicators.size === 0) {
    throw new Error('Could not read taxonomy indicator definitions.');
  }

  return { version: versionMatch[1], indicators };
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function validateScoringConfig(config, taxonomy) {
  const errors = [];
  const addError = (message) => errors.push(message);

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['Configuration root must be an object.'];
  }

  if (typeof config.scoring_version !== 'string' || config.scoring_version.trim() === '') {
    addError('scoring_version must be a non-empty string.');
  }
  if (typeof config.taxonomy_version !== 'string' || config.taxonomy_version.trim() === '') {
    addError('taxonomy_version must be a non-empty string.');
  } else if (config.taxonomy_version !== taxonomy.version) {
    addError(`taxonomy_version ${config.taxonomy_version} does not match taxonomy ${taxonomy.version}.`);
  }

  if (!config.score_range || !isNonNegativeInteger(config.score_range.min) || !isNonNegativeInteger(config.score_range.max)) {
    addError('score_range min and max must be non-negative integers.');
  } else if (config.score_range.min !== 0 || config.score_range.max !== 100) {
    addError('score_range must be exactly 0 through 100.');
  }

  if (!isNonNegativeInteger(config.final_score_cap)) {
    addError('final_score_cap must be a non-negative integer.');
  } else if (config.final_score_cap !== 100) {
    addError('final_score_cap must be exactly 100.');
  }

  const expectedLevels = [
    { level: 'low', min: 0, max: 29 },
    { level: 'medium', min: 30, max: 59 },
    { level: 'high', min: 60, max: 79 },
    { level: 'critical', min: 80, max: 100 }
  ];
  const levels = Array.isArray(config.risk_levels) ? config.risk_levels : [];
  if (!Array.isArray(config.risk_levels) || levels.length === 0) {
    addError('risk_levels must be a non-empty array.');
  } else {
    const duplicateLevels = findDuplicates(levels.map((entry) => entry && entry.level));
    for (const level of duplicateLevels) {
      addError(`Duplicate risk level: ${String(level)}.`);
    }

    for (const entry of levels) {
      if (!entry || typeof entry.level !== 'string' || !isNonNegativeInteger(entry.min) || !isNonNegativeInteger(entry.max)) {
        addError('Every risk level must have a string level and non-negative integer min and max.');
      } else if (entry.min > entry.max) {
        addError(`Risk level ${entry.level} has min greater than max.`);
      }
    }

    const sortedLevels = levels
      .filter((entry) => entry && isNonNegativeInteger(entry.min) && isNonNegativeInteger(entry.max))
      .slice()
      .sort((a, b) => a.min - b.min);
    if (sortedLevels.length > 0) {
      if (sortedLevels[0].min !== 0 || sortedLevels[sortedLevels.length - 1].max !== 100) {
        addError('Risk thresholds must cover 0 through 100.');
      }
      for (let index = 1; index < sortedLevels.length; index += 1) {
        if (sortedLevels[index].min !== sortedLevels[index - 1].max + 1) {
          addError('Risk thresholds must not contain gaps or overlaps.');
          break;
        }
      }
    }

    for (const expected of expectedLevels) {
      const actual = levels.find((entry) => entry && entry.level === expected.level);
      if (!actual || actual.min !== expected.min || actual.max !== expected.max) {
        addError(`Risk level ${expected.level} must cover ${expected.min}-${expected.max}.`);
      }
    }
  }

  const weights = Array.isArray(config.indicator_weights) ? config.indicator_weights : [];
  if (!Array.isArray(config.indicator_weights)) {
    addError('indicator_weights must be an array.');
  }
  const weightCodes = weights.map((entry) => entry && entry.code);
  for (const code of findDuplicates(weightCodes)) {
    addError(`Duplicate weighted indicator code: ${String(code)}.`);
  }
  const weightByCode = new Map();
  for (const entry of weights) {
    if (!entry || typeof entry.code !== 'string') {
      addError('Every indicator weight must have a code.');
      continue;
    }
    const taxonomyEntry = taxonomy.indicators.get(entry.code);
    if (!taxonomyEntry) {
      addError(`Weighted indicator does not exist in taxonomy: ${entry.code}.`);
      continue;
    }
    if (taxonomyEntry.behavior !== 'score') {
      addError(`Non-scoring indicator must not appear in indicator_weights: ${entry.code}.`);
    }
    if (entry.severity !== taxonomyEntry.severity) {
      addError(`Severity mismatch for ${entry.code}: expected ${taxonomyEntry.severity}.`);
    }
    if (!isNonNegativeInteger(entry.weight)) {
      addError(`Weight for ${entry.code} must be a non-negative integer.`);
    }
    if (typeof entry.group !== 'string' || entry.group.trim() === '') {
      addError(`Weighted indicator ${entry.code} must belong to one scoring group.`);
    }
    if (!weightByCode.has(entry.code)) {
      weightByCode.set(entry.code, entry);
    }
  }

  const nonScoring = Array.isArray(config.non_scoring_indicators) ? config.non_scoring_indicators : [];
  if (!Array.isArray(config.non_scoring_indicators)) {
    addError('non_scoring_indicators must be an array.');
  }
  const nonScoringCodes = nonScoring.map((entry) => entry && entry.code);
  for (const code of findDuplicates(nonScoringCodes)) {
    addError(`Duplicate non-scoring indicator code: ${String(code)}.`);
  }
  const nonScoringByCode = new Map();
  for (const entry of nonScoring) {
    if (!entry || typeof entry.code !== 'string') {
      addError('Every non-scoring indicator must have a code.');
      continue;
    }
    const taxonomyEntry = taxonomy.indicators.get(entry.code);
    if (!taxonomyEntry) {
      addError(`Non-scoring indicator does not exist in taxonomy: ${entry.code}.`);
      continue;
    }
    if (taxonomyEntry.behavior === 'score') {
      addError(`Score-bearing indicator must not appear in non_scoring_indicators: ${entry.code}.`);
    }
    if (entry.behavior !== taxonomyEntry.behavior) {
      addError(`Behavior mismatch for ${entry.code}: expected ${taxonomyEntry.behavior}.`);
    }
    if (entry.severity !== taxonomyEntry.severity) {
      addError(`Severity mismatch for ${entry.code}: expected ${taxonomyEntry.severity}.`);
    }
    if (!isNonNegativeInteger(entry.weight) || entry.weight !== 0) {
      addError(`Non-scoring indicator ${entry.code} must have integer weight 0.`);
    }
    if (!nonScoringByCode.has(entry.code)) {
      nonScoringByCode.set(entry.code, entry);
    }
  }

  for (const [code, definition] of taxonomy.indicators) {
    if (definition.behavior === 'score') {
      if (!weightByCode.has(code)) {
        addError(`Missing exactly one weight for score-bearing indicator: ${code}.`);
      }
      if (nonScoringByCode.has(code)) {
        addError(`Indicator appears in both scoring and non-scoring lists: ${code}.`);
      }
    } else {
      if (!nonScoringByCode.has(code)) {
        addError(`Missing non-scoring declaration for ${definition.behavior} indicator: ${code}.`);
      }
      if (weightByCode.has(code)) {
        addError(`Non-scoring indicator has a positive-risk configuration entry: ${code}.`);
      }
    }
  }

  const groups = Array.isArray(config.scoring_groups) ? config.scoring_groups : [];
  if (!Array.isArray(config.scoring_groups) || groups.length === 0) {
    addError('scoring_groups must be a non-empty array.');
  }
  for (const id of findDuplicates(groups.map((group) => group && group.id))) {
    addError(`Duplicate scoring group id: ${String(id)}.`);
  }
  const groupById = new Map();
  const membershipCount = new Map();
  for (const group of groups) {
    if (!group || typeof group.id !== 'string' || group.id.trim() === '') {
      addError('Every scoring group must have a non-empty id.');
      continue;
    }
    if (!isNonNegativeInteger(group.score_cap)) {
      addError(`Score cap for group ${group.id} must be a non-negative integer.`);
    }
    if (!Array.isArray(group.members)) {
      addError(`Members for group ${group.id} must be an array.`);
      continue;
    }
    for (const code of findDuplicates(group.members)) {
      addError(`Duplicate member ${String(code)} in scoring group ${group.id}.`);
    }
    if (!groupById.has(group.id)) {
      groupById.set(group.id, group);
    }
    for (const code of group.members) {
      if (!weightByCode.has(code)) {
        addError(`Scoring group ${group.id} contains unknown or non-weighted member: ${String(code)}.`);
      }
      membershipCount.set(code, (membershipCount.get(code) || 0) + 1);
    }
  }

  for (const [code, entry] of weightByCode) {
    const memberships = membershipCount.get(code) || 0;
    if (memberships !== 1) {
      addError(`Weighted indicator ${code} must belong to exactly one scoring group; found ${memberships}.`);
    }
    const group = groupById.get(entry.group);
    if (!group || !Array.isArray(group.members) || !group.members.includes(code)) {
      addError(`Weighted indicator ${code} declares group ${entry.group}, but group membership does not match.`);
    }
  }

  if (!isNonNegativeInteger(config.combination_bonus_cap)) {
    addError('combination_bonus_cap must be a non-negative integer.');
  }
  const bonuses = Array.isArray(config.combination_bonuses) ? config.combination_bonuses : [];
  if (!Array.isArray(config.combination_bonuses)) {
    addError('combination_bonuses must be an array.');
  }
  for (const id of findDuplicates(bonuses.map((bonus) => bonus && bonus.id))) {
    addError(`Duplicate combination bonus id: ${String(id)}.`);
  }
  for (const bonus of bonuses) {
    if (!bonus || typeof bonus.id !== 'string' || bonus.id.trim() === '') {
      addError('Every combination bonus must have a non-empty id.');
      continue;
    }
    if (typeof bonus.description !== 'string' || bonus.description.trim() === '') {
      addError(`Combination bonus ${bonus.id} must have a description.`);
    }
    if (!isNonNegativeInteger(bonus.points)) {
      addError(`Combination bonus ${bonus.id} points must be a non-negative integer.`);
    }
    if (!Array.isArray(bonus.indicators) || bonus.indicators.length < 2) {
      addError(`Combination bonus ${bonus.id} must require at least two indicator codes.`);
      continue;
    }
    for (const code of findDuplicates(bonus.indicators)) {
      addError(`Combination bonus ${bonus.id} contains duplicate code: ${String(code)}.`);
    }
    for (const code of bonus.indicators) {
      if (!taxonomy.indicators.has(code)) {
        addError(`Combination bonus ${bonus.id} contains unknown indicator: ${String(code)}.`);
      } else if (!weightByCode.has(code)) {
        addError(`Combination bonus ${bonus.id} may only use score-bearing indicators: ${code}.`);
      }
    }
  }

  const rules = Array.isArray(config.specificity_rules) ? config.specificity_rules : [];
  if (!Array.isArray(config.specificity_rules)) {
    addError('specificity_rules must be an array.');
  }
  for (const code of findDuplicates(rules.map((rule) => rule && rule.generic_code))) {
    addError(`Duplicate specificity generic code: ${String(code)}.`);
  }
  for (const rule of rules) {
    if (!rule || !weightByCode.has(rule.generic_code)) {
      addError(`Specificity rule has unknown generic code: ${rule && rule.generic_code}.`);
      continue;
    }
    if (!Array.isArray(rule.prefer_codes) || rule.prefer_codes.length === 0) {
      addError(`Specificity rule for ${rule.generic_code} must have prefer_codes.`);
      continue;
    }
    for (const code of findDuplicates(rule.prefer_codes)) {
      addError(`Specificity rule for ${rule.generic_code} contains duplicate preferred code: ${String(code)}.`);
    }
    for (const code of rule.prefer_codes) {
      if (!weightByCode.has(code)) {
        addError(`Specificity rule for ${rule.generic_code} contains unknown preferred code: ${String(code)}.`);
      }
    }
    if (rule.evidence_match !== 'normalized_equal_or_containment') {
      addError(`Specificity rule for ${rule.generic_code} has unsupported evidence_match.`);
    }
  }

  const review = config.human_review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    addError('human_review must be an object.');
  } else {
    if (typeof review.confidence_below !== 'number' || !Number.isFinite(review.confidence_below) || review.confidence_below < 0 || review.confidence_below > 1) {
      addError('human_review.confidence_below must be a number from 0 to 1.');
    }
    for (const field of ['unsupported_indicator', 'conflicting_evidence', 'possible_prompt_injection', 'invalid_confidence']) {
      if (typeof review[field] !== 'boolean') {
        addError(`human_review.${field} must be a boolean.`);
      }
    }
    for (const field of ['quality_indicator_codes', 'always_review_indicator_codes']) {
      if (!Array.isArray(review[field])) {
        addError(`human_review.${field} must be an array.`);
        continue;
      }
      for (const code of findDuplicates(review[field])) {
        addError(`human_review.${field} contains duplicate code: ${String(code)}.`);
      }
      for (const code of review[field]) {
        if (!taxonomy.indicators.has(code)) {
          addError(`human_review.${field} contains unknown code: ${String(code)}.`);
        }
      }
    }
  }

  return errors;
}

function runCli() {
  const configPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONFIG_PATH;
  const taxonomyPath = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_TAXONOMY_PATH;

  let config;
  let taxonomy;
  try {
    const configText = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configText);
  } catch (error) {
    console.error(`Invalid scoring configuration JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    taxonomy = parseTaxonomy(fs.readFileSync(taxonomyPath, 'utf8'));
  } catch (error) {
    console.error(`Invalid taxonomy source: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = validateScoringConfig(config, taxonomy);
  if (errors.length > 0) {
    console.error(`Scoring configuration validation failed with ${errors.length} error(s):`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Scoring configuration is valid: ${config.scoring_version} (${taxonomy.indicators.size} taxonomy indicators).`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  parseTaxonomy,
  validateScoringConfig
};
