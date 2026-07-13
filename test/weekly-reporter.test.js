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
  let discoveryOptions;

  const result = await generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listAllDailyReportsForRange: async () => [{
        reportDate: '2026-06-26',
        reporterName: '王秀男',
        project: '收单项目组',
        agileGroup: '收单项目组',
        workItems: ['与银联沟通银联代收业务场景限额调整问题'],
        tomorrowPlanItems: ['继续推进银联限额调整方案确认'],
        riskItems: [],
      }],
      listDailyReportsForWeek: async () => {
        throw new Error('should use all daily table scope');
      },
      upsertWeeklySummary: async () => ({ skipped: true }),
    },
    aiProvider: new TemplateAiProvider(),
    messenger: {
      uploadImage: async () => {
        throw new Error('should not upload image for weeklySheet');
      },
      sendText: async (chatId, text, uuid) => sent.push({ chatId, text, uuid }),
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'shtcn_test',
        sheetId: 'new_sheet_1',
        title: '数字金融部周报 2026-06-22-2026-06-26',
        reused: false,
      }),
      discoverTemplateTargets: async (_config, sheetId, options) => {
        assert.equal(sheetId, 'new_sheet_1');
        discoveryOptions = options;
        return discoveredMap;
      },
      writeCells: async (_config, sheetId, values) => {
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
  assert.equal(written[0].sheetId, 'new_sheet_1');
  assert.match(written[0].values.C28, /银联代收/);
  assert.deepEqual(discoveryOptions.aliasMap, group.weeklySheet.entityAliases);
  assert.equal(sent[0].chatId, 'oc_push');
  assert.match(sent[0].text, /https:\/\/example\.feishu\.cn\/sheets\/shtcn_test\?sheet=new_sheet_1/);
});

test('does not push again when scheduled weekly sheet already exists', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_test',
        templateSheetId: 'tpl_sheet',
        skipPushIfExisting: true,
      },
    }],
  }).groups[0];
  let sendCount = 0;

  const result = await generateWeeklyReportForGroup({
    group,
    bitable: {
      findWeeklySummaryRecord: async () => null,
      listDailyReportsForWeek: async () => [],
      upsertWeeklySummary: async () => ({ skipped: true }),
    },
    aiProvider: new TemplateAiProvider(),
    messenger: {
      sendText: async () => { sendCount += 1; },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'shtcn_test',
        sheetId: 'existing_sheet',
        title: '数字金融部周报 2026-06-22-2026-06-26',
        reused: true,
      }),
      discoverTemplateTargets: async () => discoveredMap,
      writeCells: async () => ({ rangeCount: 1 }),
    },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-27T02:00:00.000Z'),
    delivery: 'send',
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'weekly_sheet_exists');
  assert.equal(sendCount, 0);
});

test('deduplicates multi-day fact rows before calling AI provider', async () => {
  const group = normalizeConfig({ groups: [{
    chatId: 'oc_test', project: '数字金融部',
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    weeklySheet: { enabled: true, spreadsheetToken: 'sheet', templateSheetId: 'tpl' },
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
    },
    aiProvider: new TemplateAiProvider(),
    messenger: { sendText: async () => { sendCount += 1; } },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet', sheetId: 'week', title: 'week', reused: false,
      }),
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
