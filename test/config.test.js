import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseWeeklySheetLink } from '../src/config.js';

test('parses weekly sheet wiki link', () => {
  const parsed = parseWeeklySheetLink('https://acncyn3n5k6i.feishu.cn/wiki/BaTOwZsM6ikYjJkhSqOc8e0Ynrh?sheet=4dcda2');
  assert.equal(parsed.wikiNodeToken, 'BaTOwZsM6ikYjJkhSqOc8e0Ynrh');
  assert.equal(parsed.sheetId, '4dcda2');
  assert.equal(parsed.spreadsheetToken, '');
});

test('normalizes weeklySheet from wiki url', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
      weeklySheet: {
        enabled: false,
        spreadsheetUrl: 'https://acncyn3n5k6i.feishu.cn/wiki/BaTOwZsM6ikYjJkhSqOc8e0Ynrh?sheet=4dcda2',
      },
    }],
  }).groups[0];

  assert.equal(group.weeklySheet.wikiNodeToken, 'BaTOwZsM6ikYjJkhSqOc8e0Ynrh');
  assert.equal(group.weeklySheet.templateSheetId, '4dcda2');
});
