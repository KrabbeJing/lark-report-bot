import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildErrorSummary,
  formatLarkErrorForLog,
  reportHandlerError,
  reportOperationalFailure,
  reportScheduledError,
  sanitizeOperationalText,
} from '../src/error-reporter.js';
import { normalizeConfig } from '../src/config.js';

test('formats nested Feishu field violations for PM2 logs', () => {
  const output = formatLarkErrorForLog({
    response: {
      data: {
        code: 99992402,
        msg: 'field validation failed',
        error: {
          log_id: 'log_test',
          field_violations: [{ field: 'uuid', description: 'max length is 50' }],
        },
      },
    },
  });
  assert.match(output, /uuid/);
  assert.match(output, /max length is 50/);
  assert.match(output, /log_test/);
});

test('does not reply in chat when error reporting has no recipients', async () => {
  const calls = [];
  await reportHandlerError({
    err: new Error('boom'),
    message: { message_id: 'om_1', chat_id: 'oc_1' },
    messenger: {
      replyText: async (...args) => calls.push(['replyText', ...args]),
      sendText: async (...args) => calls.push(['sendText', ...args]),
      sendTextToOpenId: async (...args) => calls.push(['sendTextToOpenId', ...args]),
    },
    config: normalizeConfig({}),
  });

  assert.deepEqual(calls, []);
});

test('sends handler errors to configured admin open ids and chat ids', async () => {
  const calls = [];
  await reportHandlerError({
    err: {
      response: {
        data: {
          code: 1254064,
          msg: 'DatetimeFieldConvFail',
          error: {
            message: 'Correct format : the value of Date must be a unix timestamp.',
            log_id: 'log_1',
          },
        },
      },
    },
    message: { message_id: 'om_1', chat_id: 'oc_source' },
    messenger: {
      replyText: async (...args) => calls.push(['replyText', ...args]),
      sendText: async (...args) => calls.push(['sendText', ...args]),
      sendTextToOpenId: async (...args) => calls.push(['sendTextToOpenId', ...args]),
    },
    config: normalizeConfig({
      errorReporting: {
        adminOpenIds: ['ou_admin'],
        adminChatIds: ['oc_admin'],
      },
    }),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'sendTextToOpenId');
  assert.equal(calls[0][1], 'ou_admin');
  assert.match(calls[0][2], /DatetimeFieldConvFail/);
  assert.match(calls[0][2], /\[masked-id\]/);
  assert.doesNotMatch(calls[0][2], /om_1|oc_source/);
  assert.match(calls[0][3], /^[A-Za-z0-9-]{1,64}$/);
  assert.match(calls[1][3], /^[A-Za-z0-9-]{1,64}$/);
  assert.equal(calls[1][0], 'sendText');
  assert.equal(calls[1][1], 'oc_admin');
});

test('can optionally send a generic failure notice in the source chat', async () => {
  const calls = [];
  await reportHandlerError({
    err: new Error('boom'),
    message: { message_id: 'om_1', chat_id: 'oc_1' },
    messenger: {
      replyText: async (...args) => calls.push(['replyText', ...args]),
      sendText: async (...args) => calls.push(['sendText', ...args]),
      sendTextToOpenId: async (...args) => calls.push(['sendTextToOpenId', ...args]),
    },
    config: normalizeConfig({
      errorReporting: {
        notifyInChat: true,
      },
    }),
  });

  assert.deepEqual(calls, [['replyText', 'om_1', '机器人处理失败，已通知管理员排查。']]);
});

test('builds concise error summaries from bitable errors', () => {
  const summary = buildErrorSummary({
    response: {
      data: {
        code: 1254064,
        msg: 'DatetimeFieldConvFail',
        error: {
          message: 'Invalid request parameter.',
          log_id: 'log_1',
        },
      },
    },
  }, {
    message_id: 'om_1',
    chat_id: 'oc_1',
  });

  assert.match(summary, /数金小助手异常/);
  assert.match(summary, /1254064/);
  assert.match(summary, /DatetimeFieldConvFail/);
  assert.match(summary, /log_1/);
});

test('notifies configured admins about a scheduled task failure', async () => {
  const sent = [];
  await reportScheduledError({
    err: new Error('复制模板失败'),
    task: '周报实例创建',
    scope: '公司项目组',
    messenger: {
      sendTextToOpenId: async (...args) => sent.push(['open', ...args]),
      sendText: async (...args) => sent.push(['chat', ...args]),
    },
    config: {
      errorReporting: {
        adminOpenIds: ['ou_admin'],
        adminChatIds: ['oc_admin'],
      },
    },
  });

  assert.equal(sent.length, 2);
  assert.match(sent[0][2], /周报实例创建/);
  assert.match(sent[0][2], /公司项目组/);
  assert.match(sent[0][2], /复制模板失败/);
  assert.match(sent[0][3], /^handler-error-scheduled-open-/);
});

test('aggregates batch errors into one masked operations message per recipient', async () => {
  const sent = [];
  const messenger = {
    sendText: async (chatId, text) => sent.push({ kind: 'chat', chatId, text }),
    sendTextToOpenId: async (openId, text) => sent.push({ kind: 'open', openId, text }),
  };
  await reportOperationalFailure({
    task: '日报事实同步',
    scope: '公司项目组',
    stage: 'write_daily_fact',
    errors: [
      new Error('appToken=CjCM123456789 tableId=tbl123456 open_id=ou_abcdef'),
      new Error('second failure'),
    ],
    messenger,
    config: {
      errorReporting: { adminChatIds: ['oc_admin'], adminOpenIds: ['ou_admin'] },
    },
    now: new Date('2026-07-12T02:00:00.000Z'),
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /失败数量：2/);
  assert.match(sent[0].text, /阶段：write_daily_fact/);
  assert.doesNotMatch(sent[0].text, /CjCM123456789|tbl123456|ou_abcdef/);
});

test('limits the displayed error sample', async () => {
  let summary = '';
  await reportOperationalFailure({
    task: '批量任务',
    scope: '测试范围',
    errors: ['one', 'two', 'three', 'four', 'five'].map(value => new Error(value)),
    messenger: {
      sendText: async (_chatId, text) => { summary = text; },
      sendTextToOpenId: async () => {},
    },
    config: { errorReporting: { adminChatIds: ['oc_admin'], adminOpenIds: [] } },
  });
  assert.match(summary, /1\. one/);
  assert.match(summary, /2\. two/);
  assert.match(summary, /3\. three/);
  assert.doesNotMatch(summary, /4\. four|5\. five/);
});

test('masks Feishu IDs and credentials without retaining partial tokens', () => {
  const text = sanitizeOperationalText(
    'open=ou_abcdef chat=oc_abcdef message=om_abcdef table=tbl123456 view=vew123456 record=rec123456 appToken=CjCM123456789 Bearer secret-token',
  );

  assert.doesNotMatch(text, /ou_abcdef|oc_abcdef|om_abcdef|tbl123456|vew123456|rec123456|CjCM123456789|secret-token/);
  assert.match(text, /\[masked-id\]/);
  assert.match(text, /appToken=\[masked\]/);
  assert.match(text, /Bearer \[masked\]/);
});
