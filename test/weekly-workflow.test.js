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

test('draft stage unwraps ensured instance results and passes discovered metric cells to reminders', async () => {
  const order = [];
  let draftInstance;
  let metricCells;
  const base = fakeServices(order, {
    instanceService: {
      ensure: async () => ({
        instance: { instanceKey: '2026-W30', sheetId: 'sheet_week', sheetConfig: { enabled: true } },
        targets: { metrics: { 手机银行月活: 'B5' } },
      }),
      load: async () => ({
        instance: { instanceKey: '2026-W30', sheetId: 'sheet_week', sheetConfig: { enabled: true } },
        targets: { metrics: { 手机银行月活: 'B5' } },
      }),
    },
    draftService: {
      writeInitial: async args => { draftInstance = args.instance; order.push('write protected cells'); return {}; },
      refresh: async () => ({}),
    },
    ownerNotifier: {
      owners: async () => { order.push('notify weekly owners'); },
      metrics: async args => { metricCells = args.metricCells; order.push('notify blank metrics'); },
    },
  });

  await runWeeklyWorkflowStage({
    stage: 'draft',
    group: { project: '测试组' },
    now: new Date('2026-07-24T08:30:00+08:00'),
    services: base,
  });
  assert.equal(draftInstance.sheetId, 'sheet_week');

  await runWeeklyWorkflowStage({
    stage: 'notify',
    group: { project: '测试组' },
    now: new Date('2026-07-24T09:00:00+08:00'),
    services: base,
  });
  assert.deepEqual(metricCells, { 手机银行月活: 'B5' });
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
  assert.deepEqual(order, ['read current Sheet', 'render deterministic poster', 'validate image', 'send department image', 'persist status', 'send team-a', 'persist status', 'send team-b', 'persist status', 'persist publish']);
  assert.deepEqual(sent.map(item => item.content), [{ Alpha: 'alpha' }, { Beta: 'beta' }]);
  assert.notEqual(sent[0].key, sent[1].key);
});

test('publish stage skips department and team sends already marked successful', async () => {
  const sent = [];
  const services = fakeServices([], {
    instanceService: {
      load: async () => ({
        instance: {
          instanceKey: '2026-W30',
          sheetId: 'sheet_week',
          sheetConfig: { enabled: true },
          posterStatus: '已发送',
          smallTeamPushDetails: [{
            key: 'team-a',
            status: '成功',
            idempotencyKey: 'weekly-2026-07-24-publish-team-a',
          }],
        },
        targets: {},
      }),
    },
    poster: {
      readSheet: async () => ({ sections: { Alpha: 'alpha' } }),
      render: async sheet => sheet,
      validate: async () => {},
      sendDepartment: async () => sent.push('department'),
      sendTeam: async target => sent.push(target.key),
    },
  });

  await runWeeklyWorkflowStage({
    stage: 'publish',
    group: {
      project: '测试组',
      weeklyDelivery: {
        departmentChatId: 'oc_same',
        smallTeams: [{ key: 'team-a', enabled: true, sectionTargets: ['Alpha'] }],
      },
    },
    now: new Date('2026-07-25T03:00:00Z'),
    services,
  });
  assert.deepEqual(sent, []);
});

test('manual runner parses stage, date, and dry-run without contacting services', () => {
  assert.deepEqual(parseWeeklyWorkflowArgs(['--stage', 'draft', '--date', '2026-07-24', '--dry-run']), {
    stage: 'draft', date: '2026-07-24', dryRun: true,
  });
});
