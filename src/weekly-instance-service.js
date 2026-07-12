import { tableIsConfigured } from './config.js';
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
    return {
      skipped: false,
      reused: true,
      instanceKey,
      record: existing,
    };
  }

  const sheet = await retryOperation(
    () => sheetWriter.ensureWeeklySheet(group.weeklySheet, { weekStart, weekEnd }),
    { attempts: 3, delayMs: retryDelayMs },
  );
  const effectiveConfig = {
    ...group.weeklySheet,
    spreadsheetToken: sheet.spreadsheetToken || group.weeklySheet.spreadsheetToken,
  };
  const targets = await sheetWriter.discoverTemplateTargets(
    effectiveConfig,
    sheet.sheetId,
    { aliasMap: group.weeklySheet.entityAliases },
  );
  await sheetWriter.writeCells(effectiveConfig, sheet.sheetId, {
    [targets.reportPeriod]: `${weekStart} 至 ${weekEnd}`,
  });

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
  const persisted = await bitable.upsertWeeklyInstance(group, instance, { now, timezone });
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
