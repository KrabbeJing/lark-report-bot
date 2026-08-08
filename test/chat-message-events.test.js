import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRecalledMessageEvent } from '../src/chat-message-events.js';
import { normalizeConfig } from '../src/config.js';

test('marks a recalled message historical only in its configured chat', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_raw' },
    }],
  });
  const calls = [];
  const result = await handleRecalledMessageEvent({
    data: {
      event: {
        message_id: 'om_recalled',
        chat_id: 'oc_test',
      },
    },
    bitable: {
      markChatDailyRawRecordHistoricalByMessageId: async (group, messageId) => {
        calls.push({ group, messageId });
        return { updated: 1, recordId: 'rec_raw' };
      },
    },
    config,
  });

  assert.deepEqual(result, { updated: 1, recordId: 'rec_raw' });
  assert.equal(calls[0].messageId, 'om_recalled');
});
