import test from 'node:test';
import assert from 'node:assert/strict';
import { runWeeklyWorkflowStage } from '../src/weekly-workflow.js';
import { parseWeeklyWorkflowArgs } from '../scripts/run-weekly-workflow.js';

function fakeServices(order, overrides = {}) {
  const instance = {
    instanceKey: '2026-W30',
    recordId: 'rec_week',
    sheetId: 'sheet_week',
    sheetConfig: { enabled: true, spreadsheetToken: 'sheet' },
    targets: { agileProjects: { Alpha: { current: 'B2' } }, management: {} },
  };
  return {
    instanceService: { ensure: async () => { order.push('ensure instance'); return instance; } },
    factSync: { sync: async () => { order.push('sync facts'); return { synced: true }; } },
    configRepository: { load: async () => { order.push('load config'); return { mappings: [], rules: [], styleExamples: [], metricOwners: [] }; } },
    sourceRouter: { route: async () => { order.push('route'); return { buckets: [] }; } },
    ai: { generate: async () => { order.push('generate'); return { cells: {}, evidence: {} }; } },
    draftService: { writeInitial: async () => { order.push('write protected cells'); return { writtenCells: {} }; }, refresh: async () => { order.push('refresh eligible cells'); return { writtenCells: {} }; } },
    bitable: { updateWeeklyInstance: async (_instance, patch) => { order.push(`persist ${patch.stage || patch.status || 'status'}`); } },
    ownerNotifier: { owners: async () => { order.push('notify weekly owners'); }, metrics: async () => { order.push('notify blank metrics'); } },
    poster: { readSheet: async () => { order.push('read current Sheet'); return {}; }, render: async () => { order.push('render deterministic poster'); return '/tmp/poster.png'; }, validate: async () => { order.push('validate image'); }, sendDepartment: async () => { order.push('send department image'); }, sendTeam: async target => { order.push(`send ${target.key}`); } },
    ...overrides,
  };
}

test('draft stage executes the required operations in order', async () => {
  const order = [];
  await runWeeklyWorkflowStage({
    stage: 'draft', group: { project: '测试组' }, now: new Date('2026-07-24T08:30:00+08:00'),
    services: fakeServices(order),
  });
  assert.deepEqual(order, ['ensure instance', 'sync facts', 'load config', 'route', 'generate', 'write protected cells', 'persist draft']);
});

test('notify stage consolidates owner and blank metric notifications before persisting', async () => {
  const order = [];
  await runWeeklyWorkflowStage({
    stage: 'notify', group: { project: '测试组' }, now: new Date('2026-07-24T09:00:00+08:00'),
    services: fakeServices(order),
  });
  assert.deepEqual(order, ['load config', 'notify weekly owners', 'notify blank metrics', 'persist notify']);
});

test('refresh stage syncs and refreshes only eligible cells', async () => {
  const order = [];
  await runWeeklyWorkflowStage({
    stage: 'refresh', group: { project: '测试组' }, now: new Date('2026-07-25T01:30:00Z'),
    services: fakeServices(order),
  });
  assert.deepEqual(order, ['sync facts', 'load config', 'route', 'generate', 'refresh eligible cells', 'persist refresh']);
});

test('publish stage sends department poster and filtered enabled small teams with distinct keys', async () => {
  const order = [];
  const sent = [];
  const services = fakeServices(order, {
    poster: {
      readSheet: async () => { order.push('read current Sheet'); return { sections: { Alpha: 'alpha', Beta: 'beta' } }; },
      render: async (_sheet, options) => { order.push('render deterministic poster'); return options; },
      validate: async () => { order.push('validate image'); },
      sendDepartment: async () => { order.push('send department image'); },
      sendTeam: async (target, content, key) => { sent.push({ target, content, key }); order.push(`send ${target.key}`); },
    },
  });
  const group = {
    project: '测试组',
    weeklyDelivery: {
      departmentChatId: 'oc_same',
      smallTeams: [
        { key: 'team-a', enabled: true, chatId: 'oc_same', sectionTargets: ['Alpha'] },
        { key: 'team-b', enabled: true, chatId: 'oc_same', sectionTargets: ['Beta'] },
      ],
    },
  };
  await runWeeklyWorkflowStage({ stage: 'publish', group, now: new Date('2026-07-25T03:00:00Z'), services });
  assert.deepEqual(order, ['read current Sheet', 'render deterministic poster', 'validate image', 'send department image', 'send team-a', 'send team-b', 'persist publish']);
  assert.deepEqual(sent.map(item => item.content), [{ Alpha: 'alpha' }, { Beta: 'beta' }]);
  assert.notEqual(sent[0].key, sent[1].key);
});

test('manual runner parses stage, date, and dry-run without contacting services', () => {
  assert.deepEqual(parseWeeklyWorkflowArgs(['--stage', 'draft', '--date', '2026-07-24', '--dry-run']), {
    stage: 'draft', date: '2026-07-24', dryRun: true,
  });
});
