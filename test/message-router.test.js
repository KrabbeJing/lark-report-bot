import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageEvent } from '../src/message-router.js';
import { normalizeConfig } from '../src/config.js';

test('routes high-confidence daily report into bitable service without logging identifiers or report text', async t => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      chatDailyRawTable: { appToken: 'bas_test', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_test', tableId: 'tbl_fact' },
      weeklyTable: { appToken: 'bas_test', tableId: 'tbl_weekly' },
    }],
  });
  const calls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args);
  t.after(() => { console.log = originalLog; });

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
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_raw' } }),
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].group.project, '支付平台');
  assert.equal(calls[0].input.reporterName, '王治坤');
  assert.equal(calls[0].input.senderOpenId, 'ou_1');
  const serialized = JSON.stringify(logs);
  for (const secret of ['om_1', 'oc_test', '王治坤', 'ou_1', 'rec_raw', 'rec_fact', '参加案例评审', '沟通分级分类案例', '支付平台']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(logs.length, 2);
  assert.equal(logs[0][1].reportDate, '2026-06-26');
  assert.equal(logs[1][1].factResultCount, 1);
});

test('strips bot mention before parsing mentioned daily report', async () => {
  const config = normalizeConfig({
    botNames: ['数金小助手'],
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      chatDailyRawTable: { appToken: 'bas_test', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_test', tableId: 'tbl_fact' },
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
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_raw' } }),
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.reporterName, '王治坤');
  assert.match(replies[0], /已收集/);
});

test('continues daily report collection when contact lookup is forbidden without logging query details', async t => {
  const config = normalizeConfig({
    botNames: ['数金小助手'],
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      chatDailyRawTable: { appToken: 'bas_test', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_test', tableId: 'tbl_fact' },
      contactTable: { appToken: 'bas_test', tableId: 'tbl_contacts' },
    }],
  });
  const calls = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = originalWarn; });

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
        const err = new Error('raw report body rec_error_secret ou_error_secret oc_error_secret bascnErrorSecret table_id=tbl_error_secret wiki/WikiNodeSecret');
        err.response = { data: { code: 91403, msg: 'raw report body rec_error_secret ou_error_secret oc_error_secret bascnErrorSecret table_id=tbl_error_secret wiki/WikiNodeSecret' } };
        throw err;
      },
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_raw' } }),
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.contact, null);
  assert.equal(calls[0].input.reporterName, '王治坤');
  assert.deepEqual(warnings, [
    ['[daily-report] contact lookup failed; continue without supervisor mapping', { code: '91403' }],
  ]);
  const serialized = JSON.stringify(warnings);
  for (const secret of ['oc_test', '支付平台', 'rec_error_secret', 'ou_error_secret', 'oc_error_secret', 'bascnErrorSecret', 'tbl_error_secret', 'WikiNodeSecret', 'raw report body', '王治坤']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test('rejects chat daily report when raw and fact tables are absent without exposing the chat identifier', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    }],
  });
  const calls = [];

  let rejection;
  await assert.rejects(handleMessageEvent({
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
  }), error => {
    rejection = error;
    return /chatDailyRawTable\/dailyFactTable 未配置/.test(error.message);
  });

  assert.equal(calls.length, 0);
  assert.doesNotMatch(rejection.message, /oc_test/);
});

test('rejects weekly commands without a daily table without exposing the chat identifier', async () => {
  const chatId = 'oc_missing_daily_secret';
  const config = normalizeConfig({
    botNames: ['数金小助手'],
    groups: [{
      chatId,
      project: '敏感项目',
      weeklyTable: { appToken: 'bas_weekly', tableId: 'tbl_weekly' },
    }],
  });

  await assert.rejects(handleMessageEvent({
    data: {
      message: {
        message_id: 'om_missing_daily_secret',
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'text',
        mentions: [{ mentioned_type: 'bot', name: '数金小助手' }],
        content: JSON.stringify({ text: '@数金小助手 周报' }),
      },
    },
    client: {}, messenger: { replyText: async () => {} }, bitable: {}, config, aiProvider: {}, outDir: '/tmp',
  }), error => {
    assert.match(error.message, /dailyTable 未配置/);
    assert.doesNotMatch(error.message, new RegExp(chatId));
    return true;
  });
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
  assert.deepEqual(
    factInputs.map(input => input.sourceTime),
    [
      new Date('2026-07-01T00:30:00+08:00').getTime(),
      new Date('2026-07-01T00:30:00+08:00').getTime(),
    ],
  );
});

test('does not log scope identifiers when a parsed daily report is sent from an unconfigured group', async t => {
  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.log = originalLog;
    console.warn = originalWarn;
  });
  const replies = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_unconfigured_secret' } },
      message: {
        message_id: 'om_unconfigured_secret',
        chat_id: 'oc_unconfigured_secret',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        mentions: [{ mentioned_type: 'bot', name: '数金小助手' }],
        content: JSON.stringify({ text: '@数金小助手 王敏感6.26日工作日报\n1.日报正文机密' }),
      },
    },
    client: {},
    messenger: { replyText: async (_id, text) => replies.push(text) },
    bitable: {},
    config: normalizeConfig({ botNames: ['数金小助手'], groups: [] }),
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(replies.length, 1);
  assert.equal(warnings.length, 1);
  const serialized = JSON.stringify({ logs, warnings });
  for (const secret of ['om_unconfigured_secret', 'oc_unconfigured_secret', 'ou_unconfigured_secret', '王敏感', '日报正文机密']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(logs[0][1].reportDate, '2026-06-26');
  assert.equal(warnings[0][1].reportDate, '2026-06-26');
  assert.equal(warnings[0][1].reason, 'group_not_configured');
});

test('does not log daily report text for low-confidence reports', async t => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = originalWarn; });
  const messageId = 'om_low_confidence_secret';
  const chatId = 'oc_low_confidence_secret';
  const reportText = '王敏感日报正文机密工作日报';

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_low_confidence_secret' } },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({ text: reportText }),
      },
    },
    client: {}, messenger: { replyText: async () => {} }, bitable: {},
    config: normalizeConfig({ groups: [{ chatId, project: '敏感项目' }] }),
    aiProvider: {}, outDir: '/tmp',
  });

  assert.equal(warnings.length, 1);
  const serialized = JSON.stringify(warnings);
  for (const secret of [messageId, chatId, 'ou_low_confidence_secret', '王敏感', '日报正文机密', '敏感项目']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(warnings[0][1].reason, 'low_confidence');
});

test('does not log raw messages for debug not-matched reports', async t => {
  const logs = [];
  const originalLog = console.log;
  const previousDebug = process.env.DAILY_PARSE_DEBUG;
  console.log = (...args) => logs.push(args);
  process.env.DAILY_PARSE_DEBUG = 'true';
  t.after(() => {
    console.log = originalLog;
    if (previousDebug === undefined) delete process.env.DAILY_PARSE_DEBUG;
    else process.env.DAILY_PARSE_DEBUG = previousDebug;
  });
  const messageId = 'om_not_matched_secret';
  const chatId = 'oc_not_matched_secret';
  const rawText = '王敏感的工作内容机密，但不是预期格式';

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_not_matched_secret' } },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({ text: rawText }),
      },
    },
    client: {}, messenger: { replyText: async () => {} }, bitable: {},
    config: normalizeConfig({ groups: [{ chatId, project: '敏感项目' }] }),
    aiProvider: {}, outDir: '/tmp',
  });

  assert.equal(logs.length, 1);
  const serialized = JSON.stringify(logs);
  for (const secret of [messageId, chatId, 'ou_not_matched_secret', '王敏感', '工作内容机密', '敏感项目']) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(logs[0][1].reason, 'not_matched');
});
