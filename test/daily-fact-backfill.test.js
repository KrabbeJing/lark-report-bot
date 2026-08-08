import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDailyFactBackfillArgs,
  runDailyFactBackfill,
} from '../src/daily-fact-backfill.js';
import { BitableService } from '../src/bitable-service.js';
import { normalizeConfig } from '../src/config.js';

test('parses an inclusive repair range', () => {
  assert.deepEqual(parseDailyFactBackfillArgs([
    '--start', '2026-07-01', '--end', '2026-07-12', '--repair-organization',
  ]), {
    startDate: '2026-07-01',
    endDate: '2026-07-12',
    repairOrganization: true,
  });
});

test('rejects invalid or reversed ranges', () => {
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026-07-12', '--end', '2026-07-01']),
    /start.*end/,
  );
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026/07/01', '--end', '2026-07-12']),
    /YYYY-MM-DD/,
  );
});

test('rejects impossible calendar dates', () => {
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026-02-30', '--end', '2026-03-01']),
    /YYYY-MM-DD/,
  );
});

test('accepts a valid leap day', () => {
  assert.deepEqual(parseDailyFactBackfillArgs([
    '--start', '2024-02-29', '--end', '2024-03-01',
  ]), {
    startDate: '2024-02-29',
    endDate: '2024-03-01',
    repairOrganization: false,
  });
});

test('forwards explicit dates and repair policy to every group', async () => {
  const calls = [];
  const result = await runDailyFactBackfill({
    config: { timezone: 'Asia/Shanghai', groups: [{ project: '测试组' }] },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 0, errors: [] };
      },
    },
    options: {
      startDate: '2026-07-01',
      endDate: '2026-07-12',
      repairOrganization: true,
    },
  });
  assert.equal(result[0].group, '测试组');
  assert.equal(calls[0].options.startDate, '2026-07-01');
  assert.equal(calls[0].options.endDate, '2026-07-12');
  assert.equal(calls[0].options.repairOrganization, true);
});

test('backfills one shared reporting unit once for multiple chats', async () => {
  const calls = [];
  const result = await runDailyFactBackfill({
    config: normalizeConfig(sharedConfigWithTwoChats()),
    bitable: {
      syncDailyFactRecordsForGroup: async (unit, options) => {
        calls.push({ unit, options });
        return { created: 0, updated: 0, errors: [] };
      },
    },
    options: {
      startDate: '2026-08-07',
      endDate: '2026-08-08',
      repairOrganization: true,
    },
  });

  assert.deepEqual(calls.map(call => call.unit.key), ['digital-finance']);
  assert.equal(result.length, 1);
});

test('initializes facts from current content when source tables are unavailable', async () => {
  const config = normalizeConfig({
    groups: [{
      project: '测试组',
      dailyTable: { appToken: 'bas', tableId: 'tbl_source' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fieldTypes: { reportDate: 'date', sourceTime: 'datetime' },
      },
    }],
  });
  let updatePayload;
  const bitable = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path }) => {
          if (path.table_id === 'tbl_fact') {
            return {
              data: {
                items: [{
                  record_id: 'rec_fact',
                  fields: {
                    事实唯一键: 'name:刘喜双:2026-07-01',
                    日报日期: Date.UTC(2026, 6, 1),
                    日报提交人姓名: '刘喜双',
                    今日工作总结: '保留当前总结',
                    明日工作计划: '保留当前计划',
                    日报来源: 'form+chat',
                    有效来源: 'form+chat',
                    来源时间: 2000,
                    事实记录状态: '忽略',
                    匹配状态: '已匹配',
                  },
                }],
              },
            };
          }
          throw new Error('source table unavailable');
        },
        update: async payload => {
          updatePayload = payload;
          return { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } };
        },
      },
    },
  });

  const results = await runDailyFactBackfill({
    config,
    bitable,
    options: {
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      repairOrganization: false,
    },
  });

  assert.equal(results[0].failed, undefined);
  assert.equal(results[0].updated, 1);
  assert.equal(results[0].errors.length, 1);
  assert.equal(updatePayload.data.fields['今日工作总结'], '保留当前总结');
  assert.equal(updatePayload.data.fields['明日工作计划'], '保留当前计划');
  assert.equal(updatePayload.data.fields['事实记录状态'], '忽略');
  assert.equal(JSON.parse(updatePayload.data.fields['字段来源快照']).workItems.ambiguous, true);
});

function sharedConfigWithTwoChats() {
  return {
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
  };
}
