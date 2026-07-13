import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureWeeklyInstanceForGroup,
  ensureWeeklyInstancesForAllGroups,
} from '../src/weekly-instance-service.js';

test('copies, moves, validates, writes only report period, then registers instance', async () => {
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
      ensureWeeklySheet: async () => {
        calls.push(['copy']);
        return {
          spreadsheetToken: 'sheet_token',
          sheetId: 'week_29',
          title: '本周周报',
          created: true,
          reused: false,
        };
      },
      moveSheet: async () => calls.push(['move']),
      discoverTemplateTargets: async () => {
        calls.push(['locate']);
        return { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} };
      },
      writeCells: async (_config, sheetId, values) => calls.push(['write', sheetId, values]),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(result.instanceKey, '2026-W29');
  assert.deepEqual(calls.map(([name]) => name), ['copy', 'move', 'locate', 'write', 'register']);
  assert.deepEqual(calls[3], ['write', 'week_29', { B2: '2026-07-13 至 2026-07-17' }]);
  assert.equal(calls[4][1].status, '已创建');
});

test('persists a current-token URL instead of a stale configured workbook URL', async () => {
  const group = buildGroup();
  group.weeklySheet = {
    ...group.weeklySheet,
    wikiNodeToken: 'wiki_current',
    spreadsheetToken: 'sheet_stale',
    spreadsheetUrl: 'https://tenant.feishu.cn/sheets/sheet_stale?fromScene=spaceOverview',
  };
  let persistedInstance;

  const result = await ensureWeeklyInstanceForGroup({
    group,
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async (_group, instance) => {
        persistedInstance = instance;
        return { created: true };
      },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet_current', sheetId: 'week_29', title: '本周周报', created: true,
      }),
      moveSheet: async () => {},
      discoverTemplateTargets: async () => ({ reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} }),
      writeCells: async () => {},
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  const expectedUrl = 'https://www.feishu.cn/sheets/sheet_current?sheet=week_29';
  assert.equal(result.instance.sheetUrl, expectedUrl);
  assert.equal(persistedInstance.sheetUrl, expectedUrl);
  assert.doesNotMatch(persistedInstance.sheetUrl, /sheet_stale/);
});

test('validates and returns a persistent instance without copying, moving, writing, or updating Base', async () => {
  const calls = [];
  const result = await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => ({
        record_id: 'rec_week',
        fields: { SpreadsheetToken: 'sheet_token', SheetID: 'week_29', 工作表名称: '本周周报' },
      }),
    },
    sheetWriter: {
      ensureWeeklySheet: async () => { calls.push('copy'); },
      moveSheet: async () => { calls.push('move'); },
      writeCells: async () => { calls.push('write'); },
      discoverTemplateTargets: async () => {
        calls.push('locate');
        return { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} };
      },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.equal(result.reused, true);
  assert.equal(result.record.record_id, 'rec_week');
  assert.deepEqual(result.targets, { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} });
  assert.deepEqual(calls, ['locate']);
});

test('returns reusable sheet metadata from an existing Base instance', async () => {
  const group = buildGroup();
  const result = await ensureWeeklyInstanceForGroup({
    group,
    bitable: {
      findWeeklyInstanceRecord: async () => ({
        record_id: 'rec_week',
        fields: {
          SpreadsheetToken: 'sheet_token', SheetID: 'week_29', 工作表名称: '本周周报', 周报链接: 'https://example.invalid/sheets/sheet_token?sheet=week_29',
        },
      }),
    },
    sheetWriter: {
      discoverTemplateTargets: async () => ({ reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} }),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.sheet, {
    spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '本周周报',
    reused: true, created: false,
  });
  assert.equal(result.instance.sheetUrl, 'https://example.invalid/sheets/sheet_token?sheet=week_29');
});

test('rejects Base reuse rows with blank spreadsheet token or sheet id before sheet operations', async () => {
  for (const [label, spreadsheetToken, sheetId] of [
    ['blank token', '', 'week_29'],
    ['blank sheet id', 'sheet_token', ''],
  ]) {
    let writerCalls = 0;
    await assert.rejects(
      ensureWeeklyInstanceForGroup({
        group: buildGroup(),
        bitable: {
          findWeeklyInstanceRecord: async () => ({
            record_id: 'rec_incomplete',
            fields: { SpreadsheetToken: spreadsheetToken, SheetID: sheetId },
          }),
        },
        sheetWriter: {
          discoverTemplateTargets: async () => { writerCalls += 1; },
        },
        now: new Date('2026-07-13T01:00:00.000Z'),
      }),
      error => error.weeklyInstanceStage === 'validate_reused_instance',
      label,
    );
    assert.equal(writerCalls, 0, label);
  }
});

test('rejects Base reuse matching a stale explicit workbook token before target discovery', async () => {
  const group = buildGroup();
  group.weeklySheet = { ...group.weeklySheet, spreadsheetToken: 'sheet_stale', wikiNodeToken: 'wiki_current' };
  let discoveryCalls = 0;

  await assert.rejects(
    ensureWeeklyInstanceForGroup({
      group,
      bitable: {
        findWeeklyInstanceRecord: async () => ({
          record_id: 'rec_wrong_workbook',
          fields: { SpreadsheetToken: 'sheet_stale', SheetID: 'week_29' },
        }),
      },
      sheetWriter: {
        resolveSheetConfig: async config => {
          assert.equal(config.wikiNodeToken, 'wiki_current');
          return { ...config, spreadsheetToken: 'sheet_current' };
        },
        discoverTemplateTargets: async () => { discoveryCalls += 1; },
      },
      now: new Date('2026-07-13T01:00:00.000Z'),
    }),
    error => error.weeklyInstanceStage === 'validate_reused_instance',
  );
  assert.equal(discoveryCalls, 0);
});

test('validates targets when Base reuse matches the wiki-resolved workbook token', async () => {
  const group = buildGroup();
  group.weeklySheet = { ...group.weeklySheet, spreadsheetToken: 'sheet_stale', wikiNodeToken: 'wiki_current' };
  let discoveredConfig;

  const result = await ensureWeeklyInstanceForGroup({
    group,
    bitable: {
      findWeeklyInstanceRecord: async () => ({
        record_id: 'rec_current_workbook',
        fields: { SpreadsheetToken: 'sheet_current', SheetID: 'week_29', 工作表名称: '本周周报' },
      }),
    },
    sheetWriter: {
      resolveSheetConfig: async config => ({ ...config, spreadsheetToken: 'sheet_current' }),
      discoverTemplateTargets: async config => {
        discoveredConfig = config;
        return { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} };
      },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.equal(result.reused, true);
  assert.equal(result.sheet.spreadsheetToken, 'sheet_current');
  assert.equal(discoveredConfig.spreadsheetToken, 'sheet_current');
  assert.deepEqual(result.targets, { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} });
});

test('rejects a missing or corrupt persisted sheet while retaining the validation stage', async () => {
  for (const [label, error] of [
    ['missing physical sheet', new Error('sheet not found')],
    ['corrupt semantic targets', new Error('missing report period target')],
  ]) {
    let writes = 0;
    await assert.rejects(
      ensureWeeklyInstanceForGroup({
        group: buildGroup(),
        bitable: {
          findWeeklyInstanceRecord: async () => ({
            record_id: 'rec_week',
            fields: { SpreadsheetToken: 'sheet_token', SheetID: 'week_29' },
          }),
        },
        sheetWriter: {
          discoverTemplateTargets: async () => { throw error; },
          writeCells: async () => { writes += 1; },
        },
        now: new Date('2026-07-13T01:00:00.000Z'),
      }),
      thrown => thrown === error && thrown.weeklyInstanceStage === 'validate_reused_sheet',
      label,
    );
    assert.equal(writes, 0, label);
  }
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
      moveSheet: async () => {},
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
      moveSheet: async () => {},
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
  }), error => error === originalError && error.weeklyInstanceStage === 'copy_sheet');

  assert.equal(attempts, 3);
});

test('marks a Base instance lookup failure with a stable stage', async () => {
  const originalError = new Error('Base lookup failed');
  await assert.rejects(
    ensureWeeklyInstanceForGroup({
      group: buildGroup(),
      bitable: { findWeeklyInstanceRecord: async () => { throw originalError; } },
      sheetWriter: {},
      now: new Date('2026-07-13T01:00:00.000Z'),
    }),
    error => error === originalError && error.weeklyInstanceStage === 'find_existing_instance',
  );
});

test('stages movement failures, avoids Base writes, and moves a recovered sheet before retrying Base', async () => {
  const order = [];
  let moveAttempts = 0;
  let baseCalls = 0;
  const dependencies = {
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => { baseCalls += 1; order.push('base'); return { created: true }; },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => {
        order.push('copy');
        return {
          spreadsheetToken: 'sheet_token',
          sheetId: 'week_29',
          title: '数字金融部周报0717',
          created: moveAttempts === 0,
          reused: moveAttempts > 0,
        };
      },
      moveSheet: async () => {
        moveAttempts += 1;
        order.push('move');
        if (moveAttempts === 1) throw new Error('move failed');
      },
      discoverTemplateTargets: async () => {
        order.push('locate');
        return { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} };
      },
      writeCells: async () => { order.push('write'); return { rangeCount: 1 }; },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    retryDelayMs: 0,
  };

  await assert.rejects(
    ensureWeeklyInstanceForGroup(dependencies),
    error => error.weeklyInstanceStage === 'move_sheet',
  );
  assert.equal(baseCalls, 0);

  const recovered = await ensureWeeklyInstanceForGroup(dependencies);
  assert.equal(recovered.reused, true);
  assert.equal(baseCalls, 1);
  assert.deepEqual(order, ['copy', 'move', 'copy', 'move', 'locate', 'write', 'base']);
});

test('marks locate, write, and Base failures with their stable stage names', async () => {
  for (const [failingMethod, expectedStage] of [
    ['discoverTemplateTargets', 'locate_template'],
    ['writeCells', 'write_period'],
    ['upsertWeeklyInstance', 'write_instance_base'],
  ]) {
    const originalError = new Error(`${failingMethod} failed`);
    const bitable = {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => ({ created: true }),
    };
    const sheetWriter = {
      ensureWeeklySheet: async () => ({ spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '周报' }),
      moveSheet: async () => {},
      discoverTemplateTargets: async () => ({ reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} }),
      writeCells: async () => ({ rangeCount: 1 }),
    };
    if (failingMethod === 'upsertWeeklyInstance') bitable.upsertWeeklyInstance = async () => { throw originalError; };
    else sheetWriter[failingMethod] = async () => { throw originalError; };

    await assert.rejects(
      ensureWeeklyInstanceForGroup({ group: buildGroup(), bitable, sheetWriter, now: new Date('2026-07-13T01:00:00.000Z') }),
      error => error === originalError && error.weeklyInstanceStage === expectedStage,
    );
  }
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

test('returns staged reuse validation failures from the all-groups workflow', async () => {
  const groups = [
    buildGroup({ project: 'blank' }),
    buildGroup({ project: 'mismatch' }),
    buildGroup({ project: 'missing' }),
    buildGroup({ project: 'corrupt' }),
  ];
  const rows = {
    blank: { SpreadsheetToken: '', SheetID: 'week_blank' },
    mismatch: { SpreadsheetToken: 'sheet_other', SheetID: 'week_mismatch' },
    missing: { SpreadsheetToken: 'sheet_token', SheetID: 'week_missing' },
    corrupt: { SpreadsheetToken: 'sheet_token', SheetID: 'week_corrupt' },
  };
  const results = await ensureWeeklyInstancesForAllGroups({
    config: { timezone: 'Asia/Shanghai', groups },
    bitable: {
      findWeeklyInstanceRecord: async group => ({ record_id: `rec_${group.project}`, fields: rows[group.project] }),
    },
    sheetWriter: {
      discoverTemplateTargets: async (_config, sheetId) => {
        if (sheetId === 'week_missing') throw new Error('physical sheet missing');
        if (sheetId === 'week_corrupt') throw new Error('semantic targets corrupt');
      },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });

  assert.deepEqual(results.map(result => result.error?.weeklyInstanceStage), [
    'validate_reused_instance',
    'validate_reused_instance',
    'validate_reused_sheet',
    'validate_reused_sheet',
  ]);
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
