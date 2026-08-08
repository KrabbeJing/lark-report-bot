import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupervisorDigestText,
  groupReportsBySupervisor,
  pushDailyReportsToSupervisors,
} from '../src/daily-supervisor-push.js';

test('groups reports by supervisor open id', () => {
  const groups = groupReportsBySupervisor([
    { supervisor: '张经理', supervisorOpenId: 'ou_mgr', reporterName: '王治坤' },
    { supervisor: '张经理', supervisorOpenId: 'ou_mgr', reporterName: '李四' },
    { supervisor: '赵经理', supervisorOpenId: 'ou_mgr2', reporterName: '周五' },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.supervisorOpenId === 'ou_mgr').reports.length, 2);
});

test('builds supervisor digest text from daily reports', () => {
  const text = buildSupervisorDigestText({
    group: { project: '支付平台' },
    reportDate: '2026-06-29',
    supervisorName: '张经理',
    reports: [{
      reporterName: '王治坤',
      workItems: ['完成案例评审'],
      tomorrowPlanItems: ['推进接口联调'],
      riskItems: ['上线依赖待协调'],
    }],
  });

  assert.match(text, /支付平台/);
  assert.match(text, /王治坤/);
  assert.match(text, /今日工作总结/);
  assert.match(text, /明日工作计划/);
  assert.match(text, /遇到的问题/);
});

test('pushes one message per supervisor with open id', async () => {
  const sent = [];
  const result = await pushDailyReportsToSupervisors({
    group: { chatId: 'oc_test', project: '支付平台' },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-29T09:00:00.000Z'),
    bitable: {
      listDailyReportsForDate: async (_group, date) => {
        assert.equal(date, '2026-06-29');
        return [
          {
            supervisor: '张经理',
            supervisorOpenId: 'ou_mgr',
            reporterName: '王治坤',
            workItems: ['完成案例评审'],
            tomorrowPlanItems: [],
            riskItems: [],
          },
          {
            supervisor: '赵经理',
            supervisorOpenId: '',
            reporterName: '李四',
            workItems: ['推进联调'],
            tomorrowPlanItems: [],
            riskItems: [],
          },
        ];
      },
    },
    messenger: {
      sendTextToOpenId: async (openId, text, uuid) => sent.push({ openId, text, uuid }),
    },
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });

  assert.equal(result.totalReports, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, 'ou_mgr');
  assert.match(sent[0].uuid, /daily-supervisor/);
});

test('loads all effective facts for a shared reporting unit', async () => {
  const calls = [];
  const sent = [];
  const result = await pushDailyReportsToSupervisors({
    group: { key: 'digital-finance', name: '数字金融部', project: '数字金融部' },
    timezone: 'Asia/Shanghai',
    now: new Date('2026-06-29T09:00:00.000Z'),
    bitable: {
      listDailyReportsForDate: async () => {
        throw new Error('reporting units must not use chat/project-filtered reads');
      },
      listAllDailyReportsForRange: async (_group, startDate, endDate) => {
        calls.push({ startDate, endDate });
        return [
          {
            project: '板块A',
            supervisor: '张经理',
            supervisorOpenId: 'ou_mgr',
            reporterName: '成员甲',
            workItems: ['完成事项A'],
          },
          {
            project: '板块B',
            supervisor: '张经理',
            supervisorOpenId: 'ou_mgr',
            reporterName: '成员乙',
            workItems: ['完成事项B'],
          },
        ];
      },
    },
    messenger: {
      sendTextToOpenId: async (openId, text) => sent.push({ openId, text }),
    },
    logger: { warn() {}, error() {}, log() {} },
  });

  assert.deepEqual(calls, [{ startDate: '2026-06-29', endDate: '2026-06-29' }]);
  assert.equal(result.totalReports, 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /成员甲/);
  assert.match(sent[0].text, /成员乙/);
});
