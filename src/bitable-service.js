import { WEEKLY_FIELD_KEYS, tableIsConfigured } from './config.js';
import { DEFAULT_TIMEZONE, addDaysToYmd, formatDateTime, formatYmd, parseYmd } from './date-utils.js';
import { buildContentFingerprint, buildFactKey, buildSourceRefs } from './daily-record-utils.js';
import { resolveIncrementalDailyFact } from './daily-fact-resolution.js';
import { sanitizeOperationalText } from './error-reporter.js';
import { resolveOrganizationSnapshot } from './organization-snapshot.js';

export class BitableService {
  constructor(client) {
    this.client = client;
    this.tableAppTokenCache = new Map();
    this.contactCache = new Map();
  }

  async resolveTableConfig(table, name = 'table') {
    if (!table || table.appToken || !table.wikiNodeToken) return table;

    const cached = this.tableAppTokenCache.get(table.wikiNodeToken);
    if (cached) {
      table.appToken = cached;
      return table;
    }

    if (typeof this.client.request !== 'function') {
      throw new Error(`${name} 配置了 wikiNodeToken，但当前 client 不支持 wiki 节点解析`);
    }

    const res = await this.client.request({
      method: 'GET',
      url: `/open-apis/wiki/v2/spaces/get_node?token=${table.wikiNodeToken}`,
    });
    const node = res?.data?.node;
    if (!node?.obj_token) throw new Error('未找到 wiki 节点或节点无 obj_token');

    table.appToken = node.obj_token;
    this.tableAppTokenCache.set(table.wikiNodeToken, table.appToken);
    return table;
  }

  buildDailyRecordFields(group, report, context = {}) {
    const table = context.table || getDailyWriteTable(group);
    const contact = context.contact || null;
    const existingFields = context.existingRecord?.fields || {};
    const organization = resolveOrganizationSnapshot({
      contact,
      existingSnapshot: normalizeExistingOrganizationSnapshot(existingFields, table.fields),
      repairOrganization: context.repairOrganization === true,
    });
    const snapshot = organization.snapshot;
    const recordFields = {};
    const setDailyField = (key, value, fieldContext = context) => {
      if (!shouldWriteDailyField(table, key)) return;
      setMappedField(recordFields, table, key, value, fieldContext);
    };

    setDailyField('sourceRecordId', context.sourceRecordId || '');
    setDailyField('messageId', context.messageId || '');
    setDailyField('chatId', context.chatId || group.chatId || '');
    setDailyField('project', contact?.teamName || group.project || '');
    setDailyField('agileGroup', snapshot.agileGroup);
    setDailyField('reportDate', report.reportDate || '');
    setDailyField('reporterName', snapshot.reporterNameText, {
      ...context,
      senderOpenId: snapshot.memberOpenId,
      clearUser: !organization.matched && existingFields[table.fields.reporterName] !== undefined,
    });
    setDailyField('reporterNameText', snapshot.reporterNameText);
    setDailyField('memberOpenId', snapshot.memberOpenId);
    setDailyField('senderOpenId', context.senderOpenId || snapshot.memberOpenId);
    setDailyField('rawText', report.rawText || '');
    setDailyField('workItems', report.workSummaryText || report.workItems || []);
    setDailyField('tomorrowPlanItems', report.tomorrowPlanItems || []);
    setDailyField('riskItems', report.riskItems || []);
    setDailyField('aiSummary', buildDailyAiSummary(report));
    setOrganizationPersonField({
      table, key: 'supervisor', snapshot, organization, existingFields, setField: setDailyField,
    });
    setOrganizationPersonField({
      table, key: 'divisionalLeader', snapshot, organization, existingFields, setField: setDailyField,
    });
    setDailyField('source', context.source || 'chat');
    setDailyField('parseStatus', report.highConfidence ? 'parsed' : 'low_confidence');
    setDailyField('matchingStatus', snapshot.matchingStatus);
    setDailyField('matchMethod', snapshot.matchMethod);
    const existingFactStatus = normalizeFieldValue(existingFields[table.fields.factStatus]);
    const factStatus = existingFactStatus === '忽略'
      ? '忽略'
      : organization.matched ? context.factStatus || '有效' : '待人工确认';
    setDailyField('factStatus', factStatus);
    setDailyField('messageTime', context.messageTimeText || '');
    setDailyField('syncedAt', context.syncedAtText || '');

    return recordFields;
  }

  async createDailyReportRecord(group, report, context = {}) {
    const table = await this.resolveTableConfig(getDailyWriteTable(group), 'dailyTable');
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
          recordIdPresent: true,
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

  async createChatDailyRawRecord(group, report, context = {}) {
    const table = await this.resolveTableConfig(group.chatDailyRawTable, 'chatDailyRawTable');
    assertTable(table, 'chatDailyRawTable');
    const fields = buildChatRawFields(table, report, context);
    const res = await withBitableErrorContext('chatDailyRaw.create', table, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
        },
        params: { user_id_type: 'open_id' },
        data: { fields },
      })
    ));
    const record = extractRecordFromResponse(res);
    const historical = await this.markPreviousChatRawRecordsHistorical(group, report, {
      ...context,
      excludeRecordId: getRecordId(record),
      excludeMessageId: context.messageId,
    });
    return { created: true, record, fields, historicalUpdated: historical.updated };
  }

  async markPreviousChatRawRecordsHistorical(group, report, context = {}) {
    if (!tableIsConfigured(group.chatDailyRawTable)) return { updated: 0 };
    const table = await this.resolveTableConfig(group.chatDailyRawTable, 'chatDailyRawTable');
    const records = await this.listRecords(table, 'chatDailyRaw.findPrevious', { includeView: false });
    const fields = table.fields;
    const dates = new Set((report.reportDates || [report.reportDate]).map(date => String(date || '').trim()).filter(Boolean));
    const incomingSender = String(context.senderOpenId || '').trim();
    const incomingName = String(report.reporterName || '').trim();
    const excludeRecordId = String(context.excludeRecordId || '').trim();
    const excludeMessageId = String(context.excludeMessageId || '').trim();
    const candidates = records.filter(record => {
      if (excludeRecordId && String(record.record_id || '') === excludeRecordId) return false;
      const f = record.fields || {};
      const recordMessageId = normalizeFieldValue(fields.messageId ? f[fields.messageId] : '');
      if (excludeMessageId && recordMessageId === excludeMessageId) return false;
      const recordSender = normalizeFieldValue(f[fields.senderOpenId]);
      const recordName = normalizeFieldValue(f[fields.reporterName]);
      const sameSender = Boolean(incomingSender && recordSender && recordSender === incomingSender);
      const sameName = Boolean(incomingName && recordName && recordName === incomingName);
      const sameIdentity = incomingName && recordName ? sameName : sameSender;
      const recordDates = splitMultiline(f[fields.reportDates]);
      const overlaps = recordDates.some(date => dates.has(date));
      const isMain = normalizeFieldValue(f[fields.rawRecordStatus]) === '主版本';
      return overlaps && isMain && sameIdentity;
    });

    for (const record of candidates) {
      await withBitableErrorContext('chatDailyRaw.markHistorical', table, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
            record_id: record.record_id,
          },
          data: { fields: { [fields.rawRecordStatus]: '历史版本' } },
        })
      ));
    }
    return { updated: candidates.length };
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
    if (!tableIsConfigured(group.dailyTable)
      || !tableIsConfigured(group.chatDailyRawTable)
      || !tableIsConfigured(group.dailyFactTable)) {
      return { skipped: true, reason: 'dailyTable, chatDailyRawTable or dailyFactTable not configured' };
    }

    const timezone = options.timezone || DEFAULT_TIMEZONE;
    const now = options.now || new Date();
    const endDate = options.endDate || formatYmd(now, timezone);
    const lookbackDays = Number(options.lookbackDays ?? 7);
    const startDate = options.startDate || addDaysToYmd(endDate, -Math.max(lookbackDays - 1, 0));
    const formRecords = await this.listRecords(group.dailyTable, 'dailyFactSync.form.list', { automaticFields: true });
    const chatRawRecords = await this.listRecords(group.chatDailyRawTable, 'dailyFactSync.chatRaw.list', { includeView: false });
    const targetRecords = await this.listRecords(group.dailyFactTable, 'dailyFactSync.fact.list', { includeView: false });
    const selectedFormRecordIds = selectLatestFormRecordIds(
      formRecords,
      group.dailyTable.fields,
      group,
      startDate,
      endDate,
    );
    const selectedChatEntries = await selectLatestChatEntries(
      chatRawRecords,
      group.chatDailyRawTable.fields,
      group,
      startDate,
      endDate,
      options.includeHistoricalChat === true,
      (raw, record) => this.findTeamContactForReport(group, {
        reporterName: raw.reporterName,
        senderOpenId: raw.senderOpenId,
      }, record.record_id),
    );
    const targetByFactKey = indexRecordsByField(targetRecords, group.dailyFactTable.fields.factKey);
    const targetBySourceIdentity = indexFactRecordsBySourceIdentity(targetRecords, group.dailyFactTable.fields);

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    let filtered = 0;
    const errors = [];
    const sourceCounts = {
      form: formRecords.length,
      chatRaw: chatRawRecords.length,
      formFacts: 0,
      chatFacts: 0,
    };

    for (const formRecord of formRecords) {
      const report = normalizeDailyRecord(formRecord, group.dailyTable.fields, group);
      if (!report.reportDate || report.reportDate < startDate || report.reportDate > endDate) {
        filtered += 1;
        continue;
      }
      if (!selectedFormRecordIds.has(formRecord.record_id)) {
        filtered += 1;
        continue;
      }

      try {
        const contact = await this.findTeamContactForReport(group, report, formRecord.record_id);
        const reporterName = contact?.teamMember || report.reporterName;
        const memberOpenId = contact?.teamMemberId || report.senderOpenId;
        const input = {
          factKey: buildFactKey({
            openId: memberOpenId,
            name: reporterName,
            reportDate: report.reportDate,
          }),
          sourceRecordId: formRecord.record_id || '',
          source: 'form',
          reportDate: report.reportDate,
          reporterName,
          memberOpenId,
          senderOpenId: report.senderOpenId,
          workSummaryText: report.workSummaryText || report.workItems,
          tomorrowPlanItems: report.tomorrowPlanItems,
          riskItems: report.riskItems,
          rawText: report.rawText,
          project: contact?.teamName || report.project || group.project || '',
          agileGroup: contact?.agileGroup || report.agileGroup || '',
          supervisor: contact?.supervisor || report.supervisor || '',
          supervisorOpenId: contact?.supervisorOpenId || report.supervisorOpenId || '',
          divisionalLeader: contact?.divisionalLeader || '',
          divisionalLeaderOpenId: contact?.divisionalLeaderOpenId || '',
          matchingStatus: contact?.matchingStatus || '未匹配',
          matchMethod: contact?.matchMethod || '',
          contact,
          messageId: report.messageId,
          chatId: report.chatId,
          messageTime: report.messageTime,
          sourceTime: normalizeSourceTimestamp(formRecord.last_modified_time || formRecord.created_time),
          syncedAt: formatDateTime(now, timezone),
        };
        const existingRecord = targetByFactKey.get(input.factKey)
          || targetBySourceIdentity.get(buildFactSourceIdentity(input));
        const result = await this.upsertDailyFactRecord(group, input, {
          existingRecord,
          existingLookupComplete: true,
          repairOrganization: options.repairOrganization === true,
        });
        updateFactRecordIndexes({
          targetByFactKey,
          targetBySourceIdentity,
          fields: group.dailyFactTable.fields,
          input,
          existingRecord,
          result,
        });
        sourceCounts.formFacts += 1;
        if (result.created) created += 1;
        else if (result.updated) updated += 1;
        else if (result.unchanged) unchanged += 1;
        if (isConflictResult(group.dailyFactTable, result)) conflicts += 1;
      } catch (err) {
        errors.push({
          source: 'form',
          sourceRecordId: formRecord.record_id,
          message: err?.message || String(err),
        });
      }
    }

    for (const rawRecord of chatRawRecords) {
      const raw = normalizeChatRawRecord(rawRecord, group.chatDailyRawTable.fields, group);
      if (raw.rawRecordStatus === '历史版本' && options.includeHistoricalChat !== true) {
        filtered += 1;
        continue;
      }

      const reportDates = raw.reportDates.length ? raw.reportDates : [raw.reportDate].filter(Boolean);
      if (!reportDates.length) {
        filtered += 1;
        continue;
      }

      for (const reportDate of reportDates) {
        if (!reportDate || reportDate < startDate || reportDate > endDate) {
          filtered += 1;
          continue;
        }
        if (!selectedChatEntries.has(buildChatEntryId(rawRecord.record_id, reportDate))) {
          filtered += 1;
          continue;
        }

        try {
          const contact = await this.findTeamContactForReport(group, {
            reporterName: raw.reporterName,
            senderOpenId: raw.senderOpenId,
          }, rawRecord.record_id);
          const reporterName = contact?.teamMember || raw.reporterName;
          const memberOpenId = contact?.teamMemberId || raw.senderOpenId;
          const input = {
            factKey: buildFactKey({
              openId: memberOpenId,
              name: reporterName,
              reportDate,
            }),
            sourceRecordId: rawRecord.record_id || '',
            messageId: raw.messageId,
            source: 'chat',
            reportDate,
            reporterName,
            memberOpenId,
            senderOpenId: raw.senderOpenId,
            workSummaryText: raw.workSummaryText,
            rawText: raw.rawText,
            chatId: raw.chatId,
            project: contact?.teamName || raw.project,
            agileGroup: contact?.agileGroup || raw.agileGroup,
            supervisor: contact?.supervisor || '',
            supervisorOpenId: contact?.supervisorOpenId || '',
            divisionalLeader: contact?.divisionalLeader || '',
            divisionalLeaderOpenId: contact?.divisionalLeaderOpenId || '',
            matchingStatus: contact?.matchingStatus || (contact ? '已匹配' : '未匹配'),
            matchMethod: contact?.matchMethod || '',
            reportType: raw.reportType,
            dateRange: raw.dateRange,
            messageTime: raw.messageTime,
            sourceTime: normalizeSourceTimestamp(raw.messageTime),
            contact,
            syncedAt: formatDateTime(now, timezone),
          };
          const existingRecord = targetByFactKey.get(input.factKey)
            || targetBySourceIdentity.get(buildFactSourceIdentity(input));
          const result = await this.upsertDailyFactRecord(group, input, {
            existingRecord,
            existingLookupComplete: true,
            repairOrganization: options.repairOrganization === true,
          });
          updateFactRecordIndexes({
            targetByFactKey,
            targetBySourceIdentity,
            fields: group.dailyFactTable.fields,
            input,
            existingRecord,
            result,
          });
          sourceCounts.chatFacts += 1;
          if (result.created) created += 1;
          else if (result.updated) updated += 1;
          else if (result.unchanged) unchanged += 1;
          if (isConflictResult(group.dailyFactTable, result)) conflicts += 1;
        } catch (err) {
          errors.push({
            source: 'chat',
            sourceRecordId: rawRecord.record_id,
            messageId: raw.messageId,
            reportDate,
            message: err?.message || String(err),
          });
        }
      }
    }

    return {
      skipped: false,
      sourceCount: formRecords.length + chatRawRecords.length,
      sourceCounts,
      rangeStart: startDate,
      rangeEnd: endDate,
      created,
      updated,
      unchanged,
      conflicts,
      filtered,
      errors,
      existingTargetCount: targetRecords.length,
    };
  }

  async findTeamContactForReport(group, report, sourceRecordId) {
    try {
      return await this.findTeamContact(group, {
        reporterName: report.reporterName,
        senderOpenId: report.senderOpenId,
      });
    } catch (err) {
      logContactLookupFallback(err);
      return null;
    }
  }

  async upsertDailyFactRecordFromSource(group, sourceRecord, report, options = {}) {
    const table = await this.resolveTableConfig(group.dailyFactTable, 'dailyFactTable');
    assertTable(table, 'dailyFactTable');
    const sourceRecordId = sourceRecord.record_id || '';
    const existing = options.existingRecord || await this.findDailyFactRecordBySourceRecordId(group, sourceRecordId);
    let contact = null;
    try {
      contact = await this.findTeamContact(group, {
        reporterName: report.reporterName,
        senderOpenId: report.senderOpenId,
      });
    } catch (err) {
      logContactLookupFallback(err);
    }
    const fields = this.buildDailyRecordFields(group, report, {
      table,
      sourceRecordId,
      source: 'form',
      senderOpenId: report.senderOpenId,
      contact,
      existingRecord: existing,
      repairOrganization: options.repairOrganization === true,
      matchingStatus: contact?.matchingStatus || '未匹配',
      syncedAtText: formatDateTime(options.now || new Date(), options.timezone || DEFAULT_TIMEZONE),
    });

    if (existing) {
      const res = await withBitableErrorContext('dailyFactSync.target.update', table, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
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

    const res = await withBitableErrorContext('dailyFactSync.target.create', table, () => (
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
    return { created: true, record: extractRecordFromResponse(res), fields };
  }

  async upsertDailyFactRecord(group, input, options = {}) {
    const table = await this.resolveTableConfig(group.dailyFactTable, 'dailyFactTable');
    assertTable(table, 'dailyFactTable');
    const existing = options.existingLookupComplete
      ? options.existingRecord
      : options.existingRecord || await this.findDailyFactRecordByFactKey(group, input.factKey);
    const fields = buildDailyFactFields(table, input, existing, options);
    if (existing) {
      if (fieldsEqualForUpdate(fields, existing.fields || {}, table.fields.syncedAt, { source: input.source })) {
        return { unchanged: true, record: existing, fields };
      }
      const res = await withBitableErrorContext('dailyFact.update', table, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
            record_id: existing.record_id,
          },
          params: { user_id_type: 'open_id' },
          data: { fields },
        })
      ));
      return { updated: true, record: extractRecordFromResponse(res), fields };
    }

    const res = await withBitableErrorContext('dailyFact.create', table, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
        },
        params: { user_id_type: 'open_id' },
        data: { fields },
      })
    ));
    return { created: true, record: extractRecordFromResponse(res), fields };
  }

  async findDailyFactRecordByFactKey(group, factKey) {
    if (!factKey || !tableIsConfigured(group.dailyFactTable)) return null;
    const fieldName = group.dailyFactTable.fields.factKey;
    if (!fieldName) return null;
    const records = await this.listRecords(group.dailyFactTable, 'dailyFact.findByFactKey', { includeView: false });
    return records.find(record => String(record.fields?.[fieldName] || '') === String(factKey)) || null;
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
    const table = await this.resolveTableConfig(getDailyReadTable(group), 'dailyReadTable');
    assertTable(table, table === group.dailyFactTable ? 'dailyFactTable' : 'dailyTable');
    const records = await this.listRecords(table, 'dailyTable.listAll');
    const fields = table.fields;
    return records
      .filter(record => {
        const reportDate = normalizeDateFieldValue(record.fields?.[fields.reportDate]);
        return reportDate >= startDate && reportDate <= endDate
          && isEffectiveFactRecord(record, fields);
      })
      .map(record => normalizeDailyRecord(record, fields, group));
  }

  async listDailyReportsForRange(group, startDate, endDate) {
    const table = await this.resolveTableConfig(getDailyReadTable(group), 'dailyReadTable');
    assertTable(table, table === group.dailyFactTable ? 'dailyFactTable' : 'dailyTable');
    const records = await this.listRecords(table, 'dailyTable.listRange');
    const fields = table.fields;
    return records
      .filter(record => {
        const recordChatId = normalizeFieldValue(fields.chatId ? record.fields?.[fields.chatId] : '');
        const recordProject = normalizeFieldValue(fields.project ? record.fields?.[fields.project] : '');
        const reportDate = normalizeDateFieldValue(record.fields?.[fields.reportDate]);
        if (reportDate < startDate || reportDate > endDate) return false;
        if (!isEffectiveFactRecord(record, fields)) return false;
        if (recordChatId) return recordChatId === group.chatId;
        if (recordProject) {
          return [group.project, group.name].filter(Boolean).includes(recordProject);
        }
        return true;
      })
      .map(record => normalizeDailyRecord(record, fields, group));
  }

  async findTeamContact(group, { reporterName = '', senderOpenId = '' } = {}) {
    if (!tableIsConfigured(group.contactTable)) return null;
    const table = await this.resolveTableConfig(group.contactTable, 'contactTable');
    const cacheKey = `${table.appToken}:${table.tableId}`;
    const cached = this.contactCache.get(cacheKey);
    let contacts = cached?.expiresAt > Date.now() ? cached.contacts : null;
    if (!contacts) {
      const records = await this.listRecords(table, 'contactTable.findTeamContact');
      contacts = records.map(record => normalizeContactRecord(record, table.fields));
      this.contactCache.set(cacheKey, {
        contacts,
        expiresAt: Date.now() + 60_000,
      });
    }
    return findBestContact(contacts, { reporterName, senderOpenId });
  }

  async upsertWeeklySummary(group, summary, context = {}) {
    if (!tableIsConfigured(group.weeklyTable)) {
      console.warn(`[weekly] weeklyTable not configured for ${group.project}; skip summary persistence`);
      return { skipped: true };
    }

    const table = await this.resolveTableConfig(group.weeklyTable, 'weeklyTable');
    const existing = await this.findWeeklySummaryRecord(group, summary.weekStart);
    const fields = buildWeeklyFields(group, summary, context);
    if (existing) {
      const res = await withBitableErrorContext('upsertWeeklySummary.update', table, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
            record_id: existing.record_id,
          },
          data: { fields },
        })
      ));
      return { updated: true, record: extractRecordFromResponse(res), fields };
    }

    const res = await withBitableErrorContext('upsertWeeklySummary.create', table, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
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

  async findWeeklyInstanceRecord(group, instanceKey) {
    if (!tableIsConfigured(group.weeklyInstanceTable) || !instanceKey) return null;
    const records = await this.listRecords(
      group.weeklyInstanceTable,
      'weeklyInstance.findByKey',
      { includeView: false },
    );
    const fieldName = group.weeklyInstanceTable.fields.instanceKey;
    return records.find(record => (
      normalizeFieldValue(record.fields?.[fieldName]) === String(instanceKey)
    )) || null;
  }

  async upsertWeeklyInstance(group, instance, context = {}) {
    const table = await this.resolveTableConfig(group.weeklyInstanceTable, 'weeklyInstanceTable');
    assertTable(table, 'weeklyInstanceTable');
    const existing = context.existingRecord
      || await this.findWeeklyInstanceRecord(group, instance.instanceKey);
    const fields = buildWeeklyInstanceFields(table, instance, {
      ...context,
      existing,
    });

    if (existing) {
      const res = await withBitableErrorContext('weeklyInstance.update', table, () => (
        this.client.bitable.appTableRecord.update({
          path: {
            app_token: table.appToken,
            table_id: table.tableId,
            record_id: existing.record_id,
          },
          data: { fields },
        })
      ));
      return {
        created: false,
        updated: true,
        record: extractRecordFromResponse(res),
        fields,
      };
    }

    const res = await withBitableErrorContext('weeklyInstance.create', table, () => (
      this.client.bitable.appTableRecord.create({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
        },
        data: { fields },
      })
    ));
    return {
      created: true,
      updated: false,
      record: extractRecordFromResponse(res),
      fields,
    };
  }

  async listRecords(table, label = 'table.listRecords', options = {}) {
    const resolvedTable = await this.resolveTableConfig(table, 'table');
    assertTable(resolvedTable, 'table');
    const includeView = options.includeView !== false;
    const items = [];
    let pageToken;
    do {
      const res = await withBitableErrorContext(label, resolvedTable, () => (
        this.client.bitable.appTableRecord.list({
          path: {
            app_token: resolvedTable.appToken,
            table_id: resolvedTable.tableId,
          },
          params: {
            view_id: includeView ? resolvedTable.viewId || undefined : undefined,
            page_size: 500,
            page_token: pageToken,
            user_id_type: 'open_id',
            automatic_fields: options.automaticFields === true || undefined,
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

const RETRYABLE_BITABLE_CODES = new Set(['1254290', '1254291', '1254607']);
const BITABLE_RETRY_DELAYS_MS = [300, 800, 1600];

async function withBitableErrorContext(operation, table, fn) {
  for (let attempt = 0; attempt <= BITABLE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await fn();
      const code = getBitableBusinessCode(res);
      if (code != null && Number(code) !== 0) {
        const err = new Error('Bitable business error');
        err.code = code;
        err.response = { data: extractBitablePayload(res) };
        throw err;
      }
      return res;
    } catch (err) {
      const code = err?.response?.data?.code ?? err?.code;
      if (RETRYABLE_BITABLE_CODES.has(String(code)) && attempt < BITABLE_RETRY_DELAYS_MS.length) {
        const delayMs = BITABLE_RETRY_DELAYS_MS[attempt];
        console.warn('[bitable] transient failure; retrying', {
          operation,
          code: sanitizeOperationalCode(code),
          attempt: attempt + 1,
          delayMs,
        });
        await delay(delayMs);
        continue;
      }

      const context = buildBitableFailureContext(operation, table, code);
      console.error('[bitable] request failed', context);
      err.message = buildBitableFailureMessage(context);
      throw err;
    }
  }

  throw new Error(`Bitable request failed [operation=${operation}]`);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function buildBitableFailureContext(operation, table, code) {
  return {
    operation,
    appToken: maskToken(table?.appToken),
    tableId: maskToken(table?.tableId),
    viewId: maskToken(table?.viewId),
    code: sanitizeOperationalCode(code),
  };
}

function buildBitableFailureMessage(context) {
  return `Bitable request failed [operation=${context.operation} appToken=${context.appToken} tableId=${context.tableId} viewId=${context.viewId} code=${context.code}]`;
}

function sanitizeOperationalCode(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? sanitizeOperationalText(text) : '';
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
  const workItems = splitMultiline(f[fields.workItems]);
  return {
    recordId: record.record_id,
    messageId: normalizeFieldValue(fields.messageId ? f[fields.messageId] : ''),
    chatId: normalizeFieldValue(fields.chatId ? f[fields.chatId] : ''),
    project: normalizeFieldValue(fields.project ? f[fields.project] : '') || group.project,
    agileGroup: normalizeFieldValue(fields.agileGroup ? f[fields.agileGroup] : ''),
    reportDate: normalizeDateFieldValue(f[fields.reportDate]),
    reporterName: reporter.name || normalizeFieldValue(f[fields.reporterName]),
    memberOpenId: normalizeFieldValue(fields.memberOpenId ? f[fields.memberOpenId] : ''),
    senderOpenId: normalizeFieldValue(fields.senderOpenId ? f[fields.senderOpenId] : '') || reporter.id,
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    rawText: normalizeFieldValue(fields.rawText ? f[fields.rawText] : ''),
    workItems,
    workSummaryText: normalizeFieldValue(fields.workItems ? f[fields.workItems] : '') || workItems,
    tomorrowPlanItems: splitMultiline(fields.tomorrowPlanItems ? f[fields.tomorrowPlanItems] : ''),
    riskItems: splitMultiline(f[fields.riskItems]),
    source: normalizeFieldValue(fields.source ? f[fields.source] : ''),
    parseStatus: normalizeFieldValue(fields.parseStatus ? f[fields.parseStatus] : ''),
    messageTime: normalizeFieldValue(fields.messageTime ? f[fields.messageTime] : ''),
    sourceRecordId: normalizeFieldValue(fields.sourceRecordId ? f[fields.sourceRecordId] : ''),
    sourceRefs: normalizeFieldValue(fields.sourceRefs ? f[fields.sourceRefs] : ''),
    contentFingerprint: normalizeFieldValue(fields.contentFingerprint ? f[fields.contentFingerprint] : ''),
    effectiveSource: normalizeFieldValue(fields.effectiveSource ? f[fields.effectiveSource] : ''),
    factStatus: normalizeFieldValue(fields.factStatus ? f[fields.factStatus] : ''),
    reportType: normalizeFieldValue(fields.reportType ? f[fields.reportType] : ''),
    dateRange: normalizeFieldValue(fields.dateRange ? f[fields.dateRange] : ''),
    sourceTime: normalizeSourceTimestamp(fields.sourceTime ? f[fields.sourceTime] : ''),
  };
}

function normalizeExistingOrganizationSnapshot(existingFields, fields) {
  const reporter = normalizePersonValue(existingFields[fields.reporterName]);
  const supervisor = normalizePersonValue(existingFields[fields.supervisor]);
  const leader = normalizePersonValue(existingFields[fields.divisionalLeader]);
  return {
    reporterNameText: normalizeFieldValue(existingFields[fields.reporterNameText]),
    memberOpenId: normalizeFieldValue(existingFields[fields.memberOpenId]) || reporter.id,
    agileGroup: normalizeFieldValue(existingFields[fields.agileGroup]),
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    divisionalLeader: leader.name,
    divisionalLeaderOpenId: leader.id,
    matchingStatus: normalizeFieldValue(existingFields[fields.matchingStatus]),
    matchMethod: normalizeFieldValue(existingFields[fields.matchMethod]),
  };
}

function isEffectiveFactRecord(record, fields) {
  if (!fields.factStatus) return true;
  return normalizeFieldValue(record.fields?.[fields.factStatus]) === '有效';
}

function normalizeChatRawRecord(record, fields, group) {
  const f = record.fields || {};
  return {
    recordId: record.record_id,
    messageId: normalizeFieldValue(fields.messageId ? f[fields.messageId] : ''),
    chatId: normalizeFieldValue(fields.chatId ? f[fields.chatId] : '') || group.chatId || '',
    senderOpenId: normalizeFieldValue(fields.senderOpenId ? f[fields.senderOpenId] : ''),
    reporterName: normalizeFieldValue(fields.reporterName ? f[fields.reporterName] : ''),
    reportDate: normalizeDateFieldValue(fields.reportDate ? f[fields.reportDate] : ''),
    dateRange: normalizeFieldValue(fields.reportDateRange ? f[fields.reportDateRange] : '')
      || normalizeFieldValue(fields.dateRange ? f[fields.dateRange] : ''),
    reportDates: splitMultiline(fields.reportDates ? f[fields.reportDates] : ''),
    rawText: normalizeFieldValue(fields.rawText ? f[fields.rawText] : ''),
    workSummaryText: normalizeFieldValue(fields.workSummaryText ? f[fields.workSummaryText] : ''),
    project: normalizeFieldValue(fields.project ? f[fields.project] : '') || group.project || '',
    agileGroup: normalizeFieldValue(fields.agileGroup ? f[fields.agileGroup] : ''),
    reportType: normalizeFieldValue(fields.reportType ? f[fields.reportType] : ''),
    messageTime: normalizeFieldValue(fields.messageTime ? f[fields.messageTime] : ''),
    rawRecordStatus: normalizeFieldValue(fields.rawRecordStatus ? f[fields.rawRecordStatus] : ''),
  };
}

function selectLatestFormRecordIds(records, fields, group, startDate, endDate) {
  const selected = new Map();
  for (const record of records) {
    const report = normalizeDailyRecord(record, fields, group);
    if (!report.reportDate || report.reportDate < startDate || report.reportDate > endDate) continue;
    const identity = buildFactKey({
      openId: report.senderOpenId,
      name: report.reporterName,
      reportDate: report.reportDate,
    });
    keepLatestSourceCandidate(selected, identity, {
      id: record.record_id,
      sourceTime: normalizeSourceTimestamp(record.last_modified_time || record.created_time),
    });
  }
  return new Set([...selected.values()].map(candidate => candidate.id));
}

async function selectLatestChatEntries(
  records,
  fields,
  group,
  startDate,
  endDate,
  includeHistorical,
  resolveContact,
) {
  const selected = new Map();
  for (const record of records) {
    const raw = normalizeChatRawRecord(record, fields, group);
    if (raw.rawRecordStatus === '历史版本' && !includeHistorical) continue;
    const contact = await resolveContact(raw, record);
    const dates = raw.reportDates.length ? raw.reportDates : [raw.reportDate].filter(Boolean);
    for (const reportDate of dates) {
      if (!reportDate || reportDate < startDate || reportDate > endDate) continue;
      const identity = buildFactKey({
        openId: contact?.teamMemberId || (raw.reporterName ? '' : raw.senderOpenId),
        name: contact?.teamMember || raw.reporterName,
        reportDate,
      });
      keepLatestSourceCandidate(selected, identity, {
        id: buildChatEntryId(record.record_id, reportDate),
        sourceTime: normalizeSourceTimestamp(raw.messageTime),
      });
    }
  }
  return new Set([...selected.values()].map(candidate => candidate.id));
}

function keepLatestSourceCandidate(selected, identity, candidate) {
  const existing = selected.get(identity);
  if (!existing
    || candidate.sourceTime > existing.sourceTime
    || (candidate.sourceTime === existing.sourceTime && candidate.id > existing.id)) {
    selected.set(identity, candidate);
  }
}

function buildChatEntryId(recordId, reportDate) {
  return `${recordId || ''}:${reportDate || ''}`;
}

function buildChatRawFields(table, report, context = {}) {
  const recordFields = {};
  setMappedField(recordFields, table, 'messageId', context.messageId || '', context);
  setMappedField(recordFields, table, 'chatId', context.chatId || '', context);
  setMappedField(recordFields, table, 'chatName', context.chatName || '', context);
  setMappedField(recordFields, table, 'senderOpenId', context.senderOpenId || '', context);
  setMappedField(recordFields, table, 'reporterName', report.reporterName || '', context);
  setMappedField(recordFields, table, 'reportDateRange', report.dateRange || report.reportDate || '', context);
  setMappedField(recordFields, table, 'reportDates', report.reportDates || [report.reportDate], context);
  setMappedField(recordFields, table, 'rawText', report.rawText || '', context);
  setMappedField(recordFields, table, 'workSummaryText', report.workSummaryText || report.workItems || [], context);
  setMappedField(recordFields, table, 'contentFingerprint', buildContentFingerprint({
    workItems: report.workSummaryText || report.workItems || '',
    tomorrowPlanItems: report.tomorrowPlanItems || '',
    riskItems: report.riskItems || '',
  }), context);
  setMappedField(recordFields, table, 'messageTime', context.messageTimeText || '', context);
  setMappedField(recordFields, table, 'receivedAt', context.receivedAtText || formatDateTime(new Date(), DEFAULT_TIMEZONE), context);
  setMappedField(recordFields, table, 'parseStatus', report.highConfidence ? '已解析' : '低置信度', context);
  setMappedField(recordFields, table, 'rawRecordStatus', '主版本', context);
  return recordFields;
}

function buildDailyFactFields(table, input, existing, options = {}) {
  const existingFields = existing?.fields || {};
  const fields = table.fields;
  const incomingWorkItems = input.workSummaryText || input.workItems || '';
  const incomingTomorrowPlanItems = input.tomorrowPlanItems || '';
  const incomingRiskItems = input.riskItems || '';
  const existingWorkItems = normalizeFieldValue(fields.workItems ? existingFields[fields.workItems] : '');
  const existingTomorrowPlanItems = normalizeFieldValue(fields.tomorrowPlanItems ? existingFields[fields.tomorrowPlanItems] : '');
  const existingRiskItems = normalizeFieldValue(fields.riskItems ? existingFields[fields.riskItems] : '');
  const incomingFingerprint = buildContentFingerprint({
    workItems: incomingWorkItems,
    tomorrowPlanItems: incomingTomorrowPlanItems,
    riskItems: incomingRiskItems,
  });
  const existingFingerprint = normalizeFieldValue(fields.contentFingerprint ? existingFields[fields.contentFingerprint] : '');
  const existingSourceTime = normalizeSourceTimestamp(fields.sourceTime ? existingFields[fields.sourceTime] : '');
  const existingSource = normalizeFieldValue(fields.source ? existingFields[fields.source] : '');
  const existingHasForm = sourceHas(existingSource, 'form');
  const existingHasChat = sourceHas(existingSource, 'chat');
  const incomingCandidate = {
    source: input.source,
    sourceTime: normalizeSourceTimestamp(input.sourceTime),
    fingerprint: incomingFingerprint,
    matchingStatus: input.matchingStatus || '',
  };
  const resolution = resolveIncrementalDailyFact({
    existing: existing ? {
      source: existingSource,
      effectiveSource: normalizeFieldValue(fields.effectiveSource ? existingFields[fields.effectiveSource] : ''),
      sourceTime: existingSourceTime,
      fingerprint: existingFingerprint,
      matchingStatus: normalizeFieldValue(fields.matchingStatus ? existingFields[fields.matchingStatus] : ''),
      factStatus: normalizeFieldValue(fields.factStatus ? existingFields[fields.factStatus] : ''),
      mergeStatus: normalizeFieldValue(fields.mergeStatus ? existingFields[fields.mergeStatus] : ''),
      conflictStatus: normalizeFieldValue(fields.conflictStatus ? existingFields[fields.conflictStatus] : ''),
      autoResolutionNote: normalizeFieldValue(fields.autoResolutionNote ? existingFields[fields.autoResolutionNote] : ''),
    } : null,
    incoming: incomingCandidate,
  });
  const mergedSource = resolution.hasBothSources ? 'form+chat' : input.source;
  const useIncomingContent = resolution.winner === incomingCandidate;
  const useIncomingCanonical = useIncomingContent;
  const organization = resolveOrganizationSnapshot({
    contact: input.contact || null,
    existingSnapshot: normalizeExistingOrganizationSnapshot(existingFields, fields),
    repairOrganization: options.repairOrganization === true,
  });
  const snapshot = organization.snapshot;
  const existingFactKey = normalizeFieldValue(existingFields[fields.factKey]);
  const persistedFactKey = organization.source === 'existing' && existingFactKey
    ? existingFactKey
    : organization.matched
      ? buildFactKey({
        openId: snapshot.memberOpenId,
        name: snapshot.reporterNameText,
        reportDate: input.reportDate,
      })
      : input.factKey;
  const existingRefs = normalizeFieldValue(fields.sourceRefs ? existingFields[fields.sourceRefs] : '');
  const incomingRefs = buildSourceRefs({
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    messageId: input.messageId,
  });
  const setCanonicalField = (recordFields, key, value, context = {}) => {
    if (useIncomingCanonical) {
      setMappedField(recordFields, table, key, value, context);
      return;
    }

    const fieldName = fields[key];
    if (!fieldName) return;
    if (existingFields[fieldName] !== undefined) {
      recordFields[fieldName] = existingFields[fieldName];
    }
  };

  const recordFields = {};
  setMappedField(recordFields, table, 'factKey', persistedFactKey);
  setMappedField(recordFields, table, 'reportDate', input.reportDate);
  setCanonicalField(recordFields, 'project', input.project || '');
  setMappedField(recordFields, table, 'agileGroup', snapshot.agileGroup);
  setMappedField(recordFields, table, 'reporterName', snapshot.reporterNameText, {
    senderOpenId: snapshot.memberOpenId,
    clearUser: !organization.matched && existingFields[fields.reporterName] !== undefined,
  });
  setMappedField(recordFields, table, 'reporterNameText', snapshot.reporterNameText);
  setMappedField(recordFields, table, 'memberOpenId', snapshot.memberOpenId);
  setCanonicalField(recordFields, 'senderOpenId', input.senderOpenId || input.memberOpenId || '');
  setMappedField(recordFields, table, 'workItems', useIncomingContent ? incomingWorkItems : existingWorkItems);
  setMappedField(recordFields, table, 'tomorrowPlanItems', useIncomingContent ? incomingTomorrowPlanItems : existingTomorrowPlanItems);
  setMappedField(recordFields, table, 'riskItems', useIncomingContent ? incomingRiskItems : existingRiskItems);
  setMappedField(recordFields, table, 'contentFingerprint', useIncomingContent ? incomingFingerprint : existingFingerprint);
  setMappedField(recordFields, table, 'sourceTime', resolution.sourceTime);
  setMappedField(recordFields, table, 'source', mergedSource);
  setMappedField(recordFields, table, 'sourceRecordId', input.source === 'form'
    ? input.sourceRecordId || ''
    : existingHasForm ? normalizeFieldValue(fields.sourceRecordId ? existingFields[fields.sourceRecordId] : '') : input.sourceRecordId || '');
  setMappedField(recordFields, table, 'messageId', input.source === 'chat'
    ? input.messageId || ''
    : normalizeFieldValue(fields.messageId ? existingFields[fields.messageId] : ''));
  setMappedField(recordFields, table, 'sourceRefs', mergeSourceRefs(existingRefs, incomingRefs));
  setMappedField(recordFields, table, 'effectiveSource', resolution.effectiveSource);
  setMappedField(recordFields, table, 'autoResolutionNote', resolution.autoResolutionNote);
  setMappedField(recordFields, table, 'mergeStatus', resolution.mergeStatus);
  setMappedField(recordFields, table, 'conflictStatus', resolution.conflictStatus);
  const existingFactStatus = normalizeFieldValue(existingFields[fields.factStatus]);
  const factStatus = existingFactStatus === '忽略'
    ? '忽略'
    : organization.matched ? resolution.factStatus : '待人工确认';
  setMappedField(recordFields, table, 'factStatus', factStatus);
  setCanonicalField(recordFields, 'rawText', input.rawText || '');
  setCanonicalField(recordFields, 'chatId', input.chatId || '');
  setOrganizationPersonField({
    table, key: 'supervisor', snapshot, organization, existingFields,
    setField: (fieldKey, value, context) => setMappedField(recordFields, table, fieldKey, value, context),
  });
  setOrganizationPersonField({
    table, key: 'divisionalLeader', snapshot, organization, existingFields,
    setField: (fieldKey, value, context) => setMappedField(recordFields, table, fieldKey, value, context),
  });
  setMappedField(recordFields, table, 'matchingStatus', snapshot.matchingStatus);
  setMappedField(recordFields, table, 'matchMethod', snapshot.matchMethod);
  setCanonicalField(recordFields, 'reportType', input.reportType || '');
  setCanonicalField(recordFields, 'dateRange', input.dateRange || '');
  setCanonicalField(recordFields, 'messageTime', input.messageTime || '');
  setMappedField(recordFields, table, 'syncedAt', input.syncedAt || formatDateTime(new Date(), DEFAULT_TIMEZONE));
  return recordFields;
}

function isConflictResult(table, result) {
  const fieldName = table?.fields?.conflictStatus;
  return fieldName ? result?.fields?.[fieldName] === '已自动处理' : false;
}

function updateFactRecordIndexes({
  targetByFactKey,
  targetBySourceIdentity,
  fields,
  input,
  existingRecord,
  result,
}) {
  const resultRecord = result.record || {};
  const indexedRecord = {
    ...existingRecord,
    ...resultRecord,
    record_id: resultRecord.record_id || existingRecord?.record_id,
    fields: result.fields || resultRecord.fields || existingRecord?.fields || {},
  };
  const previousFactKey = normalizeFieldValue(existingRecord?.fields?.[fields.factKey]);
  const persistedFactKey = normalizeFieldValue(
    result.fields?.[fields.factKey]
      || resultRecord.fields?.[fields.factKey]
      || previousFactKey
      || input.factKey,
  );
  if (previousFactKey && previousFactKey !== persistedFactKey) {
    targetByFactKey.delete(previousFactKey);
  }
  if (persistedFactKey) targetByFactKey.set(persistedFactKey, indexedRecord);

  const sourceIdentities = new Set([
    ...buildFactSourceIdentitiesFromFields(indexedRecord.fields, fields),
    buildFactSourceIdentity(input),
  ]);
  for (const sourceIdentity of sourceIdentities) {
    if (sourceIdentity) targetBySourceIdentity.set(sourceIdentity, indexedRecord);
  }
}

function fieldsEqualForUpdate(incomingFields, existingFields, syncedAtFieldName, debugContext = {}) {
  const changedFields = [];
  for (const [fieldName, value] of Object.entries(incomingFields || {})) {
    if (fieldName === syncedAtFieldName) continue;
    if (!fieldValuesEqual(value, existingFields?.[fieldName])) changedFields.push(fieldName);
  }
  if (changedFields.length && process.env.DEBUG_BITABLE_DIFF === '1') {
    console.warn('[bitable] update fields differ', {
      source: debugContext.source || '',
      fields: changedFields.sort(),
    });
  }
  return changedFields.length === 0;
}

export function fieldValuesEqual(a, b) {
  return JSON.stringify(normalizeComparableFieldValue(a)) === JSON.stringify(normalizeComparableFieldValue(b));
}

function normalizeComparableFieldValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map(item => normalizeComparableFieldValue(item));
  }
  if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.id) return { id: value.id };
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeComparableFieldValue(item)]),
    );
  }
  return value;
}

function sourceHas(source, part) {
  return String(source || '')
    .split('+')
    .map(item => item.trim())
    .includes(part);
}

function mergeSourceRefs(existingRefs, incomingRefs) {
  const refs = [];
  for (const ref of `${existingRefs || ''}\n${incomingRefs || ''}`.split('\n')) {
    const value = ref.trim();
    if (value && !refs.includes(value)) refs.push(value);
  }
  return refs.join('\n');
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

function buildWeeklyInstanceFields(table, instance, context = {}) {
  const recordFields = {};
  for (const key of [
    'instanceKey',
    'isoYear',
    'isoWeek',
    'weekStart',
    'weekEnd',
    'spreadsheetToken',
    'sheetId',
    'sheetTitle',
    'sheetUrl',
    'status',
  ]) {
    const fieldContext = key === 'sheetUrl'
      ? { ...context, urlText: instance.sheetTitle || instance.sheetUrl }
      : context;
    setMappedField(recordFields, table, key, instance[key], fieldContext);
  }
  const now = context.now || new Date();
  if (!context.existing) {
    setMappedField(recordFields, table, 'createdAt', now.getTime(), context);
  }
  setMappedField(recordFields, table, 'updatedAt', now.getTime(), context);
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

export function normalizeSourceTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const shanghaiTimestamp = parseShanghaiDateTime(String(value).trim());
  if (shanghaiTimestamp != null) return shanghaiTimestamp;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
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

function setOrganizationPersonField({
  table,
  key,
  snapshot,
  organization,
  existingFields,
  setField,
}) {
  const fieldName = table?.fields?.[key];
  if (!fieldName) return;
  const openIdKey = `${key}OpenId`;
  const hasValue = Boolean(String(snapshot?.[key] || '').trim() || String(snapshot?.[openIdKey] || '').trim());
  const hasExisting = existingFields[fieldName] !== undefined;
  if (organization.matched && hasExisting && !hasValue) return;
  if (!hasValue && !hasExisting) return;
  setField(key, snapshot?.[key] || '', {
    [openIdKey]: snapshot?.[openIdKey] || '',
    clearUser: !organization.matched && hasExisting,
  });
}

function formatFieldValue(table, key, value, context = {}) {
  const fieldType = table?.fieldTypes?.[key] || '';
  if (fieldType === 'date' || fieldType === 'datetime') {
    return toBitableDateTimestamp(value, fieldType);
  }

  if (fieldType === 'user') {
    const id = getUserFieldOpenId(key, context);
    const name = Array.isArray(value) ? value.join('\n') : String(value || '');
    if (id) return [{ id, name }];
    if (context.clearUser === true) return [];
    return undefined;
  }

  if (fieldType === 'url') {
    const link = String(value || '').trim();
    if (!link) return undefined;
    return {
      text: String(context.urlText || link),
      link,
    };
  }

  if (Array.isArray(value)) return value.join('\n');
  return value == null ? '' : value;
}

function getUserFieldOpenId(key, context = {}) {
  if (key === 'reporterName') return context.senderOpenId;
  if (key === 'supervisor') return context.supervisorOpenId;
  if (key === 'divisionalLeader') return context.divisionalLeaderOpenId;
  return '';
}

function toBitableDateTimestamp(value, fieldType = 'date') {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  const normalized = String(text || '').trim();
  if (/^\d{10,13}$/.test(normalized)) {
    const numeric = Number(normalized);
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  if (fieldType === 'datetime') {
    const parsedDateTime = parseShanghaiDateTime(normalized);
    if (parsedDateTime != null) return parsedDateTime;
  }
  const parsed = parseYmd(normalized);
  if (!parsed) return value == null || value === '' ? undefined : value;
  return Date.UTC(parsed.year, parsed.month - 1, parsed.day);
}

function parseShanghaiDateTime(text) {
  const match = String(text || '').match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second),
    );
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeContactRecord(record, fields) {
  const f = record.fields || {};
  const member = normalizePersonValue(fields.teamMember ? f[fields.teamMember] : '');
  const supervisor = normalizePersonValue(fields.supervisor ? f[fields.supervisor] : '');
  const divisionalLeader = normalizePersonValue(fields.divisionalLeader ? f[fields.divisionalLeader] : '');
  const realName = normalizeFieldValue(fields.memberRealName ? f[fields.memberRealName] : '')
    || normalizeFieldValue(f['成员真实名称'])
    || normalizeFieldValue(f['成员真实姓名']);
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
  const name = String(reporterName || '').trim();
  const exactRealName = name
    ? contacts.find(contact => contact.teamMember === name)
    : null;
  if (exactRealName) {
    return {
      ...exactRealName,
      matchMethod: '姓名',
      matchingStatus: '已匹配',
    };
  }

  const exactAlias = name
    ? contacts.find(contact => contact.memberAliases?.includes(name))
    : null;
  if (exactAlias) {
    return {
      ...exactAlias,
      matchMethod: '别名',
      matchingStatus: '已匹配',
    };
  }

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

  return null;
}

function logContactLookupFallback(err) {
  const candidate = err?.response?.data?.code ?? err?.code ?? '';
  const code = /^[A-Za-z0-9_.:-]{1,64}$/.test(String(candidate))
    ? sanitizeOperationalText(candidate)
    : '';
  console.warn('[daily-fact-sync] contact lookup failed; continue unmatched', { code });
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
    topLevelKeys: objectKeys(res),
    responseDataKeys: objectKeys(res?.data),
    businessDataKeys: objectKeys(data),
    hasRecord: Boolean(record),
    recordIdPresent: Boolean(getRecordId(record)),
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

function indexFactRecordsBySourceIdentity(records, fields) {
  const index = new Map();
  for (const record of records || []) {
    for (const identity of buildFactSourceIdentitiesFromFields(record.fields, fields)) {
      index.set(identity, record);
    }
  }
  return index;
}

function buildFactSourceIdentitiesFromFields(recordFields, fields) {
  const source = normalizeFieldValue(recordFields?.[fields.source]);
  const sourceRecordId = normalizeFieldValue(recordFields?.[fields.sourceRecordId]);
  const reportDate = normalizeDateFieldValue(recordFields?.[fields.reportDate]);
  const identities = new Set();
  const addIdentity = (sourceType, recordId) => {
    const identity = buildFactSourceIdentity({ source: sourceType, sourceRecordId: recordId, reportDate });
    if (identity) identities.add(identity);
  };

  if (sourceHas(source, 'form')) addIdentity('form', sourceRecordId);
  else if (sourceHas(source, 'chat')) addIdentity('chat', sourceRecordId);

  for (const ref of parseSourceRefs(recordFields?.[fields.sourceRefs])) {
    if (ref.type === 'form') addIdentity('form', ref.recordId);
    if (ref.type === 'chat_raw') addIdentity('chat', ref.recordId);
  }
  return identities;
}

function parseSourceRefs(value) {
  const refs = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const type = line.slice(0, separator).trim();
    const recordId = line.slice(separator + 1).trim();
    if ((type === 'form' || type === 'chat_raw') && recordId) {
      refs.push({ type, recordId });
    }
  }
  return refs;
}

function buildFactSourceIdentity({ source, sourceRecordId, reportDate } = {}) {
  const sourceType = String(source || '').trim();
  const recordId = String(sourceRecordId || '').trim();
  const date = String(reportDate || '').trim();
  return sourceType && recordId && date ? `${sourceType}:${recordId}:${date}` : '';
}
