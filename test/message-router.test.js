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

test('falls back to legacy daily table write when raw and fact tables are absent', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_fallback',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `王治坤6.26日工作日报
1、参加案例评审`,
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
  assert.equal(calls[0].parsed.reporterName, '王治坤');
  assert.equal(calls[0].context.senderOpenId, 'ou_1');
});

test('writes configured chat reports to raw table and fact table', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_liu' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-07-01T00:30:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双6.30工作日报
1、补发昨日数据提取进展`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      findTeamContact: async () => ({
        teamName: '渠道创新建设',
        agileGroup: 'A组',
        teamMember: '刘喜双',
        teamMemberId: 'ou_liu',
        supervisor: '王经理',
        supervisorOpenId: 'ou_mgr',
        divisionalLeader: '赵总',
        divisionalLeaderOpenId: 'ou_leader',
        matchingStatus: '已匹配',
        matchMethod: 'open_id',
      }),
      createChatDailyRawRecord: async (group, parsed, context) => {
        calls.push({ type: 'raw', group, parsed, context });
        return { created: true, record: { record_id: 'rec_raw' } };
      },
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ type: 'fact', group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls[0].type, 'raw');
  assert.equal(calls[0].parsed.reportDate, '2026-06-30');
  assert.equal(calls[1].type, 'fact');
  assert.equal(calls[1].input.factKey, 'open_id:ou_liu:2026-06-30');
  assert.equal(calls[1].input.source, 'chat');
  assert.equal(calls[1].input.chatId, 'oc_test');
  assert.equal(calls[1].input.senderOpenId, 'ou_liu');
  assert.equal(calls[1].input.rawText, `刘喜双6.30工作日报
1、补发昨日数据提取进展`);
  assert.equal(calls[1].input.project, '渠道创新建设');
  assert.equal(calls[1].input.agileGroup, 'A组');
  assert.equal(calls[1].input.supervisor, '王经理');
  assert.equal(calls[1].input.supervisorOpenId, 'ou_mgr');
  assert.equal(calls[1].input.divisionalLeader, '赵总');
  assert.equal(calls[1].input.divisionalLeaderOpenId, 'ou_leader');
  assert.equal(calls[1].input.matchingStatus, '已匹配');
  assert.equal(calls[1].input.matchMethod, 'open_id');
});

test('passes configured group name to chat raw records', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      name: '测试日报群',
      project: '支付平台',
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const rawContexts = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_liu' } },
      message: {
        message_id: 'om_chat_name',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-07-01T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双7.1工作日报
1、完成数据提取`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createChatDailyRawRecord: async (_group, _parsed, context) => {
        rawContexts.push(context);
        return { created: true, record: { record_id: 'rec_raw' } };
      },
      upsertDailyFactRecord: async () => ({ created: true, record: { record_id: 'rec_fact' } }),
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(rawContexts[0].chatName, '测试日报群');
});

test('writes raw and fact records without legacy daily table configured', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: null,
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_liu' } },
      message: {
        message_id: 'om_4',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-07-01T00:30:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双6.30工作日报
1、补发昨日数据提取进展`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createChatDailyRawRecord: async (group, parsed, context) => {
        calls.push({ type: 'raw', group, parsed, context });
        return { created: true, record: { record_id: 'rec_raw' } };
      },
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ type: 'fact', group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, 'raw');
  assert.equal(calls[1].type, 'fact');
  assert.equal(calls[1].input.factKey, 'open_id:ou_liu:2026-06-30');
});

test('writes one fact record per report date with raw source record id', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const factInputs = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_liu' } },
      message: {
        message_id: 'om_5',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-07-01T00:30:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双 6.29-6.30 工作日报
1、补发两日数据提取进展`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_raw' } }),
      upsertDailyFactRecord: async (_group, input) => {
        factInputs.push(input);
        return { created: true, record: { record_id: `rec_fact_${factInputs.length}` } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(factInputs.length, 2);
  assert.deepEqual(factInputs.map(input => input.reportDate), ['2026-06-29', '2026-06-30']);
  assert.deepEqual(factInputs.map(input => input.sourceRecordId), ['rec_raw', 'rec_raw']);
  assert.deepEqual(factInputs.map(input => input.source), ['chat', 'chat']);
});
