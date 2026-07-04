import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentFingerprint,
  buildFactKey,
  buildSourceRefs,
  normalizeContentForFingerprint,
} from '../src/daily-record-utils.js';

test('normalizes content for stable fingerprinting', () => {
  assert.equal(
    normalizeContentForFingerprint(' 1. 完成测试\n\n2、整理材料 '),
    '1、完成测试\n2、整理材料',
  );
});

test('builds same fingerprint for equivalent list markers', () => {
  const a = buildContentFingerprint({ workItems: '1. 完成测试' });
  const b = buildContentFingerprint({ workItems: '1、完成测试' });
  assert.equal(a, b);
});

test('builds fact key with open id first and name fallback', () => {
  assert.equal(buildFactKey({ openId: 'ou_1', name: '张三', reportDate: '2026-07-01' }), 'open_id:ou_1:2026-07-01');
  assert.equal(buildFactKey({ openId: '', name: '张三', reportDate: '2026-07-01' }), 'name:张三:2026-07-01');
});

test('builds compact source refs', () => {
  assert.equal(buildSourceRefs({ sourceRecordId: 'rec_1', messageId: 'om_1' }), 'form:rec_1\nchat:om_1');
});
