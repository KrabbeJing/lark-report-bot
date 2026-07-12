import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig, parseBitableLink, parseWeeklySheetLink } from '../src/config.js';

test('parses weekly sheet wiki link', () => {
  const parsed = parseWeeklySheetLink('https://acncyn3n5k6i.feishu.cn/wiki/BaTOwZsM6ikYjJkhSqOc8e0Ynrh?sheet=4dcda2');
  assert.equal(parsed.wikiNodeToken, 'BaTOwZsM6ikYjJkhSqOc8e0Ynrh');
  assert.equal(parsed.sheetId, '4dcda2');
  assert.equal(parsed.spreadsheetToken, '');
});

test('normalizes weeklySheet from wiki url', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklySheet: {
        enabled: false,
        spreadsheetUrl: 'https://acncyn3n5k6i.feishu.cn/wiki/BaTOwZsM6ikYjJkhSqOc8e0Ynrh?sheet=4dcda2',
      },
    }],
  }).groups[0];

  assert.equal(group.weeklySheet.wikiNodeToken, 'BaTOwZsM6ikYjJkhSqOc8e0Ynrh');
  assert.equal(group.weeklySheet.templateSheetId, '4dcda2');
});

test('normalizes weekly instance schedule, table, and semantic aliases without cell coordinates', () => {
  const config = normalizeConfig({
    weeklyInstanceCreation: { enabled: true, time: '09:05' },
    weeklyInstanceTable: {
      appToken: 'base_token',
      tableId: 'instance_table',
      fieldTypes: {
        weekStart: 'date',
        weekEnd: 'date',
        sheetUrl: 'url',
        createdAt: 'datetime',
        updatedAt: 'datetime',
      },
    },
    weeklySheet: { spreadsheetToken: 'sheet_token', templateSheetId: 'template' },
    groups: [{ enabled: true, chatId: 'chat_1', project: '公司项目组' }],
  });

  assert.deepEqual(config.weeklyInstanceCreation, {
    enabled: true,
    dayOfWeek: 1,
    time: '09:05',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(config.groups[0].weeklyInstanceTable.fields.instanceKey, '周报实例唯一键');
  assert.equal(config.groups[0].weeklyInstanceTable.fieldTypes.sheetUrl, 'url');
  assert.equal(config.groups[0].weeklySheet.cellMap, undefined);
  assert.deepEqual(config.groups[0].weeklySheet.entityAliases.agileProjects['融羲项目组'], ['融羲']);
});

test('normalizes chat raw and daily fact table configs', () => {
  const config = normalizeConfig({
    dailyFactSync: {
      enabled: true,
      time: '18:10',
      lookbackDays: 5,
    },
    groups: [{
      chatId: 'oc_test',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          rawText: '原始消息文本',
        },
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reporterNameText: '日报提交人姓名',
        },
      },
    }],
  });

  const group = config.groups[0];
  assert.equal(config.dailyFactSync.enabled, true);
  assert.equal(config.dailyFactSync.lookbackDays, 5);
  assert.equal(group.chatDailyRawTable.tableId, 'tbl_chat_raw');
  assert.equal(group.chatDailyRawTable.fields.messageId, '消息ID');
  assert.equal(group.chatDailyRawTable.fields.reportDateRange, '日报日期范围');
  assert.equal(group.dailyFactTable.fields.factKey, '事实唯一键');
  assert.equal(group.dailyFactTable.fields.contentFingerprint, '内容指纹');
  assert.equal(group.dailyFactTable.fields.sourceTime, '来源时间');
  assert.equal(group.dailyFactTable.fields.effectiveSource, '有效来源');
  assert.equal(group.dailyFactTable.fields.autoResolutionNote, '自动处理说明');
  assert.equal(group.dailyFactTable.fields.divisionalLeader, '分管领导');
});

test('local group configs map supervisor users and contact agile groups', () => {
  for (const filePath of ['config/groups.json', 'config/groups.personal.json']) {
    const config = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')));
    for (const group of config.groups) {
      assert.equal(
        group.dailyFactTable?.fieldTypes?.supervisor,
        'user',
        `${filePath} ${group.chatId} dailyFactTable.直属上级 应配置为人员字段 user`,
      );
      assert.equal(group.dailyFactTable?.fieldTypes?.sourceTime, 'datetime');
      assert.equal(group.dailyFactTable?.fieldTypes?.divisionalLeader, 'user');
      assert.equal(
        group.contactTable?.fields?.agileGroup,
        '敏捷小组',
        `${filePath} ${group.chatId} contactTable 需要映射敏捷小组字段`,
      );
    }
  }
});

test('parses bitable wiki link with table and view ids', () => {
  const parsed = parseBitableLink('https://scnbvf7ldg2u.feishu.cn/wiki/WNumwlQuKi8ucak6ZEBcYiYtnH8?table=tblT1DtMmxmHx3cs&view=vewXSKRchw');
  assert.equal(parsed.wikiNodeToken, 'WNumwlQuKi8ucak6ZEBcYiYtnH8');
  assert.equal(parsed.tableId, 'tblT1DtMmxmHx3cs');
  assert.equal(parsed.viewId, 'vewXSKRchw');
  assert.equal(parsed.appToken, '');
});

test('normalizes table config from wiki url', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: {
        wikiUrl: 'https://scnbvf7ldg2u.feishu.cn/wiki/WNumwlQuKi8ucak6ZEBcYiYtnH8?table=tblT1DtMmxmHx3cs&view=vewXSKRchw',
      },
    }],
  }).groups[0];

  assert.equal(group.dailyTable.wikiNodeToken, 'WNumwlQuKi8ucak6ZEBcYiYtnH8');
  assert.equal(group.dailyTable.tableId, 'tblT1DtMmxmHx3cs');
  assert.equal(group.dailyTable.viewId, 'vewXSKRchw');
});
