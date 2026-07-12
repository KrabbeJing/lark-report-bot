import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locateWeeklyTemplateTargets,
  normalizeSheetCellText,
} from '../src/weekly-template-locator.js';

const rows = [
  ['数字金融部周报'],
  ['报告周期', 'YYYY年MM月DD日-YYYY年MM月DD日'],
  [],
  ['一、核心指标完成情况'],
  ['指标名称', '目标值', '完成情况'],
  ['手机银行月活', '100万', ''],
  [],
  ['二、敏捷项目组工作进展'],
  ['填写说明'],
  [[{ text: '融羲项目组\n' }, { text: '【需求分析阶段】' }], '本周重点事项说明', ''],
  ['', '下周工作计划', ''],
  ['收单项目组', '本周重点事项说明', ''],
  ['', '下周工作计划', ''],
  [],
  ['三、部门管理工作'],
  [[{ text: '填写说明：每项不超过3条' }]],
  ['1.零售客群经营', '本周工作进展', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '下周工作计划', ''],
  ['', '', ''],
  ['', '', ''],
  ['2.对公客群经营', '本周工作进展', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '下周工作计划', ''],
  ['', '', ''],
  ['', '', ''],
];

test('normalizes Feishu rich-text segments without losing line breaks', () => {
  assert.equal(
    normalizeSheetCellText([{ text: '融羲项目组\n' }, { text: '【需求分析阶段】' }]),
    '融羲项目组\n【需求分析阶段】',
  );
});

test('locates all module targets and inherits merged title context', () => {
  const result = locateWeeklyTemplateTargets(rows, {
    aliasMap: {
      agileProjects: { 融羲项目组: ['融羲'] },
      management: { 零售客群经营: ['零售'] },
    },
  });

  assert.equal(result.reportPeriod, 'B2');
  assert.equal(result.metrics['手机银行月活'], 'C6');
  assert.deepEqual(result.agileProjects['融羲项目组'], {
    current: 'C10', next: 'C11', aliases: ['融羲'],
  });
  assert.deepEqual(result.agileProjects['收单项目组'], {
    current: 'C12', next: 'C13', aliases: [],
  });
  assert.deepEqual(result.management['零售客群经营'], {
    current: ['C17', 'C18', 'C19'],
    next: ['C21', 'C22', 'C23'],
    aliases: ['零售'],
  });
  assert.deepEqual(result.management['对公客群经营'].next, ['C27', 'C28', 'C29']);
});

test('rejects duplicate semantic paths', () => {
  const duplicate = [...rows, ['2.零售客群经营', '本周工作进展', '']];
  assert.throws(
    () => locateWeeklyTemplateTargets(duplicate),
    /重复定位.*三、部门管理工作.*零售客群经营.*本周工作进展/,
  );
});

test('rejects a management region with fewer than three cells before boundary', () => {
  const tooShort = rows.map(row => [...row]);
  tooShort[18] = ['', '下周工作计划', ''];
  assert.throws(
    () => locateWeeklyTemplateTargets(tooShort),
    /目标区域不足3行/,
  );
});

test('rejects missing required module', () => {
  assert.throws(
    () => locateWeeklyTemplateTargets(rows.slice(0, 14)),
    /缺少模块.*三、部门管理工作/,
  );
});
