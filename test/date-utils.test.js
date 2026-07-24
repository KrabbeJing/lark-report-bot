import test from 'node:test';
import assert from 'node:assert/strict';
import { getIsoWeekInfo, getWeeklyReportRange } from '../src/date-utils.js';

test('uses ISO week year across calendar-year boundary', () => {
  assert.deepEqual(getIsoWeekInfo('2027-01-01'), {
    isoYear: 2026,
    isoWeek: 53,
    key: '2026-W53',
  });
  assert.deepEqual(getIsoWeekInfo('2027-01-04'), {
    isoYear: 2027,
    isoWeek: 1,
    key: '2027-W01',
  });
});

test('anchors Friday generation to previous Friday through Thursday', () => {
  const range = getWeeklyReportRange(new Date('2026-07-24T08:30:00+08:00'));
  assert.deepEqual(range, {
    reportDate: '2026-07-24',
    start: '2026-07-17',
    end: '2026-07-23',
  });
});

test('Saturday refresh uses the same Friday report period', () => {
  const range = getWeeklyReportRange(new Date('2026-07-25T09:30:00+08:00'));
  assert.deepEqual(range, {
    reportDate: '2026-07-24',
    start: '2026-07-17',
    end: '2026-07-23',
  });
});
