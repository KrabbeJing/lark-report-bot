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

test('routes shared-chat messages with chat metadata and shared resources', async () => {
  const config = normalizeConfig({
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      dailyTable: { appToken: 'bas_shared', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas_shared', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B' },
    ],
  });
  const receivedGroups = [];
  const factInputs = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_shared_b',
        chat_id: 'oc_b',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: '王治坤6.26日工作日报\n1.参加案例评审',
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      findTeamContact: async () => ({
        teamName: '联系来源组织',
        teamMember: '王治坤',
        teamMemberId: 'ou_1',
        matchingStatus: '已匹配',
        matchMethod: 'open_id',
      }),
      createChatDailyRawRecord: async group => {
        receivedGroups.push(group);
        return { created: true, record: { record_id: 'rec_raw' } };
      },
      upsertDailyFactRecord: async (_group, input) => {
        factInputs.push(input);
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(receivedGroups.length, 1);
  assert.equal(receivedGroups[0].chatId, 'oc_b');
  assert.equal(receivedGroups[0].name, '日报群B');
  assert.equal(receivedGroups[0].project, '板块B');
  assert.equal(receivedGroups[0].chatDailyRawTable.tableId, 'tbl_raw');
  assert.equal(receivedGroups[0].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(factInputs[0].project, '联系来源组织');
  assert.notEqual(factInputs[0].project, receivedGroups[0].project);
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
  assert.equal(calls[1].input.supervisor, '王经理');
  assert.equal(calls[1].input.supervisorOpenId, 'ou_mgr');
  assert.equal(calls[1].input.agileGroup, undefined);
  assert.equal(calls[1].input.divisionalLeader, undefined);
  assert.equal(calls[1].input.divisionalLeaderOpenId, undefined);
  assert.equal(calls[1].input.matchingStatus, '已匹配');
  assert.equal(calls[1].input.matchMethod, 'open_id');
  assert.deepEqual(calls[1].input.values, {
    workItems: '1、补发昨日数据提取进展',
    tomorrowPlanItems: '',
    riskItems: '',
  });
});

test('writes separate facts when one chat message contains two report blocks', async () => {
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
        message_id: 'om_two_reports',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-08-06T23:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双 8.5日工作日报
1、配置聊城分行收单商户手续费额度包
2、处理日常收单业务问题
刘喜双 8.6 日工作日报
1、解决市南支行收单系统机具中心云喇叭分拨报错问题
2、处理日常收单业务问题`,
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

  assert.deepEqual(factInputs.map(input => input.reportDate), ['2026-08-05', '2026-08-06']);
  assert.deepEqual(factInputs.map(input => input.workSummaryText), [
    '1、配置聊城分行收单商户手续费额度包\n2、处理日常收单业务问题',
    '1、解决市南支行收单系统机具中心云喇叭分拨报错问题\n2、处理日常收单业务问题',
  ]);
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

test('writes separate facts for a Chinese-comma date list', async () => {
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
      sender: { sender_id: { open_id: 'ou_hu' } },
      message: {
        message_id: 'om_hu_0819_0820',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-08-20T18:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `胡仁庆8.19，8.20工作日报
1.整理商户支付合同，并且进行标号处理。
2.参加与聊城分行的线上会议，沟通校园托管相关业。
3.了解青岛中小学课后服务平台解决方案。
4.解决即东酒店支付码牌问题
5.参与慧馨特超市项目会谈`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_hu_raw' } }),
      upsertDailyFactRecord: async (_group, input) => {
        factInputs.push(input);
        return { created: true, record: { record_id: `rec_hu_${factInputs.length}` } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.deepEqual(factInputs.map(input => input.reportDate), ['2026-08-19', '2026-08-20']);
  assert.deepEqual(factInputs.map(input => input.sourceRecordId), ['rec_hu_raw', 'rec_hu_raw']);
  assert.ok(factInputs.every(input => input.workSummaryText.includes('整理商户支付合同')));
});

test('writes separate facts with isolated content for consecutive report blocks', async () => {
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
      sender: { sender_id: { open_id: 'ou_bai' } },
      message: {
        message_id: 'om_bai_0820_0821',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-08-21T18:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `白欧8.20日工作日报
1、与零售部耿总沟通银联前置业务分工问题。
2、与数办沟通银联前置其他银行的分工问题。
3、组内讨论银联前置外围系统开发变化内容。
4、协调西海岸实验中学数据迁移问题。
5、组内沟通聊城分行校园课后辅导问题。
白欧8.21工作日报
1、继续协调西海岸实验中学数据迁移问题，找到数据重复原因。
2、与测试中心沟通银联前置applepay，刷脸付，碳排放，收单商户入账，EAST,反洗钱测试情况。
3、与运管部沟通ATM机本代他转账手续费收益问题。`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createChatDailyRawRecord: async () => ({ created: true, record: { record_id: 'rec_bai_raw' } }),
      upsertDailyFactRecord: async (_group, input) => {
        factInputs.push(input);
        return { created: true, record: { record_id: `rec_bai_${factInputs.length}` } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.deepEqual(factInputs.map(input => input.reportDate), ['2026-08-20', '2026-08-21']);
  assert.match(factInputs[0].workSummaryText, /银联前置业务分工/);
  assert.doesNotMatch(factInputs[0].workSummaryText, /数据重复原因/);
  assert.match(factInputs[1].workSummaryText, /数据重复原因/);
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
