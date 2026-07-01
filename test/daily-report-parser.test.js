import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDailyReportText } from '../src/daily-report-parser.js';

test('parses numbered daily report with short date', () => {
  const parsed = parseDailyReportText(`王治坤6.26日工作日报
1.参加互联网支付平台和网联前置的案例评审
2.根据会议上提出的需求增加以及修改案例
3.沟通分级分类的部分案例`, {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '王治坤');
  assert.equal(parsed.reportDate, '2026-06-26');
  assert.deepEqual(parsed.workItems, [
    '参加互联网支付平台和网联前置的案例评审',
    '根据会议上提出的需求增加以及修改案例',
    '沟通分级分类的部分案例',
  ]);
});

test('parses full date and bullet items', () => {
  const parsed = parseDailyReportText(`王治坤 2026-06-26 工作日报
- 完成支付平台接口联调
- 发现上线依赖待协调`, {
    messageTime: new Date('2026-06-27T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reportDate, '2026-06-26');
  assert.equal(parsed.riskItems.length, 1);
  assert.match(parsed.riskItems[0], /待协调/);
});

test('uses message date when title has no date', () => {
  const parsed = parseDailyReportText(`王治坤工作日报
1、完成案例修订`, {
    messageTime: new Date('2026-06-28T12:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reportDate, '2026-06-28');
});

test('ignores ordinary chat noise', () => {
  const parsed = parseDailyReportText('今天下午三点开会，大家记得参加', {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
  });

  assert.equal(parsed, null);
});

test('marks incomplete report as low confidence', () => {
  const parsed = parseDailyReportText('王治坤工作日报', {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
  });

  assert.equal(parsed.highConfidence, false);
  assert.ok(parsed.confidence < 0.75);
});

test('parses structured daily report sections', () => {
  const parsed = parseDailyReportText(`王治坤6.26日工作日报
今日工作总结：
1.完成案例评审
明日工作计划：
1.继续推进接口联调
遇到的问题或需求的协助：
1.上线依赖待协调`, {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.deepEqual(parsed.workItems, ['完成案例评审']);
  assert.deepEqual(parsed.tomorrowPlanItems, ['继续推进接口联调']);
  assert.deepEqual(parsed.riskItems, ['上线依赖待协调']);
});

test('parses bracketed item markers and chinese month date', () => {
  const parsed = parseDailyReportText(`王秀男6月26日工作日报
【1】与银联沟通银联代收业务场景限额调整问题
【2】协助反洗钱查询POS交易对手方开户行信息缺失问题，讨论优化方案
【3】参加网联、互联网支付新核心案例评审
【4】与天翼支付沟通手续费对账问题，发起行内交易明细取数流程
【5】沟通银联风险交易核查问题`, {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '王秀男');
  assert.equal(parsed.reportDate, '2026-06-26');
  assert.equal(parsed.workItems.length, 5);
  assert.match(parsed.workItems[0], /银联代收业务场景限额调整/);
});

test('parses two-digit year date in title', () => {
  const parsed = parseDailyReportText(`李阜彦26.6.24工作日报
1、参加人工智能培训。
2、撰写对公线上营业厅项目组汇报材料。
3、完成对公线上营业厅项目组周报。
4、完成对公线上营业厅项目组考核取数和佐证材料整理。
5、协调新核心测试，解答测试问题。`, {
    messageTime: new Date('2026-06-24T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '李阜彦');
  assert.equal(parsed.reportDate, '2026-06-24');
  assert.equal(parsed.workItems.length, 5);
});

test('parses dot date title with trailing colon', () => {
  const parsed = parseDailyReportText(`杨敬成6.26工作日报：
1.参加人工智能培训会议；
2.对接市北支行推进市北众和医院结算业务对接；
3.对接市北第二支行沟通医码当先营销活动策略。`, {
    messageTime: new Date('2026-06-26T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '杨敬成');
  assert.equal(parsed.reportDate, '2026-06-26');
  assert.deepEqual(parsed.workItems, [
    '参加人工智能培训会议；',
    '对接市北支行推进市北众和医院结算业务对接；',
    '对接市北第二支行沟通医码当先营销活动策略。',
  ]);
});
