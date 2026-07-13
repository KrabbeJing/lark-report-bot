import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDailyFactBackfillArgs,
  runDailyFactBackfill,
} from '../src/daily-fact-backfill.js';

test('parses an inclusive repair range', () => {
  assert.deepEqual(parseDailyFactBackfillArgs([
    '--start', '2026-07-01', '--end', '2026-07-12', '--repair-organization',
  ]), {
    startDate: '2026-07-01',
    endDate: '2026-07-12',
    repairOrganization: true,
  });
});

test('rejects invalid or reversed ranges', () => {
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026-07-12', '--end', '2026-07-01']),
    /start.*end/,
  );
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026/07/01', '--end', '2026-07-12']),
    /YYYY-MM-DD/,
  );
});

test('rejects impossible calendar dates', () => {
  assert.throws(
    () => parseDailyFactBackfillArgs(['--start', '2026-02-30', '--end', '2026-03-01']),
    /YYYY-MM-DD/,
  );
});

test('accepts a valid leap day', () => {
  assert.deepEqual(parseDailyFactBackfillArgs([
    '--start', '2024-02-29', '--end', '2024-03-01',
  ]), {
    startDate: '2024-02-29',
    endDate: '2024-03-01',
    repairOrganization: false,
  });
});

test('forwards explicit dates and repair policy to every group', async () => {
  const calls = [];
  const result = await runDailyFactBackfill({
    config: { timezone: 'Asia/Shanghai', groups: [{ project: '测试组' }] },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 0, errors: [] };
      },
    },
    options: {
      startDate: '2026-07-01',
      endDate: '2026-07-12',
      repairOrganization: true,
    },
  });
  assert.equal(result[0].group, '测试组');
  assert.equal(calls[0].options.startDate, '2026-07-01');
  assert.equal(calls[0].options.endDate, '2026-07-12');
  assert.equal(calls[0].options.repairOrganization, true);
});
