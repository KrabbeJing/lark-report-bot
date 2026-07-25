import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeeklyPreviewBuckets,
  buildWeeklySheetValues,
  getWeeklySheetExpectedCells,
} from '../src/weekly-sheet-content.js';

const cellMap = {
  reportPeriod: 'B2',
  agileProjects: {
    收单项目组: { current: 'C26', next: 'C27', aliases: ['收单'] },
  },
  management: {
    对公客群经营及场景建设: {
      current: ['C45', 'C46', 'C47'],
      next: ['C48', 'C49', 'C50'],
      aliases: ['对公', '云缴费'],
    },
  },
};

const routing = {
  buckets: [{
    module: 'module2',
    target: '收单项目组',
    targets: { current: ['C26'] },
    sources: {
      current: [{
        evidenceId: 'rec_fact_1:current:workItems:0',
        factRecordId: 'rec_fact_1',
        category: 'current',
        sourceField: 'workItems',
        itemIndex: 0,
        date: '2026-07-20',
        member: '张三',
        text: '完成收单接口联调',
      }],
    },
  }],
  evidence: {},
  diagnostics: [],
};

test('formats only routed current work into semantic current cells', () => {
  const result = buildWeeklySheetValues({
    weekStart: '2026-07-17',
    weekEnd: '2026-07-23',
    cellMap,
    routing,
  });

  assert.deepEqual(result.values, {
    B2: '2026.07.17-2026.07.23',
    C26: '1. 张三：完成收单接口联调',
    C45: '',
    C46: '',
    C47: '',
  });
  assert.deepEqual(result.buckets, routing.buckets);
  assert.equal(result.reportCount, 0);
});

test('does not infer a current or next route from report agile group, project, aliases, or plans', () => {
  const result = buildWeeklySheetValues({
    group: { project: '收单项目组', name: '收单项目组' },
    reports: [{
      recordId: 'rec_legacy',
      agileGroup: '收单项目组',
      project: '收单项目组',
      workItems: ['完成收单接口联调'],
      tomorrowPlanItems: ['下周上线'],
      riskItems: ['需跟进'],
    }],
    cellMap,
  });

  assert.deepEqual(result.values, { B2: '', C26: '', C45: '', C46: '', C47: '' });
  assert.deepEqual(result.buckets, []);
});

test('exposes only the report period and semantic current cells', () => {
  assert.deepEqual(getWeeklySheetExpectedCells(cellMap), ['B2', 'C26', 'C45', 'C46', 'C47']);
});

test('keeps routed preview buckets with only current sources and targets', () => {
  assert.deepEqual(buildWeeklyPreviewBuckets({ routing }), routing.buckets);
});
