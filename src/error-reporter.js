import { createHash } from 'node:crypto';

export function formatLarkErrorForLog(err) {
  const data = err?.response?.data;
  if (data) return JSON.stringify(data, null, 2);
  return JSON.stringify({
    code: err?.code || '',
    message: err?.message || String(err || ''),
  }, null, 2);
}

export async function reportHandlerError({ err, message, messenger, config }) {
  const errorReporting = config?.errorReporting || {};
  const summary = buildErrorSummary(err, message);
  const tasks = [];

  for (const openId of errorReporting.adminOpenIds || []) {
    tasks.push(messenger.sendTextToOpenId(openId, summary, buildErrorUuid('open', openId, message)));
  }

  for (const chatId of errorReporting.adminChatIds || []) {
    tasks.push(messenger.sendText(chatId, summary, buildErrorUuid('chat', chatId, message)));
  }

  if (errorReporting.notifyInChat === true && message?.message_id) {
    tasks.push(messenger.replyText(message.message_id, '机器人处理失败，已通知管理员排查。'));
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    console.warn('[error-report] failed to notify admins', failed.map(result => result.reason?.message || result.reason));
  }
}

export function buildErrorSummary(err, message) {
  const data = err?.response?.data || {};
  const detail = data.error || {};
  const lines = [
    '【数金小助手异常】',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `群ID：${message?.chat_id || ''}`,
    `消息ID：${message?.message_id || ''}`,
    `错误码：${data.code || err?.code || ''}`,
    `错误信息：${data.msg || err?.message || String(err || '')}`,
  ];

  if (detail.message) lines.push(`详情：${truncateText(detail.message, 500)}`);
  if (detail.log_id) lines.push(`log_id：${detail.log_id}`);

  return lines.filter(line => !line.endsWith('：')).join('\n');
}

function buildErrorUuid(kind, id, message) {
  const digest = createHash('sha256')
    .update([kind, id, message?.message_id || Date.now()].join('|'))
    .digest('hex')
    .slice(0, 32);
  return `handler-error-${kind}-${digest}`;
}

function truncateText(text, maxLength) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
