import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rebuildDailyFactFields,
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
  const source = result.fieldSources.workItems;
  assert.deepEqual(result.fieldSources.workItems, {
    source: 'form',
    sourceTime: 2000,
    fingerprint: source.fingerprint,
    sources: {
      form: {
        sourceTime: 2000,
        fingerprint: source.fingerprint,
      },
      chat: {
        sourceTime: 2000,
        fingerprint: source.sources.chat.fingerprint,
      },
    },
    relation: 'conflict',
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
  const candidates = [
    candidate('form', 1000, { tomorrowPlanItems: '保留的计划' }),
    candidate('form', 2000, { tomorrowPlanItems: '' }),
  ];
  const results = [
    resolveInOrder(candidates),
    rebuildDailyFactFields({ candidates }),
  ];

  for (const result of results) {
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
  const forward = rebuildDailyFactFields({ candidates });
  const reverse = rebuildDailyFactFields({ candidates: [...candidates].reverse() });

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
    rebuildDailyFactFields({ candidates: order })
  ));
  const expected = results[0];

  assert.equal(results.length, 24);
  for (const result of results) {
    assert.deepEqual(result, expected);
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
  const forward = rebuildDailyFactFields({ candidates });
  const reverse = rebuildDailyFactFields({ candidates: [...candidates].reverse() });

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
  const incremental = resolveDailyFactFields({
    existing: { factStatus: '忽略' },
    incoming: candidate('chat', 2000, { workItems: '群聊内容' }),
  });
  const rebuilt = rebuildDailyFactFields({
    candidates: [candidate('chat', 2000, { workItems: '群聊内容' })],
    existingFactStatus: '忽略',
  });

  assert.equal(incremental.factStatus, '忽略');
  assert.equal(rebuilt.factStatus, '忽略');
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
  const persisted = rebuildDailyFactFields({ candidates: [formOld, chat] });

  const incremental = resolveDailyFactFields({
    existing: persisted,
    incoming: candidate('chat', 4000, { tomorrowPlanItems: '群聊计划' }),
  });
  const rebuilt = rebuildDailyFactFields({ candidates: [formOld, chat, formNew] });

  assert.equal(incremental.conflictStatus, '已自动处理');
  assert.equal(incremental.mergeStatus, '按字段取最新');
  assert.equal(rebuilt.conflictStatus, '无冲突');
  assert.equal(rebuilt.mergeStatus, '重复已合并');
  assert.equal(rebuilt.autoResolutionNote, '');
});

test('JSON roundtrip preserves complementary coverage through blank and same-source updates', () => {
  const complementary = resolveInOrder([
    candidate('form', 1000, { workItems: '表单总结' }),
    candidate('chat', 2000, { tomorrowPlanItems: '群聊计划' }),
  ]);
  const afterBlank = resolveDailyFactFields({
    existing: jsonRoundtrip(complementary),
    incoming: candidate('chat', 3000),
  });
  const afterRevision = resolveDailyFactFields({
    existing: jsonRoundtrip(afterBlank),
    incoming: candidate('chat', 4000, { tomorrowPlanItems: '群聊新计划' }),
  });

  for (const result of [afterBlank, afterRevision]) {
    assert.equal(result.mergeStatus, '互补已合并');
    assert.equal(result.conflictStatus, '无冲突');
    assert.equal(result.autoResolutionNote, '');
    assert.equal(result.fieldSources.workItems.source, 'form');
    assert.equal(result.fieldSources.tomorrowPlanItems.source, 'chat');
  }
  assert.equal(afterBlank.values.tomorrowPlanItems, '群聊计划');
  assert.equal(afterRevision.values.tomorrowPlanItems, '群聊新计划');
  assert.equal(afterRevision.fieldSources.tomorrowPlanItems.sourceTime, 4000);
});

test('JSON roundtrip preserves conflict status and note through a blank refresh', () => {
  const conflicted = resolveInOrder([
    candidate('form', 1000, {
      workItems: '表单总结',
      tomorrowPlanItems: '表单计划',
    }),
    candidate('chat', 2000, { workItems: '群聊总结' }),
  ]);
  const result = resolveDailyFactFields({
    existing: jsonRoundtrip(conflicted),
    incoming: candidate('chat', 3000),
  });

  assert.equal(conflicted.mergeStatus, '按字段取最新');
  assert.equal(result.mergeStatus, conflicted.mergeStatus);
  assert.equal(result.conflictStatus, conflicted.conflictStatus);
  assert.equal(result.autoResolutionNote, conflicted.autoResolutionNote);
  assert.deepEqual(result.values, conflicted.values);
});

test('source rebuild is stable across all 120 mixed-candidate permutations', () => {
  const candidates = [
    candidate('form', 1000, { workItems: 'form-old', riskItems: 'form-risk' }),
    candidate('chat', 2000, { workItems: 'chat-old', tomorrowPlanItems: 'chat-plan' }),
    candidate('form', 3000, { workItems: 'final', tomorrowPlanItems: 'form-plan' }),
    candidate('chat', 4000, { workItems: 'final', riskItems: '' }),
    candidate('form', 3000, { workItems: '  final\n', riskItems: 'form-risk-v2' }),
  ];
  const results = permutations(candidates)
    .map(order => rebuildDailyFactFields({ candidates: order }));
  const expected = results[0];

  assert.equal(results.length, 120);
  for (const result of results) {
    assert.deepEqual(result, expected);
  }
});

test('legacy form+chat facts without snapshots use ambiguous provenance without inventing conflict', () => {
  const legacy = {
    values: {
      workItems: '历史总结',
      tomorrowPlanItems: '历史群聊计划',
      riskItems: '',
    },
    source: 'form+chat',
    effectiveSource: 'form+chat',
    observedSources: 'form+chat',
    sourceTime: '2000',
    mergeStatus: '互补已合并',
    conflictStatus: '无冲突',
    factStatus: '有效',
    autoResolutionNote: '',
  };
  const result = resolveDailyFactFields({
    existing: jsonRoundtrip(legacy),
    incoming: candidate('chat', 3000, { tomorrowPlanItems: '群聊计划修订' }),
  });

  assert.equal(result.values.workItems, '历史总结');
  assert.equal(result.values.tomorrowPlanItems, '群聊计划修订');
  assert.equal(result.mergeStatus, '互补已合并');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.autoResolutionNote, '');
  assert.equal(result.fieldSources.workItems.source, '');
  assert.equal(result.fieldSources.workItems.ambiguous, true);
  assert.equal(result.fieldSources.tomorrowPlanItems.source, 'chat');
  assert.equal(result.fieldSources.tomorrowPlanItems.ambiguous, true);
});

test('partial persisted provenance normalizes sourceTime and stale selected fingerprints', () => {
  const baseline = resolveDailyFactFields({
    incoming: candidate('chat', 2000, { workItems: '群聊总结' }),
  });
  const partial = jsonRoundtrip(baseline);
  partial.fieldSources.workItems.sourceTime = '2000';
  partial.fieldSources.workItems.fingerprint = 'stale';
  partial.fieldSources.workItems.sources.chat.sourceTime = '2000';
  partial.fieldSources.workItems.sources.chat.fingerprint = 'stale';

  const result = resolveDailyFactFields({
    existing: partial,
    incoming: candidate('chat', 3000),
  });

  assert.equal(typeof result.fieldSources.workItems.sourceTime, 'number');
  assert.equal(typeof result.fieldSources.workItems.sources.chat.sourceTime, 'number');
  assert.equal(result.fieldSources.workItems.sourceTime, 2000);
  assert.equal(result.fieldSources.workItems.sources.chat.sourceTime, 2000);
  assert.equal(
    result.fieldSources.workItems.fingerprint,
    baseline.fieldSources.workItems.fingerprint,
  );
  assert.equal(
    result.fieldSources.workItems.sources.chat.fingerprint,
    baseline.fieldSources.workItems.fingerprint,
  );
});

test('source rebuild output is plain JSON and never contains candidate body text', () => {
  const candidates = [
    candidate('form', 1000, {
      workItems: 'FORM_BODY_SENTINEL',
      tomorrowPlanItems: 'FORM_PLAN_SENTINEL',
    }),
    candidate('chat', 2000, {
      workItems: 'CHAT_BODY_SENTINEL',
      riskItems: 'CHAT_RISK_SENTINEL',
    }),
  ];
  const result = rebuildDailyFactFields({ candidates });
  const serializedSources = JSON.stringify(result.fieldSources);
  const serializedResult = JSON.stringify(result);

  assert.deepEqual(Object.getOwnPropertySymbols(result), []);
  assert.ok(!serializedSources.includes('FORM_BODY_SENTINEL'));
  assert.ok(!serializedSources.includes('FORM_PLAN_SENTINEL'));
  assert.ok(!serializedSources.includes('CHAT_BODY_SENTINEL'));
  assert.ok(!serializedSources.includes('CHAT_RISK_SENTINEL'));
  assert.ok(!serializedResult.includes('FORM_BODY_SENTINEL'));
  assert.ok(serializedResult.includes('CHAT_BODY_SENTINEL'));
  assert.deepEqual(jsonRoundtrip(result), result);
});

function resolveInOrder(candidates) {
  return candidates.reduce(
    (existing, incoming) => resolveDailyFactFields({ existing, incoming }),
    null,
  );
}

function jsonRoundtrip(value) {
  return JSON.parse(JSON.stringify(value));
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
