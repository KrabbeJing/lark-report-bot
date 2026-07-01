import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkWeekRange } from './date-utils.js';
import { WEEKLY_FIELD_KEYS } from './config.js';
import { normalizeFieldValue } from './bitable-service.js';
import { renderWeeklySummaryToPng } from './render-weekly.js';
import { buildWeeklySheetValues } from './weekly-sheet-content.js';
import { buildWeeklySheetUrl, WeeklySheetWriter } from './weekly-sheet-writer.js';

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

  const reports = await listReportsForWeeklyOutput(bitable, group, weekStart, weekEnd);
  const summary = await aiProvider.summarizeWeeklyReports({
    group,
    reports,
    weekStart,
    weekEnd,
    generatedAt: now,
  });

  if (group.weeklySheet?.enabled) {
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
      sheetWriter,
      client,
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
  sheetWriter,
  client,
}) {
  const writer = sheetWriter || (client ? new WeeklySheetWriter(client) : null);
  if (!writer) {
    throw new Error('weeklySheet 已启用，但未提供 sheetWriter/client');
  }

  const sheet = await writer.ensureWeeklySheet(group.weeklySheet, { weekStart, weekEnd });
  const effectiveSheetConfig = {
    ...group.weeklySheet,
    spreadsheetToken: sheet.spreadsheetToken || group.weeklySheet.spreadsheetToken,
  };
  const sheetContent = typeof aiProvider.summarizeWeeklySheet === 'function'
    ? await aiProvider.summarizeWeeklySheet({
      group,
      reports,
      summary,
      weekStart,
      weekEnd,
      generatedAt: now,
      cellMap: group.weeklySheet.cellMap,
    })
    : buildWeeklySheetValues({
      group,
      reports,
      summary,
      weekStart,
      weekEnd,
      cellMap: group.weeklySheet.cellMap,
    });

  const writeResult = await writer.writeCells(effectiveSheetConfig, sheet.sheetId, sheetContent.values);
  const sheetUrl = buildWeeklySheetUrl(effectiveSheetConfig, sheet.sheetId);

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
