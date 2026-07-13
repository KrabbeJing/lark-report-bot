import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOperationalError } from '../src/operational-log.js';
import { formatSchedulerFailure } from '../src/scheduler.js';
import { hasWeeklyEnsureFailures, summarizeWeeklyEnsureResult } from '../src/weekly-instance-cli-summary.js';
import {
  buildSheetPosterParsedLogMetadata,
  buildSheetPosterRenderedLogMetadata,
} from '../src/sheet-poster.js';

const sensitiveError = {
  code: 'SDK_FAIL',
  weeklyInstanceStage: 'copy_sheet',
  message: 'report content secret oc_chat shtcn_workbook',
  response: { data: { code: 99991663, msg: 'raw response om_message' } },
};

test('handler-facing error summary allows only code and stage metadata', () => {
  const summary = formatOperationalError(sensitiveError, { stage: 'handler' });
  assert.equal(summary, 'code=99991663 stage=handler');
  assert.doesNotMatch(summary, /SDK_FAIL|secret|oc_chat|shtcn_workbook|raw response|om_message/);
});

test('scheduler-facing error summary excludes raw SDK response data', () => {
  const summary = formatSchedulerFailure('weekly instance creation', sensitiveError);
  assert.equal(summary, '[scheduler] weekly instance creation failed code=99991663 stage=copy_sheet');
  assert.doesNotMatch(summary, /secret|oc_chat|shtcn_workbook|raw response|om_message/);
});

test('CLI-facing weekly ensure summary excludes raw error text and IDs', () => {
  const summary = summarizeWeeklyEnsureResult({
    group: '公司项目组',
    instanceKey: '2026-W29',
    error: sensitiveError,
  });
  assert.deepEqual(summary, {
    group: '公司项目组',
    skipped: undefined,
    reason: undefined,
    reused: undefined,
    instanceKey: '2026-W29',
    error: { code: '99991663', stage: 'copy_sheet' },
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret|oc_chat|shtcn_workbook|raw response|om_message/);
  assert.equal(hasWeeklyEnsureFailures([{ error: sensitiveError }]), true);
  assert.equal(hasWeeklyEnsureFailures([{ skipped: true }]), false);
});

test('CLI-facing weekly ensure summary masks a fallback ChatID while preserving project labels', () => {
  const chatResult = summarizeWeeklyEnsureResult({ group: 'oc_secret_chat' });
  const projectResult = summarizeWeeklyEnsureResult({ group: '数字金融部' });

  assert.equal(chatResult.group, '[masked-id]');
  assert.equal(projectResult.group, '数字金融部');
  assert.doesNotMatch(JSON.stringify(chatResult), /oc_secret_chat/);
});

test('sheet poster log metadata contains counts and duration only', () => {
  const parsed = buildSheetPosterParsedLogMetadata({
    title: 'confidential report title',
    period: 'confidential report period',
    metrics: ['a', 'b'],
    projects: ['a'],
    managementCategories: ['a', 'b', 'c'],
  });
  const rendered = buildSheetPosterRenderedLogMetadata(123);

  assert.deepEqual(parsed, { metricCount: 2, projectCount: 1, managementCategoryCount: 3 });
  assert.deepEqual(rendered, { durationMs: 123 });
  assert.doesNotMatch(JSON.stringify({ parsed, rendered }), /confidential|report title|report period|om_|oc_|shtcn_|\//);
});
