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
