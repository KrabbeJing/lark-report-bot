import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  calculateWeeklyClassificationEvaluation,
  evaluateWeeklyClassification,
  runWeeklyClassificationEvaluationCli,
} from '../src/weekly-classification-evaluation.js';

function item(index, expectedTargetId = `target-${index}`) {
  return {
    evidenceId: `case-${index}`,
    date: '2026-07-28',
    text: `Synthetic work item ${index}`,
    allowedTargets: [{
      targetId: expectedTargetId,
      module: 'module2',
      target: `Section ${index}`,
      contentType: '本周重点事项说明',
      businessScope: 'Synthetic scope',
      includeTopics: [],
      excludeTopics: [],
      positiveExamples: [],
      negativeExamples: [],
    }],
    expectedTargetId,
  };
}

function joined(source, targetId, confidence) {
  return {
    ...source,
    selectedTarget: { targetId },
    classification: {
      evidenceId: source.evidenceId,
      targetId,
      confidence,
      reason: 'synthetic reason',
    },
  };
}

test('calculates a passing 90 percent gate with visible low-confidence items', () => {
  const items = Array.from({ length: 10 }, (_, index) => item(index));
  items[8].allowedTargets.push({
    ...items[8].allowedTargets[0],
    targetId: 'wrong-target',
    target: 'Alternative allowed section',
  });
  const accepted = items.slice(0, 9).map((source, index) => joined(
    source,
    index === 8 ? 'wrong-target' : source.expectedTargetId,
    index === 8 ? 'medium' : 'high',
  ));
  const pendingOwnerReview = [joined(items[9], items[9].expectedTargetId, 'low')];

  const report = calculateWeeklyClassificationEvaluation({
    items,
    classificationResult: { accepted, pendingOwnerReview, diagnostics: [] },
  });

  assert.deepEqual(report.metrics, {
    total: 10,
    classified: 10,
    correct: 9,
    highConfidence: 8,
    mediumConfidence: 1,
    lowConfidence: 1,
    failed: 0,
    unauthorized: 0,
    duplicateOrMultiTarget: 0,
    visibleLowConfidence: 1,
    accuracy: 0.9,
  });
  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.lowConfidenceVisible, true);
  assert.equal(JSON.stringify(report).includes('Synthetic work item'), false);
});

test('fails closed for missing unauthorized duplicate and hidden-low results without leaking errors', () => {
  const items = [item(1), item(2), item(3), item(4)];
  const hiddenLow = joined(items[1], items[1].expectedTargetId, 'low');
  const report = calculateWeeklyClassificationEvaluation({
    items,
    classificationResult: {
      accepted: [joined(items[0], items[0].expectedTargetId, 'high'), hiddenLow],
      pendingOwnerReview: [],
      diagnostics: [
        { evidenceId: items[2].evidenceId, code: 'classification_unauthorized_target', detail: 'secret provider body' },
        { evidenceId: items[3].evidenceId, code: 'classification_duplicate_result', error: new Error('API_KEY=secret') },
      ],
    },
  });

  assert.equal(report.metrics.total, 4);
  assert.equal(report.metrics.classified, 2);
  assert.equal(report.metrics.correct, 2);
  assert.equal(report.metrics.lowConfidence, 1);
  assert.equal(report.metrics.visibleLowConfidence, 0);
  assert.equal(report.metrics.failed, 2);
  assert.equal(report.metrics.unauthorized, 1);
  assert.equal(report.metrics.duplicateOrMultiTarget, 1);
  assert.equal(report.gate.passed, false);
  assert.equal(report.gate.lowConfidenceVisible, false);
  assert.deepEqual(report.diagnostics, [
    { evidenceId: 'case-3', code: 'classification_unauthorized_target' },
    { evidenceId: 'case-4', code: 'classification_duplicate_result' },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /secret|API_KEY|provider body/);
});

test('evaluates labels through only the strict weekly candidate classifier', async () => {
  const items = [item(1), item(2)];
  let classifyCalls = 0;
  let fallbackCalls = 0;
  const report = await evaluateWeeklyClassification({
    items,
    aiProvider: {
      name: 'fake',
      model: 'fake-model',
      classifyWeeklyEvidence: async ({ items: modelItems }) => {
        classifyCalls += 1;
        return {
          classifications: modelItems.map(modelItem => ({
            evidenceId: modelItem.evidenceId,
            targetId: modelItem.allowedTargets[0].targetId,
            confidence: 'high',
            reason: 'synthetic',
          })),
        };
      },
      summarizeWeeklyReports: async () => { fallbackCalls += 1; },
      generateWeeklySheetPreview: async () => { fallbackCalls += 1; },
    },
  });

  assert.equal(classifyCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(report.gate.passed, true);
});

test('CLI writes a new sanitized report and rejects an existing or symlink output', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'weekly-classification-eval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'out'));
  await writeFile(path.join(cwd, 'out', 'labels.json'), JSON.stringify({ items: [item(1)] }));
  const provider = {
    name: 'openai-compatible',
    apiKey: 'test-key',
    classifyWeeklyEvidence: async ({ items: modelItems }) => ({
      classifications: modelItems.map(modelItem => ({
        evidenceId: modelItem.evidenceId,
        targetId: modelItem.allowedTargets[0].targetId,
        confidence: 'high',
        reason: 'synthetic',
      })),
    }),
  };
  const processRef = { cwd: () => cwd, exitCode: 0 };

  const report = await runWeeklyClassificationEvaluationCli({
    argv: ['--input', 'out/labels.json', '--output', 'out/report.json'],
    createAiProvider: () => provider,
    readFile,
    mkdir,
    realpath,
    lstat,
    writeFile,
    processRef,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(report.gate.passed, true);
  const serialized = await readFile(path.join(cwd, 'out', 'report.json'), 'utf8');
  assert.doesNotMatch(serialized, /Synthetic work item|test-key/);

  let providerCalls = 0;
  const existing = await runWeeklyClassificationEvaluationCli({
    argv: ['--input', 'out/labels.json', '--output', 'out/report.json'],
    createAiProvider: () => { providerCalls += 1; return provider; },
    readFile,
    mkdir,
    realpath,
    lstat,
    writeFile,
    processRef,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(existing, null);
  assert.equal(providerCalls, 0);
  assert.equal(processRef.exitCode, 1);

  await symlink('missing.json', path.join(cwd, 'out', 'symlink-report.json'));
  const symlinkResult = await runWeeklyClassificationEvaluationCli({
    argv: ['--input', 'out/labels.json', '--output', 'out/symlink-report.json'],
    createAiProvider: () => provider,
    readFile,
    mkdir,
    realpath,
    lstat,
    writeFile,
    processRef,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(symlinkResult, null);
  assert.equal(processRef.exitCode, 1);
});

test('CLI rejects output traversal before creating any directory', async () => {
  let mkdirCalls = 0;
  let providerCalls = 0;
  const processRef = { cwd: () => '/safe/workspace', exitCode: 0 };
  const result = await runWeeklyClassificationEvaluationCli({
    argv: ['--input', 'out/labels.json', '--output', '../outside/report.json'],
    createAiProvider: () => { providerCalls += 1; return {}; },
    readFile: async () => '',
    mkdir: async () => { mkdirCalls += 1; },
    realpath: async value => value,
    lstat: async () => ({ isFile: () => true }),
    writeFile: async () => {},
    processRef,
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(result, null);
  assert.equal(mkdirCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(processRef.exitCode, 1);
});
