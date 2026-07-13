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
                  gridProperties: {
                    rowCount: 100,
                    columnCount: 3,
                  },
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
  assert.equal(sheet.rowCount, 100);
  assert.equal(sheet.columnCount, 3);
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

test('uses the Friday MMDD title default through the public writer path', async () => {
  for (const titlePattern of [undefined, '']) {
    const calls = [];
    const writer = new WeeklySheetWriter({
      request: async payload => {
        calls.push(payload);
        if (payload.url.includes('/sheets/query')) return { data: { sheets: [] } };
        return {
          data: {
            replies: [{
              copySheet: {
                properties: { sheetId: 'new_sheet_1', title: payload.data.requests[0].copySheet.destination.title },
              },
            }],
          },
        };
      },
    });

    const sheet = await writer.ensureWeeklySheet({
      spreadsheetToken: 'sheet_token',
      templateSheetId: 'template',
      ...(titlePattern === undefined ? {} : { titlePattern }),
    }, { weekStart: '2026-07-06', weekEnd: '2026-07-10' });

    assert.equal(sheet.title, '数字金融部周报0710');
    assert.equal(calls.at(-1).data.requests[0].copySheet.destination.title, '数字金融部周报0710');
  }
});

test('moves a sheet to workbook index zero with the verified sheet_ai payload', async () => {
  const calls = [];
  let sheetListReads = 0;
  const writer = new WeeklySheetWriter({
    request: async payload => {
      calls.push(payload);
      if (payload.url.includes('/wiki/v2/spaces/get_node')) {
        return { data: { node: { obj_type: 'sheet', obj_token: 'sheet_token' } } };
      }
      if (payload.url.includes('/sheets/query')) {
        sheetListReads += 1;
        return {
          data: {
            sheets: [
              ...(sheetListReads === 1
                ? [
                  { sheet_id: 'template', title: '模板', index: 0 },
                  { sheet_id: 'other', title: '其他', index: 1 },
                  { sheet_id: 'week_28', title: '数字金融部周报0710', index: 2 },
                ]
                : [
                  { sheet_id: 'week_28', title: '数字金融部周报0710', index: 0 },
                  { sheet_id: 'template', title: '模板', index: 1 },
                  { sheet_id: 'other', title: '其他', index: 2 },
                ]),
            ],
          },
        };
      }
      return { data: {} };
    },
  });

  const result = await writer.moveSheet({ wikiNodeToken: 'wiki_node' }, 'week_28', 0);

  assert.deepEqual(result, {
    moved: true,
    targetIndex: 0,
    sourceIndex: 2,
    response: { data: {} },
  });
  assert.equal(sheetListReads, 2);
  assert.deepEqual(calls.find(call => call.method === 'POST'), {
    method: 'POST',
    url: '/open-apis/sheet_ai/v2/spreadsheets/sheet_token/tools/invoke_write',
    data: {
      input: JSON.stringify({
        excel_id: 'sheet_token',
        operation: 'move',
        sheet_id: 'week_28',
        source_index: 2,
        target_index: 0,
      }),
      tool_name: 'modify_workbook_structure',
    },
  });
});

test('rejects a top-level nonzero sheet move business code without exposing tokens', async () => {
  const writer = new WeeklySheetWriter({
    request: async payload => {
      if (payload.url.includes('/sheets/query')) {
        return { data: { sheets: [{ sheet_id: 'week_secret', title: '周报', index: 2 }] } };
      }
      return { code: 99991663, data: { msg: 'sheet_token_should_not_leak' } };
    },
  });

  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token_should_not_leak' }, 'week_secret', 0),
    error => {
      assert.match(error.message, /周报工作表移动失败/);
      assert.doesNotMatch(error.message, /sheet_token_should_not_leak|week_secret/);
      return true;
    },
  );
});

test('rejects a nested nonzero sheet move business code without exposing tokens', async () => {
  const writer = new WeeklySheetWriter({
    request: async payload => {
      if (payload.url.includes('/sheets/query')) {
        return { data: { sheets: [{ sheet_id: 'week_secret', title: '周报', index: 2 }] } };
      }
      return { data: { code: 99991663, msg: 'sheet_token_should_not_leak' } };
    },
  });

  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token_should_not_leak' }, 'week_secret', 0),
    error => {
      assert.match(error.message, /周报工作表移动失败/);
      assert.doesNotMatch(error.message, /sheet_token_should_not_leak|week_secret/);
      return true;
    },
  );
});

test('rejects a successful move response when the follow-up sheet list keeps the old index', async () => {
  let sheetListReads = 0;
  const writer = new WeeklySheetWriter({
    request: async payload => {
      if (payload.url.includes('/sheets/query')) {
        sheetListReads += 1;
        return { data: { sheets: [{ sheet_id: 'week_secret', title: '周报', index: 2 }] } };
      }
      return { data: {} };
    },
  });

  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token_should_not_leak' }, 'week_secret', 0),
    error => {
      assert.match(error.message, /移动后位置未确认/);
      assert.doesNotMatch(error.message, /sheet_token_should_not_leak|week_secret/);
      return true;
    },
  );
  assert.equal(sheetListReads, 2);
});

test('does not invoke a write when the sheet is already at the target index', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({
    request: async payload => {
      calls.push(payload);
      return { data: { sheets: [{ sheet_id: 'week_28', title: '数字金融部周报0710', index: 0 }] } };
    },
  });

  const result = await writer.moveSheet({ spreadsheetToken: 'sheet_token' }, 'week_28', 0);

  assert.deepEqual(result, {
    moved: false,
    skipped: true,
    reason: 'already_at_target_index',
    targetIndex: 0,
    sourceIndex: 0,
  });
  assert.equal(calls.length, 1);
});

test('validates sheet move arguments and requires the current sheet to exist', async () => {
  const writer = new WeeklySheetWriter({
    request: async () => ({ data: { sheets: [] } }),
  });

  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token' }, '', 0),
    /sheetId 为空/,
  );
  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token' }, 'week_28', -1),
    /目标位置无效/,
  );
  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: 'sheet_token' }, 'week_28', 0),
    /周报工作表不存在/,
  );
});

test('rejects a direct empty spreadsheet token before querying sheets', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({ request: async payload => {
    calls.push(payload);
    return { data: { sheets: [] } };
  } });

  await assert.rejects(
    writer.moveSheet({ spreadsheetToken: '' }, 'week_28', 0),
    /spreadsheetToken.*为空/,
  );
  assert.equal(calls.length, 0);
});

test('rejects an empty Wiki spreadsheet token before querying or writing', async () => {
  const calls = [];
  const writer = new WeeklySheetWriter({ request: async payload => {
    calls.push(payload);
    return { data: { node: { obj_type: 'sheet', obj_token: '' } } };
  } });

  await assert.rejects(
    writer.moveSheet({ wikiNodeToken: 'wiki_node' }, 'week_28', 0),
    /spreadsheetToken.*为空/,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /wiki\/v2\/spaces\/get_node/);
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

test('reads copied sheet matrix and returns dynamic targets', async () => {
  const requests = [];
  const writer = new WeeklySheetWriter({
    request: async payload => {
      requests.push(payload);
      if (payload.url.includes('/sheets/query')) {
        return {
          data: {
            sheets: [{
              sheet_id: 'week_1',
              title: '本周周报',
              grid_properties: { row_count: 29, column_count: 3 },
            }],
          },
        };
      }
      if (payload.url.includes('/values/')) {
        return { data: { valueRange: { values: buildTemplateRows() } } };
      }
      return { data: {} };
    },
  });

  const result = await writer.discoverTemplateTargets(
    { spreadsheetToken: 'sheet_token' },
    'week_1',
  );

  assert.equal(result.reportPeriod, 'B2');
  assert.equal(result.agileProjects['融羲项目组'].current, 'C10');
  assert.match(requests.at(-1).url, /values/);
  assert.match(decodeURIComponent(requests.at(-1).url), /week_1!A1:C29/);
});

test('never falls back to writing the template when copy is disabled', async () => {
  const writer = new WeeklySheetWriter({
    request: async () => ({ data: { sheets: [] } }),
  });

  await assert.rejects(
    writer.ensureWeeklySheet({
      spreadsheetToken: 'sheet_token',
      templateSheetId: 'template',
      copyTemplate: false,
      titlePattern: '周报 {{weekStart}}',
    }, { weekStart: '2026-07-13', weekEnd: '2026-07-17' }),
    /禁止直接写入周报模板/,
  );
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
    renderWeeklySheetTitle('数字金融部周报{{weekEndMMDD}}', {
      weekStart: '2026-07-06',
      weekEnd: '2026-07-10',
    }),
    '数字金融部周报0710',
  );
  assert.equal(
    buildWeeklySheetUrl({
      spreadsheetToken: 'shtcn_test',
      spreadsheetUrl: 'https://example.feishu.cn/sheets/shtcn_test',
    }, 'new_sheet_1'),
    'https://example.feishu.cn/sheets/shtcn_test?sheet=new_sheet_1',
  );
});

function buildTemplateRows() {
  return [
    ['数字金融部周报'],
    ['报告周期', 'YYYY年MM月DD日-YYYY年MM月DD日'],
    [],
    ['一、核心指标完成情况'],
    ['指标名称', '目标值', '完成情况'],
    ['手机银行月活', '100万', ''],
    [],
    ['二、敏捷项目组工作进展'],
    ['填写说明'],
    [[{ text: '融羲项目组\n' }, { text: '【需求分析阶段】' }], '本周重点事项说明', ''],
    ['', '下周工作计划', ''],
    [],
    ['三、部门管理工作'],
    ['填写说明：每项不超过3条'],
    ['1.零售客群经营', '本周工作进展', ''],
    ['', '', ''],
    ['', '', ''],
    ['', '', ''],
    ['', '下周工作计划', ''],
    ['', '', ''],
    ['', '', ''],
  ];
}
