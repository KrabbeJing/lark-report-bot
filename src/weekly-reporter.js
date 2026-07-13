import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkWeekRange } from './date-utils.js';
import { buildWeeklyAiInputs } from './ai-input-normalizer.js';
import { WEEKLY_FIELD_KEYS, tableIsConfigured } from './config.js';
import { normalizeFieldValue } from './bitable-service.js';
import { renderWeeklySummaryToPng } from './render-weekly.js';
import { buildWeeklySheetValues } from './weekly-sheet-content.js';
import { buildWeeklySheetUrl, WeeklySheetWriter } from './weekly-sheet-writer.js';
import { ensureWeeklyInstanceForGroup } from './weekly-instance-service.js';

export async function generateWeeklyReportForGroup({
  group,
  bitable,
  aiProvider,
  messenger,
  outDir,
  timezone = 'Asia/Shanghai',
  now = new Date(),
  delivery = 'send',
  replyMessageId = '',
  sheetWriter = null,
  client = null,
}) {
  const { start: weekStart, end: weekEnd } = getWorkWeekRange(now, timezone);

  if (delivery === 'send') {
    const existing = await getExistingSentSummary(bitable, group, weekStart);
    if (existing) {
      console.log(`[weekly] already sent for ${group.project} ${weekStart}; skip`);
      return { skipped: true, reason: 'already_sent', weekStart, weekEnd };
    }
  }

  const preparedWeeklySheet = group.weeklySheet?.enabled
    ? await prepareWeeklySheetForGroup({ group, bitable, sheetWriter, client, now, timezone })
    : null;

  const factReports = await listReportsForWeeklyOutput(bitable, group, weekStart, weekEnd);
  const reports = buildWeeklyAiInputs(factReports);
  const summary = await aiProvider.summarizeWeeklyReports({
    group,
    reports,
    weekStart,
    weekEnd,
    generatedAt: now,
  });

  if (preparedWeeklySheet) {
    return generateWeeklySheetForGroup({
      group,
      reports,
      summary,
      bitable,
      aiProvider,
      messenger,
      timezone,
      now,
      delivery,
      replyMessageId,
      weekStart,
      weekEnd,
      ...preparedWeeklySheet,
    });
  }

  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `weekly-${safeName(group.chatId || group.project)}-${weekStart}.jpg`);
  await renderWeeklySummaryToPng(summary, outPath, { timezone });
  const imageKey = await messenger.uploadImage(outPath);

  if (delivery === 'reply') {
    await messenger.replyImage(replyMessageId, imageKey);
  } else {
    await messenger.sendImage(group.pushChatId || group.chatId, imageKey, `weekly-${group.chatId}-${weekStart}`);
  }

  await bitable.upsertWeeklySummary(group, summary, {
    imageKey,
    pushStatus: delivery === 'reply' ? 'manual_sent' : 'sent',
    pushedAt: now,
    timezone,
  });

  return {
    skipped: false,
    summary,
    imageKey,
    outPath,
  };
}

async function generateWeeklySheetForGroup({
  group,
  reports,
  summary,
  bitable,
  aiProvider,
  messenger,
  timezone,
  now,
  delivery,
  replyMessageId,
  weekStart,
  weekEnd,
  writer,
  weeklyInstance,
}) {
  const sheet = weeklyInstance.sheet;
  const effectiveSheetConfig = {
    ...group.weeklySheet,
    spreadsheetToken: sheet.spreadsheetToken,
  };
  const cellMap = weeklyInstance.targets;
  const sheetContent = typeof aiProvider.summarizeWeeklySheet === 'function'
    ? await aiProvider.summarizeWeeklySheet({
      group,
      reports,
      summary,
      weekStart,
      weekEnd,
      generatedAt: now,
      cellMap,
    })
    : buildWeeklySheetValues({
      group,
      reports,
      summary,
      weekStart,
      weekEnd,
      cellMap,
    });

  const writeResult = await writer.writeCells(effectiveSheetConfig, sheet.sheetId, sheetContent.values);
  const sheetUrl = resolveWeeklySheetUrl(
    weeklyInstance.instance?.sheetUrl,
    effectiveSheetConfig,
    sheet.sheetId,
  );

  await bitable.upsertWeeklySummary(group, summary, {
    imageKey: '',
    pushStatus: delivery === 'reply' ? 'manual_sent' : 'sent',
    pushedAt: now,
    timezone,
  });

  const skippedPush = delivery === 'send'
    && sheet.reused
    && group.weeklySheet.skipPushIfExisting !== false;

  if (skippedPush) {
    console.log(`[weekly-sheet] existing sheet reused for ${group.project} ${weekStart}; skip push`);
  } else if (delivery === 'reply') {
    await messenger.replyText(replyMessageId, buildWeeklySheetMessage(group, summary, sheet, sheetUrl));
  } else {
    await messenger.sendText(
      group.pushChatId || group.chatId,
      buildWeeklySheetMessage(group, summary, sheet, sheetUrl),
      `weekly-sheet-${group.chatId}-${weekStart}`,
    );
  }

  return {
    skipped: skippedPush,
    reason: skippedPush ? 'weekly_sheet_exists' : undefined,
    summary,
    sheet,
    sheetContent,
    writeResult,
    sheetUrl,
  };
}

async function prepareWeeklySheetForGroup({ group, bitable, sheetWriter, client, now, timezone }) {
  const writer = sheetWriter || (client ? new WeeklySheetWriter(client) : null);
  if (!writer) {
    throw new Error('weeklySheet 已启用，但未提供 sheetWriter/client');
  }
  if (!tableIsConfigured(group.weeklyInstanceTable)) {
    throw new Error('weeklySheet 已启用，但 weeklyInstanceTable 未配置，禁止写入未登记工作表');
  }

  const weeklyInstance = await ensureWeeklyInstanceForGroup({
    group,
    bitable,
    sheetWriter: writer,
    now,
    timezone,
  });
  if (weeklyInstance.skipped || !hasCompleteWeeklySheet(weeklyInstance.sheet)) {
    throw new Error('weeklySheet 实例不可用，禁止写入未登记工作表');
  }
  const effectiveSheetConfig = {
    ...group.weeklySheet,
    spreadsheetToken: weeklyInstance.sheet.spreadsheetToken,
  };
  const targets = weeklyInstance.targets || await writer.discoverTemplateTargets(
    effectiveSheetConfig,
    weeklyInstance.sheet.sheetId,
    { aliasMap: group.weeklySheet.entityAliases },
  );
  return { writer, weeklyInstance: { ...weeklyInstance, targets } };
}

async function listReportsForWeeklyOutput(bitable, group, weekStart, weekEnd) {
  if (group.weeklySheet?.enabled && group.weeklySheet.reportScope === 'allDailyTable') {
    if (typeof bitable.listAllDailyReportsForRange === 'function') {
      return bitable.listAllDailyReportsForRange(group, weekStart, weekEnd);
    }
    console.warn('[weekly-sheet] bitable.listAllDailyReportsForRange missing; fallback to group reports');
  }
  return bitable.listDailyReportsForWeek(group, weekStart, weekEnd);
}

function buildWeeklySheetMessage(group, summary, sheet, sheetUrl) {
  return [
    `${group.project || '项目组'}周报已生成：${sheet.title}`,
    `周期：${summary.weekStart} 至 ${summary.weekEnd}`,
    `日报：${summary.reportCount} 份，成员：${summary.memberCount} 人`,
    sheetUrl,
  ].join('\n');
}

function resolveWeeklySheetUrl(instanceSheetUrl, sheetConfig, sheetId) {
  if (isCurrentSheetUrl(instanceSheetUrl, sheetConfig, sheetId)) return instanceSheetUrl;
  return buildWeeklySheetUrl(sheetConfig, sheetId);
}

function hasCompleteWeeklySheet(sheet) {
  return Boolean(String(sheet?.spreadsheetToken || '').trim() && String(sheet?.sheetId || '').trim());
}

function isCurrentSheetUrl(value, sheetConfig, sheetId) {
  if (!value || !sheetId) return false;
  try {
    const persisted = new URL(value);
    const expected = new URL(buildWeeklySheetUrl(sheetConfig, sheetId));
    const sheetQueries = persisted.searchParams.getAll('sheet');
    return persisted.protocol === 'https:'
      && persisted.username === ''
      && persisted.password === ''
      && persisted.origin === expected.origin
      && persisted.pathname === expected.pathname
      && sheetQueries.length === 1
      && sheetQueries[0] === String(sheetId);
  } catch {
    return false;
  }
}

async function getExistingSentSummary(bitable, group, weekStart) {
  const existing = await bitable.findWeeklySummaryRecord(group, weekStart);
  if (!existing) return null;
  const fields = group.weeklyTable?.fields || WEEKLY_FIELD_KEYS;
  const status = normalizeFieldValue(existing.fields?.[fields.pushStatus]);
  return status === 'sent' ? existing : null;
}

function safeName(value) {
  return String(value || 'group').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
}
