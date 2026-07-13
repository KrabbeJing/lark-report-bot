import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { TemplateAiProvider } from '../src/ai-providers.js';
import { generateWeeklyReportForGroup } from '../src/weekly-reporter.js';

const discoveredMap = {
  reportPeriod: 'B2',
  metrics: { 手机银行月活: 'C6' },
  agileProjects: {
    收单项目组: { current: 'C28', next: 'C29', aliases: ['收单'] },
  },
  management: {
    业务风控合规: {
      current: ['C57', 'C58', 'C59'],
      next: ['C60', 'C61', 'C62'],
      aliases: ['风控', '合规', '风险', '反洗钱'],
    },
  },
};

test('generates weekly sheet instead of image when weeklySheet is enabled', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      pushChatId: 'oc_push',
      project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklyTable: null,
      weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_test',
        templateSheetId: 'tpl_sheet',
        spreadsheetUrl: 'https://example.feishu.cn/sheets/shtcn_test',
        reportScope: 'allDailyTable',
      },
    }],
  }).groups[0];
  const sent = [];
  const written = [];
  const instanceStages = [];
  let discoveryOptions;

  const result = await generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listAllDailyReportsForRange: async () => {
        instanceStages.push('reports');
        return [{
          reportDate: '2026-06-26',
          reporterName: '王秀男',
          project: '收单项目组',
          agileGroup: '收单项目组',
          workItems: ['与银联沟通银联代收业务场景限额调整问题'],
          tomorrowPlanItems: ['继续推进银联限额调整方案确认'],
          riskItems: [],
        }];
      },
      listDailyReportsForWeek: async () => {
        throw new Error('should use all daily table scope');
      },
      upsertWeeklySummary: async () => ({ skipped: true }),
      findWeeklyInstanceRecord: async () => { instanceStages.push('find'); return null; },
      upsertWeeklyInstance: async () => { instanceStages.push('base'); return { created: true }; },
    },
    aiProvider: {
      summarizeWeeklyReports: async input => {
        instanceStages.push('summary');
        return new TemplateAiProvider().summarizeWeeklyReports(input);
      },
      summarizeWeeklySheet: async input => {
        instanceStages.push('sheet-ai');
        return new TemplateAiProvider().summarizeWeeklySheet(input);
      },
    },
    messenger: {
      uploadImage: async () => {
        throw new Error('should not upload image for weeklySheet');
      },
      sendText: async (chatId, text, uuid) => sent.push({ chatId, text, uuid }),
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        ...(instanceStages.push('copy'), {}),
        spreadsheetToken: 'shtcn_test',
        sheetId: 'new_sheet_1',
        title: '数字金融部周报 2026-06-22-2026-06-26',
        reused: false,
      }),
      moveSheet: async () => { instanceStages.push('move'); },
      discoverTemplateTargets: async (_config, sheetId, options) => {
        instanceStages.push('locate');
        assert.equal(sheetId, 'new_sheet_1');
        discoveryOptions = options;
        return discoveredMap;
      },
      writeCells: async (_config, sheetId, values) => {
        instanceStages.push(values.C28 ? 'content' : 'period');
        written.push({ sheetId, values });
        return { rangeCount: Object.keys(values).length };
      },
    },
    outDir: '/tmp',
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-27T02:00:00.000Z'),
    delivery: 'send',
  });

  assert.equal(result.skipped, false);
  assert.equal(written.at(-1).sheetId, 'new_sheet_1');
  assert.match(written.at(-1).values.C28, /银联代收/);
  assert.deepEqual(discoveryOptions.aliasMap, group.weeklySheet.entityAliases);
  assert.equal(sent[0].chatId, 'oc_push');
  assert.match(sent[0].text, /https:\/\/example\.feishu\.cn\/sheets\/shtcn_test\?sheet=new_sheet_1/);
  assert.deepEqual(instanceStages, [
    'find', 'copy', 'move', 'locate', 'period', 'base', 'reports', 'summary', 'sheet-ai', 'content',
  ]);
});

test('does not push again when scheduled weekly sheet already exists', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_test',
        templateSheetId: 'tpl_sheet',
        skipPushIfExisting: true,
      },
    }],
  }).groups[0];
  let sendCount = 0;
  let baseWrites = 0;
  const summaryWrites = [];
  const stages = [];

  const result = await generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => { stages.push('reports'); return []; },
      upsertWeeklySummary: async (_group, _summary, context) => { summaryWrites.push(context); return { skipped: true }; },
      findWeeklyInstanceRecord: async () => {
        stages.push('find');
        return {
          record_id: 'rec_week',
          fields: {
            SpreadsheetToken: 'shtcn_test', SheetID: 'existing_sheet', 工作表名称: '数字金融部周报', 周报链接: 'https://example.feishu.cn/sheets/shtcn_test?sheet=existing_sheet',
          },
        };
      },
      upsertWeeklyInstance: async () => { baseWrites += 1; },
    },
    aiProvider: {
      summarizeWeeklyReports: async input => {
        stages.push('summary');
        return new TemplateAiProvider().summarizeWeeklyReports(input);
      },
      summarizeWeeklySheet: async input => {
        stages.push('sheet-ai');
        return new TemplateAiProvider().summarizeWeeklySheet(input);
      },
    },
    messenger: {
      sendText: async () => { sendCount += 1; },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => { throw new Error('must not copy existing instance'); },
      moveSheet: async () => { throw new Error('must not move existing instance'); },
      discoverTemplateTargets: async () => { stages.push('locate'); return discoveredMap; },
      writeCells: async () => { stages.push('content'); return { rangeCount: 1 }; },
    },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-27T02:00:00.000Z'),
    delivery: 'send',
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'weekly_sheet_exists');
  assert.equal(sendCount, 0);
  assert.equal(baseWrites, 0);
  assert.deepEqual(summaryWrites.map(write => write.pushStatus), ['sent']);
  assert.deepEqual(stages, ['find', 'locate', 'reports', 'summary', 'sheet-ai', 'content']);
});

test('retries an initial weekly sheet delivery and records sent only after messenger success', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test',
    project: '数字金融部',
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
    weeklySheet: { enabled: true, spreadsheetToken: 'sheet', templateSheetId: 'tpl', skipPushIfExisting: false },
  }] }).groups[0];
  const summaryWrites = [];
  let sendAttempts = 0;
  const dependencies = {
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => [],
      upsertWeeklySummary: async (_group, _summary, context) => { summaryWrites.push(context); },
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => ({ created: true }),
    },
    aiProvider: new TemplateAiProvider(),
    messenger: {
      sendText: async () => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('delivery failed');
      },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({ spreadsheetToken: 'sheet', sheetId: 'week', title: 'week', reused: false }),
      moveSheet: async () => {},
      discoverTemplateTargets: async () => discoveredMap,
      writeCells: async () => ({ rangeCount: 1 }),
    },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-07-04T02:00:00.000Z'),
    delivery: 'send',
  };

  await assert.rejects(generateWeeklyReportForGroup(dependencies), /delivery failed/);
  assert.deepEqual(summaryWrites, []);

  await generateWeeklyReportForGroup(dependencies);
  assert.equal(sendAttempts, 2);
  assert.deepEqual(summaryWrites.map(write => write.pushStatus), ['sent']);
});

test('deduplicates multi-day fact rows before calling AI provider', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test', project: '数字金融部',
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklySheet: { enabled: true, spreadsheetToken: 'sheet', templateSheetId: 'tpl' },
    weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
  }] }).groups[0];
  let aiReports;
  await generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => [
        { recordId: 'fact_1', reportDate: '2026-06-29', messageId: 'om_1', effectiveSource: 'chat', workItems: ['完成A'] },
        { recordId: 'fact_2', reportDate: '2026-06-30', messageId: 'om_1', effectiveSource: 'chat', workItems: ['完成A'] },
      ],
      upsertWeeklySummary: async () => ({ skipped: true }),
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => ({ created: true }),
    },
    aiProvider: {
      summarizeWeeklyReports: async input => {
        aiReports = input.reports;
        return { ...input, reportCount: input.reports.length, memberCount: 1, summaryText: '' };
      },
      summarizeWeeklySheet: async () => ({ values: {} }),
    },
    messenger: { sendText: async () => {} },
    sheetWriter: {
      ensureWeeklySheet: async () => ({ spreadsheetToken: 'sheet', sheetId: 'week', title: 'week', reused: false }),
      moveSheet: async () => {},
      discoverTemplateTargets: async () => discoveredMap,
      writeCells: async () => ({ rangeCount: 0 }),
    },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-07-04T02:00:00.000Z'),
    delivery: 'send',
  });
  assert.equal(aiReports.length, 1);
  assert.deepEqual(aiReports[0].reportDates, ['2026-06-29', '2026-06-30']);
});

test('fails closed when copied sheet semantic targets cannot be located', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test',
    project: '数字金融部',
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklySheet: { enabled: true, spreadsheetToken: 'sheet', templateSheetId: 'tpl' },
    weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
  }] }).groups[0];
  let writeCount = 0;
  let persistCount = 0;
  let sendCount = 0;

  await assert.rejects(generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => [],
      upsertWeeklySummary: async () => { persistCount += 1; },
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => { persistCount += 1; },
    },
    aiProvider: new TemplateAiProvider(),
    messenger: { sendText: async () => { sendCount += 1; } },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet', sheetId: 'week', title: 'week', reused: false,
      }),
      moveSheet: async () => {},
      discoverTemplateTargets: async () => {
        throw new Error('缺少模块：三、部门管理工作');
      },
      writeCells: async () => { writeCount += 1; },
    },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-07-04T02:00:00.000Z'),
    delivery: 'send',
  }), /缺少模块：三、部门管理工作/);

  assert.equal(writeCount, 0);
  assert.equal(persistCount, 0);
  assert.equal(sendCount, 0);
});

test('fails closed before loading reports or calling AI when a weekly sheet has no instance table', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test', project: '数字金融部', dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklySheet: { enabled: true, spreadsheetToken: 'sheet', templateSheetId: 'tpl' },
  }] }).groups[0];
  let reportLoads = 0;
  let weeklySummaries = 0;
  let sheetSummaries = 0;

  await assert.rejects(generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => { reportLoads += 1; return []; },
    },
    aiProvider: {
      summarizeWeeklyReports: async () => { weeklySummaries += 1; return {}; },
      summarizeWeeklySheet: async () => { sheetSummaries += 1; return { values: {} }; },
    },
    messenger: { sendText: async () => {} },
    sheetWriter: { ensureWeeklySheet: async () => { throw new Error('must not create unregistered sheet'); } },
    timezone: 'Asia/Shanghai', now: new Date('2026-07-04T02:00:00.000Z'), delivery: 'send',
  }), /weeklyInstanceTable/);

  assert.equal(reportLoads, 0);
  assert.equal(weeklySummaries, 0);
  assert.equal(sheetSummaries, 0);
});

test('fails closed rather than writing when a reused Base instance is incomplete', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test', project: '数字金融部',
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
    weeklySheet: { enabled: true, spreadsheetToken: 'shtcn_configured', templateSheetId: 'tpl_sheet' },
  }] }).groups[0];
  for (const [label, spreadsheetToken, sheetId] of [
    ['blank spreadsheet token', '', 'current_sheet'],
    ['blank sheet id', 'shtcn_persisted', ''],
  ]) {
    let discoveryCalls = 0;
    let writeCalls = 0;
    let reportLoads = 0;
    let weeklySummaries = 0;
    let sheetSummaries = 0;

    await assert.rejects(generateWeeklyReportForGroup({
      group,
      bitable: {
        findWeeklySummaryRecord: async () => null,
        listDailyReportsForWeek: async () => { reportLoads += 1; return []; },
        findWeeklyInstanceRecord: async () => ({
          record_id: 'rec_incomplete',
          fields: { SpreadsheetToken: spreadsheetToken, SheetID: sheetId, 工作表名称: '数字金融部周报' },
        }),
      },
      aiProvider: {
        summarizeWeeklyReports: async () => { weeklySummaries += 1; return {}; },
        summarizeWeeklySheet: async () => { sheetSummaries += 1; return { values: {} }; },
      },
      messenger: { sendText: async () => {} },
      sheetWriter: {
        discoverTemplateTargets: async () => { discoveryCalls += 1; return discoveredMap; },
        writeCells: async () => { writeCalls += 1; },
      },
      timezone: 'Asia/Shanghai', now: new Date('2026-06-27T02:00:00.000Z'), delivery: 'send',
    }), error => {
      assert.equal(error.weeklyInstanceStage, 'validate_reused_instance', label);
      assert.match(error.message, /Base 周报实例/);
      return true;
    }, label);

    assert.equal(discoveryCalls, 0, label);
    assert.equal(writeCalls, 0, label);
    assert.equal(reportLoads, 0, label);
    assert.equal(weeklySummaries, 0, label);
    assert.equal(sheetSummaries, 0, label);
  }
});

test('rebuilds untrusted Base instance links and reuses only the expected HTTPS workbook sheet', async () => {
  const expectedUrl = 'https://example.feishu.cn/sheets/shtcn_current?sheet=current_sheet';
  for (const [label, persistedUrl, expectedSheetUrl] of [
    ['old workbook homepage', 'https://example.feishu.cn/sheets/shtcn_legacy', expectedUrl],
    ['wrong sheet query', 'https://example.feishu.cn/sheets/shtcn_current?sheet=wrong_sheet', expectedUrl],
    ['insecure protocol', 'http://example.feishu.cn/sheets/shtcn_current?sheet=current_sheet', expectedUrl],
    ['wrong Feishu host', 'https://evil.example/sheets/shtcn_current?sheet=current_sheet', expectedUrl],
    ['wrong workbook token', 'https://example.feishu.cn/sheets/shtcn_other?sheet=current_sheet', expectedUrl],
    ['duplicate sheet query', 'https://example.feishu.cn/sheets/shtcn_current?sheet=current_sheet&sheet=other_sheet', expectedUrl],
    ['matching sheet query', expectedUrl, expectedUrl],
  ]) {
    const group = normalizeConfig({ groups: [{
      chatId: 'oc_test', project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_current',
        templateSheetId: 'tpl_sheet',
        spreadsheetUrl: 'https://example.feishu.cn/sheets/shtcn_current',
      },
    }] }).groups[0];
    const replies = [];

    const result = await generateWeeklyReportForGroup({
      group,
      bitable: {
        findWeeklySummaryRecord: async () => null,
        listDailyReportsForWeek: async () => [],
        upsertWeeklySummary: async () => ({ skipped: true }),
        findWeeklyInstanceRecord: async () => ({
          record_id: 'rec_week',
          fields: {
            SpreadsheetToken: 'shtcn_current',
            SheetID: 'current_sheet',
            工作表名称: '数字金融部周报',
            周报链接: persistedUrl,
          },
        }),
        upsertWeeklyInstance: async () => { throw new Error('must not write an existing instance'); },
      },
      aiProvider: new TemplateAiProvider(),
      messenger: { replyText: async (_id, text) => replies.push(text) },
      sheetWriter: {
        ensureWeeklySheet: async () => { throw new Error('must not copy an existing instance'); },
        moveSheet: async () => { throw new Error('must not move an existing instance'); },
        discoverTemplateTargets: async () => discoveredMap,
        writeCells: async () => ({ rangeCount: 1 }),
      },
      timezone: 'Asia/Shanghai',
      now: new Date('2026-06-27T02:00:00.000Z'),
      delivery: 'reply',
      replyMessageId: `om_${label}`,
    });

    assert.equal(result.sheetUrl, expectedSheetUrl, label);
    assert.match(replies[0], new RegExp(expectedSheetUrl.replace(/[.?]/g, '\\$&')), label);
  }
});

test('reuses and rebuilds persisted links against an HTTPS Wiki weekly sheet config', async () => {
  const configuredWikiUrl = 'https://tenant.feishu.cn/wiki/WikiNodeCurrent?fromScene=spaceOverview&sheet=template_sheet';
  const rebuiltWikiUrl = 'https://tenant.feishu.cn/wiki/WikiNodeCurrent?fromScene=spaceOverview&sheet=current_sheet';
  for (const [label, persistedUrl, expectedUrl] of [
    [
      'matching Wiki path',
      'https://tenant.feishu.cn/wiki/WikiNodeCurrent?sheet=current_sheet&fromScene=spaceOverview',
      'https://tenant.feishu.cn/wiki/WikiNodeCurrent?sheet=current_sheet&fromScene=spaceOverview',
    ],
    [
      'different Wiki node',
      'https://tenant.feishu.cn/wiki/WikiNodeOther?fromScene=spaceOverview&sheet=current_sheet',
      rebuiltWikiUrl,
    ],
  ]) {
    const group = normalizeConfig({ groups: [{
      chatId: 'oc_test', project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklyInstanceTable: { appToken: 'bas_test', tableId: 'tbl_instances' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_resolved',
        wikiNodeToken: 'WikiNodeCurrent',
        spreadsheetUrl: configuredWikiUrl,
        templateSheetId: 'template_sheet',
      },
    }] }).groups[0];

    const result = await generateWeeklyReportForGroup({
      group,
      bitable: {
        findWeeklySummaryRecord: async () => null,
        listDailyReportsForWeek: async () => [],
        upsertWeeklySummary: async () => ({ skipped: true }),
        findWeeklyInstanceRecord: async () => ({
          record_id: 'rec_week',
          fields: {
            SpreadsheetToken: 'shtcn_resolved',
            SheetID: 'current_sheet',
            工作表名称: '数字金融部周报',
            周报链接: persistedUrl,
          },
        }),
      },
      aiProvider: new TemplateAiProvider(),
      messenger: { replyText: async () => {} },
      sheetWriter: {
        discoverTemplateTargets: async () => discoveredMap,
        writeCells: async () => ({ rangeCount: 1 }),
      },
      timezone: 'Asia/Shanghai',
      now: new Date('2026-06-27T02:00:00.000Z'),
      delivery: 'reply',
      replyMessageId: `om_${label}`,
    });

    assert.equal(result.sheetUrl, expectedUrl, label);
  }
});
