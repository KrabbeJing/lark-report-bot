import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIMEZONE } from './date-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'groups.json');

export const DAILY_FIELD_KEYS = {
  reportDate: '日报日期',
  project: '所属板块',
  reporterName: '日报提交人',
  workItems: '今日工作总结',
  tomorrowPlanItems: '明日工作计划',
  riskItems: '遇到的问题',
  aiSummary: 'AI汇总',
  supervisor: '直属上级',
};

export const DAILY_TECHNICAL_FIELD_KEYS = {
  messageId: '',
  chatId: '',
  reportDate: '日报日期',
  senderOpenId: '发送人OpenID',
  rawText: '原文',
  source: '来源',
  parseStatus: '解析状态',
  messageTime: '消息时间',
};

export const CONTACT_FIELD_KEYS = {
  teamName: '团队名称',
  teamMember: '团队成员',
  teamRole: '团队身份',
  supervisor: '直属上级',
};

export const WEEKLY_FIELD_KEYS = {
  chatId: '群ID',
  project: '项目组',
  weekStart: '周起始日',
  weekEnd: '周结束日',
  summaryText: '摘要正文',
  imageKey: '海报ImageKey',
  pushStatus: '推送状态',
  pushedAt: '推送时间',
};

export const WEEKLY_SHEET_CELL_MAP = {
  reportPeriod: 'B2',
  agileProjects: {
    融羲项目组: {
      current: 'C26',
      next: 'C27',
      aliases: ['融羲'],
    },
    收单项目组: {
      current: 'C28',
      next: 'C29',
      aliases: ['收单'],
    },
    线上营业厅项目组: {
      current: 'C30',
      next: 'C31',
      aliases: ['线上营业厅', '对公线上营业厅'],
    },
    手机银行项目组: {
      current: 'C32',
      next: 'C33',
      aliases: ['手机银行'],
    },
    新核心项目组: {
      current: 'C34',
      next: 'C35',
      aliases: ['新核心'],
    },
  },
  management: {
    零售大众客群经营: {
      current: ['C39', 'C40', 'C41'],
      next: ['C42', 'C43', 'C44'],
      aliases: ['零售大众客群', '零售', '大众客群', '客群经营', '营销活动'],
    },
    对公客群经营及场景建设: {
      current: ['C45', 'C46', 'C47'],
      next: ['C48', 'C49', 'C50'],
      aliases: ['对公客群', '对公', '场景建设', '医院', '企业'],
    },
    渠道创新建设: {
      current: ['C51', 'C52', 'C53'],
      next: ['C54', 'C55', 'C56'],
      aliases: ['渠道创新', '渠道', '线上营业厅', '手机银行'],
    },
    业务风控合规: {
      current: ['C57', 'C58', 'C59'],
      next: ['C60', 'C61', 'C62'],
      aliases: ['风控', '合规', '风险', '反洗钱', '风险交易', '分级分类', '核查'],
    },
    业务转型推动: {
      current: ['C63', 'C64', 'C65'],
      next: ['C66', 'C67', 'C68'],
      aliases: ['业务转型', '转型推动', '新核心', '人工智能', '培训'],
    },
  },
};

export function loadGroupConfig(configPath = process.env.GROUPS_CONFIG_PATH || DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    console.warn(`[config] groups config not found: ${configPath}`);
    return normalizeConfig({});
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizeConfig(parsed);
}

export function normalizeConfig(raw) {
  const timezone = raw.timezone || process.env.TZ || DEFAULT_TIMEZONE;
  const botNames = raw.botNames?.length ? raw.botNames : ['数金小助手'];
  const weeklyPush = {
    enabled: raw.weeklyPush?.enabled !== false,
    dayOfWeek: Number(raw.weeklyPush?.dayOfWeek ?? 6),
    time: raw.weeklyPush?.time || '10:00',
    timezone: raw.weeklyPush?.timezone || timezone,
  };
  const dailySupervisorPush = {
    enabled: raw.dailySupervisorPush?.enabled === true,
    time: raw.dailySupervisorPush?.time || '17:00',
    timezone: raw.dailySupervisorPush?.timezone || timezone,
  };

  const groups = (raw.groups || [])
    .filter(group => group.enabled !== false)
    .map(group => ({
      ...group,
      pushChatId: group.pushChatId || group.chatId,
      project: group.project || group.name || group.chatId,
      agileGroup: group.agileGroup || '',
      dailyTable: normalizeTableConfig(group.dailyTable, DAILY_FIELD_KEYS),
      contactTable: normalizeTableConfig(group.contactTable || raw.contactTable, CONTACT_FIELD_KEYS),
      weeklyTable: normalizeTableConfig(group.weeklyTable, WEEKLY_FIELD_KEYS),
      weeklySheet: normalizeWeeklySheetConfig(group.weeklySheet || raw.weeklySheet),
    }));

  return {
    timezone,
    botNames,
    weeklyPush,
    dailySupervisorPush,
    groups,
  };
}

function normalizeTableConfig(table, defaults) {
  if (!table) return null;
  const configuredFields = Object.fromEntries(
    Object.entries({
      ...defaults,
      ...(table.fields || {}),
    }).filter(([, fieldName]) => Boolean(fieldName)),
  );
  return {
    appToken: table.appToken || table.app_token || '',
    tableId: table.tableId || table.table_id || '',
    viewId: table.viewId || table.view_id || '',
    fields: configuredFields,
    fieldTypes: table.fieldTypes || table.field_types || {},
  };
}

function normalizeWeeklySheetConfig(sheet) {
  if (!sheet) return null;
  const sheetUrl = sheet.spreadsheetUrl || sheet.spreadsheet_url || sheet.sourceUrl || sheet.source_url || sheet.url || '';
  const parsedLink = parseWeeklySheetLink(sheetUrl);
  return {
    enabled: sheet.enabled === true,
    spreadsheetToken: sheet.spreadsheetToken || sheet.spreadsheet_token || parsedLink.spreadsheetToken || '',
    wikiNodeToken: sheet.wikiNodeToken || sheet.wiki_node_token || parsedLink.wikiNodeToken || '',
    spreadsheetUrl: sheetUrl,
    templateSheetId: sheet.templateSheetId || sheet.template_sheet_id || parsedLink.sheetId || '',
    titlePattern: sheet.titlePattern || '数字金融部周报 {{weekStart}}-{{weekEnd}}',
    copyTemplate: sheet.copyTemplate !== false,
    reportScope: sheet.reportScope || sheet.report_scope || 'group',
    reuseExisting: sheet.reuseExisting !== false,
    skipPushIfExisting: sheet.skipPushIfExisting !== false,
    cellMap: mergeWeeklySheetCellMap(WEEKLY_SHEET_CELL_MAP, sheet.cellMap || {}),
  };
}

export function parseWeeklySheetLink(url) {
  const text = String(url || '');
  const sheetMatch = text.match(/\/sheets\/([A-Za-z0-9]+)/);
  const wikiMatch = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  const subSheetMatch = text.match(/[?#&]sheet=([A-Za-z0-9_-]+)/);
  return {
    spreadsheetToken: sheetMatch ? sheetMatch[1] : '',
    wikiNodeToken: wikiMatch ? wikiMatch[1] : '',
    sheetId: subSheetMatch ? subSheetMatch[1] : '',
  };
}

function mergeWeeklySheetCellMap(defaultMap, overrideMap) {
  return {
    ...defaultMap,
    ...overrideMap,
    agileProjects: {
      ...(defaultMap.agileProjects || {}),
      ...(overrideMap.agileProjects || {}),
    },
    management: {
      ...(defaultMap.management || {}),
      ...(overrideMap.management || {}),
    },
  };
}

export function findGroupByChatId(config, chatId) {
  return config.groups.find(group => group.chatId === chatId || group.pushChatId === chatId) || null;
}

export function tableIsConfigured(table) {
  return Boolean(table?.appToken && table?.tableId);
}
