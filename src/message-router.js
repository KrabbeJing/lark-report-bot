import { tableIsConfigured, findGroupByChatId } from './config.js';
import { formatDateTime, coerceLarkTimestamp } from './date-utils.js';
import { parseDailyReportText } from './daily-report-parser.js';
import { buildFactKey } from './daily-record-utils.js';
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
    console.log('[daily-report] parsed', {
      messageId: message.message_id,
      chatId: message.chat_id,
      reporterName: parsed.reporterName,
      reportDate: parsed.reportDate,
      confidence: parsed.confidence,
      workItemCount: parsed.workItems.length,
      planItemCount: parsed.tomorrowPlanItems.length,
      riskItemCount: parsed.riskItems.length,
    });

    if (!group) {
      console.warn('[daily-report] parsed but group not configured', {
        messageId: message.message_id,
        chatId: message.chat_id,
        reporterName: parsed.reporterName,
        reportDate: parsed.reportDate,
      });
      if (mentioned) {
        await messenger.replyText(message.message_id, '我识别到了日报，但当前群还没有配置日报收集表。请先在 config/groups.json 里配置这个群。');
      }
      return;
    }

    const senderOpenId = getSenderOpenId(data);
    const contact = typeof bitable.findTeamContact === 'function'
      ? await findTeamContactSafely(bitable, group, {
        reporterName: parsed.reporterName,
        senderOpenId,
      })
      : null;

    const context = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatName: group?.name || group?.project || '',
      senderOpenId,
      source: mentioned ? 'mention_chat' : 'chat',
      messageTimeText: formatDateTime(messageTime, config.timezone),
      contact,
    };

    ensureChatDailyTables(group, bitable);

    const rawResult = await bitable.createChatDailyRawRecord(group, parsed, context);
    const rawRecordId = rawResult.record?.record_id || rawResult.record?.recordId || '';
    const reportDates = (parsed.reportDates?.length ? parsed.reportDates : [parsed.reportDate])
      .map(date => String(date || '').trim())
      .filter(Boolean);
    const factResults = [];

    for (const reportDate of reportDates) {
      const reporterName = contact?.teamMember || parsed.reporterName;
      const memberOpenId = contact?.teamMemberId || senderOpenId;
      const factInput = {
        factKey: buildFactKey({
          openId: memberOpenId,
          name: reporterName,
          reportDate,
        }),
        reportDate,
        reporterName,
        memberOpenId,
        senderOpenId,
        workSummaryText: parsed.workSummaryText,
        tomorrowPlanItems: parsed.tomorrowPlanItems,
        riskItems: parsed.riskItems,
        source: 'chat',
        messageId: message.message_id,
        sourceRecordId: rawRecordId,
        rawRecordId,
        rawText: parsed.rawText,
        chatId: message.chat_id,
        project: contact?.teamName || group.project || '',
        agileGroup: contact?.agileGroup || group.agileGroup || '',
        supervisor: contact?.supervisor || '',
        supervisorOpenId: contact?.supervisorOpenId || '',
        divisionalLeader: contact?.divisionalLeader || '',
        divisionalLeaderOpenId: contact?.divisionalLeaderOpenId || '',
        matchingStatus: contact?.matchingStatus || (contact ? '已匹配' : '未匹配'),
        matchMethod: contact?.matchMethod || '',
        reportType: parsed.reportType,
        dateRange: parsed.dateRange,
        messageTime: context.messageTimeText,
        sourceTime: messageTime.getTime(),
        contact,
      };
      factResults.push(await bitable.upsertDailyFactRecord(group, factInput));
    }

    const result = {
      created: rawResult.created || factResults.some(factResult => factResult.created),
      record: rawResult.record || factResults[0]?.record,
    };

    console.log('[daily-report] chat raw/fact write result', {
      messageId: message.message_id,
      chatId: message.chat_id,
      reporterName: parsed.reporterName,
      reportDate: parsed.reportDate,
      reportDates,
      rawCreated: rawResult.created,
      rawRecordId,
      factResultCount: factResults.length,
      factRecordIds: factResults.map(factResult => factResult.record?.record_id || factResult.record?.recordId || ''),
      workItemCount: parsed.workItems.length,
    });

    if (mentioned) {
      const verb = result.created ? '已收集' : '这条日报已收集过';
      await messenger.replyText(message.message_id, `${verb}：${parsed.reporterName} ${parsed.reportDate}，共 ${parsed.workItems.length} 项事项。`);
    }
    return;
  }

  if (parsed && !parsed.highConfidence) {
    console.warn('[daily-report] low confidence; ignored', {
      messageId: message.message_id,
      chatId: message.chat_id,
      confidence: parsed.confidence,
      reason: parsed.reason,
      firstLine: getFirstLine(reportText),
    });
  } else if ((mentioned || process.env.DAILY_PARSE_DEBUG === 'true') && group) {
    console.log('[daily-report] not matched; ignored', {
      messageId: message.message_id,
      chatId: message.chat_id,
      mentioned,
      firstLine: getFirstLine(reportText),
    });
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

function ensureChatDailyTables(group, bitable) {
  if (!tableIsConfigured(group.chatDailyRawTable) || !tableIsConfigured(group.dailyFactTable)) {
    throw new Error(`群 ${group.chatId} 的 chatDailyRawTable/dailyFactTable 未配置，群聊日报不写 dailyTable`);
  }
  if (typeof bitable.createChatDailyRawRecord !== 'function' || typeof bitable.upsertDailyFactRecord !== 'function') {
    throw new Error('群聊日报写入服务未实现 chatDailyRawTable/dailyFactTable 写入方法，群聊日报不写 dailyTable');
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

function getFirstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 60) || '';
}
