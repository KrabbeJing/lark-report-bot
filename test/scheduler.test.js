import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunDailySupervisorPush, shouldRunWeeklyPush } from '../src/scheduler.js';
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
