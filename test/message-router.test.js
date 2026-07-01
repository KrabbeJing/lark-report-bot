import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageEvent } from '../src/message-router.js';
import { normalizeConfig } from '../src/config.js';

test('routes high-confidence daily report into bitable service', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      agileGroup: 'A组',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklyTable: { appToken: 'bas_test', tableId: 'tbl_weekly' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `王治坤6.26日工作日报
1.参加案例评审
2.沟通分级分类案例`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createDailyReportRecord: async (group, parsed, context) => {
        calls.push({ group, parsed, context });
        return { created: true };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].group.project, '支付平台');
  assert.equal(calls[0].parsed.reporterName, '王治坤');
  assert.equal(calls[0].context.senderOpenId, 'ou_1');
});

test('strips bot mention before parsing mentioned daily report', async () => {
  const config = normalizeConfig({
    botNames: ['数金小助手'],
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    }],
  });
  const calls = [];
  const replies = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        mentions: [{ mentioned_type: 'bot', name: '数金小助手' }],
        content: JSON.stringify({
          text: `@数金小助手 王治坤6.26日工作日报
1.参加案例评审`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async (_id, text) => replies.push(text) },
    bitable: {
      createDailyReportRecord: async (group, parsed, context) => {
        calls.push({ group, parsed, context });
        return { created: true };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsed.reporterName, '王治坤');
  assert.match(replies[0], /已收集/);
});

test('continues daily report collection when contact lookup is forbidden', async () => {
  const config = normalizeConfig({
    botNames: ['数金小助手'],
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      contactTable: { appToken: 'bas_test', tableId: 'tbl_contacts' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_3',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `王治坤6.26日工作日报
1.参加案例评审`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      findTeamContact: async () => {
        const err = new Error('Request failed with status code 403');
        err.response = { data: { code: 91403, msg: 'Forbidden' } };
        throw err;
      },
      createDailyReportRecord: async (group, parsed, context) => {
        calls.push({ group, parsed, context });
        return { created: true };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.contact, null);
  assert.equal(calls[0].parsed.reporterName, '王治坤');
});
