import { createHash } from 'node:crypto';

export function formatLarkErrorForLog(err) {
  const data = err?.response?.data;
  if (data) return JSON.stringify(data, null, 2);
  return JSON.stringify({
    code: err?.code || '',
    message: err?.message || String(err || ''),
  }, null, 2);
}

export function sanitizeOperationalText(value) {
  return String(value || '')
    .replace(/\b(?:ou|oc|om|tbl|vew|rec)_[A-Za-z0-9_-]+\b/g, '[masked-id]')
    .replace(/\b(?:tbl|vew|rec)[A-Za-z0-9_-]{6,}\b/g, '[masked-id]')
    .replace(/\b(appToken|app_token|tableId|table_id|sheetId|sheet_id|spreadsheetToken)\s*[=:]\s*[^\s,\]]+/gi, '$1=[masked]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [masked]');
}

export async function reportOperationalFailure({
  task,
  scope,
  stage = '',
  errors = [],
  messenger,
  config,
  now = new Date(),
}) {
  const list = errors.map(error => sanitizeOperationalText(
    error?.response?.data?.msg || error?.message || String(error || ''),
  ));
  const summary = [
    '【数金小助手任务异常】',
    `任务：${sanitizeOperationalText(task)}`,
    `范围：${sanitizeOperationalText(scope)}`,
    stage ? `阶段：${sanitizeOperationalText(stage)}` : '',
    `时间：${now.toLocaleString('zh-CN', {
      hour12: false,
      timeZone: config?.timezone || 'Asia/Shanghai',
    })}`,
    `失败数量：${list.length}`,
    ...list.slice(0, 3).map((message, index) => `${index + 1}. ${truncateText(message, 300)}`),
  ].filter(Boolean).join('\n');

  return deliverToOperations({ summary, task, scope, messenger, config });
}

export async function reportHandlerError({ err, message, messenger, config }) {
  const summary = buildErrorSummary(err, message);
  await deliverToOperations({
    summary,
    task: 'handler',
    scope: message?.chat_id || '',
    eventId: message?.message_id,
    messenger,
    config,
  });

  if (config?.errorReporting?.notifyInChat === true && message?.message_id) {
    const results = await Promise.allSettled([
      messenger.replyText(message.message_id, '机器人处理失败，已通知管理员排查。'),
    ]);
    logDeliveryFailures(results);
  }
}

export async function reportScheduledError({ err, task, scope, messenger, config }) {
  const summary = [
    '【数金小助手定时任务异常】',
    `任务：${sanitizeOperationalText(task)}`,
    `范围：${sanitizeOperationalText(scope)}`,
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `错误信息：${truncateText(sanitizeOperationalText(err?.message || String(err || '')), 500)}`,
  ].filter(line => !line.endsWith('：')).join('\n');

  return deliverToOperations({ summary, task, scope, recipientKindPrefix: 'scheduled', messenger, config });
}

export function buildErrorSummary(err, message) {
  const data = err?.response?.data || {};
  const detail = data.error || {};
  const lines = [
    '【数金小助手异常】',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `群ID：${sanitizeOperationalText(message?.chat_id)}`,
    `消息ID：${sanitizeOperationalText(message?.message_id)}`,
    `错误码：${sanitizeOperationalText(data.code || err?.code)}`,
    `错误信息：${sanitizeOperationalText(data.msg || err?.message || String(err || ''))}`,
  ];

  if (detail.message) lines.push(`详情：${truncateText(sanitizeOperationalText(detail.message), 500)}`);
  if (detail.log_id) lines.push(`log_id：${sanitizeOperationalText(detail.log_id)}`);

  return lines.filter(line => !line.endsWith('：')).join('\n');
}

async function deliverToOperations({ summary, task, scope, eventId, recipientKindPrefix = '', messenger, config }) {
  const errorReporting = config?.errorReporting || {};
  const deliveryId = eventId || `${task}-${scope}-${Date.now()}`;
  const recipientKind = kind => (recipientKindPrefix ? `${recipientKindPrefix}-${kind}` : kind);
  const tasks = [
    ...(errorReporting.adminOpenIds || []).map(openId => (
      messenger.sendTextToOpenId(
        openId,
        summary,
        buildErrorUuid(recipientKind('open'), openId, { message_id: deliveryId }),
      )
    )),
    ...(errorReporting.adminChatIds || []).map(chatId => (
      messenger.sendText(
        chatId,
        summary,
        buildErrorUuid(recipientKind('chat'), chatId, { message_id: deliveryId }),
      )
    )),
  ];
  const results = await Promise.allSettled(tasks);
  logDeliveryFailures(results);
  return results;
}

function logDeliveryFailures(results) {
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    console.warn(
      '[error-report] failed to notify admins',
      failed.map(result => sanitizeOperationalText(result.reason?.message || result.reason)),
    );
  }
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
