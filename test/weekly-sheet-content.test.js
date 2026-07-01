import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { buildWeeklySheetValues, getWeeklySheetExpectedCells } from '../src/weekly-sheet-content.js';

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
    cellMap: group.weeklySheet.cellMap,
    reports: [
      {
        reportDate: '2026-06-26',
        reporterName: '王秀男',
        project: '收单项目组',
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

test('exposes the full configured cell list', () => {
  const group = createGroup();
  const cells = getWeeklySheetExpectedCells(group.weeklySheet.cellMap);
  assert.equal(cells.includes('C26'), true);
  assert.equal(cells.includes('C68'), true);
  assert.equal(cells.includes('B2'), true);
});
