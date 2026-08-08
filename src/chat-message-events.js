import { findGroupByChatId } from './config.js';

export async function handleRecalledMessageEvent({ data, bitable, config }) {
  const event = data?.event || data || {};
  const messageId = String(event.message_id || '').trim();
  const chatId = String(event.chat_id || '').trim();
  if (!messageId || !chatId || typeof bitable?.markChatDailyRawRecordHistoricalByMessageId !== 'function') {
    return { updated: 0, skipped: true };
  }

  const group = findGroupByChatId(config, chatId);
  if (!group) return { updated: 0, skipped: true };
  return bitable.markChatDailyRawRecordHistoricalByMessageId(group, messageId);
}
