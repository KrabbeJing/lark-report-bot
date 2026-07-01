import { tableIsConfigured, findGroupByChatId } from './config.js';
import { formatDateTime, coerceLarkTimestamp } from './date-utils.js';
import { parseDailyReportText } from './daily-report-parser.js';
import { generateWeeklyReportForGroup } from './weekly-reporter.js';
import { getMessageText, getSenderOpenId, isMentionedBot, isWeeklyCommand, stripBotMentions } from './message-utils.js';
import { extractSheetRef, handleSheetPosterRequest } from './sheet-poster.js';

export async function handleMessageEvent({
  data,
  client,
  messenger,
  bitable,
  config,
  aiProvider,
  sheetWriter,
  outDir,
}) {
  const { message } = data;
  const text = getMessageText(message);
  if (!text.trim()) return;

  if (extractSheetRef(text)) {
    await handleSheetPosterRequest({ client, messenger, message, text, outDir });
    return;
  }

  const mentioned = isMentionedBot(message, config.botNames);
  const group = findGroupByChatId(config, message.chat_id);

  if (isWeeklyCommand(text, message, config.botNames)) {
    if (!group) {
      await messenger.replyText(message.message_id, '当前群还没有配置项目组和多维表格，暂时无法生成周报。');
      return;
    }
    await ensureGroupTables(group);
    await messenger.replyText(message.message_id, '正在汇总本周日报并生成周报...');
    await generateWeeklyReportForGroup({
      group,
      bitable,
      aiProvider,
      messenger,
      outDir,
      timezone: config.timezone,
      now: new Date(),
      delivery: 'reply',
      replyMessageId: message.message_id,
      sheetWriter,
      client,
    });
    return;
  }

  const messageTime = coerceLarkTimestamp(message.create_time);
  const reportText = mentioned ? stripBotMentions(text, config.botNames) : text;
  const parsed = parseDailyReportText(reportText, {
    messageTime,
    timezone: config.timezone,
  });

  if (parsed?.highConfidence) {
    if (!group) {
      if (mentioned) {
        await messenger.replyText(message.message_id, '我识别到了日报，但当前群还没有配置日报收集表。请先在 config/groups.json 里配置这个群。');
      }
      return;
    }
    await ensureDailyTable(group);

    const contact = typeof bitable.findTeamContact === 'function'
      ? await findTeamContactSafely(bitable, group, {
        reporterName: parsed.reporterName,
        senderOpenId: getSenderOpenId(data),
      })
      : null;

    const result = await bitable.createDailyReportRecord(group, parsed, {
      messageId: message.message_id,
      chatId: message.chat_id,
      senderOpenId: getSenderOpenId(data),
      source: mentioned ? 'mention_chat' : 'chat',
      messageTimeText: formatDateTime(messageTime, config.timezone),
      contact,
    });

    if (mentioned) {
      const verb = result.created ? '已收集' : '这条日报已收集过';
      await messenger.replyText(message.message_id, `${verb}：${parsed.reporterName} ${parsed.reportDate}，共 ${parsed.workItems.length} 项事项。`);
    }
    return;
  }

  if (mentioned) {
    await messenger.replyText(
      message.message_id,
      '我现在支持：1）贴飞书表格/wiki 链接生成海报；2）发送“姓名 日期 工作日报 + 编号事项”收集日报；3）@我 周报 生成本群项目周报。',
    );
  }
}

async function ensureGroupTables(group) {
  await ensureDailyTable(group);
  if (!tableIsConfigured(group.weeklyTable) && !group.weeklySheet?.enabled) {
    console.warn(`[router] weeklyTable/weeklySheet not configured for ${group.project}; weekly summary will not persist`);
  }
}

async function ensureDailyTable(group) {
  if (!tableIsConfigured(group.dailyTable)) {
    throw new Error(`群 ${group.chatId} 的 dailyTable 未配置 appToken/tableId`);
  }
}

async function findTeamContactSafely(bitable, group, query) {
  try {
    return await bitable.findTeamContact(group, query);
  } catch (err) {
    console.warn('[daily-report] contact lookup failed; continue without supervisor mapping', {
      chatId: group.chatId,
      project: group.project,
      code: err?.response?.data?.code || err?.code,
      msg: err?.response?.data?.msg || err?.message,
    });
    return null;
  }
}
