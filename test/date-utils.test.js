import test from 'node:test';
import assert from 'node:assert/strict';
import { getIsoWeekInfo } from '../src/date-utils.js';

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
