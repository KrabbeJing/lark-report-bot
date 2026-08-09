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
      ruleKey: '规则唯一键',
      module: '模块',
      target: '周报板块',
      contentType: '内容类型',
      businessScope: '业务范围说明',
      includeTopics: '包含主题',
      excludeTopics: '排除主题',
      positiveExamples: '分类正例',
      negativeExamples: '分类反例',
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

test('normalizes Base millisecond mapping dates in Asia Shanghai while retaining YYYY-MM-DD strings', () => {
  const tableConfig = createGroup().weeklySourceMappingTable;
  const numericMapping = normalizeWeeklySourceMapping(record('rec_numeric_dates', {
    成员: ['rec_member'],
    成员真实姓名: ['王小明'],
    成员OpenID: ['ou_member_1'],
    模块二可归集板块: [],
    模块三归属板块: [],
    生效日期: 1784476800000,
    失效日期: 1784822400000,
    是否启用: true,
  }), tableConfig);
  const textMapping = normalizeWeeklySourceMapping(record('rec_text_dates', {
    生效日期: '2026-07-20',
    失效日期: '2026-07-24',
  }), tableConfig);

  assert.equal(numericMapping.effectiveFrom, '2026-07-20');
  assert.equal(numericMapping.effectiveTo, '2026-07-24');
  assert.equal(textMapping.effectiveFrom, '2026-07-20');
  assert.equal(textMapping.effectiveTo, '2026-07-24');
});

test('normalizes multiple weekly owners to public people objects', () => {
  const rule = normalizeWeeklySectionRule(record('rec_rule', {
    规则唯一键: '模块三-对公客群经营及场景建设-本周工作进展',
    模块: '模块三',
    周报板块: '对公客群经营及场景建设',
    内容类型: '本周工作进展',
    业务范围说明: '负责云缴费、云充值和银企直联等对公客群经营事项',
    包含主题: ['云缴费', '银企直联'],
    排除主题: ['收单项目阶段成果'],
    分类正例: ['完成银企直联证书更新并通过验证'],
    分类反例: ['收单商户进件属于收单项目组'],
    周报负责人: [{ id: 'ou_1', name: '负责人甲' }, { id: 'ou_2', name: '负责人乙' }],
    负责人提醒: true,
    排序: '10',
    是否启用: true,
  }), createGroup().weeklySectionRuleTable);

  assert.deepEqual(rule, {
    recordId: 'rec_rule',
    targetId: '模块三-对公客群经营及场景建设-本周工作进展',
    module: '模块三',
    target: '对公客群经营及场景建设',
    contentType: '本周工作进展',
    businessScope: '负责云缴费、云充值和银企直联等对公客群经营事项',
    includeTopics: ['云缴费', '银企直联'],
    excludeTopics: ['收单项目阶段成果'],
    positiveExamples: ['完成银企直联证书更新并通过验证'],
    negativeExamples: ['收单商户进件属于收单项目组'],
    owners: [
      { openId: 'ou_1', name: '负责人甲' },
      { openId: 'ou_2', name: '负责人乙' },
    ],
    remindOwners: true,
    order: 10,
    enabled: true,
  });

  const metricOwner = normalizeCoreMetricOwner(record('rec_metric', {
    指标名称: '月活',
    指标负责人: [{ id: 'ou_3', name: '指标负责人' }],
    启用提醒: true,
    是否启用: true,
  }), createGroup().coreMetricOwnerTable);
  assert.deepEqual(metricOwner.owners, [{ openId: 'ou_3', name: '指标负责人' }]);
});

test('splits multiline weekly rule hints and examples into trimmed entries', () => {
  const rule = normalizeWeeklySectionRule(record('rec_rule_lines', {
    规则唯一键: '模块二-收单项目组-本周重点事项说明',
    模块: '模块二',
    周报板块: '收单项目组',
    内容类型: '本周重点事项说明',
    业务范围说明: '收单业务',
    包含主题: '收单\r\n 商户进件 \n\nD0订单',
    排除主题: '云缴费\n 云充值 ',
    分类正例: '完成商户进件流程优化\nD0订单完成核对',
    分类反例: '云缴费工单\r\n 银企直联证书更新 ',
    是否启用: true,
  }), createGroup().weeklySectionRuleTable);

  assert.deepEqual(rule.includeTopics, ['收单', '商户进件', 'D0订单']);
  assert.deepEqual(rule.excludeTopics, ['云缴费', '云充值']);
  assert.deepEqual(rule.positiveExamples, ['完成商户进件流程优化', 'D0订单完成核对']);
  assert.deepEqual(rule.negativeExamples, ['云缴费工单', '银企直联证书更新']);
});

test('normalizes style examples without exposing Base records', () => {
  const example = normalizeWeeklyStyleExample(record('rec_style', {
    模块: '模块三',
    周报板块: '经营管理',
    内容类型: '进展',
    样例周次: '2026-W30',
    最终样例正文: '已完成推进。',
    审核时间: 1784881800000,
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
    reviewedAt: '2026/07/24 16:30:00',
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
        record('rec_closed_boundaries', { 成员: ['rec_member_1'], 成员真实姓名: '甲', 成员OpenID: 'ou_1', 模块二可归集板块: ['项目A'], 模块三归属板块: '', 生效日期: 1784476800000, 失效日期: 1784822400000, 是否启用: true }),
        record('rec_start_boundary', { 成员: ['rec_member_2'], 成员真实姓名: '乙', 成员OpenID: 'ou_2', 模块二可归集板块: ['项目B'], 模块三归属板块: '', 生效日期: 1784822400000, 失效日期: '', 是否启用: true }),
        record('rec_end_boundary', { 成员: ['rec_member_3'], 成员真实姓名: '丙', 成员OpenID: 'ou_3', 模块二可归集板块: ['项目C'], 模块三归属板块: '', 生效日期: '', 失效日期: 1784476800000, 是否启用: true }),
        record('rec_future_open', { 成员: ['rec_member_4'], 成员真实姓名: '丁', 成员OpenID: 'ou_4', 模块二可归集板块: ['项目D'], 模块三归属板块: '', 生效日期: 1785513600000, 失效日期: '', 是否启用: true }),
        record('rec_expired', { 成员: ['rec_member_5'], 成员真实姓名: '戊', 成员OpenID: 'ou_5', 模块二可归集板块: ['项目E'], 模块三归属板块: '', 生效日期: '', 失效日期: 1784390400000, 是否启用: true }),
        record('rec_disabled', { 成员: ['rec_member_6'], 成员真实姓名: '己', 成员OpenID: 'ou_6', 模块二可归集板块: ['项目F'], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: false }),
      ];
      if (sourceTable === group.weeklySectionRuleTable) return [
        record('rec_rule_enabled', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 包含主题: [], 排除主题: [], 周报负责人: [], 负责人提醒: false, 排序: 1, 是否启用: true }),
        record('rec_rule_disabled', { 模块: '模块二', 周报板块: '项目B', 内容类型: '进展', 包含主题: [], 排除主题: [], 周报负责人: [], 负责人提醒: false, 排序: 2, 是否启用: false }),
      ];
      if (sourceTable === group.weeklyStyleExampleTable) return [
        record('rec_style_accepted', { 模块: '模块二', 周报板块: '项目A', 内容类型: '进展', 样例周次: '2026-W30', 最终样例正文: '优质样例', 审核时间: 1784881800000, 纳入优质样例: true, 是否启用: true }),
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
  assert.deepEqual(result.mappings.map(item => item.recordId), [
    'rec_closed_boundaries', 'rec_start_boundary', 'rec_end_boundary',
  ]);
  assert.deepEqual(result.rules.map(item => item.recordId), ['rec_rule_enabled']);
  assert.deepEqual(result.styleExamples.map(item => item.recordId), ['rec_style_accepted']);
  assert.deepEqual(result.metricOwners.map(item => item.recordId), ['rec_metric']);
});

test('returns a duplicate active mapping warning instead of selecting a record', async () => {
  const group = createGroup();
  const bitable = {
    listRecords: async sourceTable => sourceTable === group.weeklySourceMappingTable
      ? [
        record('rec_first', { 成员: ['rec_member'], 成员真实姓名: '甲', 成员OpenID: 'ou_duplicate', 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
        record('rec_second', { 成员: ['rec_member'], 成员真实姓名: '甲', 成员OpenID: [], 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
      ]
      : [],
  };

  const result = await loadWeeklyConfiguration({ group, bitable, period: { start: '2026-07-20', end: '2026-07-20' } });

  assert.equal(result.mappings.length, 2);
  assert.deepEqual(result.warnings, ['duplicate_active_mapping:2026-07-20:rec_member']);
});

test('uses every sorted unique linked contact ID for deterministic duplicate warnings', async () => {
  const group = createGroup();
  const bitable = {
    listRecords: async sourceTable => sourceTable === group.weeklySourceMappingTable
      ? [
        record('rec_first', { 成员: ['rec_member_b', 'rec_member_a', 'rec_member_a'], 成员真实姓名: '甲', 成员OpenID: 'ou_first', 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
        record('rec_second', { 成员: ['rec_member_a', 'rec_member_b'], 成员真实姓名: '乙', 成员OpenID: 'ou_second', 模块二可归集板块: [], 模块三归属板块: '', 生效日期: '', 失效日期: '', 是否启用: true }),
      ]
      : [],
  };

  const result = await loadWeeklyConfiguration({ group, bitable, period: { start: '2026-07-20', end: '2026-07-20' } });

  assert.deepEqual(result.warnings, [
    'duplicate_active_mapping:2026-07-20:rec_member_a',
    'duplicate_active_mapping:2026-07-20:rec_member_b',
  ]);
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
