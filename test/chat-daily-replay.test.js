import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChatDailyReplayArgs,
  replayChatDailyReports,
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

function message(messageId, text) {
  return {
    message_id: messageId,
    chat_id: 'oc_test',
    msg_type: 'text',
    create_time: '1784293200000',
    sender: { id: 'ou_sender' },
    body: { content: JSON.stringify({ text }) },
  };
}
