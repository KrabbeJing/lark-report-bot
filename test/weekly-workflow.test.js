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

test('publish stage renders one modular image poster for each configured small team', async () => {
  const order = [];
  const sent = [];
  const services = fakeServices(order, {
    poster: {
      readSheet: async () => { order.push('read current Sheet'); return { sections: {} }; },
      render: async () => { order.push('render deterministic poster'); return { outPath: '/tmp/department.png' }; },
      renderTeam: async ({ target, summary }) => {
        order.push(`render ${target.key} image`);
        return { outPath: `/tmp/${target.key}.png`, sections: summary.sections };
      },
      validate: async ({ poster }) => {
        assert.match(poster.outPath, /\.png$/);
        order.push('validate image');
      },
      sendDepartment: async () => { order.push('send department image'); },
      sendTeam: async (target, poster, key) => {
        sent.push({ target, poster, key });
        order.push(`send ${target.key}`);
        return { imageKey: `img-${target.key}` };
      },
    },
    smallTeam: {
      generate: async ({ target }) => ({
        target: target.key,
        name: target.name,
        sections: [{ key: 'cloud-pay', name: '云缴费', summaryText: '完成需求评审。' }],
      }),
    },
  });
  const group = {
    project: '测试组',
    weeklyDelivery: {
      departmentChatId: 'oc_department',
      smallTeams: [
        {
          key: 'team-a',
          name: '公司板块',
          enabled: true,
          chatId: 'oc_team_a',
          posterSections: [{ key: 'cloud-pay', name: '云缴费' }],
        },
        {
          key: 'team-b',
          name: '零售板块',
          enabled: true,
          chatId: 'oc_team_b',
          posterSections: [{ key: 'retail', name: '零售大众客群经营' }],
        },
      ],
    },
  };

  await runWeeklyWorkflowStage({
    stage: 'publish',
    group,
    now: new Date('2026-07-26T04:00:00Z'),
    services,
  });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(item => item.target.key), ['team-a', 'team-b']);
  assert.deepEqual(sent.map(item => item.poster.outPath), ['/tmp/team-a.png', '/tmp/team-b.png']);
  assert.deepEqual(sent.map(item => item.key), [
    'weekly-2026-07-31-publish-team-a',
    'weekly-2026-07-31-publish-team-b',
  ]);
  assert.deepEqual(order, [
    'read current Sheet',
    'render deterministic poster',
    'validate image',
    'send department image',
    'persist status',
    'render team-a image',
    'validate image',
    'send team-a',
    'persist status',
    'render team-b image',
    'validate image',
    'send team-b',
    'persist status',
    'persist publish',
  ]);
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

test('publish stage does not retry a small team already marked as having no content', async () => {
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
            status: '跳过',
            idempotencyKey: 'weekly-2026-07-31-publish-team-a',
            errorCode: 'no_content',
          }],
        },
        targets: {},
      }),
    },
    poster: {
      readSheet: async () => ({ sections: {} }),
      render: async sheet => sheet,
      validate: async () => {},
      sendDepartment: async () => sent.push('department'),
      sendTeam: async target => sent.push(target.key),
    },
    smallTeam: {
      generate: async () => { throw new Error('should not regenerate'); },
    },
  });

  await runWeeklyWorkflowStage({
    stage: 'publish',
    group: {
      project: '测试组',
      weeklyDelivery: {
        departmentChatId: 'oc_same',
        smallTeams: [{
          key: 'team-a',
          enabled: true,
          posterSections: [{ key: 'retail', name: '零售大众客群经营' }],
        }],
      },
    },
    now: new Date('2026-07-26T03:00:00Z'),
    services,
  });

  assert.deepEqual(sent, []);
});

test('manual runner parses stage, date, and dry-run without contacting services', () => {
  assert.deepEqual(parseWeeklyWorkflowArgs(['--stage', 'draft', '--date', '2026-07-24', '--dry-run']), {
    stage: 'draft', date: '2026-07-24', dryRun: true,
  });
});
