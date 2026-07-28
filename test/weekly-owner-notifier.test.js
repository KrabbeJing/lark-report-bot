import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notifyMissingCoreMetricOwners,
  notifyWeeklyOwners,
} from '../src/weekly-owner-notifier.js';

const now = new Date('2026-07-24T09:00:00+08:00');

function buildInstance(overrides = {}) {
  return {
    instanceKey: '2026-W30',
    sheetUrl: 'https://feishu.test/sheets/week-30',
    targets: {
      agileProjects: { 融羲项目组: { current: 'C10' } },
      management: { 零售大众客群经营: { current: ['C17', 'C18', 'C19'] } },
    },
    ownerNotificationDetails: [],
    coreMetricReminderDetails: [],
    ...overrides,
  };
}

function buildOwnerRules(overrides = {}) {
  return [
    {
      module: 'module2',
      target: '融羲项目组',
      contentType: '本周重点事项说明',
      remindOwners: true,
      owners: [{ openId: 'ou_owner', name: '周报负责人' }],
      ...overrides.first,
    },
    {
      module: 'module3',
      target: '零售大众客群经营',
      contentType: '本周工作进展',
      remindOwners: true,
      owners: [{ openId: 'ou_owner', name: '周报负责人' }],
      ...overrides.second,
    },
  ];
}

function buildDependencies({ instance = buildInstance(), sendError = null } = {}) {
  const sent = [];
  const updates = [];
  return {
    sent,
    updates,
    instance,
    messenger: {
      sendTextToOpenId: async (openId, text, uuid) => {
        sent.push({ openId, text, uuid });
        if (sendError) throw sendError;
      },
    },
    bitable: {
      updateWeeklyInstance: async (_instance, patch) => {
        updates.push(patch);
        return { updated: true };
      },
    },
  };
}

test('consolidates two sections for one owner and includes available draft text and direct Sheet link', async () => {
  const dependencies = buildDependencies();

  const result = await notifyWeeklyOwners({
    rules: buildOwnerRules(),
    instance: dependencies.instance,
    draft: { cells: { C10: '完成融羲接口联调', C17: '完成零售活动方案评审' } },
    ...dependencies,
    now,
  });

  assert.equal(dependencies.sent.length, 1);
  assert.match(dependencies.sent[0].text, /融羲项目组/);
  assert.match(dependencies.sent[0].text, /零售大众客群经营/);
  assert.match(dependencies.sent[0].text, /完成融羲接口联调/);
  assert.match(dependencies.sent[0].text, /完成零售活动方案评审/);
  assert.match(dependencies.sent[0].text, /https:\/\/feishu\.test\/sheets\/week-30/);
  assert.equal(dependencies.sent[0].uuid, 'weekly-owner:2026-W30:ou_owner');
  assert.equal(result.status, '成功');
  assert.deepEqual(dependencies.updates[0].ownerNotificationDetails, [{
    openId: 'ou_owner',
    status: '成功',
    sentAt: now.getTime(),
    idempotencyKey: 'weekly-owner:2026-W30:ou_owner',
    errorCode: '',
  }]);
});

test('uses the safe empty-draft text and does not disclose operational coverage or personnel details', async () => {
  const dependencies = buildDependencies();
  await notifyWeeklyOwners({
    rules: buildOwnerRules(),
    instance: dependencies.instance,
    draft: { cells: {} },
    ...dependencies,
    now,
  });

  assert.match(dependencies.sent[0].text, /本期暂无可用 AI 草稿，请直接进入周报表填写/);
  assert.doesNotMatch(dependencies.sent[0].text, /覆盖率|缺报|缺失人员|人员类型|敏捷小组|敏捷团队/);
});

test('disabled owner reminders send nothing', async () => {
  const dependencies = buildDependencies();
  await notifyWeeklyOwners({
    rules: buildOwnerRules({ first: { remindOwners: false }, second: { remindOwners: false } }),
    instance: dependencies.instance,
    draft: { cells: { C10: 'AI draft' } },
    ...dependencies,
    now,
  });

  assert.deepEqual(dependencies.sent, []);
  assert.deepEqual(dependencies.updates, []);
});

test('records a safe failure when an owner has no OpenID', async () => {
  const dependencies = buildDependencies();
  const result = await notifyWeeklyOwners({
    rules: buildOwnerRules({
      first: { owners: [{ name: '未配置负责人', openId: '' }] },
      second: { remindOwners: false },
    }),
    instance: dependencies.instance,
    draft: { cells: { C10: 'AI draft' } },
    ...dependencies,
    now,
  });

  assert.deepEqual(dependencies.sent, []);
  assert.equal(result.status, '失败');
  assert.deepEqual(dependencies.updates[0].ownerNotificationDetails, [{
    openId: '',
    status: '失败',
    sentAt: now.getTime(),
    idempotencyKey: 'weekly-owner:2026-W30:missing-open-id',
    errorCode: 'missing_open_id',
  }]);
});

test('does not resend an owner whose prior notification succeeded', async () => {
  const instance = buildInstance({
    ownerNotificationDetails: [{
      openId: 'ou_owner',
      status: '成功',
      sentAt: now.getTime() - 1000,
      idempotencyKey: 'weekly-owner:2026-W30:ou_owner',
      errorCode: '',
    }],
  });
  const dependencies = buildDependencies({ instance });
  const result = await notifyWeeklyOwners({
    rules: buildOwnerRules(),
    instance,
    draft: { cells: { C10: 'AI draft' } },
    ...dependencies,
    now,
  });

  assert.deepEqual(dependencies.sent, []);
  assert.deepEqual(dependencies.updates, []);
  assert.equal(result.skipped, 1);
});

test('sends one private reminder for one blank core metric', async () => {
  const dependencies = buildDependencies();
  const result = await notifyMissingCoreMetricOwners({
    metricOwners: [{
      metricName: '手机银行月活',
      remindersEnabled: true,
      enabled: true,
      owners: [{ openId: 'ou_owner', name: '指标负责人' }],
    }],
    metricCells: { 手机银行月活: 'C6' },
    instance: dependencies.instance,
    writer: { readCells: async () => ({ C6: '' }) },
    ...dependencies,
    now,
  });

  assert.equal(dependencies.sent.length, 1);
  assert.match(dependencies.sent[0].text, /手机银行月活/);
  assert.match(dependencies.sent[0].text, /https:\/\/feishu\.test\/sheets\/week-30/);
  assert.equal(dependencies.sent[0].uuid, 'weekly-metric:2026-W30:ou_owner');
  assert.equal(result.status, '成功');
});

test('does not remind for a filled core metric target', async () => {
  const dependencies = buildDependencies();
  await notifyMissingCoreMetricOwners({
    metricOwners: [{
      metricName: '手机银行月活',
      remindersEnabled: true,
      enabled: true,
      owners: [{ openId: 'ou_owner', name: '指标负责人' }],
    }],
    metricCells: { 手机银行月活: 'C6' },
    instance: dependencies.instance,
    writer: { readCells: async () => ({ C6: '100万' }) },
    ...dependencies,
    now,
  });

  assert.deepEqual(dependencies.sent, []);
  assert.deepEqual(dependencies.updates, []);
});

test('consolidates multiple blank metrics for one owner and avoids a duplicate after success', async () => {
  const first = buildDependencies();
  const owners = [{ openId: 'ou_owner', name: '指标负责人' }];
  const args = {
    metricOwners: [
      { metricName: '手机银行月活', remindersEnabled: true, enabled: true, owners },
      { metricName: '收单交易量', remindersEnabled: true, enabled: true, owners },
    ],
    metricCells: { 手机银行月活: 'C6', 收单交易量: 'C7' },
    instance: first.instance,
    writer: { readCells: async () => ({ C6: '', C7: '' }) },
    ...first,
    now,
  };

  await notifyMissingCoreMetricOwners(args);
  assert.equal(first.sent.length, 1);
  assert.match(first.sent[0].text, /手机银行月活/);
  assert.match(first.sent[0].text, /收单交易量/);

  const second = buildDependencies({
    instance: buildInstance({ coreMetricReminderDetails: first.updates[0].coreMetricReminderDetails }),
  });
  const rerun = await notifyMissingCoreMetricOwners({ ...args, ...second, instance: second.instance });
  assert.deepEqual(second.sent, []);
  assert.equal(rerun.skipped, 1);
});

test('does not send a second core metric reminder on Saturday', async () => {
  const dependencies = buildDependencies();
  await notifyMissingCoreMetricOwners({
    metricOwners: [{
      metricName: '手机银行月活',
      remindersEnabled: true,
      enabled: true,
      owners: [{ openId: 'ou_owner', name: '指标负责人' }],
    }],
    metricCells: { 手机银行月活: 'C6' },
    instance: dependencies.instance,
    writer: { readCells: async () => ({ C6: '' }) },
    ...dependencies,
    now: new Date('2026-07-25T09:30:00+08:00'),
  });

  assert.deepEqual(dependencies.sent, []);
  assert.deepEqual(dependencies.updates, []);
});
