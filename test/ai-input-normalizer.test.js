import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyAiInputs } from '../src/ai-input-normalizer.js';

test('collapses multi-day rows from one source into one AI input', () => {
  const result = buildWeeklyAiInputs([
    report('2026-06-29', 'om_1', '完成A'),
    report('2026-06-30', 'om_1', '完成A'),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(result[0].dateRange, '2026-06-29~2026-06-30');
});

test('keeps equal text from distinct original submissions', () => {
  const result = buildWeeklyAiInputs([
    report('2026-06-29', 'om_1', '持续推进A'),
    report('2026-06-30', 'om_2', '持续推进A'),
  ]);
  assert.equal(result.length, 2);
});

test('uses effective form record id as the grouping key', () => {
  const result = buildWeeklyAiInputs([
    { ...report('2026-07-01', 'om_old', '表单内容'), effectiveSource: 'form', sourceRecordId: 'rec_form' },
    { ...report('2026-07-02', 'om_other', '表单内容'), effectiveSource: 'form', sourceRecordId: 'rec_form' },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].factRecordIds, ['fact-2026-07-01', 'fact-2026-07-02']);
});

test('does not use an opposite-source id when the effective source id is missing', () => {
  const result = buildWeeklyAiInputs([
    { ...report('2026-07-01', 'om_old', '表单内容A'), effectiveSource: 'form', sourceRecordId: '' },
    { ...report('2026-07-02', 'om_old', '表单内容B'), effectiveSource: 'form', sourceRecordId: '' },
  ]);
  assert.equal(result.length, 2);
});

function report(reportDate, messageId, text) {
  return {
    recordId: `fact-${reportDate}`,
    reportDate,
    messageId,
    effectiveSource: 'chat',
    workItems: [text],
  };
}
