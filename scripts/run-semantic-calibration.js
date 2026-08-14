'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AMBIGUOUS_MARGIN_MAX = 0.05;

function round(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(Number(value).toFixed(6));
}

function quantile(values, position) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]);
  return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function distribution(values) {
  const finite = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return { count: 0, min: null, max: null, mean: null, median: null, p25: null, p75: null };
  return {
    count: finite.length,
    min: round(finite[0]),
    max: round(finite[finite.length - 1]),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    median: quantile(finite, 0.5),
    p25: quantile(finite, 0.25),
    p75: quantile(finite, 0.75)
  };
}

function unwrapRawResults(raw) {
  let value = raw;
  if (Array.isArray(value) && value.length === 1 && value[0] && value[0].json) value = value[0].json;
  if (value && value.json) value = value.json;
  if (value && Array.isArray(value.results)) return value.results;
  if (Array.isArray(value)) return value.map((item) => item && item.json ? item.json : item);
  throw new Error('Calibration input must contain an array of lookup results.');
}

function sortPatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : []).map((item) => ({
    pattern_code: String(item.pattern_code || ''),
    category: typeof item.category === 'string' ? item.category : null,
    best_similarity: round(item.best_similarity),
    average_similarity: round(item.average_similarity),
    matched_example_count: Number(item.matched_example_count) || 0
  })).filter((item) => item.pattern_code && item.best_similarity !== null)
    .sort((a, b) =>
      b.best_similarity - a.best_similarity ||
      b.average_similarity - a.average_similarity ||
      b.matched_example_count - a.matched_example_count ||
      (a.pattern_code < b.pattern_code ? -1 : a.pattern_code > b.pattern_code ? 1 : 0)
    );
}

function buildCalibrationResult(dataset, rawInput, generatedAt = new Date().toISOString()) {
  if (!dataset || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('Calibration dataset is empty.');
  const rawResults = unwrapRawResults(rawInput);
  const byId = new Map();
  for (const raw of rawResults) {
    if (!raw || typeof raw.case_id !== 'string' || byId.has(raw.case_id)) throw new Error('Calibration results contain an invalid or duplicate case_id.');
    byId.set(raw.case_id, raw);
  }
  const cases = dataset.cases.map((definition) => {
    const raw = byId.get(definition.case_id);
    if (!raw) throw new Error(`Missing lookup result for ${definition.case_id}.`);
    if (raw.ok !== true) throw new Error(`Lookup failed for ${definition.case_id}.`);
    const ranked = sortPatterns(raw.patterns || raw.semantic_intelligence?.patterns);
    const top = ranked[0] || null;
    const second = ranked[1] || null;
    const expected = definition.expected_pattern;
    const expectedRank = expected ? ranked.findIndex((item) => item.pattern_code === expected) + 1 : null;
    const expectedMatch = expected ? ranked.find((item) => item.pattern_code === expected) : null;
    return {
      case_id: definition.case_id,
      input_text: definition.input_text,
      expected_pattern: expected,
      case_type: definition.case_type,
      notes: definition.notes,
      top_pattern: top ? top.pattern_code : null,
      best_similarity: top ? top.best_similarity : null,
      average_similarity: top ? top.average_similarity : null,
      matched_example_count: top ? top.matched_example_count : 0,
      top_k_ranked_patterns: ranked,
      top1_top2_similarity_margin: top && second ? round(top.best_similarity - second.best_similarity) : null,
      expected_pattern_rank: expectedRank || null,
      expected_pattern_similarity: expectedMatch ? expectedMatch.best_similarity : null
    };
  });
  if (byId.size !== cases.length) throw new Error('Calibration results contain unknown case IDs.');

  const known = cases.filter((item) => item.expected_pattern !== null);
  const benign = cases.filter((item) => item.case_type === 'benign');
  const borderline = cases.filter((item) => item.case_type === 'borderline_legitimate');
  const correctSimilarities = known.map((item) => item.expected_pattern_similarity).filter((value) => value !== null);
  const typeNames = [...new Set(cases.map((item) => item.case_type))].sort();
  const byCaseType = Object.fromEntries(typeNames.map((type) => [type, distribution(
    cases.filter((item) => item.case_type === type).map((item) => item.best_similarity)
  )]));
  const negativeTop = cases.filter((item) => item.expected_pattern === null).map((item) => item.best_similarity).filter((value) => value !== null);
  const knownTop = correctSimilarities;
  const negativeP75 = quantile(negativeTop, 0.75);
  const negativeMax = negativeTop.length ? round(Math.max(...negativeTop)) : null;
  const knownP25 = quantile(knownTop, 0.25);
  const knownMedian = quantile(knownTop, 0.5);

  return {
    status: 'runtime_observed_not_production_calibrated',
    dataset_version: dataset.dataset_version,
    generated_at: generatedAt,
    embedding_model: 'gemini-embedding-2',
    embedding_dimensions: 768,
    top_k: 5,
    summary: {
      total_cases: cases.length,
      known_pattern_cases: known.length,
      top1_accuracy: round(known.filter((item) => item.top_pattern === item.expected_pattern).length / known.length),
      top3_recall: round(known.filter((item) => item.expected_pattern_rank && item.expected_pattern_rank <= 3).length / known.length),
      highest_benign_similarity: benign.length ? round(Math.max(...benign.map((item) => item.best_similarity).filter((value) => value !== null))) : null,
      highest_borderline_similarity: borderline.length ? round(Math.max(...borderline.map((item) => item.best_similarity).filter((value) => value !== null))) : null,
      lowest_correct_pattern_similarity: correctSimilarities.length ? round(Math.min(...correctSimilarities)) : null,
      similarity_distributions_by_case_type: byCaseType,
      ambiguous_margin_diagnostic: {
        margin_max: AMBIGUOUS_MARGIN_MAX,
        note: 'Diagnostic ranking-margin heuristic only; this is not a scam threshold.',
        cases: cases.filter((item) => item.top1_top2_similarity_margin !== null && item.top1_top2_similarity_margin <= AMBIGUOUS_MARGIN_MAX)
          .map((item) => ({ case_id: item.case_id, margin: item.top1_top2_similarity_margin, top_pattern: item.top_pattern }))
      },
      provisional_candidate_threshold_bands: {
        status: 'exploratory_only_not_production_safe',
        observed_negative_upper_region: negativeP75 === null ? null : [negativeP75, negativeMax],
        observed_known_pattern_lower_region: knownP25 === null ? null : [knownP25, knownMedian],
        overlap_present: negativeMax !== null && knownP25 !== null ? negativeMax >= knownP25 : null,
        note: 'Bands summarize this synthetic dataset and are not a selected decision threshold.'
      }
    },
    cases
  };
}

function buildMarkdownSummary(result) {
  const percent = (value) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const ambiguous = result.summary.ambiguous_margin_diagnostic.cases;
  const lines = [
    '# Semantic Pattern Calibration Summary', '',
    `Status: **${result.status}**`, '',
    `- Dataset cases: ${result.summary.total_cases}`,
    `- Known-pattern cases: ${result.summary.known_pattern_cases}`,
    `- Top-1 accuracy: ${percent(result.summary.top1_accuracy)}`,
    `- Top-3 recall: ${percent(result.summary.top3_recall)}`,
    `- Highest benign similarity: ${result.summary.highest_benign_similarity ?? 'n/a'}`,
    `- Highest borderline similarity: ${result.summary.highest_borderline_similarity ?? 'n/a'}`,
    `- Lowest correct-pattern similarity: ${result.summary.lowest_correct_pattern_similarity ?? 'n/a'}`,
    `- Ambiguous cases at ranking margin <= ${AMBIGUOUS_MARGIN_MAX}: ${ambiguous.length}`,
    '', '## Provisional candidate bands', '',
    'These bands are exploratory summaries of a small synthetic dataset. They are not a production-safe scam threshold.', '',
    '```json', JSON.stringify(result.summary.provisional_candidate_threshold_bands, null, 2), '```', '',
    '## Ambiguous cases', ''
  ];
  if (!ambiguous.length) lines.push('None observed under the diagnostic margin rule.');
  else for (const item of ambiguous) lines.push(`- ${item.case_id}: ${item.top_pattern}, margin ${item.margin}`);
  lines.push('', 'Threshold selection remains deferred until larger, representative runtime evaluation and false-positive review.');
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || argv[index + 1] === undefined) throw new Error('Arguments must use --name value pairs.');
    options[argv[index].slice(2)] = argv[index + 1];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(__dirname, '..');
  const datasetPath = path.resolve(repositoryRoot, options.dataset || 'tests/fixtures/semantic-calibration-cases.json');
  const inputPath = path.resolve(repositoryRoot, options.input || 'tests/results/semantic-calibration-raw.json');
  const outputPath = path.resolve(repositoryRoot, options.output || 'tests/results/semantic-calibration.json');
  const summaryPath = path.resolve(repositoryRoot, options.summary || 'tests/results/semantic-calibration-summary.md');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = buildCalibrationResult(dataset, raw);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(summaryPath, buildMarkdownSummary(result), 'utf8');
  process.stdout.write(`Wrote ${result.cases.length} calibrated cases.\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Calibration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { AMBIGUOUS_MARGIN_MAX, buildCalibrationResult, buildMarkdownSummary, distribution, sortPatterns };
