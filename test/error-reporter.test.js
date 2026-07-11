import test from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorSummary, formatLarkErrorForLog, reportHandlerError } from '../src/error-reporter.js';
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
  assert.match(calls[0][2], /om_1/);
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
