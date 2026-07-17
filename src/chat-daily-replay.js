import { findGroupByChatId } from './config.js';
import { coerceLarkTimestamp } from './date-utils.js';
import { parseDailyReportText } from './daily-report-parser.js';
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
}) {
  const group = findGroupByChatId(config, options.chatId);
  if (!group) throw new Error(`群聊未配置：${options.chatId}`);

  const existingRawRecords = await bitable.listRecords(
    group.chatDailyRawTable,
    'chatDailyReplay.raw.list',
    { includeView: false },
  );
  const messageIdField = group.chatDailyRawTable.fields.messageId;
  const existingMessageIds = new Set(existingRawRecords
    .map(record => String(record.fields?.[messageIdField] || '').trim())
    .filter(Boolean));
  const messages = await listChatMessages(client, options);

  let replayed = 0;
  let skippedExisting = 0;
  let ignored = 0;
  for (const item of messages) {
    const data = toMessageEvent(item);
    const messageId = data.message.message_id;
    if (existingMessageIds.has(messageId)) {
      skippedExisting += 1;
      continue;
    }

    const text = getMessageText(data.message);
    const parsed = parseDailyReportText(text, {
      messageTime: coerceLarkTimestamp(data.message.create_time),
      timezone: config.timezone,
    });
    if (item.deleted || item.msg_type !== 'text' || !parsed?.highConfidence) {
      ignored += 1;
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
    existingMessageIds.add(messageId);
    replayed += 1;
  }

  const syncResult = await bitable.syncDailyFactRecordsForGroup(group, {
    startDate: options.reportStart,
    endDate: options.reportEnd,
    includeHistoricalChat: true,
    repairOrganization: true,
    timezone: config.timezone,
  });

  return {
    group: group.project || group.chatId,
    messagesRead: messages.length,
    replayed,
    skippedExisting,
    ignored,
    syncResult,
  };
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
