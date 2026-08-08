import { findGroupByChatId, getReportingUnits } from './config.js';
import { coerceLarkTimestamp, formatYmd } from './date-utils.js';
import { parseDailyReportText } from './daily-report-parser.js';
import { buildContentFingerprint } from './daily-record-utils.js';
import { handleMessageEvent } from './message-router.js';
import { getMessageText } from './message-utils.js';

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseChatDailyReplayArgs(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--chat-id', '--message-start', '--message-end', '--report-start', '--report-end'].includes(key)) {
      throw new Error(`未知参数：${key}`);
    }
    if (!value) throw new Error(`${key} 缺少值`);
    values.set(key, value);
  }

  const options = {
    chatId: values.get('--chat-id') || '',
    messageStart: values.get('--message-start') || '',
    messageEnd: values.get('--message-end') || '',
    reportStart: values.get('--report-start') || '',
    reportEnd: values.get('--report-end') || '',
  };
  if (!options.chatId.startsWith('oc_')) throw new Error('--chat-id 必须是 oc_ 开头的群 ID');
  if (!Number.isFinite(Date.parse(options.messageStart)) || !Number.isFinite(Date.parse(options.messageEnd))) {
    throw new Error('--message-start 和 --message-end 必须是带时区的 ISO 时间');
  }
  if (Date.parse(options.messageStart) >= Date.parse(options.messageEnd)) {
    throw new Error('--message-start 必须早于 --message-end');
  }
  if (!YMD_RE.test(options.reportStart) || !YMD_RE.test(options.reportEnd)) {
    throw new Error('--report-start 和 --report-end 必须使用 YYYY-MM-DD');
  }
  if (options.reportStart > options.reportEnd) throw new Error('--report-start 不能晚于 --report-end');
  return options;
}

export async function replayChatDailyReports({
  client,
  bitable,
  config,
  options,
  messenger = createSilentMessenger(),
  handleMessage = handleMessageEvent,
  reconcileFacts = true,
}) {
  const group = findGroupByChatId(config, options.chatId);
  if (!group) throw new Error(`群聊未配置：${options.chatId}`);

  const existingRawRecords = await bitable.listRecords(
    group.chatDailyRawTable,
    'chatDailyReplay.raw.list',
    { includeView: false },
  );
  const messageIdField = group.chatDailyRawTable.fields.messageId;
  const contentFingerprintField = group.chatDailyRawTable.fields.contentFingerprint;
  const existingMessages = new Map(existingRawRecords
    .map(record => [
      String(record.fields?.[messageIdField] || '').trim(),
      {
        fingerprint: String(record.fields?.[contentFingerprintField] || '').trim(),
        hasFingerprint: Boolean(contentFingerprintField && record.fields?.[contentFingerprintField]),
      },
    ])
    .filter(([messageId]) => messageId));
  const messages = await listChatMessages(client, options);

  let replayed = 0;
  let skippedExisting = 0;
  let ignored = 0;
  for (const item of messages) {
    const data = toMessageEvent(item);
    const messageId = data.message.message_id;
    const text = getMessageText(data.message);
    const parsed = parseDailyReportText(text, {
      messageTime: coerceLarkTimestamp(data.message.create_time),
      timezone: config.timezone,
    });
    if (item.deleted) {
      if (existingMessages.has(messageId) && typeof bitable.markChatDailyRawRecordHistoricalByMessageId === 'function') {
        await bitable.markChatDailyRawRecordHistoricalByMessageId(group, messageId);
      }
      ignored += 1;
      continue;
    }
    if (item.msg_type !== 'text' || !parsed?.highConfidence) {
      ignored += 1;
      continue;
    }

    const fingerprint = buildContentFingerprint({
      workItems: parsed.workSummaryText || parsed.workItems || '',
      tomorrowPlanItems: parsed.tomorrowPlanItems || '',
      riskItems: parsed.riskItems || '',
    });
    const existing = existingMessages.get(messageId);
    if (existing && (!existing.hasFingerprint || existing.fingerprint === fingerprint)) {
      skippedExisting += 1;
      continue;
    }

    await handleMessage({
      data,
      client,
      messenger,
      bitable,
      config,
      aiProvider: null,
      sheetWriter: null,
      outDir: '',
    });
    existingMessages.set(messageId, { fingerprint, hasFingerprint: true });
    replayed += 1;
  }

  const syncResult = reconcileFacts
    ? await bitable.syncDailyFactRecordsForGroup(group, {
      startDate: options.reportStart,
      endDate: options.reportEnd,
      includeHistoricalChat: true,
      repairOrganization: true,
      timezone: config.timezone,
    })
    : null;

  return {
    group: group.project || group.chatId,
    messagesRead: messages.length,
    replayed,
    skippedExisting,
    ignored,
    syncResult,
  };
}

export async function replayRecentChatDailyReports({
  client,
  bitable,
  config,
  now = new Date(),
  lookbackMinutes = config.chatDailyReplay?.lookbackMinutes,
  logger = console,
  replayChat = replayChatDailyReports,
}) {
  const minutes = Math.max(1, Number(lookbackMinutes || 1440));
  const start = new Date(now.getTime() - minutes * 60_000);
  const optionsForGroup = group => ({
    chatId: group.chatId,
    messageStart: start.toISOString(),
    messageEnd: now.toISOString(),
    reportStart: formatYmd(start, config.timezone),
    reportEnd: formatYmd(now, config.timezone),
  });
  const chatResults = [];
  for (const chatGroup of config.chatGroups || config.groups || []) {
    const group = findGroupByChatId(config, chatGroup.chatId);
    if (!group?.chatDailyRawTable?.appToken || !group.chatDailyRawTable?.tableId) continue;
    try {
      const result = await replayChat({
        client,
        bitable,
        config,
        options: optionsForGroup(group),
        reconcileFacts: false,
      });
      chatResults.push({ group: group.project || group.chatId, ...result });
      logger.log('[daily-chat-replay] group result', {
        group: group.project || group.chatId,
        messagesRead: result.messagesRead,
        replayed: result.replayed,
        skippedExisting: result.skippedExisting,
        ignored: result.ignored,
      });
    } catch (error) {
      logger.error('[daily-chat-replay] group failed', {
        group: group.project || group.chatId,
        message: error?.message || String(error),
      });
      chatResults.push({ group: group.project || group.chatId, failed: true, error });
    }
  }

  const reportingUnitSyncResults = [];
  for (const unit of getReportingUnits(config)) {
    const scope = unit.name || unit.project || unit.key;
    try {
      const syncResult = await bitable.syncDailyFactRecordsForGroup(unit, {
        startDate: formatYmd(start, config.timezone),
        endDate: formatYmd(now, config.timezone),
        includeHistoricalChat: true,
        repairOrganization: true,
        timezone: config.timezone,
      });
      reportingUnitSyncResults.push({ group: scope, ...syncResult });
    } catch (error) {
      logger.error('[daily-chat-replay] reporting unit failed', {
        group: scope,
        message: error?.message || String(error),
      });
      reportingUnitSyncResults.push({ group: scope, failed: true, error });
    }
  }

  return { chatResults, reportingUnitSyncResults };
}

async function listChatMessages(client, options) {
  const items = [];
  let pageToken;
  do {
    const res = await client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: options.chatId,
        start_time: toEpochSeconds(options.messageStart),
        end_time: toEpochSeconds(options.messageEnd),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        page_token: pageToken,
      },
    });
    if (Number(res?.code || 0) !== 0) {
      throw new Error(`读取群聊历史消息失败 [code=${res?.code || ''}]`);
    }
    items.push(...(res?.data?.items || []));
    pageToken = res?.data?.has_more ? res.data.page_token : undefined;
  } while (pageToken);
  return items;
}

function toMessageEvent(item) {
  return {
    sender: {
      sender_id: {
        open_id: item.sender?.id || '',
      },
    },
    message: {
      message_id: item.message_id || '',
      chat_id: item.chat_id || '',
      chat_type: 'group',
      message_type: item.msg_type || '',
      content: item.body?.content || '',
      create_time: item.create_time || '',
      update_time: item.update_time || '',
      mentions: item.mentions || [],
    },
  };
}

function toEpochSeconds(value) {
  return Math.floor(Date.parse(value) / 1000).toString();
}

function createSilentMessenger() {
  return {
    replyText: async () => {},
    sendTextToChat: async () => {},
  };
}
