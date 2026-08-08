import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { pathToFileURL } from 'node:url';
import { BitableService } from '../src/bitable-service.js';
import { getReportingUnits, loadGroupConfig, tableIsConfigured } from '../src/config.js';
import { sanitizeOperationalText } from '../src/error-reporter.js';
import { buildLarkClientOptions } from '../src/lark-client.js';

export const REPORT_TABLE_KEYS = [
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

const MODULES = ['模块二', '模块三'];
const SECTIONS = [
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
];
const CONTENT_TYPES = ['本周重点事项说明', '本周工作进展'];

const FACT_SOURCES = ['form', 'chat', 'form+chat'];
const FACT_REPORT_TYPES = ['单日', '多日合并'];
const MATCHING_STATUSES = ['已匹配', '未匹配'];
const MERGE_STATUSES = ['单来源', '重复已合并', '互补已合并', '按字段取最新'];
const CONFLICT_STATUSES = ['无冲突', '已自动处理'];
const FACT_STATUSES = ['有效', '待人工确认', '忽略'];

export function buildReportTableSchemaCatalog() {
  return {
    dailyTable: schema('表单日报表', [
      field('日报日期', 'date', true),
      // The formal form uses automatic fields/lookups; the personal test Base
      // may still use writable person/text fields.
      field('日报提交人', ['createdBy', 'user'], true),
      field('所属板块', ['lookup', 'text']),
      field('今日工作总结', 'longText', true),
      field('明日工作计划', 'longText'),
      field('遇到的问题', 'longText'),
      field('直属上级', ['lookup', 'user']),
      field('AI汇总', 'longText'),
    ]),
    chatDailyRawTable: schema('群聊日报原始表', [
      field('消息ID', 'text', true),
      field('群ID', 'text', true),
      field('群名称', 'text'),
      field('发送人OpenID', 'text', true),
      field('标题姓名', 'text'),
      field('日报日期范围', 'text'),
      field('拆分日期列表', 'longText'),
      field('原始消息文本', 'longText', true),
      field('解析后工作总结', 'longText'),
      field('内容指纹', 'text', true),
      field('消息时间', 'datetime', true),
      field('接收时间', 'datetime', true),
      field('解析状态', 'singleSelect', true, ['已解析', '低置信度', '解析失败']),
      field('原始记录状态', 'singleSelect', true, ['主版本', '历史版本', '解析失败']),
    ]),
    dailyFactTable: schema('日报统一事实表', [
      field('事实唯一键', 'text', true),
      field('日报日期', 'date', true),
      field('实际日报提交人', 'user'),
      field('日报提交人姓名', 'text', true),
      field('成员OpenID', 'text'),
      field('发送人OpenID', 'text'),
      field('群ID', 'text'),
      field('所属板块', 'text'),
      field('直属上级', 'user'),
      field('原文', 'longText'),
      field('今日工作总结', 'longText'),
      field('明日工作计划', 'longText'),
      field('遇到的问题', 'longText'),
      field('字段来源快照', 'longText', true),
      field('内容指纹', 'text', true),
      field('日报来源', 'singleSelect', true, FACT_SOURCES),
      field('来源记录ID', 'text'),
      field('来源消息ID', 'text'),
      field('来源组合', 'longText'),
      field('日报类型', 'singleSelect', false, FACT_REPORT_TYPES),
      field('日期覆盖范围', 'text'),
      field('消息时间', 'datetime'),
      field('来源时间', 'datetime', true),
      field('有效来源', 'singleSelect', true, FACT_SOURCES),
      field('自动处理说明', 'longText'),
      field('匹配方式', 'singleSelect', false, ['open_id', '姓名', '别名']),
      field('匹配状态', 'singleSelect', true, MATCHING_STATUSES),
      field('合并状态', 'singleSelect', true, MERGE_STATUSES),
      field('冲突状态', 'singleSelect', true, CONFLICT_STATUSES),
      field('事实记录状态', 'singleSelect', true, FACT_STATUSES),
      field('同步时间', 'datetime', true),
    ], ['敏捷小组', '分管领导']),
    contactTable: schema('团队通讯录', [
      field('团队名称', 'text', true),
      field('团队成员', 'user', true),
      field('成员真实姓名', 'text', true),
      field('团队身份', 'singleSelect', true, ['组员', '组长']),
      field('直属上级', 'user'),
      field('成员别名', 'longText'),
      field('当前OpenID', 'text'),
      field('历史账号说明', 'longText'),
    ], ['敏捷小组', '分管领导']),
    weeklySourceMappingTable: schema('周报来源映射表', [
      field('映射唯一键', 'text', true),
      field('成员', 'user', true),
      field('成员真实姓名', 'lookup', true),
      field('成员OpenID', 'lookup'),
      field('模块二可归集板块', 'multiSelect', false, SECTIONS.slice(0, 5)),
      field('模块三归属板块', 'singleSelect', false, SECTIONS.slice(5)),
      field('生效日期', 'date', true),
      field('失效日期', 'date'),
      field('是否启用', 'checkbox', true),
      field('备注', 'longText'),
    ]),
    weeklySectionRuleTable: schema('周报板块规则表', [
      field('规则唯一键', 'text', true),
      field('模块', 'singleSelect', true, MODULES),
      field('周报板块', 'singleSelect', true, SECTIONS),
      field('内容类型', 'singleSelect', true, CONTENT_TYPES),
      field('包含主题', 'longText', true),
      field('排除主题', 'longText'),
      field('周报负责人', 'user', true, undefined, true),
      field('负责人提醒', 'checkbox', true),
      field('排序', 'number'),
      field('是否启用', 'checkbox', true),
      field('备注', 'longText'),
    ]),
    weeklyStyleExampleTable: schema('周报风格样例表', [
      field('样例唯一键', 'text', true),
      field('模块', 'singleSelect', true, MODULES),
      field('周报板块', 'singleSelect', true, SECTIONS),
      field('内容类型', 'singleSelect', true, CONTENT_TYPES),
      field('样例周次', 'text', true),
      field('最终样例正文', 'longText', true),
      field('审核人', 'user', true),
      field('审核时间', 'datetime', true),
      field('纳入优质样例', 'checkbox', true),
      field('是否启用', 'checkbox', true),
      field('备注', 'longText'),
    ]),
    coreMetricOwnerTable: schema('核心指标负责人表', [
      field('指标名称', 'text', true),
      field('指标负责人', 'user', true, undefined, true),
      field('启用提醒', 'checkbox', true),
      field('是否启用', 'checkbox', true),
      field('备注', 'longText'),
    ]),
    weeklyInstanceTable: schema('周报实例表', [
      field('周报实例唯一键', 'text', true),
      field('ISO年份', 'number', true),
      field('ISO周次', 'number', true),
      field('周报日期', 'date', true),
      field('日报周期开始', 'date', true),
      field('日报周期结束', 'date', true),
      field('SpreadsheetToken', 'text', true),
      field('SheetID', 'text', true),
      field('工作表名称', 'text', true),
      field('周报链接', 'url', true),
      field('实例状态', 'singleSelect', true, ['已创建', '创建失败', '已发布']),
      field('AI初次生成时间', 'datetime'),
      field('AI刷新时间', 'datetime'),
      field('AI草稿快照', 'longText'),
      field('AI证据快照', 'longText'),
      field('AI生成状态', 'singleSelect', true, ['未生成', '生成中', '部分成功', '成功', '失败']),
      field('负责人通知状态', 'singleSelect', true, ['未发送', '部分成功', '成功', '失败']),
      field('负责人通知明细', 'longText'),
      field('负责人通知时间', 'datetime'),
      field('核心指标提醒明细', 'longText'),
      field('海报ImageKey', 'text'),
      field('海报状态', 'singleSelect', true, ['未生成', '生成中', '已生成', '生成失败', '已发送', '发送失败']),
      field('海报发送时间', 'datetime'),
      field('小群推送状态', 'singleSelect', true, ['停用', '未发送', '部分成功', '成功', '失败']),
      field('小群推送明细', 'longText'),
      field('最后错误摘要', 'longText'),
      field('创建时间', 'datetime', true),
      field('更新时间', 'datetime', true),
    ]),
  };
}

export function validateReportTableSchema(expected, actualFields) {
  const actualByName = new Map((actualFields || []).map(field => [field.field_name || field.name, field]));
  const errors = [];

  for (const field of expected.fields) {
    const actual = actualByName.get(field.name);
    if (!actual) {
      if (field.required) errors.push({ code: 'missing_required_field', field: field.name });
      continue;
    }

    if (!isCompatibleType(field.kind, actual)) {
      errors.push({
        code: 'type_mismatch',
        field: field.name,
        expected: field.kind,
        actual: describeActualType(actual),
      });
    }

    if (field.multiple === true && actual.property?.multiple !== true) {
      errors.push({ code: 'multiple_mismatch', field: field.name, expected: true });
    }

    if (field.options) {
      const actualOptions = (actual.property?.options || [])
        .map(option => option.name || option.value || '')
        .filter(Boolean);
      if (!sameStringSet(actualOptions, field.options)) {
        errors.push({
          code: 'options_mismatch',
          field: field.name,
          expected: field.options,
          actual: actualOptions,
        });
      }
    }
  }

  for (const forbidden of expected.forbiddenFields || []) {
    if (actualByName.has(forbidden)) errors.push({ code: 'forbidden_field', field: forbidden });
  }

  return {
    valid: errors.length === 0,
    table: expected.label,
    errors,
  };
}

export async function validateConfiguredReportTables({ groups, listFields }) {
  const catalog = buildReportTableSchemaCatalog();
  const groupResults = [];

  for (const group of groups || []) {
    const tables = [];
    for (const tableKey of REPORT_TABLE_KEYS) {
      const table = group[tableKey];
      if (!tableIsConfigured(table)) {
        tables.push({
          tableKey,
          table: catalog[tableKey].label,
          valid: false,
          errors: [{ code: 'table_not_configured' }],
        });
        continue;
      }

      try {
        const actualFields = await listFields(table);
        tables.push({
          tableKey,
          ...validateReportTableSchema(catalog[tableKey], actualFields),
        });
      } catch (error) {
        tables.push({
          tableKey,
          table: catalog[tableKey].label,
          valid: false,
          errors: [{ code: 'read_failed', message: safeErrorMessage(error) }],
        });
      }
    }
    groupResults.push({
      group: String(group.name || group.project || '未命名组'),
      valid: tables.every(table => table.valid),
      tables,
    });
  }

  return {
    valid: groupResults.length > 0 && groupResults.every(group => group.valid),
    groups: groupResults,
  };
}

async function listConfiguredFields(client, tableService, table) {
  const resolved = await tableService.resolveTableConfig(table, 'report schema table');
  if (!resolved?.appToken || !resolved.tableId) throw new Error('table is not configured');

  const items = [];
  let pageToken;
  do {
    const response = await client.bitable.appTableField.list({
      path: { app_token: resolved.appToken, table_id: resolved.tableId },
      params: { page_size: 100, page_token: pageToken },
    });
    const data = response?.data || {};
    items.push(...(data.items || []));
    pageToken = data.has_more ? data.page_token || data.next_page_token : undefined;
  } while (pageToken);
  return items;
}

async function main() {
  const { APP_ID, APP_SECRET } = process.env;
  if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');

  const config = loadGroupConfig();
  const client = new lark.Client(buildLarkClientOptions({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: lark.Domain.Feishu,
  }));
  const tableService = new BitableService(client);
  const result = await validateConfiguredReportTables({
    groups: getReportingUnits(config),
    listFields: table => listConfiguredFields(client, tableService, table),
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

function schema(label, fields, forbiddenFields = []) {
  return { label, fields, forbiddenFields };
}

function field(name, kind, required = false, options, multiple = false) {
  return { name, kind, required, options, multiple };
}

function isCompatibleType(kind, actual) {
  const type = Number(actual.type);
  const typeMap = {
    text: [1],
    longText: [1],
    number: [2],
    singleSelect: [3],
    multiSelect: [4],
    date: [5],
    datetime: [5],
    checkbox: [7],
    user: [11],
    url: [15],
    link: [18],
    lookup: [19],
    createdBy: [1003],
  };
  const kinds = Array.isArray(kind) ? kind : [kind];
  return kinds.some(item => (typeMap[item] || []).includes(type));
}

function describeActualType(actual) {
  return { type: actual.type, property: actual.property || undefined };
}

function sameStringSet(actual, expected) {
  return actual.length === expected.length && expected.every(item => actual.includes(item));
}

function safeErrorMessage(error) {
  return sanitizeOperationalText(error?.message || error || 'unknown read error').slice(0, 240);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch(error => {
    console.error(JSON.stringify({ valid: false, error: safeErrorMessage(error) }, null, 2));
    process.exitCode = 1;
  });
}
