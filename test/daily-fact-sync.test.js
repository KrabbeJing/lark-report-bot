import test from 'node:test';
import assert from 'node:assert/strict';
import { syncDailyFactsForAllGroups } from '../src/daily-fact-sync.js';
import { normalizeConfig } from '../src/config.js';

test('syncs facts for each configured group', async () => {
  const config = normalizeConfig({
    dailyFactSync: { enabled: true, lookbackDays: 3, timezone: 'Asia/Shanghai' },
    groups: [
      {
        chatId: 'oc_1',
        project: '板块1',
        dailyTable: { appToken: 'bas', tableId: 'tbl_source_1' },
        chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
        dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact_1' },
      },
      {
        chatId: 'oc_2',
        project: '板块2',
        dailyTable: { appToken: 'bas', tableId: 'tbl_source_2' },
        chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw_2' },
        dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact_2' },
      },
    ],
  });
  const calls = [];
  const now = new Date('2026-07-03T10:10:00.000Z');
  const results = await syncDailyFactsForAllGroups({
    config,
    now,
    logger: { log() {}, error() {} },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 0 };
      },
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].group.project, '板块1');
  assert.equal(calls[0].group.chatDailyRawTable.tableId, 'tbl_chat_raw');
  assert.equal(calls[0].options.lookbackDays, 3);
  assert.equal(calls[0].options.timezone, 'Asia/Shanghai');
  assert.equal(calls[0].options.now, now);
  assert.equal(results[1].group, '板块2');
  assert.equal(results[1].created, 1);
});
