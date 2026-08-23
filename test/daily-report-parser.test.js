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

test('does not keep the report suffix in names before compact daily report titles', () => {
  const parsed = parseDailyReportText(`王琳婧7.11日报
1. 完成冲突验收`, {
    messageTime: new Date('2026-07-11T23:49:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reporterName, '王琳婧');
  assert.equal(parsed.reportDate, '2026-07-11');
});

test('parses full date and bullet items', () => {
  const parsed = parseDailyReportText(`王治坤 2026-06-26 工作日报
- 完成支付平台接口联调
- 发现上线依赖待协调`, {
    messageTime: new Date('2026-06-27T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reportDate, '2026-06-26');
  assert.deepEqual(parsed.workItems, ['完成支付平台接口联调', '发现上线依赖待协调']);
  assert.deepEqual(parsed.riskItems, []);
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

test('keeps original numbered body text after removing report title', () => {
  const parsed = parseDailyReportText(`刘喜双7.1工作日报
1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '刘喜双');
  assert.equal(parsed.reportDate, '2026-07-01');
  assert.equal(parsed.workSummaryText, `1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`);
  assert.deepEqual(parsed.workItems, [
    '与技术沟通开发区一中云充值取数逻辑问题，完成数据提取',
    '整理千分卡考核指标，完成填报',
  ]);
});

test('does not infer risk items from ordinary chat work items', () => {
  const parsed = parseDailyReportText(`刘喜双7.1工作日报
1、与技术沟通开发区一中云充值取数逻辑问题，完成数据提取
2、整理千分卡考核指标，完成填报`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.deepEqual(parsed.riskItems, []);
});

test('keeps explicit risk section items', () => {
  const parsed = parseDailyReportText(`刘喜双7.1工作日报
今日工作总结：
1、完成数据提取
遇到的问题：
1、接口权限待协调`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.deepEqual(parsed.riskItems, ['接口权限待协调']);
});

test('parses date range daily report into multiple report dates', () => {
  const parsed = parseDailyReportText(`刘喜双 6.29-6.30 工作日报
1、完成开发区一中云充值取数逻辑梳理
2、整理千分卡考核指标`, {
    messageTime: new Date('2026-07-01T01:30:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '刘喜双');
  assert.equal(parsed.reportDate, '2026-06-29');
  assert.deepEqual(parsed.reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(parsed.dateRange, '2026-06-29~2026-06-30');
  assert.equal(parsed.reportType, '多日合并');
  assert.equal(parsed.workSummaryText, `1、完成开发区一中云充值取数逻辑梳理
2、整理千分卡考核指标`);
});

test('parses a non-contiguous Chinese date list and keeps the reporter name', () => {
  const parsed = parseDailyReportText(`王秀男7月24日、27日工作日报
【1】继续处理259号文未改造POS终端
【2】与科技沟通确认银联缴费业务当前业务现状`, {
    messageTime: new Date('2026-07-27T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '王秀男');
  assert.equal(parsed.reportDate, '2026-07-24');
  assert.deepEqual(parsed.reportDates, ['2026-07-24', '2026-07-27']);
  assert.equal(parsed.dateRange, '2026-07-24、2026-07-27');
  assert.equal(parsed.reportType, '多日合并');
});

test('parses a dotted date list separated by a Chinese comma', () => {
  const parsed = parseDailyReportText(`胡仁庆8.19，8.20工作日报
1.整理商户支付合同，并且进行标号处理。
2.参加与聊城分行的线上会议，沟通校园托管相关业。
3.了解青岛中小学课后服务平台解决方案。
4.解决即东酒店支付码牌问题
5.参与慧馨特超市项目会谈`, {
    messageTime: new Date('2026-08-20T18:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '胡仁庆');
  assert.deepEqual(parsed.reportDates, ['2026-08-19', '2026-08-20']);
  assert.equal(parsed.reportType, '多日合并');
  assert.equal(parsed.workItems.length, 5);
});

test('parses an em-dash date range and keeps the reporter name', () => {
  const parsed = parseDailyReportText(`徐春昱7.28—29工作日报：
1.审核收单商户进件18，信息修改、其他任务
2.新增星海源门店`, {
    messageTime: new Date('2026-07-29T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '徐春昱');
  assert.equal(parsed.reportDate, '2026-07-28');
  assert.deepEqual(parsed.reportDates, ['2026-07-28', '2026-07-29']);
  assert.equal(parsed.dateRange, '2026-07-28~2026-07-29');
  assert.equal(parsed.reportType, '多日合并');
});

test('strips a trailing status note from the report title name', () => {
  const parsed = parseDailyReportText(`徐鑫鹤7.13工作日报（年假）
1.处理网上支付工单4例`, {
    messageTime: new Date('2026-07-13T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reporterName, '徐鑫鹤');
  assert.equal(parsed.reportDate, '2026-07-13');
  assert.equal(parsed.reportType, '单日');
});

test('uses title date instead of next-day message time', () => {
  const parsed = parseDailyReportText(`刘喜双6.30工作日报
1、补发昨日数据提取进展`, {
    messageTime: new Date('2026-07-01T00:30:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reportDate, '2026-06-30');
  assert.deepEqual(parsed.reportDates, ['2026-06-30']);
  assert.equal(parsed.reportType, '单日');
});

test('splits two daily report blocks in one message', () => {
  const parsed = parseDailyReportText(`刘喜双 8.5日工作日报
1、配置聊城分行收单商户手续费额度包
2、处理日常收单业务问题
刘喜双 8.6 日工作日报
1、解决市南支行收单系统机具中心云喇叭分拨报错问题
2、处理日常收单业务问题`, {
    messageTime: new Date('2026-08-06T23:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.deepEqual(parsed.reportDates, ['2026-08-05', '2026-08-06']);
  assert.equal(parsed.reports.length, 2);
  assert.equal(parsed.reports[0].reportDate, '2026-08-05');
  assert.deepEqual(parsed.reports[0].workItems, [
    '配置聊城分行收单商户手续费额度包',
    '处理日常收单业务问题',
  ]);
  assert.equal(parsed.reports[1].reportDate, '2026-08-06');
  assert.deepEqual(parsed.reports[1].workItems, [
    '解决市南支行收单系统机具中心云喇叭分拨报错问题',
    '处理日常收单业务问题',
  ]);
});

test('splits consecutive Bai Ou daily report blocks with optional day suffix', () => {
  const parsed = parseDailyReportText(`白欧8.20日工作日报
1、与零售部耿总沟通银联前置业务分工问题。
2、与数办沟通银联前置其他银行的分工问题。
3、组内讨论银联前置外围系统开发变化内容。
4、协调西海岸实验中学数据迁移问题。
5、组内沟通聊城分行校园课后辅导问题。
白欧8.21工作日报
1、继续协调西海岸实验中学数据迁移问题，找到数据重复原因。
2、与测试中心沟通银联前置applepay，刷脸付，碳排放，收单商户入账，EAST,反洗钱测试情况。
3、与运管部沟通ATM机本代他转账手续费收益问题。`, {
    messageTime: new Date('2026-08-21T18:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.deepEqual(parsed.reportDates, ['2026-08-20', '2026-08-21']);
  assert.equal(parsed.reportType, '多段日报');
  assert.equal(parsed.reports.length, 2);
  assert.equal(parsed.reports[0].workItems.length, 5);
  assert.equal(parsed.reports[1].workItems.length, 3);
  assert.match(parsed.reports[0].workSummaryText, /银联前置业务分工/);
  assert.doesNotMatch(parsed.reports[0].workSummaryText, /数据重复原因/);
  assert.match(parsed.reports[1].workSummaryText, /数据重复原因/);
});

test('does not reinterpret backward date range as single-day report', () => {
  const parsed = parseDailyReportText(`刘喜双 6.30-6.29 工作日报
1、内容`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, false);
});

test('parses full-year date range with omitted end year', () => {
  const parsed = parseDailyReportText(`刘喜双 2026-06-29-06-30 工作日报
1、内容`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reportDate, '2026-06-29');
  assert.deepEqual(parsed.reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(parsed.dateRange, '2026-06-29~2026-06-30');
  assert.equal(parsed.reportType, '多日合并');
});

test('parses dotted full-year date range', () => {
  const parsed = parseDailyReportText(`刘喜双 2026.6.29-6.30 工作日报
1、内容`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reportDate, '2026-06-29');
  assert.deepEqual(parsed.reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(parsed.reportType, '多日合并');
});

test('does not reinterpret too-long date range as single-day report', () => {
  const parsed = parseDailyReportText(`刘喜双 6.1-7.15 工作日报
1、内容`, {
    messageTime: new Date('2026-07-01T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, false);
});
