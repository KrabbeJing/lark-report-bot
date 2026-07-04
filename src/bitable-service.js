import { WEEKLY_FIELD_KEYS, tableIsConfigured } from './config.js';
import { DEFAULT_TIMEZONE, addDaysToYmd, formatDateTime, formatYmd, parseYmd } from './date-utils.js';

export class BitableService {
  constructor(client) {
    this.client = client;
  }

  buildDailyRecordFields(group, report, context = {}) {
    const table = context.table || getDailyWriteTable(group);
    const contact = context.contact || {};
    const recordFields = {};
    const setDailyField = (key, value, fieldContext = context) => {
      if (!shouldWriteDailyField(table, key)) return;
      setMappedField(recordFields, table, key, value, fieldContext);
    };

    setDailyField('sourceRecordId', context.sourceRecordId || '');
    setDailyField('messageId', context.messageId || '');
    setDailyField('chatId', context.chatId || group.chatId || '');
    setDailyField('project', contact.teamName || group.project || '');
    setDailyField('agileGroup', group.agileGroup || '');
    setDailyField('reportDate', report.reportDate || '');
    setDailyField('reporterName', report.reporterName || '');
    setDailyField('reporterNameText', report.reporterName || '');
    setDailyField('senderOpenId', context.senderOpenId || '');
    setDailyField('rawText', report.rawText || '');
    setDailyField('workItems', report.workSummaryText || report.workItems || []);
    setDailyField('tomorrowPlanItems', report.tomorrowPlanItems || []);
    setDailyField('riskItems', report.riskItems || []);
    setDailyField('aiSummary', buildDailyAiSummary(report));
    setDailyField('supervisor', contact.supervisor || '', {
      ...context,
      supervisorOpenId: contact.supervisorOpenId || '',
    });
    setDailyField('source', context.source || 'chat');
    setDailyField('parseStatus', report.highConfidence ? 'parsed' : 'low_confidence');
    setDailyField('matchingStatus', context.matchingStatus || contact.matchingStatus || '');
    setDailyField('messageTime', context.messageTimeText || '');
    setDailyField('syncedAt', context.syncedAtText || '');

    return recordFields;
  }

  async createDailyReportRecord(group, report, context = {}) {
    const table = getDailyWriteTable(group);
    assertTable(table, table === group.dailyFactTable ? 'dailyFactTable' : 'dailyTable');
    const existing = await this.findDailyRecordByMessageId(group, context.messageId);
    if (existing) {
      return { created: false, record: existing };
    }

    const fields = this.buildDailyRecordFields(group, report, { ...context, table });
    const res = await withBitableErrorContext('createDailyReportRecord', table, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
        },
        params: {
          user_id_type: 'open_id',
        },
        data: { fields },
      })
    ));
    const responseSummary = summarizeBitableResponse(res);
    let record = extractRecordFromResponse(res);
    let verifiedOutsideView = false;

    if (!getRecordId(record)) {
      console.warn('[bitable] createDailyReportRecord returned no record_id', responseSummary);
      record = await this.findRecentlyCreatedDailyRecord(group, report);
      verifiedOutsideView = Boolean(record);
      if (record) {
        console.log('[bitable] createDailyReportRecord verified by listing table', {
          recordId: getRecordId(record),
          viewIdUsedForVerify: false,
        });
      }
    } else {
      console.log('[bitable] createDailyReportRecord response', responseSummary);
    }

    return {
      created: true,
      record,
      fields,
      responseSummary,
      verifiedOutsideView,
    };
  }

  async findDailyRecordByMessageId(group, messageId) {
    const table = getDailyWriteTable(group);
    if (!messageId || !tableIsConfigured(table)) return null;
    const fieldName = table.fields.messageId;
    if (!fieldName) return null;
    const records = await this.listRecords(table, 'dailyWriteTable.findByMessageId', { includeView: false });
    return records.find(record => String(record.fields?.[fieldName] || '') === String(messageId)) || null;
  }

  async findRecentlyCreatedDailyRecord(group, report) {
    const table = getDailyWriteTable(group);
    const records = await this.listRecords(table, 'dailyWriteTable.verifyCreate', { includeView: false });
    const fields = table.fields;
    const expectedDate = String(report.reportDate || '');
    const expectedReporter = String(report.reporterName || '');
    const expectedWorkItems = (report.workItems || []).join('\n');

    return records.find(record => {
      const f = record.fields || {};
      const recordDate = normalizeDateFieldValue(f[fields.reportDate]);
      const recordReporter = normalizePersonValue(f[fields.reporterName]).name || normalizeFieldValue(f[fields.reporterName]);
      const recordWorkItems = normalizeFieldValue(f[fields.workItems]);
      return recordDate === expectedDate
        && recordReporter === expectedReporter
        && (!expectedWorkItems || recordWorkItems.includes(report.workItems[0] || expectedWorkItems));
    }) || null;
  }

  async syncDailyFactRecordsForGroup(group, options = {}) {
    if (!tableIsConfigured(group.dailyTable) || !tableIsConfigured(group.dailyFactTable)) {
      return { skipped: true, reason: 'dailyTable or dailyFactTable not configured' };
    }

    const timezone = options.timezone || DEFAULT_TIMEZONE;
    const now = options.now || new Date();
    const endDate = options.endDate || formatYmd(now, timezone);
    const lookbackDays = Number(options.lookbackDays ?? 7);
    const startDate = options.startDate || addDaysToYmd(endDate, -Math.max(lookbackDays - 1, 0));
    const sourceRecords = await this.listRecords(group.dailyTable, 'dailyFactSync.source.list');
    const targetRecords = await this.listRecords(group.dailyFactTable, 'dailyFactSync.target.list', { includeView: false });
    const targetBySourceRecordId = indexRecordsByField(targetRecords, group.dailyFactTable.fields.sourceRecordId);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const sourceRecord of sourceRecords) {
      const report = normalizeDailyRecord(sourceRecord, group.dailyTable.fields, group);
      if (!report.reportDate || report.reportDate < startDate || report.reportDate > endDate) {
        skipped += 1;
        continue;
      }

      try {
        const result = await this.upsertDailyFactRecordFromSource(group, sourceRecord, report, {
          now,
          timezone,
          existingRecord: targetBySourceRecordId.get(String(sourceRecord.record_id || '')),
        });
        if (result.created) created += 1;
        else if (result.updated) updated += 1;
      } catch (err) {
        errors.push({
          sourceRecordId: sourceRecord.record_id,
          message: err?.message || String(err),
        });
      }
    }

    return {
      skipped: false,
      sourceCount: sourceRecords.length,
      rangeStart: startDate,
      rangeEnd: endDate,
      created,
      updated,
      filtered: skipped,
      errors,
      existingTargetCount: targetBySourceRecordId.size,
    };
  }

  async upsertDailyFactRecordFromSource(group, sourceRecord, report, options = {}) {
    assertTable(group.dailyFactTable, 'dailyFactTable');
    const sourceRecordId = sourceRecord.record_id || '';
    const existing = options.existingRecord || await this.findDailyFactRecordBySourceRecordId(group, sourceRecordId);
    let contact = null;
    try {
      contact = await this.findTeamContact(group, {
        reporterName: report.reporterName,
        senderOpenId: report.senderOpenId,
      });
    } catch (err) {
      console.warn('[daily-fact-sync] contact lookup failed; continue unmatched', {
        sourceRecordId,
        reporterName: report.reporterName,
        code: err?.response?.data?.code || err?.code,
        msg: err?.response?.data?.msg || err?.message,
      });
    }
    const fields = this.buildDailyRecordFields(group, report, {
      table: group.dailyFactTable,
      sourceRecordId,
      source: 'form',
      senderOpenId: report.senderOpenId,
      contact,
      matchingStatus: contact?.matchingStatus || '未匹配',
      syncedAtText: formatDateTime(options.now || new Date(), options.timezone || DEFAULT_TIMEZONE),
    });

    if (existing) {
      const res = await withBitableErrorContext('dailyFactSync.target.update', group.dailyFactTable, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: group.dailyFactTable.appToken,
            table_id: group.dailyFactTable.tableId,
            record_id: existing.record_id,
          },
          params: {
            user_id_type: 'open_id',
          },
          data: { fields },
        })
      ));
      return { updated: true, record: extractRecordFromResponse(res), fields };
    }

    const res = await withBitableErrorContext('dailyFactSync.target.create', group.dailyFactTable, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: group.dailyFactTable.appToken,
          table_id: group.dailyFactTable.tableId,
        },
        params: {
          user_id_type: 'open_id',
        },
        data: { fields },
      })
    ));
    return { created: true, record: extractRecordFromResponse(res), fields };
  }

  async findDailyFactRecordBySourceRecordId(group, sourceRecordId) {
    if (!sourceRecordId || !tableIsConfigured(group.dailyFactTable)) return null;
    const fieldName = group.dailyFactTable.fields.sourceRecordId;
    if (!fieldName) return null;
    const records = await this.listRecords(group.dailyFactTable, 'dailyFactSync.target.findBySourceRecordId', { includeView: false });
    return records.find(record => String(record.fields?.[fieldName] || '') === String(sourceRecordId)) || null;
  }

  async listDailyReportsForWeek(group, weekStart, weekEnd) {
    return this.listDailyReportsForRange(group, weekStart, weekEnd);
  }

  async listDailyReportsForDate(group, reportDate) {
    return this.listDailyReportsForRange(group, reportDate, reportDate);
  }

  async listAllDailyReportsForRange(group, startDate, endDate) {
    const table = getDailyReadTable(group);
    assertTable(table, table === group.dailyFactTable ? 'dailyFactTable' : 'dailyTable');
    const records = await this.listRecords(table, 'dailyTable.listAll');
    const fields = table.fields;
    return records
      .filter(record => {
        const reportDate = normalizeDateFieldValue(record.fields?.[fields.reportDate]);
        return reportDate >= startDate && reportDate <= endDate;
      })
      .map(record => normalizeDailyRecord(record, fields, group));
  }

  async listDailyReportsForRange(group, startDate, endDate) {
    const table = getDailyReadTable(group);
    assertTable(table, table === group.dailyFactTable ? 'dailyFactTable' : 'dailyTable');
    const records = await this.listRecords(table, 'dailyTable.listRange');
    const fields = table.fields;
    return records
      .filter(record => {
        const recordChatId = normalizeFieldValue(fields.chatId ? record.fields?.[fields.chatId] : '');
        const recordProject = normalizeFieldValue(fields.project ? record.fields?.[fields.project] : '');
        const reportDate = normalizeDateFieldValue(record.fields?.[fields.reportDate]);
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
    const records = await this.listRecords(group.contactTable, 'contactTable.findTeamContact');
    const fields = group.contactTable.fields;
    const contacts = records.map(record => normalizeContactRecord(record, fields));
    return findBestContact(contacts, { reporterName, senderOpenId });
  }

  async upsertWeeklySummary(group, summary, context = {}) {
    if (!tableIsConfigured(group.weeklyTable)) {
      console.warn(`[weekly] weeklyTable not configured for ${group.project}; skip summary persistence`);
      return { skipped: true };
    }

    const existing = await this.findWeeklySummaryRecord(group, summary.weekStart);
    const fields = buildWeeklyFields(group, summary, context);
    if (existing) {
      const res = await withBitableErrorContext('upsertWeeklySummary.update', group.weeklyTable, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: group.weeklyTable.appToken,
            table_id: group.weeklyTable.tableId,
            record_id: existing.record_id,
          },
          data: { fields },
        })
      ));
      return { updated: true, record: extractRecordFromResponse(res), fields };
    }

    const res = await withBitableErrorContext('upsertWeeklySummary.create', group.weeklyTable, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: group.weeklyTable.appToken,
          table_id: group.weeklyTable.tableId,
        },
        data: { fields },
      })
    ));
    return { created: true, record: extractRecordFromResponse(res), fields };
  }

  async findWeeklySummaryRecord(group, weekStart) {
    if (!tableIsConfigured(group.weeklyTable)) return null;
    const records = await this.listRecords(group.weeklyTable, 'weeklyTable.findSummary');
    const fields = group.weeklyTable.fields;
    return records.find(record => {
      const recordChatId = String(record.fields?.[fields.chatId] || '');
      const recordWeekStart = normalizeFieldValue(record.fields?.[fields.weekStart]);
      return recordChatId === group.chatId && recordWeekStart === weekStart;
    }) || null;
  }

  async listRecords(table, label = 'table.listRecords', options = {}) {
    assertTable(table, 'table');
    const includeView = options.includeView !== false;
    const items = [];
    let pageToken;
    do {
      const res = await withBitableErrorContext(label, table, () => (
        this.client.bitable.appTableRecord.list({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
          },
          params: {
            view_id: includeView ? table.viewId || undefined : undefined,
            page_size: 500,
            page_token: pageToken,
            user_id_type: 'open_id',
          },
        })
      ));
      const data = extractBitableData(res);
      items.push(...(data?.items || []));
      pageToken = data?.has_more ? data.page_token || data.next_page_token : undefined;
    } while (pageToken);
    return items;
  }
}

function assertTable(table, name) {
  if (!tableIsConfigured(table)) {
    throw new Error(`${name} 未配置 appToken/tableId`);
  }
}

function getDailyWriteTable(group) {
  return tableIsConfigured(group.dailyFactTable) ? group.dailyFactTable : group.dailyTable;
}

function getDailyReadTable(group) {
  return tableIsConfigured(group.dailyFactTable) ? group.dailyFactTable : group.dailyTable;
}

async function withBitableErrorContext(operation, table, fn) {
  try {
    const res = await fn();
    const code = getBitableBusinessCode(res);
    if (code != null && Number(code) !== 0) {
      const msg = getBitableBusinessMsg(res);
      const context = {
        operation,
        appToken: maskToken(table?.appToken),
        tableId: maskToken(table?.tableId),
        viewId: maskToken(table?.viewId),
        code,
        msg,
      };
      console.error('[bitable] request failed', context);
      const err = new Error(`Bitable request failed [${operation} code=${code} msg=${msg || ''}]`);
      err.code = code;
      err.response = { data: extractBitablePayload(res) };
      err._bitableContextLogged = true;
      throw err;
    }
    return res;
  } catch (err) {
    const data = err?.response?.data;
    const context = {
      operation,
      appToken: maskToken(table?.appToken),
      tableId: maskToken(table?.tableId),
      viewId: maskToken(table?.viewId),
      code: data?.code,
      msg: data?.msg,
    };
    if (!err._bitableContextLogged) console.error('[bitable] request failed', context);
    err.message = `${err.message || 'Bitable request failed'} [${operation} appToken=${context.appToken} tableId=${context.tableId} viewId=${context.viewId} code=${context.code || ''} msg=${context.msg || ''}]`;
    throw err;
  }
}

function maskToken(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
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
    reportDate: normalizeDateFieldValue(f[fields.reportDate]),
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

function normalizeDateFieldValue(value, timezone = DEFAULT_TIMEZONE) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return normalizeDateFieldValue(value[0], timezone);
  if (typeof value === 'number') return timestampToYmd(value, timezone);
  if (value && typeof value === 'object') {
    const candidate = value.timestamp || value.date || value.value || value.text || value.name || '';
    return normalizeDateFieldValue(candidate, timezone);
  }

  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{10,13}$/.test(text)) return timestampToYmd(Number(text), timezone);
  return text;
}

function timestampToYmd(value, timezone) {
  const ms = Number(value) < 100000000000 ? Number(value) * 1000 : Number(value);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : formatYmd(date, timezone);
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
  const formatted = formatFieldValue(table, key, value, context);
  if (formatted === undefined) return;
  recordFields[fieldName] = formatted;
}

function shouldWriteDailyField(table, key) {
  const allowed = table?.writeFields;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(key);
}

function formatFieldValue(table, key, value, context = {}) {
  const fieldType = table?.fieldTypes?.[key] || '';
  if (fieldType === 'date' || fieldType === 'datetime') {
    return toBitableDateTimestamp(value);
  }

  if (fieldType === 'user') {
    const id = key === 'reporterName' ? context.senderOpenId : context.supervisorOpenId;
    const name = Array.isArray(value) ? value.join('\n') : String(value || '');
    if (id) return [{ id, name }];
    if (!name) return undefined;
  }

  if (Array.isArray(value)) return value.join('\n');
  return value == null ? '' : value;
}

function toBitableDateTimestamp(value) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  const parsed = parseYmd(String(text || ''));
  if (!parsed) return value == null || value === '' ? undefined : value;
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

function normalizeContactRecord(record, fields) {
  const f = record.fields || {};
  const member = normalizePersonValue(fields.teamMember ? f[fields.teamMember] : '');
  const supervisor = normalizePersonValue(fields.supervisor ? f[fields.supervisor] : '');
  const divisionalLeader = normalizePersonValue(fields.divisionalLeader ? f[fields.divisionalLeader] : '');
  const realName = normalizeFieldValue(fields.memberRealName ? f[fields.memberRealName] : '');
  const aliases = splitMultiline(fields.memberAliases ? f[fields.memberAliases] : '');
  const currentOpenId = normalizeFieldValue(fields.currentOpenId ? f[fields.currentOpenId] : '') || member.id;
  return {
    recordId: record.record_id,
    teamName: normalizeFieldValue(fields.teamName ? f[fields.teamName] : ''),
    teamMember: realName || member.name,
    accountDisplayName: member.name,
    teamMemberId: currentOpenId,
    memberAliases: aliases,
    teamRole: normalizeFieldValue(fields.teamRole ? f[fields.teamRole] : ''),
    agileGroup: normalizeFieldValue(fields.agileGroup ? f[fields.agileGroup] : ''),
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    divisionalLeader: divisionalLeader.name,
    divisionalLeaderOpenId: divisionalLeader.id,
  };
}

function findBestContact(contacts, { reporterName = '', senderOpenId = '' } = {}) {
  const exactOpenId = senderOpenId
    ? contacts.find(contact => contact.teamMemberId === senderOpenId)
    : null;
  if (exactOpenId) {
    return {
      ...exactOpenId,
      matchMethod: 'open_id',
      matchingStatus: '已匹配',
    };
  }

  const name = String(reporterName || '').trim();
  const exactName = name
    ? contacts.find(contact => contact.teamMember === name || contact.memberAliases?.includes(name))
    : null;
  if (exactName) {
    return {
      ...exactName,
      matchMethod: 'name_fallback',
      matchingStatus: '姓名匹配',
    };
  }

  return null;
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

function extractRecordFromResponse(res) {
  return res?.data?.data?.record
    || res?.data?.record
    || res?.record
    || res?.data?.data?.records?.[0]
    || res?.data?.records?.[0]
    || res?.records?.[0]
    || null;
}

function extractBitablePayload(res) {
  if (res?.data && (res.data.code != null || res.data.msg != null || res.data.data != null)) return res.data;
  return res || {};
}

function extractBitableData(res) {
  const payload = extractBitablePayload(res);
  return payload?.data || payload || {};
}

function getBitableBusinessCode(res) {
  const payload = extractBitablePayload(res);
  return payload?.code;
}

function getBitableBusinessMsg(res) {
  const payload = extractBitablePayload(res);
  return payload?.msg;
}

function getRecordId(record) {
  return record?.record_id || record?.recordId || '';
}

function summarizeBitableResponse(res) {
  const payload = extractBitablePayload(res);
  const data = extractBitableData(res);
  const record = extractRecordFromResponse(res);
  return {
    httpStatus: res?.status,
    code: payload?.code,
    msg: payload?.msg,
    topLevelKeys: objectKeys(res),
    responseDataKeys: objectKeys(res?.data),
    businessDataKeys: objectKeys(data),
    hasRecord: Boolean(record),
    recordId: getRecordId(record),
    recordKeys: objectKeys(record),
  };
}

function objectKeys(value) {
  return value && typeof value === 'object' ? Object.keys(value).slice(0, 12) : [];
}

function indexRecordsByField(records, fieldName) {
  const index = new Map();
  if (!fieldName) return index;
  for (const record of records || []) {
    const value = normalizeFieldValue(record.fields?.[fieldName]);
    if (value) index.set(String(value), record);
  }
  return index;
}
