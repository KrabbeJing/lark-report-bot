import { WEEKLY_INSTANCE_FIELD_KEYS, getReportingUnits, tableIsConfigured } from './config.js';
import {
  formatNaturalWeekPeriod,
  getIsoWeekInfo,
  getWeeklyReportRange,
  getWorkWeekRangeForYmd,
} from './date-utils.js';
import { buildWeeklySheetUrl } from './weekly-sheet-writer.js';

export async function ensureWeeklyInstanceForGroup({
  group,
  bitable,
  sheetWriter,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  retryDelayMs = 1000,
}) {
  if (!group.weeklySheet?.enabled) {
    return { skipped: true, reason: 'weekly_sheet_disabled' };
  }
  if (!tableIsConfigured(group.weeklyInstanceTable)) {
    return { skipped: true, reason: 'weekly_instance_table_not_configured' };
  }

  const { reportDate, start: periodStart, end: periodEnd } = getWeeklyReportRange(now, timezone);
  const { start: weekStart, end: weekEnd } = getWorkWeekRangeForYmd(reportDate);
  const { isoYear, isoWeek, key: instanceKey } = getIsoWeekInfo(reportDate);
  const existing = await runWeeklyStage('find_existing_instance', () => (
    bitable.findWeeklyInstanceRecord(group, instanceKey)
  ));
  if (existing) {
    const resolvedConfig = await runWeeklyStage('resolve_workbook', () => (
      resolveWeeklySheetConfig(sheetWriter, group.weeklySheet)
    ));
    const instance = {
      ...readWeeklyInstanceRecord(existing, group.weeklyInstanceTable),
      group,
      sheetConfig: resolvedConfig,
      recordId: existing.record_id,
    };
    await runWeeklyStage('validate_reused_instance', () => {
      assertReusableWeeklyInstance(instance, resolvedConfig);
    });
    const targets = await runWeeklyStage('validate_reused_sheet', () => sheetWriter.discoverTemplateTargets(
      resolvedConfig,
      instance.sheetId,
      { aliasMap: group.weeklySheet.entityAliases },
    ));
    return {
      skipped: false,
      reused: true,
      instanceKey,
      record: existing,
      instance,
      sheet: {
        spreadsheetToken: resolvedConfig.spreadsheetToken,
        sheetId: instance.sheetId,
        title: instance.sheetTitle,
        reused: true,
        created: false,
      },
      targets,
    };
  }

  const sheet = await runWeeklyStage('copy_sheet', () => retryOperation(
    () => sheetWriter.ensureWeeklySheet(group.weeklySheet, {
      reportDate,
      weekStart,
      weekEnd,
    }),
    { attempts: 3, delayMs: retryDelayMs },
  ));
  const effectiveConfig = {
    ...group.weeklySheet,
    spreadsheetToken: sheet.spreadsheetToken || group.weeklySheet.spreadsheetToken,
  };
  await runWeeklyStage('move_sheet', () => sheetWriter.moveSheet(effectiveConfig, sheet.sheetId, 0));
  const targets = await runWeeklyStage('locate_template', () => sheetWriter.discoverTemplateTargets(
    effectiveConfig,
    sheet.sheetId,
    { aliasMap: group.weeklySheet.entityAliases },
  ));
  await runWeeklyStage('write_period', () => sheetWriter.writeCells(effectiveConfig, sheet.sheetId, {
    [targets.reportPeriod]: formatNaturalWeekPeriod(weekStart, weekEnd),
  }));

  const instance = {
    instanceKey,
    isoYear,
    isoWeek,
    reportDate,
    periodStart,
    periodEnd,
    weekStart,
    weekEnd,
    spreadsheetToken: effectiveConfig.spreadsheetToken,
    sheetId: sheet.sheetId,
    sheetTitle: sheet.title,
    sheetUrl: buildWeeklySheetUrl(effectiveConfig, sheet.sheetId),
    status: '已创建',
    group,
    sheetConfig: effectiveConfig,
  };
  const persisted = await runWeeklyStage('write_instance_base', () => (
    bitable.upsertWeeklyInstance(group, instance, { now, timezone })
  ));
  if (persisted?.record?.record_id) instance.recordId = persisted.record.record_id;
  return {
    skipped: false,
    reused: sheet.reused,
    instanceKey,
    sheet,
    targets,
    instance,
    persisted,
  };
}

export async function loadWeeklyInstanceForGroup({
  group,
  bitable,
  sheetWriter,
  now = new Date(),
  timezone = 'Asia/Shanghai',
}) {
  if (!group.weeklySheet?.enabled) {
    throw new Error('weekly_sheet_disabled');
  }
  if (!tableIsConfigured(group.weeklyInstanceTable)) {
    throw new Error('weekly_instance_table_not_configured');
  }

  const { reportDate } = getWeeklyReportRange(now, timezone);
  const { key: instanceKey } = getIsoWeekInfo(reportDate);
  const existing = await runWeeklyStage('load_existing_instance', () => (
    bitable.findWeeklyInstanceRecord(group, instanceKey)
  ));
  if (!existing) {
    const error = new Error(`周报实例不存在：${instanceKey}`);
    error.weeklyInstanceStage = 'load_existing_instance';
    throw error;
  }

  const resolvedConfig = await runWeeklyStage('resolve_workbook', () => (
    resolveWeeklySheetConfig(sheetWriter, group.weeklySheet)
  ));
  const instance = {
    ...readWeeklyInstanceRecord(existing, group.weeklyInstanceTable),
    group,
    sheetConfig: resolvedConfig,
    recordId: existing.record_id,
  };
  await runWeeklyStage('validate_reused_instance', () => {
    assertReusableWeeklyInstance(instance, resolvedConfig);
  });
  const targets = await runWeeklyStage('validate_reused_sheet', () => sheetWriter.discoverTemplateTargets(
    resolvedConfig,
    instance.sheetId,
    { aliasMap: group.weeklySheet.entityAliases },
  ));
  return { ...instance, targets };
}

async function resolveWeeklySheetConfig(sheetWriter, sheetConfig) {
  if (typeof sheetWriter.resolveSheetConfig === 'function') {
    return sheetWriter.resolveSheetConfig(sheetConfig);
  }
  return sheetConfig;
}

function assertReusableWeeklyInstance(instance, sheetConfig) {
  const persistedToken = String(instance.spreadsheetToken || '').trim();
  const configuredToken = String(sheetConfig?.spreadsheetToken || '').trim();
  const sheetId = String(instance.sheetId || '').trim();
  if (!persistedToken || !configuredToken || !sheetId || persistedToken !== configuredToken) {
    throw new Error('Base 周报实例与当前工作簿配置不一致或缺少工作表标识');
  }
}

function readWeeklyInstanceRecord(record, table) {
  const fields = { ...WEEKLY_INSTANCE_FIELD_KEYS, ...table?.fields };
  const value = key => normalizeInstanceValue(record?.fields?.[fields[key]]);
  return {
    instanceKey: value('instanceKey'),
    isoYear: value('isoYear'),
    isoWeek: value('isoWeek'),
    reportDate: value('reportDate') || value('weekEnd'),
    periodStart: value('periodStart') || value('weekStart'),
    periodEnd: value('periodEnd') || value('weekEnd'),
    weekStart: value('weekStart') || value('periodStart'),
    weekEnd: value('weekEnd') || value('periodEnd'),
    spreadsheetToken: value('spreadsheetToken'),
    sheetId: value('sheetId'),
    sheetTitle: value('sheetTitle'),
    sheetUrl: normalizeInstanceUrl(record?.fields?.[fields.sheetUrl]),
    status: value('status'),
    aiInitialAt: value('aiInitialAt'),
    aiRefreshAt: value('aiRefreshAt'),
    aiDraftSnapshot: parseJsonValue(record?.fields?.[fields.aiDraftSnapshot]),
    aiEvidenceSnapshot: parseJsonValue(record?.fields?.[fields.aiEvidenceSnapshot]),
    aiGenerationStatus: value('aiGenerationStatus'),
    ownerNotificationStatus: value('ownerNotificationStatus'),
    ownerNotificationDetails: parseJsonValue(record?.fields?.[fields.ownerNotificationDetails]),
    ownerNotificationAt: value('ownerNotificationAt'),
    coreMetricReminderDetails: parseJsonValue(record?.fields?.[fields.coreMetricReminderDetails]),
    posterImageKey: value('posterImageKey'),
    posterStatus: value('posterStatus'),
    posterSentAt: value('posterSentAt'),
    smallTeamPushStatus: value('smallTeamPushStatus'),
    smallTeamPushDetails: parseJsonValue(record?.fields?.[fields.smallTeamPushDetails]),
    lastErrorSummary: value('lastErrorSummary'),
  };
}

function parseJsonValue(value) {
  const text = normalizeInstanceValue(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeInstanceValue(value) {
  if (Array.isArray(value)) return normalizeInstanceValue(value[0]);
  if (value && typeof value === 'object') return value.text || value.name || value.id || '';
  return String(value || '').trim();
}

function normalizeInstanceUrl(value) {
  if (value && typeof value === 'object') return String(value.link || value.url || value.text || '').trim();
  return normalizeInstanceValue(value);
}

async function runWeeklyStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    error.weeklyInstanceStage = stage;
    throw error;
  }
}

export async function ensureWeeklyInstancesForAllGroups({
  config,
  bitable,
  sheetWriter,
  now = new Date(),
}) {
  const results = [];
  for (const group of getReportingUnits(config)) {
    try {
      results.push({
        group: group.name || group.project || group.chatId,
        ...(await ensureWeeklyInstanceForGroup({
          group,
          bitable,
          sheetWriter,
          now,
          timezone: config.weeklyInstanceCreation?.timezone || config.timezone,
        })),
      });
    } catch (error) {
      results.push({
        group: group.name || group.project || group.chatId,
        skipped: false,
        error,
      });
    }
  }
  return results;
}

async function retryOperation(operation, { attempts, delayMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
