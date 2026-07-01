import { DAILY_FIELD_KEYS, WEEKLY_FIELD_KEYS, tableIsConfigured } from './config.js';
import { formatDateTime } from './date-utils.js';

export class BitableService {
  constructor(client) {
    this.client = client;
  }

  buildDailyRecordFields(group, report, context = {}) {
    const fields = group.dailyTable?.fields || DAILY_FIELD_KEYS;
    const contact = context.contact || {};
    const recordFields = {};

    setMappedField(recordFields, group.dailyTable, 'messageId', context.messageId || '', context);
    setMappedField(recordFields, group.dailyTable, 'chatId', context.chatId || group.chatId || '', context);
    setMappedField(recordFields, group.dailyTable, 'project', contact.teamName || group.project || '', context);
    setMappedField(recordFields, group.dailyTable, 'agileGroup', group.agileGroup || '', context);
    setMappedField(recordFields, group.dailyTable, 'reportDate', report.reportDate || '', context);
    setMappedField(recordFields, group.dailyTable, 'reporterName', report.reporterName || '', context);
    setMappedField(recordFields, group.dailyTable, 'senderOpenId', context.senderOpenId || '', context);
    setMappedField(recordFields, group.dailyTable, 'rawText', report.rawText || '', context);
    setMappedField(recordFields, group.dailyTable, 'workItems', report.workItems || [], context);
    setMappedField(recordFields, group.dailyTable, 'tomorrowPlanItems', report.tomorrowPlanItems || [], context);
    setMappedField(recordFields, group.dailyTable, 'riskItems', report.riskItems || [], context);
    setMappedField(recordFields, group.dailyTable, 'aiSummary', buildDailyAiSummary(report), context);
    setMappedField(recordFields, group.dailyTable, 'supervisor', contact.supervisor || '', {
      ...context,
      supervisorOpenId: contact.supervisorOpenId || '',
    });
    setMappedField(recordFields, group.dailyTable, 'source', context.source || 'chat', context);
    setMappedField(recordFields, group.dailyTable, 'parseStatus', report.highConfidence ? 'parsed' : 'low_confidence', context);
    setMappedField(recordFields, group.dailyTable, 'messageTime', context.messageTimeText || '', context);

    return recordFields;
  }

  async createDailyReportRecord(group, report, context = {}) {
    assertTable(group.dailyTable, 'dailyTable');
    const existing = await this.findDailyRecordByMessageId(group, context.messageId);
    if (existing) {
      return { created: false, record: existing };
    }

    const fields = this.buildDailyRecordFields(group, report, context);
    const res = await this.client.bitable.appTableRecord.create({
      path: {
        app_token: group.dailyTable.appToken,
        table_id: group.dailyTable.tableId,
      },
      params: {
        client_token: context.messageId || undefined,
        user_id_type: 'open_id',
      },
      data: { fields },
    });
    return { created: true, record: res?.data?.record, fields };
  }

  async findDailyRecordByMessageId(group, messageId) {
    if (!messageId || !tableIsConfigured(group.dailyTable)) return null;
    const fieldName = group.dailyTable.fields.messageId;
    if (!fieldName) return null;
    const records = await this.listRecords(group.dailyTable);
    return records.find(record => String(record.fields?.[fieldName] || '') === String(messageId)) || null;
  }

  async listDailyReportsForWeek(group, weekStart, weekEnd) {
    return this.listDailyReportsForRange(group, weekStart, weekEnd);
  }

  async listDailyReportsForDate(group, reportDate) {
    return this.listDailyReportsForRange(group, reportDate, reportDate);
  }

  async listAllDailyReportsForRange(group, startDate, endDate) {
    assertTable(group.dailyTable, 'dailyTable');
    const records = await this.listRecords(group.dailyTable);
    const fields = group.dailyTable.fields;
    return records
      .filter(record => {
        const reportDate = normalizeFieldValue(record.fields?.[fields.reportDate]);
        return reportDate >= startDate && reportDate <= endDate;
      })
      .map(record => normalizeDailyRecord(record, fields, group));
  }

  async listDailyReportsForRange(group, startDate, endDate) {
    assertTable(group.dailyTable, 'dailyTable');
    const records = await this.listRecords(group.dailyTable);
    const fields = group.dailyTable.fields;
    return records
      .filter(record => {
        const recordChatId = normalizeFieldValue(fields.chatId ? record.fields?.[fields.chatId] : '');
        const recordProject = normalizeFieldValue(fields.project ? record.fields?.[fields.project] : '');
        const reportDate = normalizeFieldValue(record.fields?.[fields.reportDate]);
        if (reportDate < startDate || reportDate > endDate) return false;
        if (recordChatId) return recordChatId === group.chatId;
        if (recordProject) {
          return [group.project, group.name, group.agileGroup].filter(Boolean).includes(recordProject);
        }
        return true;
      })
      .map(record => normalizeDailyRecord(record, fields, group));
  }

  async findTeamContact(group, { reporterName = '', senderOpenId = '' } = {}) {
    if (!tableIsConfigured(group.contactTable)) return null;
    const records = await this.listRecords(group.contactTable);
    const fields = group.contactTable.fields;
    const contacts = records.map(record => normalizeContactRecord(record, fields));
    return contacts.find(contact => {
      const haystack = [contact.teamMember, contact.teamMemberId, contact.supervisor, contact.supervisorOpenId]
        .filter(Boolean)
        .join('\n');
      return (reporterName && haystack.includes(reporterName)) || (senderOpenId && haystack.includes(senderOpenId));
    }) || null;
  }

  async upsertWeeklySummary(group, summary, context = {}) {
    if (!tableIsConfigured(group.weeklyTable)) {
      console.warn(`[weekly] weeklyTable not configured for ${group.project}; skip summary persistence`);
      return { skipped: true };
    }

    const existing = await this.findWeeklySummaryRecord(group, summary.weekStart);
    const fields = buildWeeklyFields(group, summary, context);
    if (existing) {
      const res = await this.client.bitable.appTableRecord.update({
        path: {
          app_token: group.weeklyTable.appToken,
          table_id: group.weeklyTable.tableId,
          record_id: existing.record_id,
        },
        data: { fields },
      });
      return { updated: true, record: res?.data?.record, fields };
    }

    const res = await this.client.bitable.appTableRecord.create({
      path: {
        app_token: group.weeklyTable.appToken,
        table_id: group.weeklyTable.tableId,
      },
      data: { fields },
    });
    return { created: true, record: res?.data?.record, fields };
  }

  async findWeeklySummaryRecord(group, weekStart) {
    if (!tableIsConfigured(group.weeklyTable)) return null;
    const records = await this.listRecords(group.weeklyTable);
    const fields = group.weeklyTable.fields;
    return records.find(record => {
      const recordChatId = String(record.fields?.[fields.chatId] || '');
      const recordWeekStart = normalizeFieldValue(record.fields?.[fields.weekStart]);
      return recordChatId === group.chatId && recordWeekStart === weekStart;
    }) || null;
  }

  async listRecords(table) {
    assertTable(table, 'table');
    const items = [];
    let pageToken;
    do {
      const res = await this.client.bitable.appTableRecord.list({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
        },
        params: {
          view_id: table.viewId || undefined,
          page_size: 500,
          page_token: pageToken,
          user_id_type: 'open_id',
        },
      });
      items.push(...(res?.data?.items || []));
      pageToken = res?.data?.has_more ? res.data.page_token : undefined;
    } while (pageToken);
    return items;
  }
}

function assertTable(table, name) {
  if (!tableIsConfigured(table)) {
    throw new Error(`${name} 未配置 appToken/tableId`);
  }
}

function normalizeDailyRecord(record, fields, group) {
  const f = record.fields || {};
  const reporter = normalizePersonValue(f[fields.reporterName]);
  const supervisor = normalizePersonValue(fields.supervisor ? f[fields.supervisor] : '');
  return {
    recordId: record.record_id,
    messageId: normalizeFieldValue(fields.messageId ? f[fields.messageId] : ''),
    chatId: normalizeFieldValue(fields.chatId ? f[fields.chatId] : ''),
    project: normalizeFieldValue(fields.project ? f[fields.project] : '') || group.project,
    agileGroup: normalizeFieldValue(fields.agileGroup ? f[fields.agileGroup] : '') || group.agileGroup,
    reportDate: normalizeFieldValue(f[fields.reportDate]),
    reporterName: reporter.name || normalizeFieldValue(f[fields.reporterName]),
    senderOpenId: normalizeFieldValue(fields.senderOpenId ? f[fields.senderOpenId] : '') || reporter.id,
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    rawText: normalizeFieldValue(fields.rawText ? f[fields.rawText] : ''),
    workItems: splitMultiline(f[fields.workItems]),
    tomorrowPlanItems: splitMultiline(fields.tomorrowPlanItems ? f[fields.tomorrowPlanItems] : ''),
    riskItems: splitMultiline(f[fields.riskItems]),
    source: normalizeFieldValue(fields.source ? f[fields.source] : ''),
    parseStatus: normalizeFieldValue(fields.parseStatus ? f[fields.parseStatus] : ''),
    messageTime: normalizeFieldValue(fields.messageTime ? f[fields.messageTime] : ''),
  };
}

function buildWeeklyFields(group, summary, context = {}) {
  const fields = group.weeklyTable?.fields || WEEKLY_FIELD_KEYS;
  const recordFields = {};
  setMappedField(recordFields, group.weeklyTable, 'chatId', group.chatId, context);
  setMappedField(recordFields, group.weeklyTable, 'project', group.project || '', context);
  setMappedField(recordFields, group.weeklyTable, 'weekStart', summary.weekStart, context);
  setMappedField(recordFields, group.weeklyTable, 'weekEnd', summary.weekEnd, context);
  setMappedField(recordFields, group.weeklyTable, 'summaryText', summary.summaryText || '', context);
  setMappedField(recordFields, group.weeklyTable, 'imageKey', context.imageKey || '', context);
  setMappedField(recordFields, group.weeklyTable, 'pushStatus', context.pushStatus || 'sent', context);
  setMappedField(recordFields, group.weeklyTable, 'pushedAt', formatDateTime(context.pushedAt || new Date(), context.timezone || 'Asia/Shanghai'), context);
  return recordFields;
}

export function normalizeFieldValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(item => normalizeFieldValue(item)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return value.text || value.name || value.id || JSON.stringify(value);
  }
  return String(value).trim();
}

function splitMultiline(value) {
  return normalizeFieldValue(value)
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function setMappedField(recordFields, table, key, value, context = {}) {
  const fieldName = table?.fields?.[key];
  if (!fieldName) return;
  recordFields[fieldName] = formatFieldValue(table, key, value, context);
}

function formatFieldValue(table, key, value, context = {}) {
  const fieldType = table?.fieldTypes?.[key] || '';
  if (fieldType === 'user') {
    const id = key === 'reporterName' ? context.senderOpenId : context.supervisorOpenId;
    if (id) return [{ id, name: Array.isArray(value) ? value.join('\n') : String(value || '') }];
  }

  if (Array.isArray(value)) return value.join('\n');
  return value == null ? '' : value;
}

function normalizeContactRecord(record, fields) {
  const f = record.fields || {};
  const member = normalizePersonValue(fields.teamMember ? f[fields.teamMember] : '');
  const supervisor = normalizePersonValue(fields.supervisor ? f[fields.supervisor] : '');
  return {
    recordId: record.record_id,
    teamName: normalizeFieldValue(fields.teamName ? f[fields.teamName] : ''),
    teamMember: member.name,
    teamMemberId: member.id,
    teamRole: normalizeFieldValue(fields.teamRole ? f[fields.teamRole] : ''),
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
  };
}

function normalizePersonValue(value) {
  if (Array.isArray(value)) {
    const first = value[0] || {};
    return {
      id: first.id || '',
      name: first.name || first.en_name || first.email || normalizeFieldValue(value),
    };
  }
  if (value && typeof value === 'object') {
    return {
      id: value.id || '',
      name: value.name || value.en_name || value.email || normalizeFieldValue(value),
    };
  }
  return {
    id: '',
    name: normalizeFieldValue(value),
  };
}

function buildDailyAiSummary(report) {
  const parts = [];
  if (report.workItems?.length) parts.push(`今日：${report.workItems.join('；')}`);
  if (report.tomorrowPlanItems?.length) parts.push(`明日：${report.tomorrowPlanItems.join('；')}`);
  if (report.riskItems?.length) parts.push(`问题：${report.riskItems.join('；')}`);
  return parts.join('\n');
}
