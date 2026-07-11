import test from 'node:test';
import assert from 'node:assert/strict';
import { BitableService } from '../src/bitable-service.js';
import { normalizeConfig } from '../src/config.js';
import { buildContentFingerprint } from '../src/daily-record-utils.js';

function createGroup() {
  return normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      agileGroup: 'A组',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
      },
      weeklyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_weekly',
      },
    }],
  }).groups[0];
}

test('builds daily record fields using configured field names', () => {
  const group = createGroup();
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1', '事项2'],
    riskItems: ['风险1'],
  }, {
    messageId: 'om_1',
    chatId: 'oc_test',
    senderOpenId: 'ou_1',
    source: 'chat',
    messageTimeText: '2026/06/26 10:00:00',
  });

  assert.equal(fields['所属板块'], '支付平台');
  assert.equal(fields['今日工作总结'], '事项1\n事项2');
  assert.equal(fields['遇到的问题'], '风险1');
  assert.equal(fields['日报提交人'], '王治坤');
  assert.equal(fields['消息ID'], undefined);
});

test('creates daily record when no technical message id field exists', async () => {
  const group = createGroup();
  let createCalled = false;
  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [],
          },
        }),
        create: async (payload) => {
          createCalled = true;
          createPayload = payload;
        },
      },
    },
  });

  const result = await service.createDailyReportRecord(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  }, {
    messageId: 'om_1',
  });

  assert.equal(result.created, true);
  assert.equal(createCalled, true);
  assert.equal(createPayload.params.client_token, undefined);
});

test('resolves bitable wiki node token before writing records', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: {
        wikiUrl: 'https://example.feishu.cn/wiki/WikiNodeToken123?table=tbl_daily&view=vew_daily',
      },
    }],
  }).groups[0];
  const calls = [];
  const service = new BitableService({
    request: async (payload) => {
      calls.push(payload);
      return {
        data: {
          node: {
            obj_token: 'bas_from_wiki',
            obj_type: 'bitable',
          },
        },
      };
    },
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [],
          },
        }),
        create: async (payload) => {
          calls.push(payload);
          return {
            data: {
              record: {
                record_id: 'rec_created',
              },
            },
          };
        },
      },
    },
  });

  await service.createDailyReportRecord(group, {
    highConfidence: true,
    reportDate: '2026-07-06',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  }, {
    messageId: 'om_1',
  });

  assert.equal(calls[0].url, '/open-apis/wiki/v2/spaces/get_node?token=WikiNodeToken123');
  assert.equal(calls.find(call => call.path)?.path.app_token, 'bas_from_wiki');
  assert.equal(group.dailyTable.appToken, 'bas_from_wiki');
});

test('creates chat daily records in fact table when configured', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_source',
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          messageId: '来源消息ID',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          workItems: '今日工作总结',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
        },
      },
    }],
  }).groups[0];
  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({ data: { items: [] } }),
        create: async (payload) => {
          createPayload = payload;
          return {
            data: {
              data: {
                record: { record_id: 'rec_chat_fact', fields: payload.data.fields },
              },
            },
          };
        },
      },
    },
  });

  const result = await service.createDailyReportRecord(group, {
    highConfidence: true,
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    workSummaryText: '1、完成数据提取',
    workItems: ['完成数据提取'],
    riskItems: [],
  }, {
    messageId: 'om_1',
    senderOpenId: 'ou_liu',
  });

  assert.equal(result.created, true);
  assert.equal(createPayload.path.table_id, 'tbl_fact');
  assert.equal(createPayload.data.fields['来源消息ID'], 'om_1');
  assert.deepEqual(createPayload.data.fields['实际日报提交人'], [{ id: 'ou_liu', name: '刘喜双' }]);
  assert.equal(createPayload.data.fields['今日工作总结'], '1、完成数据提取');
});

test('reconciles form and chat sources with form priority and conflict status', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          senderOpenId: '发送人OpenID',
          project: '所属板块',
          agileGroup: '敏捷小组',
          supervisor: '直属上级',
          divisionalLeader: '分管领导',
          workItems: '今日工作总结',
          tomorrowPlanItems: '明日工作计划',
          riskItems: '遇到的问题',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          matchMethod: '匹配方式',
          matchingStatus: '匹配状态',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
          rawText: '原始内容',
          chatId: '群ID',
          messageTime: '消息时间',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
          divisionalLeader: 'user',
        },
      },
    }],
  }).groups[0];

  let updatePayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_fact',
              fields: {
                事实唯一键: 'open_id:ou_liu:2026-07-01',
                今日工作总结: '1、群聊内容',
                内容指纹: 'chat-fingerprint',
                日报来源: 'chat',
              },
            }],
          },
        }),
        update: async (payload) => {
          updatePayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、表单内容',
    tomorrowPlanItems: '2、表单明日计划',
    riskItems: '3、表单风险',
    source: 'form',
    sourceRecordId: 'rec_form',
    messageId: 'om_chat',
    existingChatFingerprint: 'chat-fingerprint',
  });

  assert.equal(result.updated, true);
  assert.equal(updatePayload.path.record_id, 'rec_fact');
  assert.equal(updatePayload.data.fields['日报来源'], 'form+chat');
  assert.equal(updatePayload.data.fields['今日工作总结'], '1、表单内容');
  assert.equal(updatePayload.data.fields['明日工作计划'], '2、表单明日计划');
  assert.equal(updatePayload.data.fields['遇到的问题'], '3、表单风险');
  assert.equal(updatePayload.data.fields['合并状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['冲突状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['事实记录状态'], '待人工确认');
});

test('marks same-content form and chat facts as duplicate merged without conflict', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          senderOpenId: '发送人OpenID',
          workItems: '今日工作总结',
          tomorrowPlanItems: '明日工作计划',
          riskItems: '遇到的问题',
          project: '所属板块',
          agileGroup: '敏捷小组',
          supervisor: '直属上级',
          divisionalLeader: '分管领导',
          rawText: '原始内容',
          chatId: '群ID',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          messageTime: '消息时间',
          matchMethod: '匹配方式',
          matchingStatus: '匹配状态',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
          divisionalLeader: 'user',
        },
      },
    }],
  }).groups[0];
  const sameFingerprint = buildContentFingerprint({
    workItems: '1、相同内容',
    tomorrowPlanItems: '2、相同计划',
    riskItems: '3、相同风险',
  });

  let updatePayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_fact',
              fields: {
                事实唯一键: 'open_id:ou_liu:2026-07-01',
                今日工作总结: '1、相同内容',
                明日工作计划: '2、相同计划',
                遇到的问题: '3、相同风险',
                内容指纹: sameFingerprint,
                日报来源: 'chat',
                来源消息ID: 'om_chat',
              },
            }],
          },
        }),
        update: async (payload) => {
          updatePayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、相同内容',
    tomorrowPlanItems: '2、相同计划',
    riskItems: '3、相同风险',
    source: 'form',
    sourceRecordId: 'rec_form',
  });

  assert.equal(result.updated, true);
  assert.equal(updatePayload.data.fields['日报来源'], 'form+chat');
  assert.equal(updatePayload.data.fields['合并状态'], '重复已合并');
  assert.equal(updatePayload.data.fields['冲突状态'], '无冲突');
  assert.equal(updatePayload.data.fields['事实记录状态'], '有效');
});

test('preserves existing form content when later chat source conflicts', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          senderOpenId: '发送人OpenID',
          project: '所属板块',
          agileGroup: '敏捷小组',
          supervisor: '直属上级',
          divisionalLeader: '分管领导',
          workItems: '今日工作总结',
          tomorrowPlanItems: '明日工作计划',
          riskItems: '遇到的问题',
          rawText: '原始内容',
          chatId: '群ID',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          messageTime: '消息时间',
          matchMethod: '匹配方式',
          matchingStatus: '匹配状态',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
          divisionalLeader: 'user',
        },
      },
    }],
  }).groups[0];

  const existingFingerprint = buildContentFingerprint({
    workItems: '1、表单内容',
    tomorrowPlanItems: '2、表单明日计划',
    riskItems: '3、表单风险',
  });
  let updatePayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_fact',
              fields: {
                事实唯一键: 'open_id:ou_liu:2026-07-01',
                实际日报提交人: [{ id: 'ou_liu', name: '刘喜双' }],
                日报提交人姓名: '刘喜双',
                成员OpenID: 'ou_liu',
                发送人OpenID: 'ou_form_sender',
                所属板块: '表单板块',
                敏捷小组: '表单敏捷组',
                今日工作总结: { text: '1、表单内容' },
                明日工作计划: ['2、表单明日计划'],
                遇到的问题: { text: '3、表单风险' },
                内容指纹: existingFingerprint,
                日报来源: 'form+chat',
                来源记录ID: 'rec_form',
                来源组合: 'form:rec_form',
                直属上级: [{ id: 'ou_mgr', name: '王经理' }],
                分管领导: [{ id: 'ou_leader', name: '赵总' }],
                匹配方式: 'open_id',
                匹配状态: '已匹配',
                原始内容: '表单原始内容',
                群ID: 'oc_form',
                消息时间: '2026/07/01 09:00:00',
              },
            }],
          },
        }),
        update: async (payload) => {
          updatePayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、群聊不同内容',
    tomorrowPlanItems: '2、群聊不同计划',
    riskItems: '3、群聊不同风险',
    source: 'chat',
    sourceRecordId: 'rec_raw',
    messageId: 'om_chat',
    project: '群聊板块',
    agileGroup: '群聊敏捷组',
    rawText: '群聊原始内容',
    chatId: 'oc_chat',
    messageTime: '2026/07/01 18:00:00',
  });

  assert.equal(result.updated, true);
  assert.equal(updatePayload.data.fields['日报来源'], 'form+chat');
  assert.deepEqual(updatePayload.data.fields['实际日报提交人'], [{ id: 'ou_liu', name: '刘喜双' }]);
  assert.equal(updatePayload.data.fields['日报提交人姓名'], '刘喜双');
  assert.equal(updatePayload.data.fields['成员OpenID'], 'ou_liu');
  assert.equal(updatePayload.data.fields['发送人OpenID'], 'ou_form_sender');
  assert.equal(updatePayload.data.fields['来源记录ID'], 'rec_form');
  assert.equal(updatePayload.data.fields['所属板块'], '表单板块');
  assert.equal(updatePayload.data.fields['敏捷小组'], '表单敏捷组');
  assert.equal(updatePayload.data.fields['今日工作总结'], '1、表单内容');
  assert.equal(updatePayload.data.fields['明日工作计划'], '2、表单明日计划');
  assert.equal(updatePayload.data.fields['遇到的问题'], '3、表单风险');
  assert.deepEqual(updatePayload.data.fields['直属上级'], [{ id: 'ou_mgr', name: '王经理' }]);
  assert.deepEqual(updatePayload.data.fields['分管领导'], [{ id: 'ou_leader', name: '赵总' }]);
  assert.equal(updatePayload.data.fields['匹配方式'], 'open_id');
  assert.equal(updatePayload.data.fields['匹配状态'], '已匹配');
  assert.equal(updatePayload.data.fields['原始内容'], '表单原始内容');
  assert.equal(updatePayload.data.fields['群ID'], 'oc_form');
  assert.equal(updatePayload.data.fields['消息时间'], '2026/07/01 09:00:00');
  assert.equal(updatePayload.data.fields['内容指纹'], existingFingerprint);
  assert.equal(updatePayload.data.fields['合并状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['冲突状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['事实记录状态'], '待人工确认');
  assert.equal(updatePayload.data.fields['来源组合'], 'form:rec_form\nchat_raw:rec_raw\nchat:om_chat');
});

test('merges existing chat source refs when incoming form source wins', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          workItems: '今日工作总结',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: { reportDate: 'date' },
      },
    }],
  }).groups[0];

  let updatePayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_fact',
              fields: {
                事实唯一键: 'open_id:ou_liu:2026-07-01',
                今日工作总结: '1、群聊内容',
                内容指纹: buildContentFingerprint({ workItems: '1、群聊内容' }),
                日报来源: 'chat',
                来源消息ID: 'om_old',
                来源组合: 'chat:om_old',
              },
            }],
          },
        }),
        update: async (payload) => {
          updatePayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、表单内容',
    source: 'form',
    sourceRecordId: 'rec_form',
  });

  assert.equal(result.updated, true);
  assert.equal(updatePayload.data.fields['日报来源'], 'form+chat');
  assert.equal(updatePayload.data.fields['今日工作总结'], '1、表单内容');
  assert.equal(updatePayload.data.fields['来源记录ID'], 'rec_form');
  assert.equal(updatePayload.data.fields['来源消息ID'], 'om_old');
  assert.equal(updatePayload.data.fields['来源组合'], 'chat:om_old\nform:rec_form');
});

test('writes reporter user field from member open id for daily fact upsert', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          workItems: '今日工作总结',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
        },
      },
    }],
  }).groups[0];

  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({ data: { items: [] } }),
        create: async (payload) => {
          createPayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、群聊内容',
    source: 'chat',
    messageId: 'om_chat',
  });

  assert.equal(result.created, true);
  assert.deepEqual(createPayload.data.fields['实际日报提交人'], [{ id: 'ou_liu', name: '刘喜双' }]);
});

test('creates chat raw daily record and marks previous version historical', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: {
        appToken: 'bas',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          chatId: '群ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDateRange: '日报日期范围',
          reportDates: '拆分日期列表',
          rawText: '原始消息文本',
          workSummaryText: '解析后工作总结',
          contentFingerprint: '内容指纹',
          rawRecordStatus: '原始记录状态',
        },
      },
    }],
  }).groups[0];

  const updates = [];
  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_old',
              fields: {
                发送人OpenID: 'ou_liu',
                拆分日期列表: '2026-07-01',
                原始记录状态: '主版本',
              },
            }],
          },
        }),
        update: async (payload) => {
          updates.push(payload);
          return { data: { data: { record: { record_id: payload.path.record_id } } } };
        },
        create: async (payload) => {
          createPayload = payload;
          return { data: { data: { record: { record_id: 'rec_new', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.createChatDailyRawRecord(group, {
    reporterName: '刘喜双',
    reportDate: '2026-07-01',
    reportDates: ['2026-07-01'],
    dateRange: '2026-07-01',
    reportType: '单日',
    rawText: '刘喜双7.1工作日报\n1、完成数据提取',
    workSummaryText: '1、完成数据提取',
    workItems: ['完成数据提取'],
  }, {
    messageId: 'om_new',
    chatId: 'oc_test',
    senderOpenId: 'ou_liu',
  });

  assert.equal(result.created, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].path.record_id, 'rec_old');
  assert.equal(updates[0].data.fields['原始记录状态'], '历史版本');
  assert.equal(createPayload.data.fields['消息ID'], 'om_new');
  assert.equal(createPayload.data.fields['原始记录状态'], '主版本');
  assert.equal(createPayload.data.fields['拆分日期列表'], '2026-07-01');
  assert.equal(createPayload.data.fields['内容指纹'], buildContentFingerprint({
    workItems: '1、完成数据提取',
  }));
  assert.equal(result.historicalUpdated, 1);
});

test('does not mark blank-identity chat raw rows historical', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: {
        appToken: 'bas',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDates: '拆分日期列表',
          rawRecordStatus: '原始记录状态',
        },
      },
    }],
  }).groups[0];

  const updates = [];
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_blank',
              fields: {
                发送人OpenID: '',
                标题姓名: '',
                拆分日期列表: '2026-07-01',
                原始记录状态: '主版本',
              },
            }],
          },
        }),
        create: async (payload) => (
          { data: { data: { record: { record_id: 'rec_new', fields: payload.data.fields } } } }
        ),
        update: async (payload) => {
          updates.push(payload);
          return { data: { data: { record: { record_id: payload.path.record_id } } } };
        },
      },
    },
  });

  const result = await service.createChatDailyRawRecord(group, {
    reportDate: '2026-07-01',
    reportDates: ['2026-07-01'],
    workSummaryText: '1、完成数据提取',
  }, {
    messageId: 'om_new',
  });

  assert.equal(result.created, true);
  assert.equal(result.historicalUpdated, 0);
  assert.equal(updates.length, 0);
});

test('does not update chat raw history when create fails', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: {
        appToken: 'bas',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDates: '拆分日期列表',
          rawRecordStatus: '原始记录状态',
        },
      },
    }],
  }).groups[0];

  let listCalled = false;
  let updateCalled = false;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => {
          listCalled = true;
          return { data: { items: [] } };
        },
        create: async () => {
          throw new Error('create failed');
        },
        update: async () => {
          updateCalled = true;
        },
      },
    },
  });

  await assert.rejects(
    () => service.createChatDailyRawRecord(group, {
      reporterName: '刘喜双',
      reportDate: '2026-07-01',
      reportDates: ['2026-07-01'],
      workSummaryText: '1、完成数据提取',
    }, {
      messageId: 'om_new',
      senderOpenId: 'ou_liu',
    }),
    /create failed/,
  );

  assert.equal(listCalled, false);
  assert.equal(updateCalled, false);
});

test('marks only overlapping main chat raw records historical for multi-day report', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: {
        appToken: 'bas',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDates: '拆分日期列表',
          rawRecordStatus: '原始记录状态',
        },
      },
    }],
  }).groups[0];

  const updates = [];
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [
              {
                record_id: 'rec_new',
                fields: {
                  消息ID: 'om_new',
                  发送人OpenID: 'ou_liu',
                  标题姓名: '刘喜双',
                  拆分日期列表: '2026-07-01\n2026-07-02',
                  原始记录状态: '主版本',
                },
              },
              {
                record_id: 'rec_overlap',
                fields: {
                  消息ID: 'om_old_1',
                  发送人OpenID: 'ou_liu',
                  拆分日期列表: '2026-07-02',
                  原始记录状态: '主版本',
                },
              },
              {
                record_id: 'rec_non_overlap',
                fields: {
                  消息ID: 'om_old_2',
                  发送人OpenID: 'ou_liu',
                  拆分日期列表: '2026-07-03',
                  原始记录状态: '主版本',
                },
              },
              {
                record_id: 'rec_history',
                fields: {
                  消息ID: 'om_old_3',
                  发送人OpenID: 'ou_liu',
                  拆分日期列表: '2026-07-01',
                  原始记录状态: '历史版本',
                },
              },
            ],
          },
        }),
        create: async (payload) => (
          { data: { data: { record: { record_id: 'rec_new', fields: payload.data.fields } } } }
        ),
        update: async (payload) => {
          updates.push(payload);
          return { data: { data: { record: { record_id: payload.path.record_id } } } };
        },
      },
    },
  });

  const result = await service.createChatDailyRawRecord(group, {
    reporterName: '刘喜双',
    reportDate: '2026-07-01',
    reportDates: ['2026-07-01', '2026-07-02'],
    workSummaryText: '1、完成数据提取',
  }, {
    messageId: 'om_new',
    senderOpenId: 'ou_liu',
  });

  assert.equal(result.historicalUpdated, 1);
  assert.deepEqual(updates.map(update => update.path.record_id), ['rec_overlap']);
});

test('extracts created record from axios-wrapped bitable response', async () => {
  const group = createGroup();
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          status: 200,
          data: {
            code: 0,
            msg: 'success',
            data: { items: [] },
          },
        }),
        create: async () => ({
          status: 200,
          data: {
            code: 0,
            msg: 'success',
            data: {
              record: {
                record_id: 'rec_new',
                fields: { 日报提交人: '王治坤' },
              },
            },
          },
        }),
      },
    },
  });

  const result = await service.createDailyReportRecord(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  });

  assert.equal(result.created, true);
  assert.equal(result.record.record_id, 'rec_new');
  assert.equal(result.responseSummary.code, 0);
  assert.equal(result.responseSummary.recordId, 'rec_new');
});

test('formats configured date fields as millisecond timestamps', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
        fieldTypes: {
          reportDate: 'date',
        },
      },
    }],
  }).groups[0];
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  });

  assert.equal(fields['日报日期'], Date.UTC(2026, 5, 26));
});

test('formats configured datetime fields as millisecond timestamps', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
        fields: {
          messageTime: '消息时间',
        },
        fieldTypes: {
          messageTime: 'datetime',
        },
      },
    }],
  }).groups[0];
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-07-06',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  }, {
    messageTimeText: '2026/07/06 11:13:50',
  });

  assert.equal(fields['消息时间'], Date.parse('2026-07-06T03:13:50.000Z'));
});

test('skips configured user fields when no open id is available', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fieldTypes: {
          reporterName: 'user',
        },
      },
    }],
  }).groups[0];
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-07-06',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  }, {
    table: group.dailyFactTable,
  });

  assert.equal(fields['实际日报提交人'], undefined);
});

test('writes only configured daily fields and preserves numbered summary text', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
        fields: {
          reportDate: '日报日期',
          reporterName: '日报提交人',
          workItems: '今日工作总结',
          riskItems: '遇到的问题',
          aiSummary: 'AI汇总',
          supervisor: '直属上级',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
        },
        writeFields: ['reportDate', 'reporterName', 'workItems', 'supervisor'],
      },
    }],
  }).groups[0];
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    rawText: '原文',
    workSummaryText: `1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`,
    workItems: [
      '与技术沟通开发区一中云充值取数逻辑问题，完成数据提取',
      '整理千分卡考核指标，完成填报',
    ],
    riskItems: ['问题不应写入'],
  }, {
    senderOpenId: 'ou_liu',
    contact: {
      supervisor: '王经理',
      supervisorOpenId: 'ou_mgr',
    },
  });

  assert.equal(fields['日报日期'], Date.UTC(2026, 6, 1));
  assert.deepEqual(fields['日报提交人'], [{ id: 'ou_liu', name: '刘喜双' }]);
  assert.equal(fields['今日工作总结'], `1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`);
  assert.deepEqual(fields['直属上级'], [{ id: 'ou_mgr', name: '王经理' }]);
  assert.equal(fields['遇到的问题'], undefined);
  assert.equal(fields['AI汇总'], undefined);
});

test('syncs source form daily records into fact table with contact enrichment', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '默认板块',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_source',
        fields: {
          reportDate: '日报日期',
          reporterName: '日报提交人',
          workItems: '今日工作总结',
          tomorrowPlanItems: '明日工作计划',
          riskItems: '遇到的问题',
          supervisor: '直属上级',
        },
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          sourceRecordId: '来源记录ID',
          source: '日报来源',
          reportDate: '日报日期',
          project: '所属板块',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          workItems: '今日工作总结',
          supervisor: '直属上级',
          matchingStatus: '匹配状态',
          syncedAt: '同步时间',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
        },
        writeFields: [
          'sourceRecordId',
          'source',
          'reportDate',
          'project',
          'reporterName',
          'reporterNameText',
          'workItems',
          'supervisor',
          'matchingStatus',
          'syncedAt',
        ],
      },
      contactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_contacts',
      },
    }],
  }).groups[0];
  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path }) => {
          if (path.table_id === 'tbl_source') {
            return {
              data: {
                items: [{
                  record_id: 'rec_source_1',
                  fields: {
                    日报日期: Date.UTC(2026, 6, 1),
                    日报提交人: [{ id: 'ou_liu', name: '刘喜双' }],
                    今日工作总结: `1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`,
                  },
                }],
              },
            };
          }
          if (path.table_id === 'tbl_chat_raw') {
            return { data: { items: [] } };
          }
          if (path.table_id === 'tbl_fact') {
            return { data: { items: [] } };
          }
          if (path.table_id === 'tbl_contacts') {
            return {
              data: {
                items: [{
                  record_id: 'rec_contact',
                  fields: {
                    团队名称: '渠道创新建设',
                    团队成员: [{ id: 'ou_liu', name: '刘喜双' }],
                    直属上级: [{ id: 'ou_mgr', name: '王经理' }],
                  },
                }],
              },
            };
          }
          return { data: { items: [] } };
        },
        create: async (payload) => {
          createPayload = payload;
          return {
            data: {
              data: {
                record: { record_id: 'rec_fact_1', fields: payload.data.fields },
              },
            },
          };
        },
      },
    },
  });

  const result = await service.syncDailyFactRecordsForGroup(group, {
    now: new Date('2026-07-03T10:10:00.000Z'),
    timezone: 'Asia/Shanghai',
    lookbackDays: 7,
  });

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(createPayload.path.table_id, 'tbl_fact');
  assert.equal(createPayload.data.fields['来源记录ID'], 'rec_source_1');
  assert.equal(createPayload.data.fields['日报来源'], 'form');
  assert.equal(createPayload.data.fields['日报日期'], Date.UTC(2026, 6, 1));
  assert.equal(createPayload.data.fields['所属板块'], '渠道创新建设');
  assert.deepEqual(createPayload.data.fields['实际日报提交人'], [{ id: 'ou_liu', name: '刘喜双' }]);
  assert.equal(createPayload.data.fields['日报提交人姓名'], '刘喜双');
  assert.equal(createPayload.data.fields['今日工作总结'], `1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`);
  assert.deepEqual(createPayload.data.fields['直属上级'], [{ id: 'ou_mgr', name: '王经理' }]);
  assert.equal(createPayload.data.fields['匹配状态'], '已匹配');
});

test('skips daily fact sync when any source or fact table is not configured', async () => {
  const configured = {
    dailyTable: { appToken: 'bas_test', tableId: 'tbl_source' },
    chatDailyRawTable: { appToken: 'bas_test', tableId: 'tbl_chat_raw' },
    dailyFactTable: { appToken: 'bas_test', tableId: 'tbl_fact' },
  };
  const cases = [
    { dailyTable: null },
    { chatDailyRawTable: null },
    { dailyFactTable: null },
  ];

  for (const override of cases) {
    const group = normalizeConfig({
      groups: [{
        chatId: 'oc_test',
        ...configured,
        ...override,
      }],
    }).groups[0];
    const service = new BitableService({});
    const result = await service.syncDailyFactRecordsForGroup(group);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /not configured/);
  }
});

test('syncs main chat raw records into fact table for each report date', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      agileGroup: 'A组',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_source',
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          chatId: '群ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDateRange: '日报日期范围',
          reportDates: '拆分日期列表',
          rawText: '原始消息文本',
          workSummaryText: '解析后工作总结',
          messageTime: '消息时间',
          rawRecordStatus: '原始记录状态',
        },
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          project: '所属板块',
          agileGroup: '敏捷小组',
          workItems: '今日工作总结',
          rawText: '原始消息文本',
          chatId: '群ID',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          reportType: '日报类型',
          dateRange: '日期覆盖范围',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: { reportDate: 'date' },
      },
    }],
  }).groups[0];

  const creates = [];
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path }) => {
          if (path.table_id === 'tbl_source') return { data: { items: [] } };
          if (path.table_id === 'tbl_fact') return { data: { items: [] } };
          if (path.table_id === 'tbl_chat_raw') {
            return {
              data: {
                items: [
                  {
                    record_id: 'rec_raw_main',
                    fields: {
                      消息ID: 'om_chat',
                      群ID: 'oc_test',
                      发送人OpenID: 'ou_liu',
                      标题姓名: '刘喜双',
                      日报日期范围: '2026-07-01~2026-07-02',
                      拆分日期列表: '2026-07-01\n2026-07-02',
                      原始消息文本: '刘喜双7.1-7.2日报',
                      解析后工作总结: '1、完成数据提取',
                      消息时间: '2026/07/02 10:00:00',
                      原始记录状态: '主版本',
                    },
                  },
                  {
                    record_id: 'rec_raw_history',
                    fields: {
                      消息ID: 'om_old',
                      发送人OpenID: 'ou_liu',
                      标题姓名: '刘喜双',
                      拆分日期列表: '2026-07-01',
                      原始记录状态: '历史版本',
                    },
                  },
                ],
              },
            };
          }
          return { data: { items: [] } };
        },
        create: async (payload) => {
          creates.push(payload);
          return { data: { data: { record: { record_id: `rec_fact_${creates.length}`, fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.syncDailyFactRecordsForGroup(group, {
    now: new Date('2026-07-03T10:10:00.000Z'),
    timezone: 'Asia/Shanghai',
    lookbackDays: 3,
  });

  assert.equal(result.created, 2);
  assert.equal(result.filtered, 1);
  assert.equal(result.sourceCounts.chatRaw, 2);
  assert.equal(result.sourceCounts.chatFacts, 2);
  assert.deepEqual(creates.map(payload => payload.data.fields['日报日期']), [
    Date.UTC(2026, 6, 1),
    Date.UTC(2026, 6, 2),
  ]);
  assert.equal(creates[0].data.fields['事实唯一键'], 'open_id:ou_liu:2026-07-01');
  assert.equal(creates[0].data.fields['日报来源'], 'chat');
  assert.equal(creates[0].data.fields['来源记录ID'], 'rec_raw_main');
  assert.equal(creates[0].data.fields['来源消息ID'], 'om_chat');
  assert.equal(creates[0].data.fields['来源组合'], 'chat_raw:rec_raw_main\nchat:om_chat');
  assert.equal(creates[0].data.fields['今日工作总结'], '1、完成数据提取');
  assert.equal(creates[0].data.fields['原始消息文本'], '刘喜双7.1-7.2日报');
  assert.equal(creates[0].data.fields['日期覆盖范围'], '2026-07-01~2026-07-02');
});

test('syncs chat raw facts with reporter real name from contact table', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '默认板块',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_source',
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDates: '拆分日期列表',
          workSummaryText: '解析后工作总结',
          rawRecordStatus: '原始记录状态',
        },
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          project: '所属板块',
          agileGroup: '敏捷小组',
          supervisor: '直属上级',
          workItems: '今日工作总结',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
        },
        fieldTypes: {
          reportDate: 'date',
          reporterName: 'user',
          supervisor: 'user',
        },
      },
      contactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_contacts',
        fields: {
          teamName: '团队名称',
          teamMember: '团队成员',
          memberRealName: '成员真实姓名',
          memberAliases: '成员别名',
          currentOpenId: '当前OpenID',
          agileGroup: '敏捷小组',
          supervisor: '直属上级',
        },
      },
    }],
  }).groups[0];

  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path }) => {
          if (path.table_id === 'tbl_source') return { data: { items: [] } };
          if (path.table_id === 'tbl_fact') return { data: { items: [] } };
          if (path.table_id === 'tbl_chat_raw') {
            return {
              data: {
                items: [{
                  record_id: 'rec_raw',
                  fields: {
                    消息ID: 'om_chat',
                    发送人OpenID: 'ou_external',
                    标题姓名: '小刘',
                    拆分日期列表: '2026-07-01',
                    解析后工作总结: '1、完成数据提取',
                    原始记录状态: '主版本',
                  },
                }],
              },
            };
          }
          if (path.table_id === 'tbl_contacts') {
            return {
              data: {
                items: [{
                  record_id: 'rec_contact',
                  fields: {
                    团队名称: '渠道创新建设',
                    团队成员: [{ id: 'ou_external', name: '用户709677' }],
                    成员真实姓名: '刘喜双',
                    成员别名: '小刘',
                    当前OpenID: 'ou_external',
                    敏捷小组: '收单项目组',
                    直属上级: [{ id: 'ou_mgr', name: '王经理' }],
                  },
                }],
              },
            };
          }
          return { data: { items: [] } };
        },
        create: async (payload) => {
          createPayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.syncDailyFactRecordsForGroup(group, {
    now: new Date('2026-07-03T10:10:00.000Z'),
    timezone: 'Asia/Shanghai',
    lookbackDays: 3,
  });

  assert.equal(result.created, 1);
  assert.equal(createPayload.data.fields['事实唯一键'], 'open_id:ou_external:2026-07-01');
  assert.deepEqual(createPayload.data.fields['实际日报提交人'], [{ id: 'ou_external', name: '刘喜双' }]);
  assert.equal(createPayload.data.fields['日报提交人姓名'], '刘喜双');
  assert.equal(createPayload.data.fields['成员OpenID'], 'ou_external');
  assert.equal(createPayload.data.fields['所属板块'], '渠道创新建设');
  assert.equal(createPayload.data.fields['敏捷小组'], '收单项目组');
  assert.deepEqual(createPayload.data.fields['直属上级'], [{ id: 'ou_mgr', name: '王经理' }]);
});

test('reuses newly created form fact when syncing matching chat raw in the same run', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_source',
        fields: {
          reportDate: '日报日期',
          reporterName: '日报提交人',
          workItems: '今日工作总结',
        },
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDates: '拆分日期列表',
          workSummaryText: '解析后工作总结',
          rawRecordStatus: '原始记录状态',
        },
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          workItems: '今日工作总结',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: { reportDate: 'date' },
      },
      contactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_contacts',
      },
    }],
  }).groups[0];

  const creates = [];
  const updates = [];
  let sourceListParams;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path, params }) => {
          if (path.table_id === 'tbl_source') {
            sourceListParams = params;
            return {
              data: {
                items: [{
                  record_id: 'rec_form',
                  created_time: 1783690000000,
                  last_modified_time: 1783699200123,
                  fields: {
                    日报日期: Date.UTC(2026, 6, 1),
                    日报提交人: [{ id: 'ou_liu', name: '刘喜双' }],
                    今日工作总结: '1、表单内容',
                  },
                }],
              },
            };
          }
          if (path.table_id === 'tbl_chat_raw') {
            return {
              data: {
                items: [{
                  record_id: 'rec_raw',
                  fields: {
                    消息ID: 'om_chat',
                    发送人OpenID: 'ou_liu',
                    标题姓名: '刘喜双',
                    拆分日期列表: '2026-07-01',
                    解析后工作总结: '1、群聊内容',
                    原始记录状态: '主版本',
                  },
                }],
              },
            };
          }
          if (path.table_id === 'tbl_contacts') {
            return {
              data: {
                items: [{
                  record_id: 'rec_contact',
                  fields: {
                    团队成员: [{ id: 'ou_liu', name: '刘喜双' }],
                  },
                }],
              },
            };
          }
          if (path.table_id === 'tbl_fact') return { data: { items: [] } };
          return { data: { items: [] } };
        },
        create: async (payload) => {
          creates.push(payload);
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
        update: async (payload) => {
          updates.push(payload);
          return { data: { data: { record: { record_id: payload.path.record_id, fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.syncDailyFactRecordsForGroup(group, {
    now: new Date('2026-07-03T10:10:00.000Z'),
    timezone: 'Asia/Shanghai',
    lookbackDays: 3,
  });

  assert.equal(result.created, 1);
  assert.equal(sourceListParams.automatic_fields, true);
  assert.equal(result.updated, 1);
  assert.equal(creates.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].path.record_id, 'rec_fact');
  assert.equal(updates[0].data.fields['日报来源'], 'form+chat');
  assert.equal(updates[0].data.fields['来源记录ID'], 'rec_form');
  assert.equal(updates[0].data.fields['来源组合'], 'form:rec_form\nchat_raw:rec_raw\nchat:om_chat');
  assert.equal(updates[0].data.fields['来源时间'], 1783699200123);
});

test('throws when bitable returns a non-zero business code', async () => {
  const group = createGroup();
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          status: 200,
          data: {
            code: 0,
            data: { items: [] },
          },
        }),
        create: async () => ({
          status: 200,
          data: {
            code: 1254037,
            msg: 'Invalid client token',
            data: {},
          },
        }),
      },
    },
  });

  await assert.rejects(
    () => service.createDailyReportRecord(group, {
      highConfidence: true,
      reportDate: '2026-06-26',
      reporterName: '王治坤',
      rawText: '原文',
      workItems: ['事项1'],
      riskItems: [],
    }),
    /code=1254037/,
  );
});

test('does not create duplicate daily records when message id field is configured', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
        fields: {
          messageId: '消息ID',
        },
      },
    }],
  }).groups[0];
  let createCalled = false;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{ record_id: 'rec_existing', fields: { 消息ID: 'om_1' } }],
          },
        }),
        create: async () => {
          createCalled = true;
        },
      },
    },
  });

  const result = await service.createDailyReportRecord(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    riskItems: [],
  }, {
    messageId: 'om_1',
  });

  assert.equal(result.created, false);
  assert.equal(result.record.record_id, 'rec_existing');
  assert.equal(createCalled, false);
});

test('filters daily records by project and work week', async () => {
  const group = createGroup();
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [
              { record_id: 'rec_1', fields: { 所属板块: '支付平台', 日报日期: '2026-06-22', 日报提交人: 'A', 今日工作总结: '事项A' } },
              { record_id: 'rec_2', fields: { 所属板块: '其他平台', 日报日期: '2026-06-23', 日报提交人: 'B', 今日工作总结: '事项B' } },
              { record_id: 'rec_3', fields: { 所属板块: '支付平台', 日报日期: '2026-06-29', 日报提交人: 'C', 今日工作总结: '事项C' } },
            ],
          },
        }),
      },
    },
  });

  const reports = await service.listDailyReportsForWeek(group, '2026-06-22', '2026-06-26');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reporterName, 'A');
});

test('uses contact table to enrich team name and supervisor', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '默认板块',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
      },
      contactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_contacts',
      },
    }],
  }).groups[0];
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async ({ path }) => {
          if (path.table_id === 'tbl_contacts') {
            return {
              data: {
                items: [{
                  record_id: 'rec_contact',
                  fields: {
                    团队名称: '支付平台',
                    团队成员: [{ id: 'ou_1', name: '王治坤' }],
                    团队身份: '成员',
                    直属上级: [{ id: 'ou_mgr', name: '张经理' }],
                  },
                }],
              },
            };
          }
          return { data: { items: [] } };
        },
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '王治坤', senderOpenId: 'ou_1' });
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-06-26',
    reporterName: '王治坤',
    rawText: '原文',
    workItems: ['事项1'],
    tomorrowPlanItems: ['计划1'],
    riskItems: ['问题1'],
  }, {
    senderOpenId: 'ou_1',
    contact,
  });

  assert.equal(contact.teamName, '支付平台');
  assert.equal(fields['所属板块'], '支付平台');
  assert.equal(fields['直属上级'], '张经理');
  assert.equal(fields['明日工作计划'], '计划1');
});

test('matches contact by open id and uses real name for display', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      contactTable: {
        appToken: 'bas',
        tableId: 'tbl_contacts',
        fields: {
          teamName: '团队名称',
          teamMember: '团队成员',
          memberRealName: '成员真实姓名',
          memberAliases: '成员别名',
          currentOpenId: '当前OpenID',
          supervisor: '直属上级',
          divisionalLeader: '分管领导',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_contact',
              fields: {
                团队名称: '零售大众客群经营',
                团队成员: [{ id: 'ou_external', name: '用户400276' }],
                成员真实姓名: '刘喜双',
                成员别名: '喜双\n小刘',
                当前OpenID: 'ou_external',
                直属上级: [{ id: 'ou_mgr', name: '王经理' }],
                分管领导: [{ id: 'ou_leader', name: '李总' }],
              },
            }],
          },
        }),
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '刘喜双', senderOpenId: 'ou_external' });
  assert.equal(contact.teamMember, '刘喜双');
  assert.equal(contact.accountDisplayName, '用户400276');
  assert.equal(contact.teamMemberId, 'ou_external');
  assert.equal(contact.matchMethod, 'open_id');
  assert.equal(contact.matchingStatus, '已匹配');
  assert.equal(contact.divisionalLeader, '李总');
  assert.equal(contact.divisionalLeaderOpenId, 'ou_leader');
});

test('matches contact by alias when open id is unavailable', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      contactTable: {
        appToken: 'bas',
        tableId: 'tbl_contacts',
        fields: {
          teamMember: '团队成员',
          memberRealName: '成员真实姓名',
          memberAliases: '成员别名',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_contact',
              fields: {
                团队成员: [{ id: 'ou_1', name: '用户400276' }],
                成员真实姓名: '刘喜双',
                成员别名: '喜双\n小刘',
              },
            }],
          },
        }),
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '小刘' });
  assert.equal(contact.teamMember, '刘喜双');
  assert.equal(contact.matchMethod, 'name_fallback');
  assert.equal(contact.matchingStatus, '姓名匹配');
});

test('matches contact by member real name field alias', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      contactTable: {
        appToken: 'bas',
        tableId: 'tbl_contacts',
        fields: {
          teamName: '团队名称',
          teamMember: '团队成员',
          teamRole: '团队身份',
          supervisor: '直属上级',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_contact',
              fields: {
                团队名称: '公司项目组',
                团队成员: [{ id: 'ou_external', name: '用户709677' }],
                成员真实名称: '刘喜双',
                直属上级: [{ id: 'ou_mgr', name: '王经理' }],
              },
            }],
          },
        }),
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '刘喜双' });
  assert.equal(contact.teamMember, '刘喜双');
  assert.equal(contact.teamMemberId, 'ou_external');
  assert.equal(contact.supervisor, '王经理');
  assert.equal(contact.supervisorOpenId, 'ou_mgr');
});

test('builds contact-enriched daily fields from real directory identity', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '默认板块',
      agileGroup: '默认敏捷组',
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          reporterName: '实际日报提交人',
          reporterNameText: '日报提交人姓名',
          agileGroup: '敏捷小组',
          divisionalLeader: '分管领导',
        },
        fieldTypes: {
          reporterName: 'user',
          divisionalLeader: 'user',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    highConfidence: true,
    reportDate: '2026-07-03',
    reporterName: '用户400276',
    workItems: [],
    riskItems: [],
  }, {
    senderOpenId: 'ou_old',
    contact: {
      teamMember: '刘喜双',
      teamMemberId: 'ou_external',
      accountDisplayName: '用户400276',
      agileGroup: '敏捷一组',
      divisionalLeader: '李总',
      divisionalLeaderOpenId: 'ou_leader',
    },
  });

  assert.equal(fields['日报提交人姓名'], '刘喜双');
  assert.deepEqual(fields['实际日报提交人'], [{ id: 'ou_external', name: '刘喜双' }]);
  assert.equal(fields['敏捷小组'], '敏捷一组');
  assert.deepEqual(fields['分管领导'], [{ id: 'ou_leader', name: '李总' }]);
});

test('normalizes supervisor user field from daily report records', async () => {
  const group = createGroup();
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_1',
              fields: {
                所属板块: '支付平台',
                日报日期: '2026-06-29',
                日报提交人: [{ id: 'ou_1', name: '王治坤' }],
                今日工作总结: '完成案例评审',
                明日工作计划: '推进联调',
                遇到的问题: '上线依赖待协调',
                直属上级: [{ id: 'ou_mgr', name: '张经理' }],
              },
            }],
          },
        }),
      },
    },
  });

  const reports = await service.listDailyReportsForDate(group, '2026-06-29');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reporterName, '王治坤');
  assert.equal(reports[0].senderOpenId, 'ou_1');
  assert.equal(reports[0].supervisor, '张经理');
  assert.equal(reports[0].supervisorOpenId, 'ou_mgr');
});
