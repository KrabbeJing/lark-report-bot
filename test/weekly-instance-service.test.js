import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureWeeklyInstanceForGroup,
  ensureWeeklyInstancesForAllGroups,
} from '../src/weekly-instance-service.js';

test('copies, validates, writes only report period, then registers instance', async () => {
  const calls = [];
  const group = buildGroup();
  const result = await ensureWeeklyInstanceForGroup({
    group,
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async (_group, instance) => {
        calls.push(['register', instance]);
        return { created: true };
      },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet_token',
        sheetId: 'week_29',
        title: '本周周报',
        created: true,
        reused: false,
      }),
      discoverTemplateTargets: async () => ({
        reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {},
      }),
      writeCells: async (_config, sheetId, values) => calls.push(['write', sheetId, values]),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(result.instanceKey, '2026-W29');
  assert.deepEqual(calls[0], ['write', 'week_29', { B2: '2026-07-13 至 2026-07-17' }]);
  assert.equal(calls[1][0], 'register');
  assert.equal(calls[1][1].status, '已创建');
});

test('returns persistent instance without copying or writing', async () => {
  let sheetCalls = 0;
  const result = await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => ({ record_id: 'rec_week', fields: {} }),
    },
    sheetWriter: {
      ensureWeeklySheet: async () => { sheetCalls += 1; },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.equal(result.reused, true);
  assert.equal(result.record.record_id, 'rec_week');
  assert.equal(sheetCalls, 0);
});

test('registers a sheet reused by title after an earlier Base write failure', async () => {
  let registered;
  const result = await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async (_group, instance) => {
        registered = instance;
        return { created: true };
      },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet_token',
        sheetId: 'existing_week_29',
        title: '本周周报',
        created: false,
        reused: true,
      }),
      discoverTemplateTargets: async () => ({
        reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {},
      }),
      writeCells: async () => ({ rangeCount: 1 }),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.equal(result.reused, true);
  assert.equal(registered.sheetId, 'existing_week_29');
});

test('retries template copy twice and succeeds on the third attempt', async () => {
  let attempts = 0;
  const result = await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => ({ created: true }),
    },
    sheetWriter: {
      ensureWeeklySheet: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('临时复制失败');
        return { spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '本周周报', reused: false };
      },
      discoverTemplateTargets: async () => ({
        reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {},
      }),
      writeCells: async () => ({ rangeCount: 1 }),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    retryDelayMs: 0,
  });

  assert.equal(attempts, 3);
  assert.equal(result.sheet.sheetId, 'week_29');
});

test('returns the original copy error after three failed attempts', async () => {
  let attempts = 0;
  const originalError = new Error('复制模板失败');

  await assert.rejects(ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: { findWeeklyInstanceRecord: async () => null },
    sheetWriter: {
      ensureWeeklySheet: async () => {
        attempts += 1;
        throw originalError;
      },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    retryDelayMs: 0,
  }), error => error === originalError);

  assert.equal(attempts, 3);
});

test('processes configured groups sequentially and reports skipped groups', async () => {
  const order = [];
  const configured = buildGroup({ project: '已配置组' });
  const disabled = buildGroup({ project: '已关闭组', weeklySheetEnabled: false });
  const missingTable = buildGroup({ project: '缺实例表组', weeklyInstanceTable: null });
  const results = await ensureWeeklyInstancesForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      weeklyInstanceCreation: { timezone: 'Asia/Shanghai' },
      groups: [disabled, missingTable, configured],
    },
    bitable: {
      findWeeklyInstanceRecord: async group => {
        order.push(`find:${group.project}`);
        return { record_id: 'rec_week', fields: {} };
      },
    },
    sheetWriter: {},
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.deepEqual(results.map(result => result.reason), [
    'weekly_sheet_disabled',
    'weekly_instance_table_not_configured',
    undefined,
  ]);
  assert.deepEqual(order, ['find:已配置组']);
});

function buildGroup({
  project = '公司项目组',
  weeklySheetEnabled = true,
  weeklyInstanceTable = undefined,
} = {}) {
  return {
    chatId: 'oc_test',
    project,
    weeklySheet: {
      enabled: weeklySheetEnabled,
      spreadsheetToken: 'sheet_token',
      spreadsheetUrl: 'https://example.invalid/sheets/sheet_token',
      templateSheetId: 'template',
      titlePattern: '数字金融部周报 {{weekStart}}-{{weekEnd}}',
      entityAliases: { agileProjects: {}, management: {} },
    },
    weeklyInstanceTable: weeklyInstanceTable === null ? null : {
      appToken: 'base_token',
      tableId: 'instance_table',
      fields: { instanceKey: '周报实例唯一键' },
    },
  };
}
