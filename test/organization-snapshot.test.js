import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrganizationSnapshot,
  snapshotFromContact,
} from '../src/organization-snapshot.js';

const contact = {
  teamMember: '刘喜双',
  teamMemberId: 'ou_member',
  agileGroup: '收单项目组',
  supervisor: '王经理',
  supervisorOpenId: 'ou_supervisor',
  divisionalLeader: '李总',
  divisionalLeaderOpenId: 'ou_leader',
  matchingStatus: '已匹配',
  matchMethod: 'open_id',
};

test('builds the complete contact-derived snapshot', () => {
  assert.deepEqual(snapshotFromContact(contact), {
    reporterNameText: '刘喜双',
    memberOpenId: 'ou_member',
    agileGroup: '收单项目组',
    supervisor: '王经理',
    supervisorOpenId: 'ou_supervisor',
    divisionalLeader: '李总',
    divisionalLeaderOpenId: 'ou_leader',
    matchingStatus: '已匹配',
    matchMethod: 'open_id',
  });
});

test('preserves an existing matched snapshot during normal sync', () => {
  const existingSnapshot = {
    ...snapshotFromContact(contact),
    agileGroup: '历史敏捷组',
    supervisor: '历史上级',
    matchingStatus: '已匹配',
  };
  const result = resolveOrganizationSnapshot({ contact, existingSnapshot });
  assert.equal(result.source, 'existing');
  assert.equal(result.snapshot.agileGroup, '历史敏捷组');
  assert.equal(result.snapshot.supervisor, '历史上级');
});

test('fills a previously unmatched snapshot after contact matching', () => {
  const result = resolveOrganizationSnapshot({
    contact,
    existingSnapshot: { matchingStatus: '未匹配' },
  });
  assert.equal(result.source, 'contact');
  assert.equal(result.matched, true);
  assert.equal(result.snapshot.reporterNameText, '刘喜双');
});

test('repair mode replaces an existing matched snapshot', () => {
  const result = resolveOrganizationSnapshot({
    contact,
    existingSnapshot: {
      ...snapshotFromContact(contact),
      agileGroup: '错误敏捷组',
      matchingStatus: '已匹配',
    },
    repairOrganization: true,
  });
  assert.equal(result.source, 'contact');
  assert.equal(result.snapshot.agileGroup, '收单项目组');
});

test('returns blank contact-derived fields when no match exists', () => {
  const result = resolveOrganizationSnapshot({
    contact: null,
    existingSnapshot: {
      reporterNameText: '群聊标题姓名',
      agileGroup: '群配置敏捷组',
      matchingStatus: '未匹配',
    },
  });
  assert.equal(result.source, 'unmatched');
  assert.equal(result.matched, false);
  assert.equal(result.snapshot.reporterNameText, '');
  assert.equal(result.snapshot.agileGroup, '');
  assert.equal(result.snapshot.supervisor, '');
  assert.equal(result.snapshot.divisionalLeader, '');
});
