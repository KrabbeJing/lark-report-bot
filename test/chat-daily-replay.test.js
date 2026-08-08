import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatDailyReplayArgs,
  replayChatDailyReports,
  replayRecentChatDailyReports,
} from '../src/chat-daily-replay.js';
import { normalizeConfig } from '../src/config.js';

test('parses a bounded replay window and report range', () => {
  const options = parseChatDailyReplayArgs([
    '--chat-id', 'oc_test',
    '--message-start', '2026-07-17T00:00:00+08:00',
    '--message-end', '2026-07-18T00:00:00+08:00',
    '--report-start', '2026-07-13',
    '--report-end', '2026-07-17',
  ]);
  assert.equal(options.chatId, 'oc_test');
  assert.equal(options.reportStart, '2026-07-13');
});

test('replays only missing daily messages and repairs facts from historical raw rows', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_form' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const pages = [
    {
      code: 0,
      data: {
        has_more: true,
        page_token: 'next',
        items: [message('om_existing', '刘喜双7.13工作日报\n1.完成事项')],
      },
    },
    {
      code: 0,
      data: {
        has_more: false,
        items: [
          message('om_missing', '王治坤7.14工作日报\n1.完成另一事项'),
          message('om_noise', '普通聊天消息'),
        ],
      },
    },
  ];
  const handled = [];
  const syncCalls = [];
  const result = await replayChatDailyReports({
    client: {
      im: {
        message: {
          list: async () => pages.shift(),
        },
      },
    },
    bitable: {
      listRecords: async () => [{
        record_id: 'rec_existing',
        fields: { 消息ID: 'om_existing' },
      }],
      syncDailyFactRecordsForGroup: async (_group, options) => {
        syncCalls.push(options);
        return { created: 1, errors: [] };
      },
    },
    config,
    options: {
      chatId: 'oc_test',
      messageStart: '2026-07-17T00:00:00+08:00',
      messageEnd: '2026-07-18T00:00:00+08:00',
      reportStart: '2026-07-13',
      reportEnd: '2026-07-17',
    },
    handleMessage: async input => handled.push(input.data.message.message_id),
  });

  assert.deepEqual(handled, ['om_missing']);
  assert.equal(result.messagesRead, 3);
  assert.equal(result.replayed, 1);
  assert.equal(result.skippedExisting, 1);
  assert.equal(result.ignored, 1);
  assert.equal(syncCalls[0].includeHistoricalChat, true);
  assert.equal(syncCalls[0].repairOrganization, true);
});

test('replays an edited message when its message id already exists with older content', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_form' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const handled = [];
  const result = await replayChatDailyReports({
    client: {
      im: {
        message: {
          list: async () => ({
            code: 0,
            data: {
              has_more: false,
              items: [message('om_edited', '刘喜双8.5工作日报\n1、修改后的事项')],
            },
          }),
        },
      },
    },
    bitable: {
      listRecords: async () => [{
        record_id: 'rec_raw',
        fields: {
          消息ID: 'om_edited',
          内容指纹: 'old-fingerprint',
        },
      }],
      syncDailyFactRecordsForGroup: async () => ({ created: 0, updated: 0, errors: [] }),
    },
    config,
    options: {
      chatId: 'oc_test',
      messageStart: '2026-08-05T00:00:00+08:00',
      messageEnd: '2026-08-06T00:00:00+08:00',
      reportStart: '2026-08-05',
      reportEnd: '2026-08-05',
    },
    handleMessage: async input => handled.push(input.data.message.message_id),
  });

  assert.deepEqual(handled, ['om_edited']);
  assert.equal(result.replayed, 1);
  assert.equal(result.skippedExisting, 0);
});

test('replays each enabled chat and reconciles shared facts once', async () => {
  const config = normalizeConfig({
    timezone: 'Asia/Shanghai',
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      dailyTable: { appToken: 'bas_shared', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas_shared', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A', pushChatId: 'oc_test' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B', pushChatId: 'oc_test' },
    ],
  });
  const listedChatIds = [];
  const handledProjects = [];
  const handledGroups = [];
  const syncCalls = [];
  const replayCalls = [];
  const result = await replayRecentChatDailyReports({
    client: {
      im: {
        message: {
          list: async ({ params }) => {
            listedChatIds.push(params.container_id);
            return {
              code: 0,
              data: {
                has_more: false,
                items: [message(params.container_id === 'oc_a' ? 'om_a' : 'om_b', `${params.container_id === 'oc_a' ? '甲' : '乙'}8.7工作日报\n1、完成事项`, params.container_id)],
              },
            };
          },
        },
      },
    },
    bitable: {
      listRecords: async table => {
        assert.equal(table.tableId, 'tbl_raw');
        return [];
      },
      createChatDailyRawRecord: async group => {
        handledGroups.push(group);
        handledProjects.push(group.project);
        return { created: true, record: { record_id: `rec_${group.chatId}` } };
      },
      upsertDailyFactRecord: async () => ({ created: true }),
      syncDailyFactRecordsForGroup: async (group, options) => {
        syncCalls.push({ group, options });
        return { created: 1, updated: 0, errors: [] };
      },
    },
    config,
    now: new Date('2026-08-08T00:00:00+08:00'),
    lookbackMinutes: 1440,
    replayChat: async options => {
      replayCalls.push(options);
      return replayChatDailyReports(options);
    },
  });

  assert.deepEqual(listedChatIds, ['oc_a', 'oc_b']);
  assert.deepEqual(handledProjects, ['板块A', '板块B']);
  assert.ok(handledGroups.every(group => group.chatDailyRawTable.tableId === 'tbl_raw'));
  assert.ok(replayCalls.every(call => call.reconcileFacts === false));
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].group.key, 'digital-finance');
  assert.deepEqual(syncCalls[0].options, {
    startDate: '2026-08-07',
    endDate: '2026-08-08',
    includeHistoricalChat: true,
    repairOrganization: true,
    timezone: 'Asia/Shanghai',
  });
  assert.equal(result.chatResults.length, 2);
  assert.equal(result.reportingUnitSyncResults.length, 1);
});

function message(messageId, text, chatId = 'oc_test') {
  return {
    message_id: messageId,
    chat_id: chatId,
    msg_type: 'text',
    create_time: '1784293200000',
    sender: { id: 'ou_sender' },
    body: { content: JSON.stringify({ text }) },
  };
}
