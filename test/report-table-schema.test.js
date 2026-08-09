import test from 'node:test';
import assert from 'node:assert/strict';
import { getReportingUnits, normalizeConfig } from '../src/config.js';
import {
  REPORT_TABLE_KEYS,
  buildReportTableSchemaCatalog,
  validateReportTableSchema,
  validateConfiguredReportTables,
} from '../scripts/validate-report-table-schema.js';

const expectedTableKeys = [
  'dailyTable',
  'chatDailyRawTable',
  'dailyFactTable',
  'contactTable',
  'weeklySourceMappingTable',
  'weeklySectionRuleTable',
  'weeklyStyleExampleTable',
  'coreMetricOwnerTable',
  'weeklyInstanceTable',
];

test('catalog covers exactly the nine report tables', () => {
  assert.deepEqual(REPORT_TABLE_KEYS, expectedTableKeys);
  assert.deepEqual(Object.keys(buildReportTableSchemaCatalog()), expectedTableKeys);
});

test('catalog keeps agile and divisional fields out of contact and fact schemas', () => {
  const catalog = buildReportTableSchemaCatalog();
  const forbidden = ['敏捷小组', '分管领导'];

  for (const tableKey of ['dailyFactTable', 'contactTable']) {
    const names = catalog[tableKey].fields.map(field => field.name);
    for (const fieldName of forbidden) assert.equal(names.includes(fieldName), false);
  }
});

test('catalog declares the exact select option sets', () => {
  const catalog = buildReportTableSchemaCatalog();
  assert.deepEqual(findField(catalog.chatDailyRawTable, '解析状态').options, ['已解析', '低置信度', '解析失败']);
  assert.deepEqual(findField(catalog.dailyFactTable, '合并状态').options, ['单来源', '重复已合并', '互补已合并', '按字段取最新']);
  assert.deepEqual(findField(catalog.weeklySectionRuleTable, '模块').options, ['模块二', '模块三']);
  assert.deepEqual(findField(catalog.weeklySectionRuleTable, '周报板块').options, [
    '融羲项目组',
    '收单项目组',
    '线上营业厅项目组',
    '手机银行项目组',
    '新核心项目组',
    '零售大众客群经营',
    '对公客群经营及场景建设',
    '渠道创新建设',
    '业务风控合规',
    '业务转型推动',
  ]);
  assert.deepEqual(findField(catalog.weeklyInstanceTable, '海报状态').options, [
    '未生成',
    '生成中',
    '已生成',
    '生成失败',
    '已发送',
    '发送失败',
  ]);
});

test('catalog accepts formal form automatic and lookup field types', () => {
  const catalog = buildReportTableSchemaCatalog();
  const actual = fieldsFromOverrides({
    日报日期: { type: 5 },
    日报提交人: { type: 1003 },
    所属板块: { type: 19 },
    今日工作总结: { type: 1 },
    明日工作计划: { type: 1 },
    遇到的问题: { type: 1 },
    直属上级: { type: 19 },
    AI汇总: { type: 1 },
  });
  const result = validateReportTableSchema(catalog.dailyTable, actual);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('weekly source mapping uses a single person field for member identity', () => {
  const field = findField(buildReportTableSchemaCatalog().weeklySourceMappingTable, '成员');
  assert.equal(field.kind, 'user');
});

test('weekly section rules require semantic scope and classify examples as long text', () => {
  const table = buildReportTableSchemaCatalog().weeklySectionRuleTable;

  for (const fieldName of ['业务范围说明', '分类正例', '分类反例']) {
    const field = findField(table, fieldName);
    assert.equal(field.kind, 'longText', fieldName);
  }
  assert.equal(findField(table, '业务范围说明').required, true);
  assert.equal(findField(table, '分类正例').required, false);
  assert.equal(findField(table, '分类反例').required, false);
  assert.equal(findField(table, '包含主题').required, true);
});

test('validator accepts compatible date, person, url, and multiselect fields', () => {
  const catalog = buildReportTableSchemaCatalog();
  const actual = fieldsFor(catalog.weeklyInstanceTable, {
    周报日期: { type: 5 },
    周报链接: { type: 15 },
    实例状态: { type: 3, options: ['已创建', '创建失败', '已发布'] },
    AI生成状态: { type: 3, options: ['未生成', '生成中', '部分成功', '成功', '失败'] },
    负责人通知状态: { type: 3, options: ['未发送', '部分成功', '成功', '失败'] },
    海报状态: { type: 3, options: ['未生成', '生成中', '已生成', '生成失败', '已发送', '发送失败'] },
    小群推送状态: { type: 3, options: ['停用', '未发送', '部分成功', '成功', '失败'] },
    '周报实例唯一键': { type: 1 },
    ISO年份: { type: 2 },
    ISO周次: { type: 2 },
    日报周期开始: { type: 5 },
    日报周期结束: { type: 5 },
    SpreadsheetToken: { type: 1 },
    SheetID: { type: 1 },
    工作表名称: { type: 1 },
    创建时间: { type: 5 },
    更新时间: { type: 5 },
  });
  const result = validateReportTableSchema(catalog.weeklyInstanceTable, actual);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validator reports missing fields, incompatible types, and option drift', () => {
  const catalog = buildReportTableSchemaCatalog();
  const actual = fieldsFromOverrides({
    消息ID: { type: 1 },
    群ID: { type: 1 },
    发送人OpenID: { type: 2 },
    原始消息文本: { type: 1 },
    内容指纹: { type: 1 },
    消息时间: { type: 1 },
    接收时间: { type: 5 },
    解析状态: { type: 3, options: ['已解析', '失败'] },
  });
  const result = validateReportTableSchema(catalog.chatDailyRawTable, actual);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'missing_required_field' && error.field === '原始记录状态'));
  assert.ok(result.errors.some(error => error.code === 'type_mismatch' && error.field === '发送人OpenID'));
  assert.ok(result.errors.some(error => error.code === 'type_mismatch' && error.field === '消息时间'));
  assert.ok(result.errors.some(error => error.code === 'options_mismatch' && error.field === '解析状态'));
});

test('configured validation reads all nine tables and never requires a write method', async () => {
  const catalog = buildReportTableSchemaCatalog();
  const calls = [];
  const actualByTable = Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
    tableKey,
    fieldsFor(catalog[tableKey], {}),
  ]));
  const group = Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
    tableKey,
    { appToken: 'app_test', tableId: `tbl_${tableKey}` },
  ]));

  const result = await validateConfiguredReportTables({
    groups: [{ name: '测试组', ...group }],
    listFields: async table => {
      calls.push([table.appToken, table.tableId]);
      return actualByTable[REPORT_TABLE_KEYS.find(key => table.tableId === `tbl_${key}`)];
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.groups[0].tables.length, 9);
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.map(([, tableId]) => tableId), REPORT_TABLE_KEYS.map(key => `tbl_${key}`));
});

test('configured validation accepts wiki-node table configurations', async () => {
  const catalog = buildReportTableSchemaCatalog();
  const actualByTable = Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
    tableKey,
    fieldsFor(catalog[tableKey], {}),
  ]));
  const group = Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
    tableKey,
    { wikiNodeToken: 'wiki_test', tableId: `tbl_${tableKey}` },
  ]));

  const result = await validateConfiguredReportTables({
    groups: [{ name: '正式组织测试组', ...group }],
    listFields: async table => actualByTable[REPORT_TABLE_KEYS.find(key => table.tableId === `tbl_${key}`)],
  });

  assert.equal(result.valid, true);
  assert.equal(result.groups[0].tables.every(table => table.valid), true);
});

test('configured validation sanitizes table read errors', async () => {
  const group = Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
    tableKey,
    { appToken: 'bas_test', tableId: `tbl_${tableKey}` },
  ]));
  const result = await validateConfiguredReportTables({
    groups: [{ name: '测试组', ...group }],
    listFields: async table => {
      if (table.tableId === 'tbl_dailyTable') {
        throw new Error('request failed app_token=bas_secret table_id=tbl_secret Bearer secret-token');
      }
      return fieldsFor(buildReportTableSchemaCatalog().dailyTable, {});
    },
  });

  const error = result.groups[0].tables.find(table => table.tableKey === 'dailyTable').errors[0];
  assert.equal(error.code, 'read_failed');
  assert.equal(error.message.includes('bas_secret'), false);
  assert.equal(error.message.includes('tbl_secret'), false);
  assert.equal(error.message.includes('secret-token'), false);
});

test('validates one shared schema group regardless of chat-group count', async () => {
  const config = normalizeConfig({
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      ...Object.fromEntries(REPORT_TABLE_KEYS.map(tableKey => [
        tableKey,
        { appToken: 'bas_shared', tableId: `tbl_${tableKey}` },
      ])),
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B' },
    ],
  });
  const listFieldsCalls = [];
  const result = await validateConfiguredReportTables({
    groups: getReportingUnits(config),
    listFields: async table => {
      listFieldsCalls.push(table.tableId);
      return [];
    },
  });

  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].group, '数字金融部');
  assert.deepEqual(
    result.groups[0].tables.map(table => table.tableKey),
    REPORT_TABLE_KEYS,
  );
  assert.equal(listFieldsCalls.length, REPORT_TABLE_KEYS.length);
});

function findField(table, name) {
  return table.fields.find(field => field.name === name);
}

function fieldsFor(table, overrides) {
  return table.fields.map(field => ({
    field_name: field.name,
    type: apiType(field.kind),
    property: field.options || field.multiple
      ? {
        options: field.options?.map(name => ({ name })),
        multiple: field.multiple === true || undefined,
      }
      : undefined,
    ...overrides[field.name],
  }));
}

function fieldsFromOverrides(overrides) {
  return Object.entries(overrides).map(([field_name, override]) => ({
    field_name,
    ...override,
    property: override.options
      ? { options: override.options.map(name => ({ name })) }
      : undefined,
  }));
}

function apiType(kind) {
  if (Array.isArray(kind)) return apiType(kind[0]);
  return {
    text: 1,
    longText: 1,
    number: 2,
    singleSelect: 3,
    multiSelect: 4,
    date: 5,
    datetime: 5,
    checkbox: 7,
    user: 11,
    url: 15,
    link: 18,
    lookup: 19,
    createdBy: 1003,
  }[kind];
}
