import test from 'node:test';
import assert from 'node:assert/strict';
import { BitableService } from '../src/bitable-service.js';
import { normalizeConfig } from '../src/config.js';

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
