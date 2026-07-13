import { WEEKLY_INSTANCE_FIELD_KEYS, tableIsConfigured } from './config.js';
import { getIsoWeekInfo, getWorkWeekRange } from './date-utils.js';
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

  const { start: weekStart, end: weekEnd } = getWorkWeekRange(now, timezone);
  const { isoYear, isoWeek, key: instanceKey } = getIsoWeekInfo(weekStart);
  const existing = await bitable.findWeeklyInstanceRecord(group, instanceKey);
  if (existing) {
    const instance = readWeeklyInstanceRecord(existing, group.weeklyInstanceTable);
    return {
      skipped: false,
      reused: true,
      instanceKey,
      record: existing,
      instance,
      sheet: {
        spreadsheetToken: instance.spreadsheetToken,
        sheetId: instance.sheetId,
        title: instance.sheetTitle,
        reused: true,
        created: false,
      },
    };
  }

  const sheet = await runWeeklyStage('copy_sheet', () => retryOperation(
    () => sheetWriter.ensureWeeklySheet(group.weeklySheet, { weekStart, weekEnd }),
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
    [targets.reportPeriod]: `${weekStart} 至 ${weekEnd}`,
  }));

  const instance = {
    instanceKey,
    isoYear,
    isoWeek,
    weekStart,
    weekEnd,
    spreadsheetToken: effectiveConfig.spreadsheetToken,
    sheetId: sheet.sheetId,
    sheetTitle: sheet.title,
    sheetUrl: buildWeeklySheetUrl(effectiveConfig, sheet.sheetId),
    status: '已创建',
  };
  const persisted = await runWeeklyStage('write_instance_base', () => (
    bitable.upsertWeeklyInstance(group, instance, { now, timezone })
  ));
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

function readWeeklyInstanceRecord(record, table) {
  const fields = { ...WEEKLY_INSTANCE_FIELD_KEYS, ...table?.fields };
  const value = key => normalizeInstanceValue(record?.fields?.[fields[key]]);
  return {
    instanceKey: value('instanceKey'),
    isoYear: value('isoYear'),
    isoWeek: value('isoWeek'),
    weekStart: value('weekStart'),
    weekEnd: value('weekEnd'),
    spreadsheetToken: value('spreadsheetToken'),
    sheetId: value('sheetId'),
    sheetTitle: value('sheetTitle'),
    sheetUrl: normalizeInstanceUrl(record?.fields?.[fields.sheetUrl]),
    status: value('status'),
  };
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
  for (const group of config.groups) {
    try {
      results.push({
        group: group.project || group.chatId,
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
        group: group.project || group.chatId,
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
