import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_FACT_RESOLUTION_MODES,
  resolveDailyFactFields,
} from '../src/daily-fact-resolution.js';

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

test('sparse cross-source ties keep complete field provenance stable without inventing empty-field sources', () => {
  const candidates = [
    candidate('form', 2000, { workItems: '表单版本' }),
    candidate('chat', 2000, { workItems: '群聊版本' }),
  ];
  const forward = resolveInOrder(candidates);
  const reverse = resolveInOrder([...candidates].reverse());

  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(forward.fieldSources.workItems.source, 'form');
  for (const key of ['tomorrowPlanItems', 'riskItems']) {
    assert.equal(forward.fieldSources[key].source, '');
    assert.equal(forward.fieldSources[key].sourceTime, 0);
    assert.match(forward.fieldSources[key].fingerprint, /^[a-f0-9]{64}$/);
  }
});

test('later blank from the same source preserves an existing non-empty field', () => {
  for (const mode of [
    DAILY_FACT_RESOLUTION_MODES.PERSISTED_INCREMENTAL,
    DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD,
  ]) {
    const result = resolveInOrder([
      candidate('form', 1000, { tomorrowPlanItems: '保留的计划' }),
      candidate('form', 2000, { tomorrowPlanItems: '' }),
    ], mode);

    assert.equal(result.values.tomorrowPlanItems, '保留的计划');
    assert.equal(result.fieldSources.tomorrowPlanItems.source, 'form');
    assert.equal(result.fieldSources.tomorrowPlanItems.sourceTime, 1000);
    assert.equal(result.mergeStatus, '单来源');
  }
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

test('source rebuild converges revised candidates independently of arrival order', () => {
  const candidates = [
    candidate('form', 1000, { workItems: '表单旧版本' }),
    candidate('chat', 2000, { workItems: '已收敛版本' }),
    candidate('form', 3000, { workItems: '已收敛版本' }),
  ];
  const forward = resolveInOrder(candidates, DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD);
  const reverse = resolveInOrder([...candidates].reverse(), DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD);

  assert.deepEqual(reverse.values, forward.values);
  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(reverse.mergeStatus, forward.mergeStatus);
  assert.equal(reverse.conflictStatus, forward.conflictStatus);
  assert.equal(reverse.autoResolutionNote, forward.autoResolutionNote);
  assert.equal(forward.values.workItems, '已收敛版本');
  assert.equal(forward.fieldSources.workItems.source, 'form');
  assert.equal(forward.fieldSources.workItems.sourceTime, 3000);
  assert.equal(forward.mergeStatus, '重复已合并');
  assert.equal(forward.conflictStatus, '无冲突');
  assert.equal(forward.autoResolutionNote, '');
});

test('source rebuild is stable across all revisions permutations', () => {
  const candidates = [
    candidate('form', 1000, { workItems: 'old-form' }),
    candidate('form', 3000, { workItems: 'final' }),
    candidate('chat', 2000, { workItems: 'old-chat' }),
    candidate('chat', 4000, { workItems: 'final' }),
  ];
  const results = permutations(candidates).map(order => (
    resolveInOrder(order, DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD)
  ));
  const expected = comparableResolution(results[0]);

  assert.equal(results.length, 24);
  for (const result of results) {
    assert.deepEqual(comparableResolution(result), expected);
    assert.deepEqual(result.values, {
      workItems: 'final',
      tomorrowPlanItems: '',
      riskItems: '',
    });
    assert.equal(result.fieldSources.workItems.source, 'chat');
    assert.equal(result.fieldSources.workItems.sourceTime, 4000);
    assert.equal(result.mergeStatus, '重复已合并');
    assert.equal(result.conflictStatus, '无冲突');
    assert.equal(result.autoResolutionNote, '');
  }
});

test('same-source equal-time normalized equivalents use a stable raw-text tie-breaker', () => {
  const candidates = [
    candidate('chat', 2000, { workItems: '  1. same\n' }),
    candidate('chat', 2000, { workItems: '1、same' }),
  ];
  const forward = resolveInOrder(candidates, DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD);
  const reverse = resolveInOrder([...candidates].reverse(), DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD);

  assert.deepEqual(reverse.values, forward.values);
  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(forward.values.workItems, '1、same');
  assert.equal(forward.mergeStatus, '单来源');
  assert.equal(forward.conflictStatus, '无冲突');
  assert.equal(forward.autoResolutionNote, '');
});

test('persisted incremental normalized equivalents use the same stable raw-text tie-breaker', () => {
  const candidates = [
    candidate('chat', 2000, { workItems: '  1. same\n' }),
    candidate('chat', 2000, { workItems: '1、same' }),
  ];
  const forward = resolveInOrder(candidates);
  const reverse = resolveInOrder([...candidates].reverse());

  assert.deepEqual(reverse.values, forward.values);
  assert.deepEqual(reverse.fieldSources, forward.fieldSources);
  assert.equal(forward.values.workItems, '1、same');
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

test('persisted incremental conflict is retained while source rebuild can clear convergence', () => {
  const formOld = candidate('form', 1000, { workItems: '表单旧版本' });
  const chat = candidate('chat', 2000, { workItems: '已收敛版本' });
  const formNew = candidate('form', 3000, { workItems: '已收敛版本' });
  const persisted = resolveInOrder([formOld, chat], DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD);

  const incremental = resolveDailyFactFields({
    existing: persisted,
    incoming: candidate('chat', 4000, { tomorrowPlanItems: '群聊计划' }),
  });
  const rebuilt = resolveInOrder(
    [formOld, chat, formNew],
    DAILY_FACT_RESOLUTION_MODES.SOURCE_REBUILD,
  );

  assert.equal(incremental.conflictStatus, '已自动处理');
  assert.equal(incremental.mergeStatus, '按字段取最新');
  assert.equal(rebuilt.conflictStatus, '无冲突');
  assert.equal(rebuilt.mergeStatus, '重复已合并');
  assert.equal(rebuilt.autoResolutionNote, '');
});

function resolveInOrder(candidates, mode) {
  return candidates.reduce(
    (existing, incoming) => resolveDailyFactFields({ existing, incoming, mode }),
    null,
  );
}

function comparableResolution(result) {
  return {
    values: result.values,
    fieldSources: result.fieldSources,
    mergeStatus: result.mergeStatus,
    conflictStatus: result.conflictStatus,
    autoResolutionNote: result.autoResolutionNote,
  };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => (
    permutations(items.filter((_, candidateIndex) => candidateIndex !== index))
      .map(rest => [item, ...rest])
  ));
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
