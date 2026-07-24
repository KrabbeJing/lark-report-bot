import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDailyFactFields } from '../src/daily-fact-resolution.js';

test('later chat work keeps earlier non-empty form plan', () => {
  const form = candidate('form', 1000, {
    workItems: '表单总结',
    tomorrowPlanItems: '表单计划',
    riskItems: '',
  });
  const afterForm = resolveDailyFactFields({ incoming: form });
  const result = resolveDailyFactFields({
    existing: afterForm,
    incoming: candidate('chat', 2000, {
      workItems: '群聊总结',
      tomorrowPlanItems: '',
      riskItems: '',
    }),
  });

  assert.deepEqual(result.values, {
    workItems: '群聊总结',
    tomorrowPlanItems: '表单计划',
    riskItems: '',
  });
  assert.equal(result.fieldSources.workItems.source, 'chat');
  assert.equal(result.fieldSources.tomorrowPlanItems.source, 'form');
  assert.equal(result.observedSources, 'form+chat');
  assert.equal(result.effectiveSources, 'form+chat');
  assert.equal(result.mergeStatus, '按字段取最新');
  assert.equal(result.conflictStatus, '已自动处理');
  assert.equal(result.autoResolutionNote, '今日工作总结按来源时间采用群聊；明日工作计划保留表单');
  assert.ok(!result.autoResolutionNote.includes('表单总结'));
  assert.ok(!result.autoResolutionNote.includes('群聊总结'));
});

test('identical overlapping fields are duplicate merged', () => {
  const result = resolveInOrder([
    candidate('form', 1000, { workItems: '相同内容' }),
    candidate('chat', 2000, { workItems: '相同内容' }),
  ]);

  assert.equal(result.mergeStatus, '重复已合并');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.values.workItems, '相同内容');
  assert.equal(result.fieldSources.workItems.source, 'chat');
});

test('non-overlapping fields are complement merged', () => {
  const result = resolveInOrder([
    candidate('form', 1000, { workItems: '表单总结' }),
    candidate('chat', 2000, { tomorrowPlanItems: '群聊计划' }),
  ]);

  assert.equal(result.mergeStatus, '互补已合并');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.effectiveSources, 'form+chat');
});

test('form wins an exact cross-source timestamp tie', () => {
  const result = resolveInOrder([
    candidate('chat', 2000, { workItems: '群聊版本' }),
    candidate('form', 2000, { workItems: '表单版本' }),
  ]);

  assert.equal(result.values.workItems, '表单版本');
  assert.deepEqual(result.fieldSources.workItems, {
    source: 'form',
    sourceTime: 2000,
    fingerprint: result.fieldSources.workItems.fingerprint,
  });
  assert.equal(result.mergeStatus, '按字段取最新');
  assert.equal(result.conflictStatus, '已自动处理');
});

test('later blank from the same source preserves an existing non-empty field', () => {
  const result = resolveInOrder([
    candidate('form', 1000, { tomorrowPlanItems: '保留的计划' }),
    candidate('form', 2000, { tomorrowPlanItems: '' }),
  ]);

  assert.equal(result.values.tomorrowPlanItems, '保留的计划');
  assert.equal(result.fieldSources.tomorrowPlanItems.source, 'form');
  assert.equal(result.fieldSources.tomorrowPlanItems.sourceTime, 1000);
  assert.equal(result.mergeStatus, '单来源');
});

test('later same-source revision stays single-source without a conflict', () => {
  const result = resolveInOrder([
    candidate('form', 1000, { workItems: '旧版本' }),
    candidate('form', 2000, { workItems: '新版本' }),
  ]);

  assert.equal(result.values.workItems, '新版本');
  assert.equal(result.fieldSources.workItems.source, 'form');
  assert.equal(result.fieldSources.workItems.sourceTime, 2000);
  assert.equal(result.mergeStatus, '单来源');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.autoResolutionNote, '');
});

test('same-source equal-time revisions are deterministic without a conflict', () => {
  const candidates = [
    candidate('chat', 2000, { workItems: '版本甲' }),
    candidate('chat', 2000, { workItems: '版本乙' }),
  ];
  const forward = resolveInOrder(candidates);
  const reverse = resolveInOrder([...candidates].reverse());

  assert.deepEqual(reverse.values, forward.values);
  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(forward.mergeStatus, '单来源');
  assert.equal(forward.conflictStatus, '无冲突');
  assert.equal(forward.autoResolutionNote, '');
});

test('preserves manual ignore status', () => {
  const result = resolveDailyFactFields({
    existing: { factStatus: '忽略' },
    incoming: candidate('chat', 2000, { workItems: '群聊内容' }),
  });

  assert.equal(result.factStatus, '忽略');
});

test('keeps an unmatched candidate pending manual confirmation', () => {
  const result = resolveDailyFactFields({
    incoming: candidate('chat', 2000, { workItems: '群聊内容' }, '未匹配'),
  });

  assert.equal(result.factStatus, '待人工确认');
  assert.equal(result.mergeStatus, '单来源');
  assert.equal(result.conflictStatus, '无冲突');
});

test('replaying candidates in the opposite arrival order keeps values and provenance stable', () => {
  const candidates = [
    candidate('form', 1000, { workItems: '表单总结', tomorrowPlanItems: '表单计划' }),
    candidate('chat', 2000, { workItems: '群聊总结', riskItems: '群聊风险' }),
  ];
  const forward = resolveInOrder(candidates);
  const reverse = resolveInOrder([...candidates].reverse());

  assert.deepEqual(reverse.values, forward.values);
  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(reverse.observedSources, forward.observedSources);
  assert.equal(reverse.effectiveSources, forward.effectiveSources);
  assert.equal(reverse.sourceTime, forward.sourceTime);
  assert.equal(reverse.mergeStatus, forward.mergeStatus);
  assert.equal(reverse.conflictStatus, forward.conflictStatus);
  assert.equal(reverse.autoResolutionNote, forward.autoResolutionNote);
});

test('same-source refresh preserves a known automatic conflict marker', () => {
  const conflicted = resolveInOrder([
    candidate('form', 1000, { workItems: '表单总结' }),
    candidate('chat', 2000, { workItems: '群聊总结' }),
  ]);
  const result = resolveDailyFactFields({
    existing: conflicted,
    incoming: candidate('chat', 3000, { tomorrowPlanItems: '群聊计划' }),
  });

  assert.equal(result.conflictStatus, '已自动处理');
  assert.equal(result.mergeStatus, '按字段取最新');
});

function resolveInOrder(candidates) {
  return candidates.reduce(
    (existing, incoming) => resolveDailyFactFields({ existing, incoming }),
    null,
  );
}

function candidate(source, sourceTime, values = {}, matchingStatus = '已匹配') {
  return {
    source,
    sourceTime,
    matchingStatus,
    values: {
      workItems: '',
      tomorrowPlanItems: '',
      riskItems: '',
      ...values,
    },
  };
}
