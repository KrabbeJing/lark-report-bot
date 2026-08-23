import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  prepareWeeklyClassificationLabels,
  runWeeklyClassificationLabelPreparationCli,
} from '../src/weekly-classification-label-preparation.js';

const rules = [
  {
    targetId: 'module2-receipt-current',
    module: '模块二',
    target: '收单项目组',
    contentType: '本周重点事项说明',
    businessScope: '收单业务',
    includeTopics: ['收单'],
    excludeTopics: [],
    positiveExamples: [],
    negativeExamples: [],
    order: 1,
    enabled: true,
  },
  {
    targetId: 'module3-corporate-current',
    module: '模块三',
    target: '对公客群经营及场景建设',
    contentType: '本周工作进展',
    businessScope: '对公客群业务',
    includeTopics: ['银企直联'],
    excludeTopics: [],
    positiveExamples: [],
    negativeExamples: [],
    order: 2,
    enabled: true,
  },
];

const mappings = [{
  recordId: 'mapping-1',
  contactRecordIds: ['contact-1'],
  memberName: '示例成员',
  memberOpenId: 'ou_example',
  module2Targets: ['收单项目组'],
  module3Target: '对公客群经营及场景建设',
  effectiveFrom: '2026-08-01',
  effectiveTo: '',
  enabled: true,
}];

test('prepares confirmed CSV labels with normalized dates and bounded targets', () => {
  const csv = [
    '\uFEFF样本编号,日报日期,日报事项原文,日报提交人,人工正确板块,人工判断备注,复核状态',
    'case-001,2026/8/13,"完成对账,并通过验证",示例成员,收单项目组,属于收单业务,已确认',
    'case-002,2026/8/14,未复核事项,示例成员,收单项目组,,',
  ].join('\r\n');

  const result = prepareWeeklyClassificationLabels({ csv, mappings, rules });

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    evidenceId: 'case-001',
    date: '2026-08-13',
    text: '完成对账,并通过验证',
    allowedTargets: [
      {
        targetId: 'module2-receipt-current',
        module: 'module2',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        businessScope: '收单业务',
        includeTopics: ['收单'],
        excludeTopics: [],
        positiveExamples: [],
        negativeExamples: [],
      },
      {
        targetId: 'module3-corporate-current',
        module: 'module3',
        target: '对公客群经营及场景建设',
        contentType: '本周工作进展',
        businessScope: '对公客群业务',
        includeTopics: ['银企直联'],
        excludeTopics: [],
        positiveExamples: [],
        negativeExamples: [],
      },
    ],
    expectedTargetId: 'module2-receipt-current',
  });
  assert.doesNotMatch(JSON.stringify(result), /示例成员|ou_example|人工判断备注/);
});

test('rejects a confirmed human target outside the member source mapping', () => {
  const csv = [
    '样本编号,日报日期,日报事项原文,日报提交人,人工正确板块,人工判断备注,复核状态',
    'case-001,2026-08-13,完成网联资料整理,示例成员,线上营业厅项目组,,已确认',
  ].join('\n');

  assert.throws(
    () => prepareWeeklyClassificationLabels({ csv, mappings, rules }),
    /case-001:expected_target_not_allowed/,
  );
});

test('rejects duplicate ids and files without confirmed rows', () => {
  const duplicateCsv = [
    '样本编号,日报日期,日报事项原文,日报提交人,人工正确板块,人工判断备注,复核状态',
    'case-001,2026-08-13,事项一,示例成员,收单项目组,,已确认',
    'case-001,2026-08-14,事项二,示例成员,收单项目组,,已确认',
  ].join('\n');
  const unconfirmedCsv = [
    '样本编号,日报日期,日报事项原文,日报提交人,人工正确板块,人工判断备注,复核状态',
    'case-001,2026-08-13,事项一,示例成员,收单项目组,,',
  ].join('\n');

  assert.throws(
    () => prepareWeeklyClassificationLabels({ csv: duplicateCsv, mappings, rules }),
    /duplicate_evidence_id:case-001/,
  );
  assert.throws(
    () => prepareWeeklyClassificationLabels({ csv: unconfirmedCsv, mappings, rules }),
    /no_confirmed_labels/,
  );
});

test('CLI reads Base configuration and writes a new anonymous evaluation label file', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'weekly-classification-labels-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'out'));
  await writeFile(path.join(cwd, 'out', 'labels.csv'), [
    '样本编号,日报日期,日报事项原文,日报提交人,人工正确板块,人工判断备注,复核状态',
    'case-001,2026/8/13,完成收单优化,示例成员,收单项目组,属于收单业务,已确认',
  ].join('\n'));
  const group = { name: '测试报告单元' };
  const processRef = { cwd: () => cwd, exitCode: 0 };
  const calls = [];

  const result = await runWeeklyClassificationLabelPreparationCli({
    argv: ['--input', 'out/labels.csv', '--output', 'out/labels.json'],
    loadConfig: () => ({ groups: [group] }),
    createClient: () => ({ client: true }),
    createBitable: client => ({ client }),
    loadWeeklyConfiguration: async args => {
      calls.push(args);
      return { mappings, rules, warnings: [] };
    },
    readFile,
    mkdir,
    realpath,
    lstat,
    writeFile,
    processRef,
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(result.items.length, 1);
  assert.deepEqual(calls.map(call => ({ group: call.group, period: call.period })), [{
    group,
    period: { start: '2026-08-13', end: '2026-08-13' },
  }]);
  const serialized = await readFile(path.join(cwd, 'out', 'labels.json'), 'utf8');
  assert.match(serialized, /module2-receipt-current/);
  assert.doesNotMatch(serialized, /示例成员|ou_example|人工判断备注/);
  assert.equal(processRef.exitCode, 0);
});

test('CLI rejects an existing output before reading Base configuration', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'weekly-classification-labels-existing-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, 'out'));
  await writeFile(path.join(cwd, 'out', 'labels.csv'), '');
  await writeFile(path.join(cwd, 'out', 'labels.json'), '{}');
  let configurationCalls = 0;
  const processRef = { cwd: () => cwd, exitCode: 0 };

  const result = await runWeeklyClassificationLabelPreparationCli({
    argv: ['--input', 'out/labels.csv', '--output', 'out/labels.json'],
    loadConfig: () => ({ groups: [{ name: '测试报告单元' }] }),
    createClient: () => ({}),
    createBitable: () => ({}),
    loadWeeklyConfiguration: async () => { configurationCalls += 1; return {}; },
    readFile,
    mkdir,
    realpath,
    lstat,
    writeFile,
    processRef,
    stdout: () => {},
    stderr: () => {},
  });

  assert.equal(result, null);
  assert.equal(configurationCalls, 0);
  assert.equal(processRef.exitCode, 1);
});
