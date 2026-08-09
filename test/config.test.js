import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as configApi from '../src/config.js';

const {
  findGroupByChatId,
  normalizeConfig,
  parseBitableLink,
  parseWeeklySheetLink,
  WEEKLY_SECTION_RULE_FIELD_KEYS,
} = configApi;

const SHARED_RESOURCE_KEYS_FOR_TEST = [
  'dailyTable',
  'chatDailyRawTable',
  'dailyFactTable',
  'contactTable',
  'weeklyTable',
  'weeklyInstanceTable',
  'weeklySourceMappingTable',
  'weeklySectionRuleTable',
  'weeklyStyleExampleTable',
  'coreMetricOwnerTable',
  'weeklySheet',
  'weeklyDelivery',
];

test('normalizes one shared reporting unit and two lightweight chat groups', () => {
  const config = normalizeConfig({
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      dailyTable: { appToken: 'bas_shared', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas_shared', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A', pushChatId: 'oc_test' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B', pushChatId: 'oc_test' },
    ],
  });

  assert.ok(Array.isArray(config.chatGroups));
  assert.equal(config.chatGroups.length, 2);
  assert.equal(config.reportingUnits.length, 1);
  assert.equal(config.reportingUnits[0].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(config.chatGroups[0].dailyFactTable, undefined);
  assert.equal(config.groups[1].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(config.groups[1].project, '板块B');
  assert.equal(config.groups[1].reportingUnitKey, 'digital-finance');
  assert.equal(typeof configApi.getReportingUnits, 'function');
  assert.deepEqual(configApi.getReportingUnits(config), config.reportingUnits);
  assert.equal(configApi.getReportingUnits(config).length, 1);
  assert.equal(configApi.getReportingUnits(config)[0].chatId, undefined);
  assert.equal(findGroupByChatId(config, 'oc_b').chatId, 'oc_b');
  assert.equal(findGroupByChatId(config, 'oc_test'), null);
});

test('requires shared resource identity and enabled chat metadata', () => {
  for (const [raw, code] of [
    [
      { sharedResources: { name: '数字金融部' }, groups: [] },
      'missing_shared_resource_key',
    ],
    [
      { sharedResources: { key: 'digital-finance' }, groups: [] },
      'missing_shared_resource_name',
    ],
    [
      {
        sharedResources: { key: 'digital-finance', name: '数字金融部' },
        groups: [{ name: '日报群A', project: '板块A' }],
      },
      'missing_group_chat_id',
    ],
    [
      {
        sharedResources: { key: 'digital-finance', name: '数字金融部' },
        groups: [{ chatId: 'oc_a', project: '板块A' }],
      },
      'missing_group_name',
    ],
    [
      {
        sharedResources: { key: 'digital-finance', name: '数字金融部' },
        groups: [{ chatId: 'oc_a', name: '日报群A' }],
      },
      'missing_group_project',
    ],
  ]) {
    assert.throws(
      () => normalizeConfig(raw),
      error => error.code === code,
    );
  }

  assert.doesNotThrow(() => normalizeConfig({
    sharedResources: { key: 'digital-finance', name: '数字金融部' },
    groups: [{ enabled: false }],
  }));
});

test('omits disabled chat groups while validating duplicate chat ids across all raw groups', () => {
  const config = normalizeConfig({
    sharedResources: { key: 'shared', name: '共享单元' },
    groups: [
      { enabled: false, chatId: 'oc_disabled', name: '已停用群' },
      { chatId: 'oc_enabled', name: '启用群', project: '启用板块' },
    ],
  });

  assert.ok(Array.isArray(config.chatGroups));
  assert.deepEqual(config.chatGroups.map(group => group.chatId), ['oc_enabled']);

  assert.throws(
    () => normalizeConfig({
      sharedResources: { key: 'shared', name: '共享单元' },
      groups: [
        { enabled: false, chatId: 'oc_duplicate' },
        { chatId: 'oc_duplicate' },
      ],
    }),
    error => error.code === 'duplicate_chat_id',
  );
});

test('rejects group-level shared resource overrides but allows shared push destinations', () => {
  assert.throws(
    () => normalizeConfig({
      sharedResources: {
        key: 'shared',
        name: '共享单元',
        dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
      },
      groups: [{
        chatId: 'oc_a',
        name: '日报群A',
        project: '板块A',
        dailyFactTable: { appToken: 'bas_group', tableId: 'tbl_other' },
      }],
    }),
    error => error.code === 'group_shared_resource_override',
  );

  const config = normalizeConfig({
    sharedResources: { key: 'shared', name: '共享单元' },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A', pushChatId: 'oc_push' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B', pushChatId: 'oc_push' },
    ],
  });
  assert.deepEqual(config.chatGroups.map(group => group.pushChatId), ['oc_push', 'oc_push']);
});

test('keeps one legacy group as one chat and one reporting unit', () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_legacy',
      name: '旧日报群',
      project: '公司项目组',
      dailyFactTable: { appToken: 'bas_legacy', tableId: 'tbl_fact' },
    }],
  });

  assert.ok(Array.isArray(config.chatGroups));
  assert.equal(config.chatGroups.length, 1);
  assert.equal(config.reportingUnits.length, 1);
  assert.equal(config.reportingUnits[0].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(findGroupByChatId(config, 'oc_legacy').project, '公司项目组');
});

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

test('exposes semantic weekly rule field mappings', () => {
  assert.deepEqual({
    ruleKey: WEEKLY_SECTION_RULE_FIELD_KEYS.ruleKey,
    businessScope: WEEKLY_SECTION_RULE_FIELD_KEYS.businessScope,
    includeTopics: WEEKLY_SECTION_RULE_FIELD_KEYS.includeTopics,
    excludeTopics: WEEKLY_SECTION_RULE_FIELD_KEYS.excludeTopics,
    positiveExamples: WEEKLY_SECTION_RULE_FIELD_KEYS.positiveExamples,
    negativeExamples: WEEKLY_SECTION_RULE_FIELD_KEYS.negativeExamples,
  }, {
    ruleKey: '规则唯一键',
    businessScope: '业务范围说明',
    includeTopics: '包含主题',
    excludeTopics: '排除主题',
    positiveExamples: '分类正例',
    negativeExamples: '分类反例',
  });
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
  assert.equal(config.groups[0].weeklySheet.titlePattern, '数字金融部周报{{reportDateMMDD}}');
});

test('all weekly title configurations use the Friday MMDD title pattern', () => {
  for (const filePath of [
    'config/groups.json',
    'config/groups.personal.json',
    'config/groups.formal.example.json',
  ]) {
    const config = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')));
    for (const group of config.groups) {
      assert.equal(group.weeklySheet?.titlePattern, '数字金融部周报{{reportDateMMDD}}', filePath);
    }
  }
});

test('migrates all config files to one shared resource unit and lightweight groups', () => {
  for (const filePath of [
    'config/groups.json',
    'config/groups.personal.json',
    'config/groups.formal.example.json',
    'config/groups.formal.json',
  ]) {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const config = normalizeConfig(raw);

    assert.ok(raw.sharedResources, filePath);
    assert.equal(config.reportingUnits.length, 1, filePath);
    assert.ok(raw.groups.length >= 1, filePath);
    for (const group of raw.groups) {
      for (const key of SHARED_RESOURCE_KEYS_FOR_TEST) {
        assert.equal(group[key], undefined, `${filePath} groups.${key}`);
      }
    }
    for (const scheduleKey of [
      'weeklyPush',
      'weeklyDraft',
      'weeklyOwnerReminder',
      'weeklyRefresh',
      'weeklyInstanceCreation',
      'dailySupervisorPush',
      'dailyFactSync',
      'chatDailyReplay',
    ]) {
      if (raw[scheduleKey]) assert.equal(raw[scheduleKey].enabled, false, `${filePath} ${scheduleKey}`);
    }
  }

  const formalExample = JSON.parse(readFileSync('config/groups.formal.example.json', 'utf8'));
  assert.equal(formalExample.groups[0].chatId, '正式组织日报群chatId');
  assert.equal(formalExample.groups[0].pushChatId, '正式组织日报群chatId');
  assert.equal(formalExample.sharedResources.weeklyInstanceTable.appToken, '');
  assert.equal(formalExample.sharedResources.weeklyInstanceTable.tableId, '');
  const serializedFormalExample = JSON.stringify(formalExample);
  assert.doesNotMatch(serializedFormalExample, /https?:\/\//);
  assert.doesNotMatch(serializedFormalExample, /\b(?:oc|ou|om)_[A-Za-z0-9_-]{8,}\b/);
  assert.doesNotMatch(serializedFormalExample, /\b(?:tbl|vew)[A-Za-z0-9_-]{8,}\b/);
  assert.doesNotMatch(serializedFormalExample, /\bWNum[A-Za-z0-9_-]+\b/);
  assert.ok(formalExample.sharedResources.weeklyDelivery.smallTeams.every(team => (
    team.enabled === false && team.chatId === ''
  )));
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
  assert.equal(group.dailyFactTable.fields.fieldSourceSnapshot, '字段来源快照');
});

test('chat daily replay is disabled by default and normalizes lookback settings', () => {
  const defaults = normalizeConfig({ groups: [] });
  assert.deepEqual(defaults.chatDailyReplay, {
    enabled: false,
    intervalMinutes: 1440,
    lookbackMinutes: 1440,
  });

  const configured = normalizeConfig({
    chatDailyReplay: {
      enabled: true,
      intervalMinutes: 10,
      lookbackMinutes: 360,
    },
    groups: [],
  });
  assert.deepEqual(configured.chatDailyReplay, {
    enabled: true,
    intervalMinutes: 10,
    lookbackMinutes: 360,
  });
});

test('does not normalize group agileGroup as organization configuration', () => {
  const group = normalizeConfig({
    groups: [{ chatId: 'oc_test', agileGroup: '不应保留' }],
  }).groups[0];

  assert.equal(Object.hasOwn(group, 'agileGroup'), false);
});

test('normalizes the weekly workflow configuration schema with disabled defaults', () => {
  const config = normalizeConfig({
    weeklyDraft: { enabled: false },
    weeklyOwnerReminder: { enabled: false },
    weeklyRefresh: { enabled: false },
    weeklyPush: { enabled: false },
    groups: [{
      chatId: 'oc_test',
      dailyFactTable: { appToken: 'bas_test', tableId: 'tbl_fact' },
      contactTable: { appToken: 'bas_test', tableId: 'tbl_contact' },
      weeklySourceMappingTable: { appToken: 'bas_test', tableId: 'tbl_mapping' },
      weeklySectionRuleTable: { appToken: 'bas_test', tableId: 'tbl_rule' },
      weeklyStyleExampleTable: { appToken: 'bas_test', tableId: 'tbl_style' },
      coreMetricOwnerTable: { appToken: 'bas_test', tableId: 'tbl_metric' },
      weeklyDelivery: {
        departmentChatId: 'oc_department',
        smallTeams: [{
          key: 'team-a',
          name: '测试小团队A',
          enabled: true,
          chatId: 'oc_test',
          sectionTargets: ['融羲项目组', '零售大众客群经营'],
        }],
      },
    }],
  });
  const group = config.groups[0];

  assert.equal(group.contactTable.fields.agileGroup, undefined);
  assert.equal(group.contactTable.fields.divisionalLeader, undefined);
  assert.equal(group.dailyFactTable.fields.agileGroup, undefined);
  assert.equal(group.dailyFactTable.fields.divisionalLeader, undefined);
  assert.equal(group.dailyFactTable.fields.fieldSourceSnapshot, '字段来源快照');
  assert.ok(group.weeklySourceMappingTable);
  assert.ok(group.weeklySectionRuleTable);
  assert.ok(group.weeklyStyleExampleTable);
  assert.ok(group.coreMetricOwnerTable);
  assert.deepEqual(config.weeklyDraft, {
    enabled: false,
    dayOfWeek: 5,
    time: '09:00',
    timezone: 'Asia/Shanghai',
  });
  assert.deepEqual(group.weeklyDelivery.smallTeams[0], {
    key: 'team-a',
    name: '测试小团队A',
    enabled: true,
    chatId: 'oc_test',
    sectionTargets: ['融羲项目组', '零售大众客群经营'],
    sourceSupervisors: [],
    posterSections: [],
  });
});

test('local group configs map supervisor users without obsolete organization fields', () => {
  for (const filePath of ['config/groups.json', 'config/groups.personal.json']) {
    const config = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')));
    for (const group of config.groups) {
      assert.equal(
        group.dailyFactTable?.fieldTypes?.supervisor,
        'user',
        `${filePath} ${group.chatId} dailyFactTable.直属上级 应配置为人员字段 user`,
      );
      assert.equal(group.dailyFactTable?.fieldTypes?.sourceTime, 'datetime');
      assert.equal(group.contactTable?.fields?.agileGroup, undefined);
      assert.equal(group.contactTable?.fields?.divisionalLeader, undefined);
      assert.equal(group.dailyFactTable?.fields?.agileGroup, undefined);
      assert.equal(group.dailyFactTable?.fields?.divisionalLeader, undefined);
    }
  }

  const personal = normalizeConfig(JSON.parse(readFileSync('config/groups.personal.json', 'utf8')));
  assert.equal(personal.groups[0].dailyFactTable.fields.fieldSourceSnapshot, '字段来源快照');
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
