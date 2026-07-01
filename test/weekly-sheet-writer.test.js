import test from 'node:test';
import assert from 'node:assert/strict';
import { WeeklySheetWriter, buildWeeklySheetUrl, renderWeeklySheetTitle } from '../src/weekly-sheet-writer.js';

test('copies template sheet and writes configured cells', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({
    request: async (payload) => {
      calls.push(payload);
      if (payload.method === 'GET') {
        return { data: { sheets: [] } };
      }
      if (payload.url.includes('sheets_batch_update')) {
        return {
          data: {
            replies: [{
              copySheet: {
                properties: {
                  sheetId: 'new_sheet_1',
                  title: '数字金融部周报 2026-06-22-2026-06-26',
                },
              },
            }],
          },
        };
      }
      return { data: {} };
    },
  });
  const config = {
    spreadsheetToken: 'shtcn_test',
    templateSheetId: 'tpl_sheet',
    titlePattern: '数字金融部周报 {{weekStart}}-{{weekEnd}}',
  };

  const sheet = await writer.ensureWeeklySheet(config, {
    weekStart: '2026-06-22',
    weekEnd: '2026-06-26',
  });
  await writer.writeCells(config, sheet.sheetId, {
    C26: '重点事项',
    C27: '下周计划',
  });

  assert.equal(sheet.sheetId, 'new_sheet_1');
  assert.equal(calls[1].data.requests[0].copySheet.source.sheetId, 'tpl_sheet');
  assert.equal(calls[1].data.requests[0].copySheet.destination.title, '数字金融部周报 2026-06-22-2026-06-26');
  assert.deepEqual(calls[2].data.valueRanges, [
    { range: 'new_sheet_1!C26:C26', values: [['重点事项']] },
    { range: 'new_sheet_1!C27:C27', values: [['下周计划']] },
  ]);
});

test('reuses existing weekly sheet by title', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({
    request: async (payload) => {
      calls.push(payload);
      return {
        data: {
          sheets: [{ sheet_id: 'old_sheet_1', title: '数字金融部周报 2026-06-22-2026-06-26' }],
        },
      };
    },
  });

  const sheet = await writer.ensureWeeklySheet({
    spreadsheetToken: 'shtcn_test',
    templateSheetId: 'tpl_sheet',
    titlePattern: '数字金融部周报 {{weekStart}}-{{weekEnd}}',
  }, {
    weekStart: '2026-06-22',
    weekEnd: '2026-06-26',
  });

  assert.equal(sheet.sheetId, 'old_sheet_1');
  assert.equal(sheet.reused, true);
  assert.equal(calls.length, 1);
});

test('resolves wiki node before querying spreadsheet sheets', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({
    request: async (payload) => {
      calls.push(payload);
      if (payload.url.includes('/wiki/v2/spaces/get_node')) {
        return {
          data: {
            node: {
              obj_type: 'sheet',
              obj_token: 'shtcn_from_wiki',
            },
          },
        };
      }
      if (payload.method === 'GET') {
        return { data: { sheets: [{ sheet_id: 'old_sheet_1', title: '周报 2026-06-22' }] } };
      }
      return { data: {} };
    },
  });

  const sheet = await writer.ensureWeeklySheet({
    wikiNodeToken: 'BaTOwZsM6ikYjJkhSqOc8e0Ynrh',
    templateSheetId: 'tpl_sheet',
    titlePattern: '周报 {{weekStart}}',
  }, {
    weekStart: '2026-06-22',
    weekEnd: '2026-06-26',
  });

  assert.equal(sheet.spreadsheetToken, 'shtcn_from_wiki');
  assert.equal(calls[1].url, '/open-apis/sheets/v3/spreadsheets/shtcn_from_wiki/sheets/query');
});

test('renders title and sheet url', () => {
  assert.equal(
    renderWeeklySheetTitle('周报 {{weekStartCompact}}-{{weekEndCompact}}', {
      weekStart: '2026-06-22',
      weekEnd: '2026-06-26',
    }),
    '周报 2026.06.22-2026.06.26',
  );
  assert.equal(
    buildWeeklySheetUrl({
      spreadsheetToken: 'shtcn_test',
      spreadsheetUrl: 'https://example.feishu.cn/sheets/shtcn_test',
    }, 'new_sheet_1'),
    'https://example.feishu.cn/sheets/shtcn_test?sheet=new_sheet_1',
  );
});
