import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  buildWeeklyPreviewBuckets,
  buildWeeklySheetValues,
  getWeeklySheetExpectedCells,
} from '../src/weekly-sheet-content.js';

const cellMap = {
  reportPeriod: 'B2',
  agileProjects: {
    融羲项目组: { current: 'C26', next: 'C27', aliases: ['融羲'] },
    收单项目组: { current: 'C28', next: 'C29', aliases: ['收单'] },
    线上营业厅项目组: { current: 'C30', next: 'C31', aliases: ['线上营业厅', '对公线上营业厅'] },
    手机银行项目组: { current: 'C32', next: 'C33', aliases: ['手机银行'] },
    新核心项目组: { current: 'C34', next: 'C35', aliases: ['新核心'] },
  },
  management: {
    零售客群经营: {
      current: ['C39', 'C40', 'C41'],
      next: ['C42', 'C43', 'C44'],
      aliases: ['零售大众客群', '零售', '大众客群', '客群经营', '营销活动'],
    },
    对公客群经营及场景建设: {
      current: ['C45', 'C46', 'C47'],
      next: ['C48', 'C49', 'C50'],
      aliases: ['对公客群', '对公', '场景建设', '医院', '企业'],
    },
    渠道创新建设: {
      current: ['C51', 'C52', 'C53'],
      next: ['C54', 'C55', 'C56'],
      aliases: ['渠道创新', '渠道', '线上营业厅', '手机银行'],
    },
    业务风控合规: {
      current: ['C57', 'C58', 'C59'],
      next: ['C60', 'C61', 'C62'],
      aliases: ['风控', '合规', '风险', '反洗钱'],
    },
    业务转型推动: {
      current: ['C63', 'C64', 'C65'],
      next: ['C66', 'C67', 'C68'],
      aliases: ['业务转型', '转型推动', '新核心', '人工智能'],
    },
  },
};

function createGroup() {
  return normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '数字金融部',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklySheet: {
        enabled: true,
        spreadsheetToken: 'shtcn_test',
        templateSheetId: 'tpl_1',
      },
    }],
  }).groups[0];
}

test('builds configured weekly sheet cell values from daily reports', () => {
  const group = createGroup();
  const result = buildWeeklySheetValues({
    group,
    weekStart: '2026-06-22',
    weekEnd: '2026-06-26',
    cellMap,
    reports: [
      {
        reportDate: '2026-06-26',
        reporterName: '王秀男',
        project: '收单项目组',
        agileGroup: '收单项目组',
        workItems: [
          '与银联沟通银联代收业务场景限额调整问题',
          '协助反洗钱查询POS交易对手方开户行信息缺失问题，讨论优化方案',
        ],
        tomorrowPlanItems: ['继续推进银联限额调整方案确认'],
        riskItems: ['风险交易核查问题需持续跟进'],
      },
      {
        reportDate: '2026-06-24',
        reporterName: '李阜彦',
        project: '线上营业厅项目组',
        agileGroup: '线上营业厅项目组',
        workItems: [
          '撰写对公线上营业厅项目组汇报材料',
          '完成对公线上营业厅项目组周报',
        ],
        tomorrowPlanItems: ['协调新核心测试，解答测试问题'],
        riskItems: [],
      },
    ],
  });

  assert.equal(result.values.B2, '2026.06.22-2026.06.26');
  assert.match(result.values.C28, /王秀男/);
  assert.match(result.values.C29, /限额调整方案确认/);
  assert.match(result.values.C30, /李阜彦/);
  assert.match(result.values.C31, /新核心测试/);
  assert.match(result.values.C57, /反洗钱/);
});

test('groups agile weekly content only by fact agileGroup', () => {
  const result = buildWeeklySheetValues({
    group: { project: '分管领导群', agileGroup: '融羲项目组' },
    reports: [{
      reporterName: '甲',
      agileGroup: '收单项目组',
      workItems: ['讨论融羲项目但本人属于收单项目组'],
      tomorrowPlanItems: [],
      riskItems: [],
    }],
    cellMap: {
      agileProjects: {
        融羲项目组: { current: 'C1', next: 'C2', aliases: [] },
        收单项目组: { current: 'C3', next: 'C4', aliases: [] },
      },
      management: {},
    },
  });
  assert.equal(result.values.C1, '');
  assert.match(result.values.C3, /讨论融羲项目/);
});

test('exposes the full configured cell list', () => {
  const group = createGroup();
  const cells = getWeeklySheetExpectedCells(cellMap);
  assert.equal(cells.includes('C26'), true);
  assert.equal(cells.includes('C68'), true);
  assert.equal(cells.includes('B2'), true);
});

test('builds preview buckets from persisted fact organization without core metric targets', () => {
  const buckets = buildWeeklyPreviewBuckets({
    group: { project: '数字金融部', contactTable: { appToken: 'must-not-be-read' } },
    reports: [{
      recordId: 'fact_history',
      reportDate: '2026-07-13',
      reporterName: '张三',
      senderOpenId: 'ou_zhangsan',
      project: '历史归属项目',
      agileGroup: '收单项目组',
      workItems: ['完成历史归属联调'],
      tomorrowPlanItems: ['下周上线'],
      riskItems: [],
    }],
    cellMap: {
      reportPeriod: 'B2',
      coreMetrics: { current: ['B5'] },
      agileProjects: { 收单项目组: { current: 'C1', next: 'C2', aliases: ['收单'] } },
      management: { 渠道创新建设: { current: ['C3', 'C4', 'C5', 'C9'], next: ['C6', 'C7', 'C8', 'C10'], aliases: ['收单'] } },
    },
  });

  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets[0], {
    module: 'agileProjects',
    name: '收单项目组',
    targets: { current: ['C1'], next: ['C2'] },
    sources: {
      current: [{
        evidenceId: 'fact_history:current:workItems:0',
        factRecordId: 'fact_history',
        category: 'current',
        sourceField: 'workItems',
        itemIndex: 0,
        date: '2026-07-13',
        member: '张三',
        text: '完成历史归属联调',
      }],
      next: [{
        evidenceId: 'fact_history:next:tomorrowPlanItems:0',
        factRecordId: 'fact_history',
        category: 'next',
        sourceField: 'tomorrowPlanItems',
        itemIndex: 0,
        date: '2026-07-13',
        member: '张三',
        text: '下周上线',
      }],
    },
  });
  assert.equal(buckets.some(bucket => bucket.targets.current.includes('B5')), false);
  assert.deepEqual(buckets[1].targets.current, ['C3', 'C4', 'C5']);
  assert.deepEqual(buckets[1].targets.next, ['C6', 'C7', 'C8']);
});
