import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDailyFactsForAllGroups } from '../src/daily-fact-sync.js';
import { normalizeConfig } from '../src/config.js';

test('syncs facts for each configured group', async () => {
  const config = normalizeConfig({
    dailyFactSync: { enabled: true, lookbackDays: 3, timezone: 'Asia/Shanghai' },
    groups: [
      {
        chatId: 'oc_1',
        project: '板块1',
        dailyTable: { appToken: 'bas', tableId: 'tbl_source_1' },
        chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
        dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact_1' },
      },
      {
        chatId: 'oc_2',
        project: '板块2',
        dailyTable: { appToken: 'bas', tableId: 'tbl_source_2' },
        chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw_2' },
        dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact_2' },
      },
    ],
  });
  const calls = [];
  const now = new Date('2026-07-03T10:10:00.000Z');
  const results = await syncDailyFactsForAllGroups({
    config,
    now,
    logger: { log() {}, error() {} },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 0 };
      },
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].group.project, '板块1');
  assert.equal(calls[0].group.chatDailyRawTable.tableId, 'tbl_chat_raw');
  assert.equal(calls[0].options.lookbackDays, 3);
  assert.equal(calls[0].options.timezone, 'Asia/Shanghai');
  assert.equal(calls[0].options.now, now);
  assert.equal(results[1].group, '板块2');
  assert.equal(results[1].created, 1);
});

test('forwards an explicit inclusive range and repair policy', async () => {
  const calls = [];
  await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ project: '板块1' }],
    },
    startDate: '2026-07-01',
    endDate: '2026-07-12',
    repairOrganization: true,
    logger: { log() {}, error() {} },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 0 };
      },
    },
  });

  assert.equal(calls[0].options.startDate, '2026-07-01');
  assert.equal(calls[0].options.endDate, '2026-07-12');
  assert.equal(calls[0].options.repairOrganization, true);
});

test('reports one aggregated failure for record errors in a group', async () => {
  const alerts = [];
  await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ project: '公司项目组' }],
    },
    bitable: {
      syncDailyFactRecordsForGroup: async () => ({
        created: 0,
        updated: 0,
        errors: [{ message: 'first' }, { message: 'second' }],
      }),
    },
    notifyFailure: async alert => alerts.push(alert),
    logger: { log() {}, error() {} },
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].task, '日报事实同步');
  assert.equal(alerts[0].errors.length, 2);
});

test('logs only a sanitized summary when a successful group returns record errors', async () => {
  const logs = [];
  const alerts = [];
  const recordError = new Error('raw report body: completed confidential work for oc_secret rec_secret sheet_token_should_not_leak');
  recordError.response = { data: { msg: 'bascnSecret table_id=tbl_secret wiki/WikiNodeSecret raw report body' } };

  await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ chatId: 'oc_secret', project: 'sheet_token_should_not_leak' }],
    },
    bitable: {
      syncDailyFactRecordsForGroup: async () => ({ created: 1, updated: 2, errors: [recordError] }),
    },
    notifyFailure: async alert => alerts.push(alert),
    logger: { log: (...args) => logs.push(args), error() {} },
  });

  const serialized = JSON.stringify(logs);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].stage, 'write_daily_fact');
  assert.equal(logs[0][1].failureCount, 1);
  for (const secret of ['oc_secret', 'rec_secret', 'sheet_token_should_not_leak', 'bascnSecret', 'tbl_secret', 'WikiNodeSecret', 'raw report body']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(alerts[0].errors[0], recordError);
});

test('logs only a sanitized summary when a group throws and preserves the original notification error', async () => {
  const errors = [];
  const alerts = [];
  const terminalError = new Error('raw report body: completed confidential work for oc_secret rec_secret sheet_token_should_not_leak');
  terminalError.response = { data: { msg: 'bascnSecret table_id=tbl_secret wiki/WikiNodeSecret raw report body' } };

  const results = await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ chatId: 'oc_secret', project: 'sheet_token_should_not_leak' }],
    },
    bitable: { syncDailyFactRecordsForGroup: async () => { throw terminalError; } },
    notifyFailure: async alert => alerts.push(alert),
    logger: { log() {}, error: (...args) => errors.push(args) },
  });

  const serialized = JSON.stringify(errors);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].stage, 'sync_group');
  assert.equal(errors[0][1].failureCount, 1);
  for (const secret of ['oc_secret', 'rec_secret', 'sheet_token_should_not_leak', 'bascnSecret', 'tbl_secret', 'WikiNodeSecret', 'raw report body']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(results[0].error, terminalError);
  assert.equal(alerts[0].errors[0], terminalError);
});

test('continues after a returned-error notification rejection without duplicating the daily fact result', async () => {
  const alertAttempts = [];
  const operationOrder = [];
  const warnings = [];
  const results = await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ project: '一组' }, { project: '二组' }],
    },
    bitable: {
      syncDailyFactRecordsForGroup: async group => {
        operationOrder.push(group.project);
        return group.project === '一组'
          ? { errors: [{ message: 'row write failed' }] }
          : { created: 1, updated: 0 };
      },
    },
    notifyFailure: async alert => {
      alertAttempts.push(alert);
      throw new Error('reporter secret body');
    },
    logger: { log() {}, error() {}, warn: message => warnings.push(message) },
  });

  assert.deepEqual(operationOrder, ['一组', '二组']);
  assert.equal(alertAttempts.length, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].failed, undefined);
  assert.equal(results[1].created, 1);
  assert.deepEqual(warnings, ['[daily-fact-sync] failure notification failed']);
});

test('continues after a terminal-error notification rejection and preserves the daily fact message', async () => {
  const alertAttempts = [];
  const operationOrder = [];
  const warnings = [];
  const terminalError = new Error('source unavailable');
  const results = await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ project: '一组' }, { project: '二组' }],
    },
    bitable: {
      syncDailyFactRecordsForGroup: async group => {
        operationOrder.push(group.project);
        if (group.project === '一组') throw terminalError;
        return { created: 1, updated: 0 };
      },
    },
    notifyFailure: async alert => {
      alertAttempts.push(alert);
      throw new Error('reporter secret body');
    },
    logger: { log() {}, error() {}, warn: message => warnings.push(message) },
  });

  assert.deepEqual(operationOrder, ['一组', '二组']);
  assert.equal(alertAttempts.length, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].failed, true);
  assert.equal(results[0].message, 'source unavailable');
  assert.equal(results[0].error, terminalError);
  assert.equal(results[1].created, 1);
  assert.deepEqual(warnings, ['[daily-fact-sync] failure notification failed']);
});
