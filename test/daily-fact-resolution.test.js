import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDailyFactCandidates, resolveIncrementalDailyFact } from '../src/daily-fact-resolution.js';

test('marks equal form and chat content as duplicate merged', () => {
  const result = resolveDailyFactCandidates({
    form: candidate('form', 1000, 'same', '已匹配'),
    chat: candidate('chat', 2000, 'same', '已匹配'),
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.mergeStatus, '重复已合并');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.factStatus, '有效');
});

test('uses the later source when content differs', () => {
  const result = resolveDailyFactCandidates({
    form: candidate('form', 1000, 'form', '已匹配'),
    chat: candidate('chat', 2000, 'chat', '已匹配'),
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.mergeStatus, '按时间取最新');
  assert.equal(result.conflictStatus, '已自动处理');
  assert.equal(result.autoResolutionNote, '按来源时间采用群聊版本');
});

test('uses form on an exact source-time tie', () => {
  const result = resolveDailyFactCandidates({
    form: candidate('form', 2000, 'form', '姓名匹配'),
    chat: candidate('chat', 2000, 'chat', '已匹配'),
  });
  assert.equal(result.winner.source, 'form');
});

test('preserves manual ignore status', () => {
  const result = resolveDailyFactCandidates({
    chat: candidate('chat', 2000, 'chat', '已匹配'),
    existingFactStatus: '忽略',
  });
  assert.equal(result.factStatus, '忽略');
});

test('keeps unmatched facts pending without a content conflict', () => {
  const result = resolveDailyFactCandidates({
    chat: candidate('chat', 2000, 'chat', '未匹配'),
  });
  assert.equal(result.mergeStatus, '单来源');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.factStatus, '待人工确认');
});

test('incremental merge lets a later chat version replace form content', () => {
  const result = resolveIncrementalDailyFact({
    existing: {
      source: 'form', effectiveSource: 'form', sourceTime: 1000,
      fingerprint: 'form', matchingStatus: '已匹配', factStatus: '有效',
    },
    incoming: candidate('chat', 2000, 'chat', '已匹配'),
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.mergeStatus, '按时间取最新');
  assert.equal(result.conflictStatus, '已自动处理');
});

test('incremental same-source refresh preserves known two-source conflict', () => {
  const result = resolveIncrementalDailyFact({
    existing: {
      source: 'form+chat', effectiveSource: 'chat', sourceTime: 2000,
      fingerprint: 'chat-old', matchingStatus: '已匹配', factStatus: '有效',
      mergeStatus: '按时间取最新', conflictStatus: '已自动处理',
    },
    incoming: candidate('chat', 3000, 'chat-new', '已匹配'),
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.mergeStatus, '按时间取最新');
  assert.equal(result.conflictStatus, '已自动处理');
});

function candidate(source, sourceTime, fingerprint, matchingStatus) {
  return { source, sourceTime, fingerprint, matchingStatus };
}
