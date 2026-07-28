import crypto from 'node:crypto';
import { WEEKLY_FIELD_KEYS, tableIsConfigured } from './config.js';
import { DEFAULT_TIMEZONE, addDaysToYmd, formatDateTime, formatYmd, parseYmd } from './date-utils.js';
import {
  buildContentFingerprint,
  buildFactKey,
  buildSourceRefs,
  normalizeContentForFingerprint,
} from './daily-record-utils.js';
import { rebuildDailyFactFields, resolveDailyFactFields } from './daily-fact-resolution.js';
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
    setOrganizationProjectField({
      recordFields,
      table,
      contact,
      organization,
      existingFields,
    });
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
    const targetRecords = await this.listRecords(group.dailyFactTable, 'dailyFactSync.fact.list', { includeView: false });
    let formRecords = [];
    let chatRawRecords = [];
    let sourceListError = null;
    try {
      formRecords = await this.listRecords(
        group.dailyTable,
        'dailyFactSync.form.list',
        { automaticFields: true },
      );
      chatRawRecords = await this.listRecords(
        group.chatDailyRawTable,
        'dailyFactSync.chatRaw.list',
        { includeView: false },
      );
    } catch (error) {
      formRecords = [];
      chatRawRecords = [];
      sourceListError = error;
    }
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
    const targetByReporterDate = indexFactRecordsByReporterDate(
      targetRecords,
      group.dailyFactTable.fields,
    );

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let conflicts = 0;
    let filtered = 0;
    const errors = sourceListError ? [{
      source: 'source_records',
      message: sourceListError?.message || String(sourceListError),
    }] : [];
    const rebuildGroups = new Map();
    const weakGroupsByReporterDate = new Map();
    const claimedTargetRecordIds = new Set();
    const blockedTargetRecordIds = new Set();
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
          values: {
            workItems: normalizeCandidateText(report.workSummaryText || report.workItems),
            tomorrowPlanItems: normalizeCandidateText(report.tomorrowPlanItems),
            riskItems: normalizeCandidateText(report.riskItems),
          },
          rawText: report.rawText,
          project: contact?.teamName || '',
          supervisor: contact?.supervisor || report.supervisor || '',
          supervisorOpenId: contact?.supervisorOpenId || report.supervisorOpenId || '',
          matchingStatus: contact?.matchingStatus || '未匹配',
          matchMethod: contact?.matchMethod || '',
          contact,
          messageId: report.messageId,
          chatId: report.chatId,
          messageTime: report.messageTime,
          sourceTime: normalizeSourceTimestamp(formRecord.last_modified_time || formRecord.created_time),
          syncedAt: formatDateTime(now, timezone),
        };
        const collection = collectDailyFactRebuildCandidate({
          rebuildGroups,
          targetByFactKey,
          targetBySourceIdentity,
          targetByReporterDate,
          weakGroupsByReporterDate,
          input,
        });
        if (collection?.conflict) {
          for (const record of collection.conflict.records) {
            if (record?.record_id) blockedTargetRecordIds.add(record.record_id);
          }
          conflicts += 1;
          errors.push(buildStrongTargetConflictError(input));
          continue;
        }
        sourceCounts.formFacts += 1;
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
            values: {
              workItems: normalizeCandidateText(raw.workSummaryText),
              tomorrowPlanItems: '',
              riskItems: '',
            },
            rawText: raw.rawText,
            chatId: raw.chatId,
            project: contact?.teamName || '',
            supervisor: contact?.supervisor || '',
            supervisorOpenId: contact?.supervisorOpenId || '',
            matchingStatus: contact?.matchingStatus || (contact ? '已匹配' : '未匹配'),
            matchMethod: contact?.matchMethod || '',
            reportType: raw.reportType,
            dateRange: raw.dateRange,
            messageTime: raw.messageTime,
            sourceTime: normalizeSourceTimestamp(raw.messageTime),
            contact,
            syncedAt: formatDateTime(now, timezone),
          };
          const collection = collectDailyFactRebuildCandidate({
            rebuildGroups,
            targetByFactKey,
            targetBySourceIdentity,
            targetByReporterDate,
            weakGroupsByReporterDate,
            input,
          });
          if (collection?.conflict) {
            for (const record of collection.conflict.records) {
              if (record?.record_id) blockedTargetRecordIds.add(record.record_id);
            }
            conflicts += 1;
            errors.push(buildStrongTargetConflictError(input));
            continue;
          }
          sourceCounts.chatFacts += 1;
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

    for (const reporterDateAlias of weakGroupsByReporterDate.keys()) {
      bridgeUnambiguousReporterDateGroups({
        reporterDateAlias,
        rebuildGroups,
        weakGroupsByReporterDate,
        targetByReporterDate,
      });
    }

    for (const rebuildGroup of new Set(rebuildGroups.values())) {
      if (blockedTargetRecordIds.has(rebuildGroup.existingRecord?.record_id)) continue;
      try {
        const existingRecord = rebuildGroup.existingRecord;
        const existingState = existingRecord
          ? readExistingDailyFactState(existingRecord.fields || {}, group.dailyFactTable.fields)
          : null;
        const candidates = buildDailyFactRebuildCandidates(
          rebuildGroup.inputs,
          existingState,
        );
        let resolution = rebuildDailyFactFields({
          candidates,
          existingFactStatus: existingState?.factStatus || '',
        });
        resolution = preserveExistingNonEmptyFactValues(resolution, existingState);
        const input = consolidateDailyFactInputs(rebuildGroup.inputs, resolution);
        const result = await this.upsertDailyFactRecord(group, input, {
          existingRecord,
          existingLookupComplete: true,
          repairOrganization: options.repairOrganization === true,
          resolution,
        });
        if (existingRecord?.record_id) {
          claimedTargetRecordIds.add(existingRecord.record_id);
        }
        if (result.created) created += 1;
        else if (result.updated) updated += 1;
        else if (result.unchanged) unchanged += 1;
        if (isConflictResult(group.dailyFactTable, result)) conflicts += 1;
      } catch (err) {
        errors.push({
          source: 'rebuild',
          message: err?.message || String(err),
        });
      }
    }

    for (const existingRecord of targetRecords) {
      if (claimedTargetRecordIds.has(existingRecord.record_id)) continue;
      if (blockedTargetRecordIds.has(existingRecord.record_id)) continue;
      const targetDate = normalizeDateFieldValue(
        existingRecord.fields?.[group.dailyFactTable.fields.reportDate],
      );
      if (!targetDate || targetDate < startDate || targetDate > endDate) continue;
      if (hasUsableFieldSourceSnapshot(existingRecord.fields, group.dailyFactTable.fields)) continue;

      try {
        const input = buildExistingFactMigrationInput(existingRecord, group.dailyFactTable.fields);
        const existingState = readExistingDailyFactState(
          existingRecord.fields || {},
          group.dailyFactTable.fields,
        );
        const resolution = initializeExistingFactProvenance(existingState);
        const result = await this.upsertDailyFactRecord(group, input, {
          existingRecord,
          existingLookupComplete: true,
          preserveCanonical: true,
          resolution,
        });
        if (result.updated) updated += 1;
        else if (result.unchanged) unchanged += 1;
        if (isConflictResult(group.dailyFactTable, result)) conflicts += 1;
      } catch (err) {
        errors.push({
          source: 'fact_migration',
          message: err?.message || String(err),
        });
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

  async updateWeeklyInstance(groupOrInstance, recordIdOrPatch, maybePatch, context = {}) {
    const instanceStyleCall = maybePatch === undefined
      && recordIdOrPatch && typeof recordIdOrPatch === 'object'
      && (groupOrInstance?.group || groupOrInstance?.weeklyInstanceTable
        || groupOrInstance?.record || groupOrInstance?.recordId)
    const instance = instanceStyleCall
      ? groupOrInstance
      : (maybePatch && typeof maybePatch === 'object' && 'now' in maybePatch
        && recordIdOrPatch && typeof recordIdOrPatch === 'object'
        && (groupOrInstance?.group || groupOrInstance?.weeklyInstanceTable
          || groupOrInstance?.record || groupOrInstance?.recordId)
        ? groupOrInstance
        : null);
    const group = instance?.group || groupOrInstance;
    const patch = instance ? recordIdOrPatch : maybePatch;
    if (instance && maybePatch && typeof maybePatch === 'object' && 'now' in maybePatch) {
      context = maybePatch;
    }
    const recordId = instance
      ? instance.recordId || instance.record?.record_id
      : recordIdOrPatch;
    const table = await this.resolveTableConfig(group.weeklyInstanceTable, 'weeklyInstanceTable');
    assertTable(table, 'weeklyInstanceTable');
    if (!recordId) throw new Error('周报实例 record_id 为空，无法更新');

    const fields = buildWeeklyInstancePatchFields(table, patch, context);
    const res = await withBitableErrorContext('weeklyInstance.update', table, () => (
      this.client.bitable.appTableRecord.update({
        path: {
          app_token: table.appToken,
          table_id: table.tableId,
          record_id: recordId,
        },
        data: { fields },
      })
    ));
    return {
      updated: true,
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
  return {
    reporterNameText: normalizeFieldValue(existingFields[fields.reporterNameText]),
    memberOpenId: normalizeFieldValue(existingFields[fields.memberOpenId]) || reporter.id,
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
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
      const identity = contact?.teamMemberId
        ? buildFactKey({
          openId: contact.teamMemberId,
          name: contact.teamMember || raw.reporterName,
          reportDate,
        })
        : `unmatched:${raw.senderOpenId || ''}:${buildReporterDateIdentity(
          raw.reporterName,
          reportDate,
        )}`;
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

function collectDailyFactRebuildCandidate({
  rebuildGroups,
  targetByFactKey,
  targetBySourceIdentity,
  targetByReporterDate,
  weakGroupsByReporterDate,
  input,
}) {
  const reporterDateAlias = buildReporterDateIdentity(input.reporterName, input.reportDate);
  const factKeyRecord = targetByFactKey.get(input.factKey);
  const sourceIdentityRecord = targetBySourceIdentity.get(buildFactSourceIdentity(input));
  if (
    factKeyRecord?.record_id
    && sourceIdentityRecord?.record_id
    && factKeyRecord.record_id !== sourceIdentityRecord.record_id
  ) {
    return {
      conflict: {
        records: [factKeyRecord, sourceIdentityRecord],
      },
    };
  }
  const existingRecord = factKeyRecord || sourceIdentityRecord;
  const aliases = [
    existingRecord?.record_id ? `record:${existingRecord.record_id}` : '',
    input.factKey ? `fact:${input.factKey}` : '',
  ].filter(Boolean);
  const matchedGroups = [...new Set(aliases.map(alias => rebuildGroups.get(alias)).filter(Boolean))];
  const current = matchedGroups.shift() || {
    existingRecord,
    inputs: [],
    weakBridgeCount: 0,
  };
  for (const duplicate of matchedGroups) {
    if (!canMergeStrongRebuildGroups(current, duplicate)) continue;
    current.existingRecord ||= duplicate.existingRecord;
    current.inputs.push(...duplicate.inputs);
    current.weakBridgeCount += duplicate.weakBridgeCount || 0;
    replaceRebuildGroupReferences(
      duplicate,
      current,
      rebuildGroups,
      weakGroupsByReporterDate,
    );
  }
  current.existingRecord ||= existingRecord;
  current.inputs.push(input);
  for (const alias of aliases) {
    const aliasGroup = rebuildGroups.get(alias);
    if (!aliasGroup || aliasGroup === current) rebuildGroups.set(alias, current);
  }
  if (reporterDateAlias) {
    const weakGroups = weakGroupsByReporterDate.get(reporterDateAlias) || new Set();
    weakGroups.add(current);
    weakGroupsByReporterDate.set(reporterDateAlias, weakGroups);
  }
  return { group: current };
}

function buildStrongTargetConflictError(input) {
  return {
    source: 'reconciliation',
    code: 'strong_target_conflict',
    candidateSource: input.source,
    reportDate: input.reportDate,
    message: 'Fact key and source identity resolve to different fact records',
  };
}

function bridgeUnambiguousReporterDateGroups({
  reporterDateAlias,
  rebuildGroups,
  weakGroupsByReporterDate,
  targetByReporterDate,
}) {
  const groups = weakGroupsByReporterDate.get(reporterDateAlias);
  const existingRecords = targetByReporterDate.get(reporterDateAlias) || new Set();
  if (!groups || groups.size !== 2 || existingRecords.size > 1) return;

  const candidates = [...groups];
  const matchedGroups = candidates.filter(hasSingleMatchedMemberIdentity);
  const unmatchedGroups = candidates.filter(isSingleUnmatchedWeakGroup);
  if (matchedGroups.length !== 1 || unmatchedGroups.length !== 1) return;

  const matched = matchedGroups[0];
  const unmatched = unmatchedGroups[0];
  if (matched === unmatched || matched.weakBridgeCount > 0) return;
  const matchedRecordId = matched.existingRecord?.record_id || '';
  const onlyWeakRecordId = [...existingRecords][0]?.record_id || '';
  if (onlyWeakRecordId && onlyWeakRecordId !== matchedRecordId) return;

  matched.inputs.push(...unmatched.inputs);
  matched.weakBridgeCount += 1;
  replaceRebuildGroupReferences(
    unmatched,
    matched,
    rebuildGroups,
    weakGroupsByReporterDate,
  );
}

function hasSingleMatchedMemberIdentity(group) {
  const matchedIds = new Set(group.inputs
    .filter(input => input.contact && input.matchingStatus !== '未匹配')
    .map(input => String(input.memberOpenId || '').trim())
    .filter(Boolean));
  return matchedIds.size === 1;
}

function isSingleUnmatchedWeakGroup(group) {
  return !group.existingRecord
    && (group.weakBridgeCount || 0) === 0
    && group.inputs.length > 0
    && group.inputs.every(input => !input.contact || input.matchingStatus === '未匹配');
}

function canMergeStrongRebuildGroups(left, right) {
  const leftRecordId = left.existingRecord?.record_id || '';
  const rightRecordId = right.existingRecord?.record_id || '';
  if (leftRecordId && rightRecordId && leftRecordId !== rightRecordId) return false;

  const matchedIds = new Set([...left.inputs, ...right.inputs]
    .filter(input => input.contact && input.matchingStatus !== '未匹配')
    .map(input => String(input.memberOpenId || '').trim())
    .filter(Boolean));
  return matchedIds.size <= 1;
}

function replaceRebuildGroupReferences(
  previous,
  next,
  rebuildGroups,
  weakGroupsByReporterDate,
) {
  for (const [alias, rebuildGroup] of rebuildGroups.entries()) {
    if (rebuildGroup === previous) rebuildGroups.set(alias, next);
  }
  for (const groups of weakGroupsByReporterDate.values()) {
    if (!groups.delete(previous)) continue;
    groups.add(next);
  }
}

function consolidateDailyFactInputs(inputs, resolution) {
  const form = selectResolutionContributor(inputs, 'form', resolution);
  const chat = selectResolutionContributor(inputs, 'chat', resolution);
  const canonical = selectCanonicalTraceInput(inputs, resolution);
  const organization = selectCanonicalTraceInput(
    inputs.filter(input => input.contact && input.matchingStatus !== '未匹配'),
    resolution,
  ) || canonical;
  const sourceRefs = inputs.reduce((refs, input) => mergeSourceRefs(refs, buildSourceRefs({
    source: input.source,
    sourceRecordId: input.sourceRecordId,
    messageId: input.messageId,
  })), '');
  return {
    ...canonical,
    factKey: organization.factKey,
    reporterName: organization.reporterName,
    memberOpenId: organization.memberOpenId,
    project: organization.project,
    supervisor: organization.supervisor,
    supervisorOpenId: organization.supervisorOpenId,
    matchingStatus: organization.matchingStatus,
    matchMethod: organization.matchMethod,
    contact: organization.contact,
    formSourceRecordId: form?.sourceRecordId || '',
    chatMessageId: chat?.messageId || '',
    sourceRefs,
  };
}

function selectResolutionContributor(inputs, source, resolution) {
  return inputs
    .filter(input => !source || input.source === source)
    .sort((left, right) => compareResolutionContributors(left, right, resolution))
    .at(-1);
}

function selectCanonicalTraceInput(inputs, resolution) {
  return [...inputs].sort((left, right) => {
    const timeDifference = normalizeSourceTimestamp(left.sourceTime)
      - normalizeSourceTimestamp(right.sourceTime);
    if (timeDifference !== 0) return timeDifference;
    const contributionDifference = compareResolutionContributors(left, right, resolution);
    if (contributionDifference !== 0) return contributionDifference;
    if (left.source === right.source) return 0;
    return left.source === 'form' ? 1 : -1;
  }).at(-1);
}

function compareResolutionContributors(left, right, resolution) {
  const leftScore = buildResolutionContributionScore(left, resolution);
  const rightScore = buildResolutionContributionScore(right, resolution);
  const metadataDifference = leftScore.metadataMatches - rightScore.metadataMatches;
  if (metadataDifference !== 0) return metadataDifference;
  const selectedDifference = leftScore.selectedMatches - rightScore.selectedMatches;
  if (selectedDifference !== 0) return selectedDifference;
  const timeDifference = leftScore.sourceTime - rightScore.sourceTime;
  if (timeDifference !== 0) return timeDifference;
  if (leftScore.stableKey === rightScore.stableKey) return 0;
  return leftScore.stableKey > rightScore.stableKey ? 1 : -1;
}

function buildResolutionContributionScore(input, resolution) {
  const candidate = toDailyFactCandidate(input);
  let metadataMatches = 0;
  let selectedMatches = 0;
  // Prefer the input contributing the most final per-source fields, then final selected fields.
  for (const key of ['workItems', 'tomorrowPlanItems', 'riskItems']) {
    const value = candidate.values[key];
    if (!normalizeContentForFingerprint(value)) continue;
    const fingerprint = buildDailyFactFieldFingerprint(value);
    const fieldSource = resolution.fieldSources?.[key];
    const sourceMetadata = fieldSource?.sources?.[candidate.source];
    if (
      Number(sourceMetadata?.sourceTime) !== candidate.sourceTime
      || sourceMetadata?.fingerprint !== fingerprint
    ) {
      continue;
    }
    metadataMatches += 1;
    if (
      fieldSource.source === candidate.source
      && Number(fieldSource.sourceTime) === candidate.sourceTime
      && fieldSource.fingerprint === fingerprint
    ) {
      selectedMatches += 1;
    }
  }
  return {
    metadataMatches,
    selectedMatches,
    sourceTime: candidate.sourceTime,
    stableKey: JSON.stringify({
      source: candidate.source,
      values: ['workItems', 'tomorrowPlanItems', 'riskItems']
        .map(key => normalizeContentForFingerprint(candidate.values[key])),
      rawText: normalizeContentForFingerprint(input.rawText),
      senderOpenId: String(input.senderOpenId || ''),
      chatId: String(input.chatId || ''),
      reportType: String(input.reportType || ''),
      dateRange: String(input.dateRange || ''),
      messageTime: String(input.messageTime || ''),
      sourceRecordId: String(input.sourceRecordId || ''),
      messageId: String(input.messageId || ''),
    }),
  };
}

function buildDailyFactFieldFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(normalizeContentForFingerprint(value))
    .digest('hex');
}

function toDailyFactCandidate(input) {
  return {
    source: input.source,
    sourceTime: normalizeSourceTimestamp(input.sourceTime),
    matchingStatus: input.matchingStatus || '',
    values: normalizeDailyFactCandidateValues(input),
  };
}

function buildDailyFactRebuildCandidates(inputs, existingState) {
  const candidates = inputs.map(toDailyFactCandidate);
  if (!existingState) return candidates;

  for (const key of ['tomorrowPlanItems', 'riskItems']) {
    const rawChatCanRecoverField = candidates.some(candidate => (
      candidate.source === 'chat' && String(candidate.values?.[key] || '').trim()
    ));
    const snapshot = existingState.fieldSources?.[key];
    const value = existingState.values?.[key];
    if (
      rawChatCanRecoverField
      || snapshot?.source !== 'chat'
      || !String(value || '').trim()
    ) {
      continue;
    }

    candidates.push({
      source: 'chat',
      sourceTime: normalizeSourceTimestamp(snapshot.sourceTime),
      matchingStatus: existingState.matchingStatus || '',
      values: { [key]: value },
    });
  }
  return candidates;
}

function buildDailyFactFields(table, input, existing, options = {}) {
  const existingFields = existing?.fields || {};
  const fields = table.fields;
  const incomingValues = normalizeDailyFactCandidateValues(input);
  const incomingCandidate = {
    source: input.source,
    sourceTime: normalizeSourceTimestamp(input.sourceTime),
    matchingStatus: input.matchingStatus || '',
    values: incomingValues,
  };
  const existingResolution = existing ? readExistingDailyFactState(existingFields, fields) : null;
  const resolution = options.resolution || resolveDailyFactFields({
    existing: existingResolution,
    incoming: incomingCandidate,
  });
  const useIncomingCanonical = options.preserveCanonical !== true
    && (!existing || Object.keys(resolution.values).some(key => (
      String(resolution.values[key] || '').trim()
      && resolution.fieldSources[key]?.source === incomingCandidate.source
      && Number(resolution.fieldSources[key]?.sourceTime) === incomingCandidate.sourceTime
    )));
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
  const incomingRefs = input.sourceRefs || buildSourceRefs({
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
  setOrganizationProjectField({
    recordFields,
    table,
    contact: input.contact,
    organization,
    existingFields,
  });
  setMappedField(recordFields, table, 'reporterName', snapshot.reporterNameText, {
    senderOpenId: snapshot.memberOpenId,
    clearUser: !organization.matched && existingFields[fields.reporterName] !== undefined,
  });
  setMappedField(recordFields, table, 'reporterNameText', snapshot.reporterNameText);
  setMappedField(recordFields, table, 'memberOpenId', snapshot.memberOpenId);
  setCanonicalField(recordFields, 'senderOpenId', input.senderOpenId || input.memberOpenId || '');
  setMappedField(recordFields, table, 'workItems', resolution.values.workItems);
  setMappedField(recordFields, table, 'tomorrowPlanItems', resolution.values.tomorrowPlanItems);
  setMappedField(recordFields, table, 'riskItems', resolution.values.riskItems);
  setMappedField(recordFields, table, 'fieldSourceSnapshot', JSON.stringify(resolution.fieldSources));
  setMappedField(recordFields, table, 'contentFingerprint', buildContentFingerprint(resolution.values));
  setMappedField(recordFields, table, 'sourceTime', resolution.sourceTime);
  setMappedField(recordFields, table, 'source', resolution.observedSources);
  setMappedField(recordFields, table, 'sourceRecordId', input.formSourceRecordId
    || (input.source === 'form'
      ? input.sourceRecordId || ''
      : normalizeFieldValue(fields.sourceRecordId ? existingFields[fields.sourceRecordId] : '')
        || input.sourceRecordId || ''));
  setMappedField(recordFields, table, 'messageId', input.chatMessageId
    || (input.source === 'chat'
      ? input.messageId || ''
      : normalizeFieldValue(fields.messageId ? existingFields[fields.messageId] : '')));
  setMappedField(recordFields, table, 'sourceRefs', mergeSourceRefs(existingRefs, incomingRefs));
  setMappedField(recordFields, table, 'effectiveSource', resolution.effectiveSources);
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
  setMappedField(recordFields, table, 'matchingStatus', snapshot.matchingStatus);
  setMappedField(recordFields, table, 'matchMethod', snapshot.matchMethod);
  setCanonicalField(recordFields, 'reportType', input.reportType || '');
  setCanonicalField(recordFields, 'dateRange', input.dateRange || '');
  setCanonicalField(recordFields, 'messageTime', input.messageTime || '');
  setMappedField(recordFields, table, 'syncedAt', input.syncedAt || formatDateTime(new Date(), DEFAULT_TIMEZONE));
  return recordFields;
}

function readExistingDailyFactState(existingFields, fields) {
  const observedSources = normalizeFieldValue(fields.source ? existingFields[fields.source] : '');
  const effectiveSources = normalizeFieldValue(
    fields.effectiveSource ? existingFields[fields.effectiveSource] : '',
  ) || observedSources;
  return {
    values: readDailyFactBusinessValues(existingFields, fields),
    fieldSources: parseFieldSourceSnapshot(
      fields.fieldSourceSnapshot ? existingFields[fields.fieldSourceSnapshot] : '',
    ),
    observedSources,
    effectiveSources,
    source: observedSources,
    sourceTime: normalizeSourceTimestamp(fields.sourceTime ? existingFields[fields.sourceTime] : ''),
    matchingStatus: normalizeFieldValue(
      fields.matchingStatus ? existingFields[fields.matchingStatus] : '',
    ),
    factStatus: normalizeFieldValue(fields.factStatus ? existingFields[fields.factStatus] : ''),
    mergeStatus: normalizeFieldValue(fields.mergeStatus ? existingFields[fields.mergeStatus] : ''),
    conflictStatus: normalizeFieldValue(
      fields.conflictStatus ? existingFields[fields.conflictStatus] : '',
    ),
    autoResolutionNote: normalizeFieldValue(
      fields.autoResolutionNote ? existingFields[fields.autoResolutionNote] : '',
    ),
  };
}

function readDailyFactBusinessValues(existingFields, fields) {
  return {
    workItems: normalizeFieldValue(fields.workItems ? existingFields[fields.workItems] : ''),
    tomorrowPlanItems: normalizeFieldValue(
      fields.tomorrowPlanItems ? existingFields[fields.tomorrowPlanItems] : '',
    ),
    riskItems: normalizeFieldValue(fields.riskItems ? existingFields[fields.riskItems] : ''),
  };
}

function preserveExistingNonEmptyFactValues(resolution, existingState) {
  if (!existingState) return resolution;
  const preservedKeys = Object.keys(existingState.values).filter(key => (
    !String(resolution.values[key] || '').trim()
    && String(existingState.values[key] || '').trim()
  ));
  if (!preservedKeys.length) return resolution;

  const fallback = initializeExistingFactProvenance(existingState);
  const values = { ...resolution.values };
  const fieldSources = { ...resolution.fieldSources };
  for (const key of preservedKeys) {
    values[key] = fallback.values[key];
    fieldSources[key] = fallback.fieldSources[key];
  }
  const observedSources = joinDailyFactSources(
    resolution.observedSources,
    fallback.observedSources,
  );
  const effectiveSources = joinDailyFactSources(
    ...Object.keys(values)
      .filter(key => String(values[key] || '').trim())
      .flatMap(key => [
        fieldSources[key]?.source,
        fieldSources[key]?.ambiguous ? existingState.effectiveSources : '',
      ]),
  );
  const sourceTime = Math.max(
    0,
    ...Object.keys(values)
      .filter(key => String(values[key] || '').trim())
      .map(key => Number(fieldSources[key]?.sourceTime) || 0),
  );
  const preservesConflict = existingState.conflictStatus === '已自动处理';
  const conflictStatus = preservesConflict || resolution.conflictStatus === '已自动处理'
    ? '已自动处理'
    : '无冲突';
  return {
    ...resolution,
    values,
    fieldSources,
    observedSources,
    effectiveSources,
    sourceTime,
    mergeStatus: derivePersistedMergeStatus({
      observedSources,
      values,
      fieldSources,
      conflictStatus,
      existingMergeStatus: existingState.mergeStatus,
    }),
    conflictStatus,
    factStatus: existingState.factStatus === '忽略' ? '忽略' : resolution.factStatus,
    autoResolutionNote: preservesConflict
      ? existingState.autoResolutionNote || resolution.autoResolutionNote
      : resolution.autoResolutionNote,
  };
}

function derivePersistedMergeStatus({
  observedSources,
  values,
  fieldSources,
  conflictStatus,
  existingMergeStatus,
}) {
  if (String(observedSources || '').split('+').filter(Boolean).length <= 1) return '单来源';
  if (conflictStatus === '已自动处理') return '按字段取最新';
  const populatedSources = Object.keys(values)
    .filter(key => String(values[key] || '').trim())
    .map(key => fieldSources[key]);
  if (populatedSources.some(source => source?.ambiguous)) {
    return ['重复已合并', '互补已合并'].includes(existingMergeStatus)
      ? existingMergeStatus
      : '重复已合并';
  }
  const knownSources = new Set(
    populatedSources.flatMap(source => Object.keys(source?.sources || {})),
  );
  return knownSources.has('form')
    && knownSources.has('chat')
    && populatedSources.some(source => Object.keys(source?.sources || {}).length === 1)
    ? '互补已合并'
    : '重复已合并';
}

function initializeExistingFactProvenance(existingState) {
  const source = firstDailyFactSource(
    existingState.effectiveSources || existingState.observedSources,
  ) || 'form';
  return resolveDailyFactFields({
    existing: existingState,
    incoming: {
      source,
      sourceTime: existingState.sourceTime,
      matchingStatus: existingState.matchingStatus,
      values: {
        workItems: '',
        tomorrowPlanItems: '',
        riskItems: '',
      },
    },
  });
}

function firstDailyFactSource(value) {
  if (sourceHas(value, 'form')) return 'form';
  if (sourceHas(value, 'chat')) return 'chat';
  return '';
}

function joinDailyFactSources(...values) {
  const found = new Set(
    values.flatMap(value => String(value || '').split('+'))
      .filter(source => source === 'form' || source === 'chat'),
  );
  return ['form', 'chat'].filter(source => found.has(source)).join('+');
}

function hasUsableFieldSourceSnapshot(existingFields, fields) {
  if (!fields.fieldSourceSnapshot) return true;
  const snapshot = parseFieldSourceSnapshot(existingFields[fields.fieldSourceSnapshot]);
  return ['workItems', 'tomorrowPlanItems', 'riskItems']
    .some(key => snapshot[key] && typeof snapshot[key] === 'object');
}

function buildExistingFactMigrationInput(existingRecord, fields) {
  const existingFields = existingRecord.fields || {};
  const effectiveSource = normalizeFieldValue(
    fields.effectiveSource ? existingFields[fields.effectiveSource] : '',
  );
  const observedSource = normalizeFieldValue(fields.source ? existingFields[fields.source] : '');
  return {
    factKey: normalizeFieldValue(fields.factKey ? existingFields[fields.factKey] : ''),
    reportDate: normalizeDateFieldValue(fields.reportDate ? existingFields[fields.reportDate] : ''),
    source: firstDailyFactSource(effectiveSource || observedSource) || 'form',
    sourceTime: normalizeSourceTimestamp(fields.sourceTime ? existingFields[fields.sourceTime] : ''),
    matchingStatus: normalizeFieldValue(
      fields.matchingStatus ? existingFields[fields.matchingStatus] : '',
    ),
    values: {
      workItems: '',
      tomorrowPlanItems: '',
      riskItems: '',
    },
  };
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
    'reportDate',
    'periodStart',
    'periodEnd',
    'weekStart',
    'weekEnd',
    'spreadsheetToken',
    'sheetId',
    'sheetTitle',
    'sheetUrl',
    'status',
    'aiInitialAt',
    'aiRefreshAt',
    'aiDraftSnapshot',
    'aiEvidenceSnapshot',
    'aiGenerationStatus',
    'ownerNotificationStatus',
    'ownerNotificationDetails',
    'ownerNotificationAt',
    'coreMetricReminderDetails',
    'posterImageKey',
    'posterStatus',
    'posterSentAt',
    'smallTeamPushStatus',
    'smallTeamPushDetails',
    'lastErrorSummary',
  ]) {
    const fieldContext = key === 'sheetUrl'
      ? { ...context, urlText: instance.sheetTitle || instance.sheetUrl }
      : context;
    setMappedField(recordFields, table, key, serializeWeeklyInstanceValue(key, instance[key]), fieldContext);
  }
  const now = context.now || new Date();
  if (!context.existing) {
    setMappedField(recordFields, table, 'createdAt', now.getTime(), context);
  }
  setMappedField(recordFields, table, 'updatedAt', now.getTime(), context);
  return recordFields;
}

function buildWeeklyInstancePatchFields(table, patch = {}, context = {}) {
  const recordFields = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(table.fields || {}, key)) continue;
    setMappedField(recordFields, table, key, serializeWeeklyInstanceValue(key, value), context);
  }
  setMappedField(recordFields, table, 'updatedAt', (context.now || new Date()).getTime(), context);
  return recordFields;
}

function serializeWeeklyInstanceValue(key, value) {
  if (value == null) return value;
  if (key.endsWith('At') && value instanceof Date) return value.getTime();
  if (key.endsWith('Snapshot') || key.endsWith('Details')) {
    return typeof value === 'string' ? value : stableJson(value);
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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

function normalizeDailyFactCandidateValues(input = {}) {
  const values = input.values || {};
  return {
    workItems: normalizeCandidateText(
      values.workItems ?? input.workSummaryText ?? input.workItems,
    ),
    tomorrowPlanItems: normalizeCandidateText(
      values.tomorrowPlanItems ?? input.tomorrowPlanItems,
    ),
    riskItems: normalizeCandidateText(values.riskItems ?? input.riskItems),
  };
}

function normalizeCandidateText(value) {
  if (Array.isArray(value)) return value.join('\n');
  return value == null ? '' : String(value);
}

function parseFieldSourceSnapshot(value) {
  const text = normalizeFieldValue(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function setOrganizationProjectField({
  recordFields,
  table,
  contact,
  organization,
  existingFields,
}) {
  const fieldName = table?.fields?.project;
  if (!fieldName) return;
  const existingValue = existingFields[fieldName];
  const contactTeamName = String(contact?.teamName || '').trim();
  if (organization.source === 'contact' && contactTeamName) {
    setMappedField(recordFields, table, 'project', contactTeamName);
  } else if (existingValue !== undefined) {
    recordFields[fieldName] = existingValue;
  }
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
  // Form creator and lookup columns are read-only in Feishu Base. They are
  // derived from the submitted record/contact mapping and must not be sent in
  // create/update payloads when the form table is used as a fallback target.
  if (fieldType === 'createdBy' || fieldType === 'lookup') return undefined;

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
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
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

function indexFactRecordsByReporterDate(records, fields) {
  const index = new Map();
  for (const record of records || []) {
    const reporter = normalizePersonValue(record.fields?.[fields.reporterName]);
    const reporterName = normalizeFieldValue(record.fields?.[fields.reporterNameText])
      || reporter.name;
    const reportDate = normalizeDateFieldValue(record.fields?.[fields.reportDate]);
    const identity = buildReporterDateIdentity(reporterName, reportDate);
    if (!identity) continue;
    const matches = index.get(identity) || new Set();
    matches.add(record);
    index.set(identity, matches);
  }
  return index;
}

function buildReporterDateIdentity(reporterName, reportDate) {
  const normalizedName = String(reporterName || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
  const date = String(reportDate || '').trim();
  return normalizedName && date ? `${normalizedName}:${date}` : '';
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
