import path from 'node:path';
import { classifyWeeklyCandidates } from './weekly-semantic-classifier.js';

const DUPLICATE_CODES = new Set([
  'classification_duplicate_input',
  'classification_duplicate_result',
  'classification_multi_target',
]);

export async function evaluateWeeklyClassification({ items = [], aiProvider } = {}) {
  validateLabelItems(items);
  const candidates = items.map(({ expectedTargetId: _expectedTargetId, ...candidate }) => candidate);
  const classificationResult = await classifyWeeklyCandidates({ candidates, aiProvider });
  return calculateWeeklyClassificationEvaluation({ items, classificationResult });
}

export function calculateWeeklyClassificationEvaluation({ items = [], classificationResult = {} } = {}) {
  validateLabelItems(items);
  const expectedById = new Map(items.map(item => [normalized(item.evidenceId), item]));
  const rowsById = new Map();
  const pendingIds = new Set();
  const diagnostics = (classificationResult.diagnostics || []).map(safeDiagnostic);
  const unauthorizedIds = new Set(diagnostics
    .filter(item => item.code === 'classification_unauthorized_target')
    .map(item => item.evidenceId));
  const duplicateOrMultiTargetIds = new Set(diagnostics
    .filter(item => DUPLICATE_CODES.has(item.code))
    .map(item => item.evidenceId));
  for (const item of classificationResult.pendingOwnerReview || []) {
    pendingIds.add(normalized(item?.evidenceId));
  }
  for (const item of [
    ...(classificationResult.accepted || []),
    ...(classificationResult.pendingOwnerReview || []),
  ]) {
    const evidenceId = normalized(item?.evidenceId);
    if (!expectedById.has(evidenceId)) continue;
    if (!rowsById.has(evidenceId)) rowsById.set(evidenceId, []);
    rowsById.get(evidenceId).push(item);
  }

  const predictions = [];
  let classified = 0;
  let correct = 0;
  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;
  let visibleLowConfidence = 0;

  for (const label of items) {
    const evidenceId = normalized(label.evidenceId);
    const expectedTargetId = normalized(label.expectedTargetId);
    const rows = rowsById.get(evidenceId) || [];
    if (rows.length > 1) {
      duplicateOrMultiTargetIds.add(evidenceId);
      continue;
    }
    if (rows.length !== 1) continue;
    const row = rows[0];
    const targetId = normalized(row?.selectedTarget?.targetId || row?.classification?.targetId);
    const confidence = normalized(row?.classification?.confidence).toLowerCase();
    const allowedTargetIds = new Set((label.allowedTargets || []).map(target => normalized(target?.targetId)));
    if (!allowedTargetIds.has(targetId)) {
      unauthorizedIds.add(evidenceId);
      continue;
    }
    if (!['high', 'medium', 'low'].includes(confidence)) continue;

    classified += 1;
    if (targetId === expectedTargetId) correct += 1;
    if (confidence === 'high') highConfidence += 1;
    if (confidence === 'medium') mediumConfidence += 1;
    if (confidence === 'low') {
      lowConfidence += 1;
      if (pendingIds.has(evidenceId)) visibleLowConfidence += 1;
    }
    predictions.push({
      evidenceId,
      expectedTargetId,
      actualTargetId: targetId,
      confidence,
      status: pendingIds.has(evidenceId) ? 'pending_owner_review' : 'accepted',
      correct: targetId === expectedTargetId,
    });
  }

  const accuracy = classified ? correct / classified : 0;
  const lowConfidenceVisible = visibleLowConfidence === lowConfidence;
  const unauthorized = unauthorizedIds.size;
  const duplicateOrMultiTarget = duplicateOrMultiTargetIds.size;
  const metrics = {
    total: items.length,
    classified,
    correct,
    highConfidence,
    mediumConfidence,
    lowConfidence,
    failed: items.length - classified,
    unauthorized,
    duplicateOrMultiTarget,
    visibleLowConfidence,
    accuracy,
  };
  return {
    mode: 'local_classification_evaluation',
    provider: normalized(classificationResult.provider),
    model: normalized(classificationResult.model),
    metrics,
    gate: {
      minimumAccuracy: 0.9,
      accuracyPassed: accuracy >= 0.9,
      unauthorizedPassed: unauthorized === 0,
      duplicateOrMultiTargetPassed: duplicateOrMultiTarget === 0,
      lowConfidenceVisible,
      passed: accuracy >= 0.9
        && unauthorized === 0
        && duplicateOrMultiTarget === 0
        && lowConfidenceVisible,
    },
    predictions: predictions.sort(compareEvidence),
    diagnostics: diagnostics.sort(compareEvidence),
  };
}

export async function runWeeklyClassificationEvaluationCli({
  argv = process.argv.slice(2),
  createAiProvider,
  readFile,
  mkdir,
  realpath,
  lstat,
  writeFile,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
  processRef = process,
} = {}) {
  try {
    const options = parseEvaluationArgs(argv);
    const cwd = processRef.cwd?.() || process.cwd();
    validateRelativePath(options.inputPath, cwd);
    validateRelativePath(options.outputPath, cwd);
    const inputPath = await resolveSafeInputPath({ cwd, inputPath: options.inputPath, realpath, lstat });
    await mkdir(path.dirname(path.resolve(cwd, options.outputPath)), { recursive: true });
    const outputPath = await resolveSafeOutputPath({ cwd, outputPath: options.outputPath, realpath, lstat });
    const labels = parseLabelFile(await readFile(inputPath, 'utf8'));
    const aiProvider = createAiProvider();
    if (aiProvider?.name !== 'openai-compatible') {
      throw new Error('weekly:classification-eval requires AI_PROVIDER=openai-compatible');
    }
    if (!normalized(aiProvider.apiKey)) {
      throw new Error('weekly:classification-eval requires an AI API key');
    }

    const report = await evaluateWeeklyClassification({ items: labels.items, aiProvider });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(outputPath, output, { encoding: 'utf8', flag: 'wx' });
    stdout(output);
    processRef.exitCode = report.gate.passed ? 0 : 2;
    return report;
  } catch (error) {
    stderr(`[weekly:classification-eval] ${safeCliError(error)}\n`);
    processRef.exitCode = 1;
    return null;
  }
}

export function parseEvaluationArgs(argv = []) {
  const options = { inputPath: '', outputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--input', '--output'].includes(option)) throw new Error('Invalid arguments');
    const value = argv[index + 1];
    if (!value || String(value).startsWith('--')) throw new Error('Invalid arguments');
    if (option === '--input') options.inputPath = value;
    if (option === '--output') options.outputPath = value;
    index += 1;
  }
  if (!options.inputPath || !options.outputPath) throw new Error('Invalid arguments');
  return options;
}

function validateLabelItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Invalid label file');
  const evidenceIds = new Set();
  for (const item of items) {
    const evidenceId = normalized(item?.evidenceId);
    const expectedTargetId = normalized(item?.expectedTargetId);
    const allowedTargetIds = new Set((item?.allowedTargets || []).map(target => normalized(target?.targetId)));
    if (!evidenceId || evidenceIds.has(evidenceId)
      || !normalized(item?.date)
      || !normalized(item?.text)
      || !expectedTargetId
      || !allowedTargetIds.has(expectedTargetId)) {
      throw new Error('Invalid label file');
    }
    evidenceIds.add(evidenceId);
  }
}

function parseLabelFile(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    validateLabelItems(parsed?.items);
    return parsed;
  } catch {
    throw new Error('Invalid label file');
  }
}

async function resolveSafeInputPath({ cwd, inputPath, realpath, lstat }) {
  validateRelativePath(inputPath, cwd);
  const [realCwd, realInput] = await Promise.all([
    realpath(cwd),
    realpath(path.resolve(cwd, inputPath)),
  ]);
  if (!isWithin(realCwd, realInput)) throw new Error('Invalid input path');
  const stats = await lstat(realInput);
  if (!stats.isFile()) throw new Error('Invalid input path');
  return realInput;
}

async function resolveSafeOutputPath({ cwd, outputPath, realpath, lstat }) {
  validateRelativePath(outputPath, cwd);
  const target = path.resolve(cwd, outputPath);
  const [realCwd, realParent] = await Promise.all([
    realpath(cwd),
    realpath(path.dirname(target)),
  ]);
  if (!isWithin(realCwd, realParent)) throw new Error('Invalid output path');
  try {
    await lstat(target);
    throw new Error('Invalid output path');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

function validateRelativePath(value, cwd) {
  const candidate = normalized(value);
  if (!candidate || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
    || candidate.split(/[\\/]+/).includes('..')) {
    throw new Error('Invalid path');
  }
  const relative = path.relative(cwd, path.resolve(cwd, candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid path');
}

function safeDiagnostic(diagnostic) {
  return {
    evidenceId: normalized(diagnostic?.evidenceId),
    code: normalized(diagnostic?.code) || 'classification_failed',
  };
}

function safeCliError(error) {
  if (error?.message === 'weekly:classification-eval requires AI_PROVIDER=openai-compatible') {
    return error.message;
  }
  return 'weekly:classification-eval failed';
}

function compareEvidence(left, right) {
  return normalized(left?.evidenceId).localeCompare(normalized(right?.evidenceId));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalized(value) {
  return String(value || '').trim();
}
