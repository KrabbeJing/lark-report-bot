import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklySummary } from '../src/weekly-summary.js';

test('builds project weekly summary from daily reports', () => {
  const summary = buildWeeklySummary({
    group: { project: '支付平台', agileGroup: 'A组', chatId: 'oc_test' },
    weekStart: '2026-06-22',
    weekEnd: '2026-06-26',
    reports: [
      {
        reportDate: '2026-06-22',
        reporterName: '王治坤',
        senderOpenId: 'ou_1',
        workItems: ['完成案例评审', '发现上线依赖待协调'],
        riskItems: ['发现上线依赖待协调'],
      },
      {
        reportDate: '2026-06-23',
        reporterName: '李四',
        senderOpenId: 'ou_2',
        workItems: ['推进接口联调'],
        riskItems: [],
      },
    ],
  });

  assert.equal(summary.reportCount, 2);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.itemCount, 3);
  assert.equal(summary.riskItems.length, 1);
  assert.match(summary.summaryText, /支付平台本周共收集 2 份日报/);
});
