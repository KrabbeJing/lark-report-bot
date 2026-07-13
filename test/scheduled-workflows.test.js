import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroupedWorkflow } from '../src/scheduled-workflows.js';

test('reports one terminal throw for a grouped workflow', async () => {
  const alerts = [];
  const results = await runGroupedWorkflow({
    task: 'AI周报生成',
    stage: 'generate_weekly',
    groups: [{ project: '公司项目组' }],
    operation: async () => { throw new Error('provider unavailable'); },
    notifyFailure: async alert => alerts.push(alert),
  });

  assert.equal(results[0].failed, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].task, 'AI周报生成');
  assert.equal(alerts[0].stage, 'generate_weekly');
  assert.equal(alerts[0].errors[0].message, 'provider unavailable');
});

test('aggregates returned record errors without throwing', async () => {
  const alerts = [];
  const results = await runGroupedWorkflow({
    task: '日报事实同步',
    stage: 'write_daily_fact',
    groups: [{ project: '公司项目组' }],
    operation: async () => ({ errors: [{ message: 'row one' }, { message: 'row two' }] }),
    notifyFailure: async alert => alerts.push(alert),
  });

  assert.equal(results[0].errors.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].errors.length, 2);
});

test('processes workflow groups sequentially', async () => {
  const order = [];
  await runGroupedWorkflow({
    task: '直属上级日报推送',
    stage: 'deliver_supervisor_digest',
    groups: [{ project: '一组' }, { project: '二组' }],
    operation: async group => { order.push(group.project); return { delivered: true }; },
    notifyFailure: async () => {},
  });

  assert.deepEqual(order, ['一组', '二组']);
});

test('preserves a weekly instance stage attached to the terminal error', async () => {
  const alerts = [];
  const error = new Error('template unavailable');
  error.weeklyInstanceStage = 'copy_template';
  await runGroupedWorkflow({
    task: '周报实例创建',
    stage: 'ensure_weekly_instance',
    groups: [{ project: '公司项目组' }],
    operation: async () => { throw error; },
    notifyFailure: async alert => alerts.push(alert),
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].stage, 'copy_template');
});
