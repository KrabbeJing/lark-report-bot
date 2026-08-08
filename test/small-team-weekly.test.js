import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySmallTeamFacts,
  generateSmallTeamSummaries,
} from '../src/small-team-weekly.js';

const period = { start: '2026-07-24', end: '2026-07-31' };

const facts = [
  {
    recordId: 'fact-1',
    reportDate: '2026-07-31',
    reporterName: '张三',
    supervisorOpenId: 'sup-public',
    factStatus: '有效',
    workItems: ['完成企业网银联调'],
  },
  {
    recordId: 'fact-2',
    reportDate: '2026-07-30',
    reporterName: '李四',
    supervisorOpenId: 'sup-other',
    factStatus: '有效',
    workItems: ['完成云缴费需求评审'],
  },
  {
    recordId: 'fact-3',
    reportDate: '2026-07-30',
    reporterName: '王五',
    supervisorOpenId: 'sup-public',
    factStatus: '有效',
    workItems: ['推进企业网银和收单联合事项'],
  },
  {
    recordId: 'fact-4',
    reportDate: '2026-07-29',
    reporterName: '赵六',
    supervisorOpenId: 'sup-public',
    factStatus: '有效',
    workItems: ['完成常规资料整理'],
  },
];

const routing = {
  buckets: [
    {
      target: '线上营业厅项目组',
      sources: [
        { factRecordId: 'fact-1', text: '完成企业网银联调' },
        { factRecordId: 'fact-3', text: '推进企业网银和收单联合事项' },
      ],
    },
    {
      target: '对公客群经营及场景建设',
      sources: [
        { factRecordId: 'fact-2', text: '完成云缴费需求评审' },
      ],
    },
    {
      target: '对公客群经营及场景建设',
      sources: [
        { factRecordId: 'fact-4', text: '完成常规资料整理' },
      ],
    },
  ],
};

const target = {
  key: 'public-business',
  name: '公司板块',
  sourceSupervisors: ['sup-public'],
  posterSections: [
    { key: 'online', name: '线上营业厅', sourceTargets: ['线上营业厅项目组'], includeTopics: ['企业网银'] },
    { key: 'collection', name: '收单项目', sourceTargets: ['线上营业厅项目组'], includeTopics: ['收单'] },
    { key: 'cloud-pay', name: '云缴费', sourceTargets: ['对公客群经营及场景建设'], includeTopics: ['云缴费'] },
  ],
};

test('filters small-team facts by supervisor and keeps only uniquely classified modules', () => {
  const result = classifySmallTeamFacts({ target, facts, routing, period });

  assert.deepEqual(result.sections.map(section => section.name), ['线上营业厅']);
  assert.deepEqual(result.sections[0].reports.map(report => report.recordId), ['fact-1']);
  assert.match(result.diagnostics.map(item => item.code).join(','), /ambiguous_module/);
  assert.match(result.diagnostics.map(item => item.code).join(','), /unmatched_module/);
});

test('generates one AI summary per non-empty small-team module', async () => {
  const calls = [];
  const result = await generateSmallTeamSummaries({
    group: { project: '数字金融部' },
    target: {
      ...target,
      posterSections: [target.posterSections[0]],
    },
    facts,
    routing,
    period,
    aiProvider: {
      summarizeWeeklyReports: async input => {
        calls.push(input);
        return { summaryText: '完成线上营业厅联调。', provider: 'test' };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].reports.length, 2);
  assert.deepEqual(result.sections.map(section => section.name), ['线上营业厅']);
  assert.equal(result.sections[0].summaryText, '完成线上营业厅联调。');
});
