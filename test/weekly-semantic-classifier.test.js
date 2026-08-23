import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWeeklyCandidates } from '../src/weekly-semantic-classifier.js';

function target(targetId, overrides = {}) {
  return {
    targetId,
    module: 'module2',
    target: `板块-${targetId}`,
    contentType: '本周重点事项说明',
    cells: ['C26'],
    businessScope: `${targetId}业务范围`,
    includeTopics: [`${targetId}主题`],
    excludeTopics: [],
    positiveExamples: [`${targetId}正例`],
    negativeExamples: [],
    ...overrides,
  };
}

function candidate(evidenceId, targetIds = [`target-${evidenceId}`], overrides = {}) {
  return {
    evidenceId,
    factRecordId: `rec-${evidenceId}`,
    member: `成员-${evidenceId}`,
    memberOpenId: `ou-${evidenceId}`,
    date: '2026-07-28',
    text: `完成事项-${evidenceId}`,
    allowedTargets: targetIds.map(targetId => target(targetId)),
    ...overrides,
  };
}

function classification(evidenceId, targetId, confidence = 'high', reason = '语义明确') {
  return { evidenceId, targetId, confidence, reason };
}

test('batches deterministically and separates accepted and low-confidence results', async () => {
  const calls = [];
  const provider = {
    name: 'fake-provider',
    model: 'fake-model',
    classifyWeeklyEvidence: async ({ items }) => {
      calls.push(items);
      return {
        classifications: items.map(item => classification(
          item.evidenceId,
          item.allowedTargets[0].targetId,
          item.evidenceId === 'c' ? 'low' : item.evidenceId === 'b' ? 'medium' : 'high',
        )).reverse(),
        provider: 'fake-provider',
        model: 'fake-model',
      };
    },
  };

  const result = await classifyWeeklyCandidates({
    candidates: [candidate('c'), candidate('a'), candidate('b')],
    aiProvider: provider,
    maxItems: 2,
    maxCharacters: 12000,
  });

  assert.deepEqual(calls.map(items => items.map(item => item.evidenceId)), [['a', 'b'], ['c']]);
  assert.equal(JSON.stringify(calls).includes('成员-'), false);
  assert.equal(JSON.stringify(calls).includes('ou-'), false);
  assert.equal(JSON.stringify(calls).includes('rec-'), false);
  assert.equal(JSON.stringify(calls).includes('C26'), false);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['a', 'b']);
  assert.deepEqual(result.accepted.map(item => item.classification.confidence), ['high', 'medium']);
  assert.deepEqual(result.pendingOwnerReview.map(item => item.evidenceId), ['c']);
  assert.equal(result.pendingOwnerReview[0].text, '完成事项-c');
  assert.equal(result.pendingOwnerReview[0].selectedTarget.targetId, 'target-c');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.provider, 'fake-provider');
  assert.equal(result.model, 'fake-model');
});

test('defaults to batches of at most five items to prevent cross-item anchoring', async () => {
  const calls = [];
  const candidates = Array.from({ length: 11 }, (_, index) => candidate(`case-${index + 1}`));
  const result = await classifyWeeklyCandidates({
    candidates,
    aiProvider: {
      classifyWeeklyEvidence: async ({ items }) => {
        calls.push(items.map(item => item.evidenceId));
        return {
          classifications: items.map(item => classification(
            item.evidenceId,
            item.allowedTargets[0].targetId,
          )),
        };
      },
    },
  });

  assert.deepEqual(calls.map(items => items.length), [5, 5, 1]);
  assert.equal(result.accepted.length, 11);
  assert.deepEqual(result.diagnostics, []);
});

test('exposes matched target topics as hints without turning them into hard routing', async () => {
  let modelItem;
  const result = await classifyWeeklyCandidates({
    candidates: [candidate('hinted', [], {
      text: '完成新银联前置强化轮测试',
      allowedTargets: [
        target('receipt', {
          target: '收单项目组',
          includeTopics: ['收单'],
          excludeTopics: ['银联前置'],
        }),
        target('corporate', {
          module: 'module3',
          target: '对公客群经营及场景建设',
          includeTopics: ['银联前置', '云缴费'],
          excludeTopics: ['收单'],
        }),
      ],
    })],
    aiProvider: {
      classifyWeeklyEvidence: async ({ items }) => {
        [modelItem] = items;
        return {
          classifications: [classification('hinted', 'receipt')],
        };
      },
    },
  });

  assert.deepEqual(modelItem.allowedTargets.map(item => ({
    targetId: item.targetId,
    matchedIncludeTopics: item.matchedIncludeTopics,
    matchedExcludeTopics: item.matchedExcludeTopics,
  })), [
    { targetId: 'receipt', matchedIncludeTopics: [], matchedExcludeTopics: ['银联前置'] },
    { targetId: 'corporate', matchedIncludeTopics: ['银联前置'], matchedExcludeTopics: [] },
  ]);
  assert.deepEqual(result.accepted.map(item => item.selectedTarget.targetId), ['receipt']);
  assert.deepEqual(result.diagnostics, []);
});

test('isolates missing duplicate unauthorized and malformed classifications per item', async () => {
  let calls = 0;
  let fallbackCalls = 0;
  const provider = {
    classifyWeeklyEvidence: async () => {
      calls += 1;
      return {
        classifications: [
          classification('good', 'target-good'),
          classification('unauthorized', 'target-other'),
          classification('duplicate', 'target-duplicate'),
          classification('duplicate', 'target-duplicate'),
          classification('bad-confidence', 'target-bad-confidence', 'certain'),
          classification('bad-reason', 'target-bad-reason', 'high', ''),
          classification('unknown', 'target-unknown'),
        ],
      };
    },
    summarizeWeeklyReports: async () => { fallbackCalls += 1; },
    summarizeWeeklySheet: async () => { fallbackCalls += 1; },
  };
  const candidates = [
    candidate('good'),
    candidate('unauthorized'),
    candidate('duplicate'),
    candidate('bad-confidence'),
    candidate('bad-reason'),
    candidate('missing'),
  ];

  const result = await classifyWeeklyCandidates({
    candidates,
    aiProvider: provider,
    maxItems: 20,
    maxCharacters: 12000,
  });

  assert.equal(calls, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['good']);
  assert.deepEqual(result.pendingOwnerReview, []);
  assert.deepEqual(result.diagnostics.map(item => [item.evidenceId, item.code]), [
    ['bad-confidence', 'classification_invalid_confidence'],
    ['bad-reason', 'classification_invalid_reason'],
    ['duplicate', 'classification_duplicate_result'],
    ['missing', 'classification_missing_result'],
    ['unauthorized', 'classification_unauthorized_target'],
    ['unknown', 'classification_unknown_evidence'],
  ]);
});

test('retries provider errors once per batch and continues with later batches', async () => {
  let calls = 0;
  const waits = [];
  const provider = {
    classifyWeeklyEvidence: async ({ items }) => {
      calls += 1;
      if (items.some(item => item.evidenceId === 'a')) {
        throw Object.assign(new Error('private provider failure'), {
          retryable: true,
          retryAfterMs: 250,
        });
      }
      return {
        classifications: items.map(item => classification(
          item.evidenceId,
          item.allowedTargets[0].targetId,
        )),
        provider: 'recovered-provider',
        model: 'recovered-model',
      };
    },
  };

  const result = await classifyWeeklyCandidates({
    candidates: [candidate('a'), candidate('b'), candidate('c')],
    aiProvider: provider,
    maxItems: 2,
    maxCharacters: 12000,
    maxAttempts: 2,
    wait: async milliseconds => { waits.push(milliseconds); },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['c']);
  assert.deepEqual(result.diagnostics.map(item => [item.evidenceId, item.code]), [
    ['a', 'classification_provider_error'],
    ['b', 'classification_provider_error'],
  ]);
  assert.equal(JSON.stringify(result).includes('private provider failure'), false);
  assert.equal(result.provider, 'recovered-provider');
  assert.equal(result.model, 'recovered-model');
});

test('uses a safe default backoff when a retryable provider error has no retry-after hint', async () => {
  let calls = 0;
  const waits = [];
  const result = await classifyWeeklyCandidates({
    candidates: [candidate('a')],
    aiProvider: {
      classifyWeeklyEvidence: async ({ items }) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('temporary failure'), { retryable: true });
        return {
          classifications: items.map(item => classification(
            item.evidenceId,
            item.allowedTargets[0].targetId,
          )),
        };
      },
    },
    maxAttempts: 2,
    wait: async milliseconds => { waits.push(milliseconds); },
  });

  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['a']);
});

test('does not retry deterministic provider response errors', async () => {
  let calls = 0;
  const error = Object.assign(new Error('AI classification returned invalid JSON'), { retryable: false });
  const result = await classifyWeeklyCandidates({
    candidates: [candidate('a')],
    aiProvider: {
      classifyWeeklyEvidence: async () => {
        calls += 1;
        throw error;
      },
    },
    maxAttempts: 2,
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.diagnostics.map(item => item.code), ['classification_provider_error']);
});

test('rejects an oversized item without calling the provider for it', async () => {
  const calls = [];
  const result = await classifyWeeklyCandidates({
    candidates: [
      candidate('short'),
      candidate('oversized', ['target-oversized'], { text: '超'.repeat(5000) }),
    ],
    aiProvider: {
      classifyWeeklyEvidence: async ({ items }) => {
        calls.push(items.map(item => item.evidenceId));
        return {
          classifications: items.map(item => classification(
            item.evidenceId,
            item.allowedTargets[0].targetId,
          )),
        };
      },
    },
    maxCharacters: 1000,
  });

  assert.deepEqual(calls, [['short']]);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['short']);
  assert.deepEqual(result.diagnostics.map(item => [item.evidenceId, item.code]), [
    ['oversized', 'classification_input_too_large'],
  ]);
});

test('uses the character budget to form stable batches without splitting an item', async () => {
  const calls = [];
  const candidates = [candidate('a'), candidate('b'), candidate('c')];
  const singleLength = JSON.stringify({
    evidenceId: candidates[0].evidenceId,
    date: candidates[0].date,
    text: candidates[0].text,
    allowedTargets: candidates[0].allowedTargets.map(({ cells, ...item }) => ({
      ...item,
      matchedIncludeTopics: [],
      matchedExcludeTopics: [],
    })),
  }).length;
  const provider = {
    classifyWeeklyEvidence: async ({ items }) => {
      calls.push(items.map(item => item.evidenceId));
      return {
        classifications: items.map(item => classification(
          item.evidenceId,
          item.allowedTargets[0].targetId,
        )).reverse(),
      };
    },
  };

  const result = await classifyWeeklyCandidates({
    candidates: [...candidates].reverse(),
    aiProvider: provider,
    maxItems: 20,
    maxCharacters: singleLength + 20,
  });

  assert.deepEqual(calls, [['a'], ['b'], ['c']]);
  assert.deepEqual(result.accepted.map(item => item.evidenceId), ['a', 'b', 'c']);
});
