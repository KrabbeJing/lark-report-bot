import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRunDailyFactSync,
  shouldRunDailySupervisorPush,
  shouldRunWeeklyInstanceCreation,
  shouldRunWeeklyPush,
  startWeeklyInstanceScheduler,
} from '../src/scheduler.js';
import { normalizeConfig } from '../src/config.js';

test('runs weekly push at configured Saturday time in Asia Shanghai', () => {
  const now = new Date('2026-06-27T02:00:00.000Z');
  assert.equal(shouldRunWeeklyPush(now, {
    dayOfWeek: 6,
    time: '10:00',
    timezone: 'Asia/Shanghai',
  }), true);
});

test('does not run at the wrong minute', () => {
  const now = new Date('2026-06-27T02:01:00.000Z');
  assert.equal(shouldRunWeeklyPush(now, {
    dayOfWeek: 6,
    time: '10:00',
    timezone: 'Asia/Shanghai',
  }), false);
});

test('runs weekly instance creation Monday at configured Shanghai time', () => {
  const schedule = {
    enabled: true,
    dayOfWeek: 1,
    time: '09:00',
    timezone: 'Asia/Shanghai',
  };
  assert.equal(shouldRunWeeklyInstanceCreation(
    new Date('2026-07-13T01:00:00.000Z'),
    schedule,
  ), true);
  assert.equal(shouldRunWeeklyInstanceCreation(
    new Date('2026-07-13T01:01:00.000Z'),
    schedule,
  ), false);
});

test('weekly instance scheduler stays inert when disabled', () => {
  const logs = [];
  let runCount = 0;
  const scheduler = startWeeklyInstanceScheduler({
    config: { weeklyInstanceCreation: { enabled: false } },
    onRun: async () => { runCount += 1; },
    logger: { log: message => logs.push(message), error() {} },
    intervalMs: 5,
  });

  scheduler.stop();
  assert.equal(runCount, 0);
  assert.deepEqual(logs, ['[scheduler] weekly instance creation disabled']);
});

test('runs daily supervisor push at configured time in Asia Shanghai', () => {
  const now = new Date('2026-06-29T09:00:00.000Z');
  assert.equal(shouldRunDailySupervisorPush(now, {
    time: '17:00',
    timezone: 'Asia/Shanghai',
  }), true);
});

test('does not run daily supervisor push at wrong time', () => {
  const now = new Date('2026-06-29T09:01:00.000Z');
  assert.equal(shouldRunDailySupervisorPush(now, {
    time: '17:00',
    timezone: 'Asia/Shanghai',
  }), false);
});

test('daily supervisor push is disabled unless explicitly enabled', () => {
  assert.equal(normalizeConfig({}).dailySupervisorPush.enabled, false);
  assert.equal(normalizeConfig({ dailySupervisorPush: { enabled: true } }).dailySupervisorPush.enabled, true);
});

test('runs daily fact sync at configured time in Asia Shanghai', () => {
  const now = new Date('2026-06-29T10:10:00.000Z');
  assert.equal(shouldRunDailyFactSync(now, {
    time: '18:10',
    timezone: 'Asia/Shanghai',
  }), true);
});

test('daily fact sync is disabled unless explicitly enabled', () => {
  assert.equal(normalizeConfig({}).dailyFactSync.enabled, false);
  const config = normalizeConfig({ dailyFactSync: { enabled: true, lookbackDays: 3 } });
  assert.equal(config.dailyFactSync.enabled, true);
  assert.equal(config.dailyFactSync.lookbackDays, 3);
});
