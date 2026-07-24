import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadWeeklyConfiguration,
  normalizeCoreMetricOwner,
  normalizeWeeklySectionRule,
  normalizeWeeklySourceMapping,
  normalizeWeeklyStyleExample,
} from '../src/weekly-config-repository.js';

const period = { start: '2026-07-20', end: '2026-07-24' };

function table(fields, suffix) {
  return { appToken: `bas_${suffix}`, tableId: `tbl_${suffix}`, fields };
}

function createGroup(overrides = {}) {
  return {
    weeklySourceMappingTable: table({
      member: '成员',
      memberRealName: '成员真实姓名',
      memberOpenId: '成员OpenID',
      module2Targets: '模块二可归集板块',
      module3Target: '模块三归属板块',
      effectiveFrom: '生效日期',
      effectiveTo: '失效日期',
      enabled: '是否启用',
    }, 'mapping'),
    weeklySectionRuleTable: table({
      module: '模块',
      target: '周报板块',
      contentType: '内容类型',
      includeTopics: '包含主题',
      excludeTopics: '排除主题',
      owners: '周报负责人',
      remindOwners: '负责人提醒',
      order: '排序',
      enabled: '是否启用',
    }, 'rule'),
    weeklyStyleExampleTable: table({
      module: '模块',
      target: '周报板块',
      contentType: '内容类型',
      weekKey: '样例周次',
      finalText: '最终样例正文',
      reviewedAt: '审核时间',
      highQuality: '纳入优质样例',
      enabled: '是否启用',
    }, 'style'),
    coreMetricOwnerTable: table({
      metricName: '指标名称',
      owners: '指标负责人',
      remindersEnabled: '启用提醒',
      enabled: '是否启用',
    }, 'metric'),
    ...overrides,
  };
}

function record(recordId, fields) {
  return { record_id: recordId, fields };
}

test('normalizes mappings with linked contacts, lookup arrays, multi-target module two, and empty module three', () => {
  const mapping = normalizeWeeklySourceMapping(record('rec_mapping', {
    成员: [{ text: '王小明' }],
    成员真实姓名: ['王小明'],
    成员OpenID: ['ou_member_1'],
    模块二可归集板块: [{ text: '项目A' }, { text: '项目B' }],
    模块三归属板块: [],
    生效日期: '2026-07-01',
    失效日期: '',
    是否启用: true,
  }), createGroup().weeklySourceMappingTable);

  assert.deepEqual(mapping, {
    recordId: 'rec_mapping',
    contactRecordIds: ['王小明'],
    memberName: '王小明',
    memberOpenId: 'ou_member_1',
    module2Targets: ['项目A', '项目B'],
    module3Target: '',
    effectiveFrom: '2026-07-01',
    effectiveTo: '',
    enabled: true,
  });
});

test('normalizes multiple weekly owners to public people objects', () => {
  const rule = normalizeWeeklySectionRule(record('rec_rule', {
    模块: '模块二',
    周报板块: '项目A',
    内容类型: '进展',
    包含主题: ['主题1'],
    排除主题: [],
    周报负责人: [{ id: 'ou_1', name: '负责人甲' }, { id: 'ou_2', name: '负责人乙' }],
    负责人提醒: true,
    排序: '3',
    是否启用: true,
  }), createGroup().weeklySectionRuleTable);

  assert.deepEqual(rule.owners, [
    { openId: 'ou_1', name: '负责人甲' },
    { openId: 'ou_2', name: '负责人乙' },
  ]);
  assert.equal(rule.order, 3);

  const metricOwner = normalizeCoreMetricOwner(record('rec_metric', {
    指标名称: '月活',
    指标负责人: [{ id: 'ou_3', name: '指标负责人' }],
    启用提醒: true,
    是否启用: true,
  }), createGroup().coreMetricOwnerTable);
  assert.deepEqual(metricOwner.owners, [{ openId: 'ou_3', name: '指标负责人' }]);
});

test('normalizes style examples without exposing Base records', () => {
  const example = normalizeWeeklyStyleExample(record('rec_style', {
    模块: '模块三',
    周报板块: '经营管理',
    内容类型: '进展',
    样例周次: '2026-W30',
    最终样例正文: '已完成推进。',
    审核时间: '2026-07-24',
    纳入优质样例: true,
    是否启用: true,
  }), createGroup().weeklyStyleExampleTable);

  assert.deepEqual(example, {
    recordId: 'rec_style',
    module: '模块三',
    target: '经营管理',
    contentType: '进展',
    weekKey: '2026-W30',
    finalText: '已完成推进。',
    reviewedAt: '2026-07-24',
    highQuality: true,
    enabled: true,
  });
});

test('loads configured tables in parallel and filters inactive, out-of-period, disabled, and unreviewed records', async () => {
  const group = createGroup();
  const calls = [];
  const bitable = {
    listRecords: async (sourceTable, operation, options) => {
      calls.push({ sourceTable, operation, options });
      if (sourceTable === group.weeklySourceMappingTable) return [
        record('rec_active', { 成员: ['contact_1'], 成员真实姓名: '甲', 成员OpenID: 'ou_1', 模块二可归集板块: ['项目A'], 模块三归属板块: '', 生效日期: '2026-07-20', 失效日期: '2026-07-24', 是否启用: true }),
        record('rec_expired', { 成员: ['contact_2'], 成员真实姓名: '乙', 成员OpenID: 'ou_2', 模块二可归集板块: ['项目B'], 模块三归属板块: '', 生效日期: '2026-07-01', 失效日期: '2026-07-19', 是否启用: true }),
        record('rec_disabled', { 成员: ['contact_3'], 成员真实姓名: '丙', 成员OpenID: 'ou_3', 模块二可归集板块: ['项目C'], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: false }),
      ];
      if (sourceTable === group.weeklySectionRuleTable) return [
        record('rec_rule_enabled', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 包含主题: [], 排除主题: [], 周报负责人: [], 负责人提醒: false, 排序: 1, 是否启用: true }),
        record('rec_rule_disabled', { 模块: '模块二', 周报板块: '项目B', 内容类型: '进展', 包含主题: [], 排除主题: [], 周报负责人: [], 负责人提醒: false, 排序: 2, 是否启用: false }),
      ];
      if (sourceTable === group.weeklyStyleExampleTable) return [
        record('rec_style_accepted', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 样例周次: '2026-W30', 最终样例正文: '优质样例', 审核时间: '2026-07-24', 纳入优质样例: true, 是否启用: true }),
        record('rec_style_unreviewed', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 样例周次: '2026-W30', 最终样例正文: '未审核', 审核时间: '', 纳入优质样例: true, 是否启用: true }),
        record('rec_style_low_quality', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 样例周次: '2026-W30', 最终样例正文: '低质量', 审核时间: '2026-07-24', 纳入优质样例: false, 是否启用: true }),
      ];
      return [record('rec_metric', { 指标名称: '月活', 指标负责人: [{ id: 'ou_owner', name: '负责人' }], 启用提醒: true, 是否启用: true })];
    },
  };

  const result = await loadWeeklyConfiguration({ group, bitable, period });

  assert.deepEqual(calls.map(call => call.operation), [
    'weeklyConfig.mappings', 'weeklyConfig.rules', 'weeklyConfig.styles', 'weeklyConfig.metrics',
  ]);
  assert.ok(calls.every(call => call.options.includeView === false));
  assert.deepEqual(result.mappings.map(item => item.recordId), ['rec_active']);
  assert.deepEqual(result.rules.map(item => item.recordId), ['rec_rule_enabled']);
  assert.deepEqual(result.styleExamples.map(item => item.recordId), ['rec_style_accepted']);
  assert.deepEqual(result.metricOwners.map(item => item.recordId), ['rec_metric']);
});

test('returns a duplicate active mapping warning instead of selecting a record', async () => {
  const group = createGroup();
  const bitable = {
    listRecords: async sourceTable => sourceTable === group.weeklySourceMappingTable
      ? [
        record('rec_first', { 成员: [], 成员真实姓名: '甲', 成员OpenID: 'ou_duplicate', 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
        record('rec_second', { 成员: [], 成员真实姓名: '甲', 成员OpenID: 'ou_duplicate', 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
      ]
      : [],
  };

  const result = await loadWeeklyConfiguration({ group, bitable, period: { start: '2026-07-20', end: '2026-07-20' } });

  assert.equal(result.mappings.length, 2);
  assert.deepEqual(result.warnings, ['duplicate_active_mapping:2026-07-20:ou_duplicate']);
});

test('safely skips every unconfigured weekly configuration table without list calls or sensitive warnings', async () => {
  const calls = [];
  const bitable = { listRecords: async (...args) => { calls.push(args); return []; } };
  const result = await loadWeeklyConfiguration({
    group: createGroup({
      weeklySourceMappingTable: { appToken: 'bas_secret' },
      weeklySectionRuleTable: { tableId: 'tbl_secret' },
      weeklyStyleExampleTable: { wikiNodeToken: 'wik_secret' },
      coreMetricOwnerTable: null,
    }),
    bitable,
    period,
  });

  assert.deepEqual(result, {
    mappings: [],
    rules: [],
    styleExamples: [],
    metricOwners: [],
    warnings: [
      'weekly_config_table_not_configured:mappings',
      'weekly_config_table_not_configured:rules',
      'weekly_config_table_not_configured:styles',
      'weekly_config_table_not_configured:metrics',
    ],
  });
  assert.deepEqual(calls, []);
});
