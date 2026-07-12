# Weekly Instance And Dynamic Template Locator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one idempotent Wiki weekly-sheet instance every Monday, register it in Base, and derive every writable cell from template text instead of configured row coordinates.

**Architecture:** A pure template locator converts the Feishu Sheet value matrix into a semantic cell map bounded by the three report modules. `WeeklySheetWriter` owns Sheet API reads, copies, validation, and cell writes; `BitableService` owns persistent weekly-instance state; a small orchestrator combines them using an ISO year-week key. Existing weekly generation discovers the map from the copied instance immediately before writing, while schedules remain disabled until personal-environment verification succeeds.

**Tech Stack:** Node.js 22, Feishu Sheets OpenAPI v2/v3, Feishu Bitable v1 SDK, Node test runner, existing Tencent Cloud/PM2 deployment.

## Global Constraints

- The fixed template sheet is read-only; all writes target a copied or previously registered weekly instance.
- The business idempotency key is `ISO年份 + ISO周次`; PM2 memory state is not the source of truth.
- The report period is Monday through Friday and uses `Asia/Shanghai` unless explicitly configured otherwise.
- Writable cells are located by `模块标题 + 项目/指标/部门名称 + 内容类型`; coordinates such as `C26` are not business configuration.
- Merged-cell context is inherited from the nearest non-empty business title above it, but never across a module boundary.
- Module 1 values are never generated or overwritten by AI; Stage 2 only locates their value cells.
- Module 2 has exactly one target cell for `本周重点事项说明` and one for `下周工作计划` per project, with no content-count limit.
- Module 3 has exactly three target cells per content type; fewer than three items leave remaining cells blank and no write may cross into the next content type or department.
- Missing modules, duplicate semantic paths, missing content labels, or an undersized Module 3 region fail closed before any business-content write.
- All new schedules and group-level weekly-sheet behavior stay disabled by default.
- Logs and documentation must not expose unmasked app tokens, table IDs, sheet IDs, chat IDs, OpenIDs, or API keys.
- Stage 2 does not add AI-generated weekly content, style adaptation, manual-edit protection, poster generation, or group publishing.

---

### Task 1: Pure Dynamic Template Locator

**Files:**
- Create: `src/weekly-template-locator.js`
- Create: `test/weekly-template-locator.test.js`

**Interfaces:**
- Produces: `normalizeSheetCellText(value): string`.
- Produces: `locateWeeklyTemplateTargets(values, options?): WeeklyCellMap`.
- `WeeklyCellMap` shape: `{ reportPeriod, metrics, agileProjects, management }` where Module 2 values are `{ current, next, aliases }` and Module 3 values are `{ current: string[3], next: string[3], aliases }`.
- Consumes: a row-major matrix returned by Feishu Sheets values API and optional `{ aliasMap, managementCellLimit }`.

- [x] **Step 1: Write failing rich-text and semantic-path tests**

Create `test/weekly-template-locator.test.js` with a compact matrix that represents merged-cell blanks and rich-text segment arrays:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locateWeeklyTemplateTargets,
  normalizeSheetCellText,
} from '../src/weekly-template-locator.js';

const rows = [
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
  ['收单项目组', '本周重点事项说明', ''],
  ['', '下周工作计划', ''],
  [],
  ['三、部门管理工作'],
  [[{ text: '填写说明：每项不超过3条' }]],
  ['1.零售客群经营', '本周工作进展', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '下周工作计划', ''],
  ['', '', ''],
  ['', '', ''],
  ['2.对公客群经营', '本周工作进展', ''],
  ['', '', ''],
  ['', '', ''],
  ['', '下周工作计划', ''],
  ['', '', ''],
  ['', '', ''],
];

test('normalizes Feishu rich-text segments without losing line breaks', () => {
  assert.equal(
    normalizeSheetCellText([{ text: '融羲项目组\n' }, { text: '【需求分析阶段】' }]),
    '融羲项目组\n【需求分析阶段】',
  );
});

test('locates all module targets and inherits merged title context', () => {
  const result = locateWeeklyTemplateTargets(rows, {
    aliasMap: {
      agileProjects: { 融羲项目组: ['融羲'] },
      management: { 零售客群经营: ['零售'] },
    },
  });

  assert.equal(result.reportPeriod, 'B2');
  assert.equal(result.metrics['手机银行月活'], 'C6');
  assert.deepEqual(result.agileProjects['融羲项目组'], {
    current: 'C10', next: 'C11', aliases: ['融羲'],
  });
  assert.deepEqual(result.agileProjects['收单项目组'], {
    current: 'C12', next: 'C13', aliases: [],
  });
  assert.deepEqual(result.management['零售客群经营'], {
    current: ['C17', 'C18', 'C19'],
    next: ['C21', 'C22', 'C23'],
    aliases: ['零售'],
  });
  assert.deepEqual(result.management['对公客群经营'].next, ['C27', 'C28', 'C29']);
});
```

Add fail-closed tests:

```js
test('rejects duplicate semantic paths', () => {
  const duplicate = [...rows, ['2.零售客群经营', '本周工作进展', '']];
  assert.throws(
    () => locateWeeklyTemplateTargets(duplicate),
    /重复定位.*三、部门管理工作.*零售客群经营.*本周工作进展/,
  );
});

test('rejects a management region with fewer than three cells before boundary', () => {
  const tooShort = rows.map(row => [...row]);
  tooShort[18] = ['', '下周工作计划', ''];
  assert.throws(
    () => locateWeeklyTemplateTargets(tooShort),
    /目标区域不足3行/,
  );
});

test('rejects missing required module', () => {
  assert.throws(
    () => locateWeeklyTemplateTargets(rows.slice(0, 14)),
    /缺少模块.*三、部门管理工作/,
  );
});
```

- [x] **Step 2: Run the locator test and verify it fails**

Run: `node --test test/weekly-template-locator.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `weekly-template-locator.js`.

- [x] **Step 3: Implement normalization, bounded scanning, and A1 conversion**

Create `src/weekly-template-locator.js` with these exported entry points and constants:

```js
const MODULES = {
  metrics: '一、核心指标完成情况',
  agileProjects: '二、敏捷项目组工作进展',
  management: '三、部门管理工作',
};

const CONTENT_LABELS = {
  agileProjects: {
    本周重点事项说明: 'current',
    下周工作计划: 'next',
  },
  management: {
    本周工作进展: 'current',
    下周工作计划: 'next',
  },
};

export function normalizeSheetCellText(value) {
  return flattenSheetCellText(value).replace(/\r\n/g, '\n').trim();
}

function flattenSheetCellText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(flattenSheetCellText).join('');
  if (typeof value === 'object') {
    if (value.text != null) return flattenSheetCellText(value.text);
    if (value.value != null) return flattenSheetCellText(value.value);
    return '';
  }
  return String(value);
}

export function locateWeeklyTemplateTargets(values, options = {}) {
  const rows = Array.isArray(values) ? values : [];
  const managementCellLimit = Number(options.managementCellLimit ?? 3);
  if (managementCellLimit !== 3) throw new Error('部门管理目标单元格数量必须为3');

  const result = {
    reportPeriod: '',
    metrics: {},
    agileProjects: {},
    management: {},
  };
  const moduleRows = findModuleRows(rows);
  result.reportPeriod = findReportPeriodCell(rows);
  scanMetrics(rows, moduleRows, result);
  scanRepeatedSections(rows, moduleRows, result, options.aliasMap || {});
  validateCompleteResult(result);
  return result;
}
```

Implement the internal helpers in the same file with these rules:

```js
function findModuleRows(rows) {
  const found = {};
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const text = normalizeSheetCellText(rows[rowIndex]?.[0]);
    for (const [key, title] of Object.entries(MODULES)) {
      if (text.includes(title)) {
        if (found[key] != null) throw new Error(`重复模块标题：${title}`);
        found[key] = rowIndex;
      }
    }
  }
  for (const [key, title] of Object.entries(MODULES)) {
    if (found[key] == null) throw new Error(`缺少模块：${title}`);
  }
  if (!(found.metrics < found.agileProjects && found.agileProjects < found.management)) {
    throw new Error('周报模块顺序错误');
  }
  return found;
}

function findReportPeriodCell(rows) {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (normalizeSheetCellText(rows[rowIndex]?.[0]) === '报告周期') {
      return toA1(1, rowIndex);
    }
  }
  throw new Error('缺少报告周期目标单元格');
}

function scanMetrics(rows, moduleRows, result) {
  for (let row = moduleRows.metrics + 1; row < moduleRows.agileProjects; row += 1) {
    const name = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    if (!name || name === '指标名称' || name.includes('填写说明')) continue;
    addUnique(result.metrics, name, toA1(2, row), `${MODULES.metrics}/${name}`);
  }
}

function scanRepeatedSections(rows, moduleRows, result, aliasMap) {
  scanSection(rows, {
    start: moduleRows.agileProjects + 1,
    end: moduleRows.management,
    moduleKey: 'agileProjects',
    result: result.agileProjects,
    aliases: aliasMap.agileProjects || {},
  });
  scanSection(rows, {
    start: moduleRows.management + 1,
    end: rows.length,
    moduleKey: 'management',
    result: result.management,
    aliases: aliasMap.management || {},
  });
}

function scanSection(rows, { start, end, moduleKey, result, aliases }) {
  let entity = '';
  const labels = CONTENT_LABELS[moduleKey];
  for (let row = start; row < end; row += 1) {
    const columnA = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    const columnB = normalizeSheetCellText(rows[row]?.[1]);
    if (columnA && !columnA.includes('填写说明')) entity = columnA;
    const contentKey = labels[columnB];
    if (!contentKey) continue;
    if (!entity) throw new Error(`${MODULES[moduleKey]}/${columnB} 缺少项目或部门上下文`);

    const target = moduleKey === 'management'
      ? buildManagementRange(rows, row, end, entity, columnB)
      : toA1(2, row);
    const entry = result[entity] || {
      current: moduleKey === 'management' ? [] : '',
      next: moduleKey === 'management' ? [] : '',
      aliases: resolveAliases(aliases, entity),
    };
    if ((Array.isArray(entry[contentKey]) && entry[contentKey].length) || entry[contentKey]) {
      throw new Error(`重复定位：${MODULES[moduleKey]}/${entity}/${columnB}`);
    }
    entry[contentKey] = target;
    result[entity] = entry;
  }
}

function buildManagementRange(rows, startRow, endRow, entity, contentLabel) {
  for (let row = startRow + 1; row <= startRow + 2; row += 1) {
    if (row >= endRow) throw new Error(`${entity}/${contentLabel} 目标区域不足3行`);
    const boundaryA = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    const boundaryB = normalizeSheetCellText(rows[row]?.[1]);
    if (boundaryA || CONTENT_LABELS.management[boundaryB]) {
      throw new Error(`${entity}/${contentLabel} 目标区域不足3行`);
    }
  }
  return [0, 1, 2].map(offset => toA1(2, startRow + offset));
}
```

Complete `cleanEntityName`, `resolveAliases`, `addUnique`, `validateCompleteResult`, and `toA1` as follows:

```js
function cleanEntityName(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/^\s*\d+[.、]\s*/, '')
    .trim();
}

function resolveAliases(aliasConfig, entity) {
  if (Array.isArray(aliasConfig[entity])) return aliasConfig[entity];
  const match = Object.entries(aliasConfig).find(([name, aliases]) => (
    name === entity
      || aliases.some(alias => entity.includes(alias) || alias.includes(entity))
  ));
  return match ? match[1] : [];
}

function addUnique(target, key, value, path) {
  if (target[key]) throw new Error(`重复定位：${path}`);
  target[key] = value;
}

function validateCompleteResult(result) {
  if (!result.reportPeriod) throw new Error('报告周期目标单元格未定位');
  if (!Object.keys(result.metrics).length) throw new Error('核心指标目标单元格未定位');
  for (const [section, title] of [['agileProjects', MODULES.agileProjects], ['management', MODULES.management]]) {
    const entries = Object.entries(result[section]);
    if (!entries.length) throw new Error(`${title}未定位到任何业务板块`);
    for (const [entity, entry] of entries) {
      if (!entry.current || !entry.next || !entry.current.length || !entry.next.length) {
        throw new Error(`${title}/${entity} 缺少本周或下周目标`);
      }
    }
  }
}

function toA1(columnIndex, rowIndex) {
  let number = columnIndex + 1;
  let letters = '';
  while (number > 0) {
    number -= 1;
    letters = String.fromCharCode(65 + (number % 26)) + letters;
    number = Math.floor(number / 26);
  }
  return `${letters}${rowIndex + 1}`;
}
```

- [x] **Step 4: Run locator tests and make boundary fixtures pass**

Run: `node --test test/weekly-template-locator.test.js`

Expected: all locator tests pass, including rejection when the next content label appears inside the required three-cell region.

- [x] **Step 5: Commit the pure locator**

```bash
git add src/weekly-template-locator.js test/weekly-template-locator.test.js
git commit -m "feat: locate weekly template targets dynamically"
```

### Task 2: Sheet Reader And Template Validation

**Files:**
- Modify: `src/weekly-sheet-writer.js`
- Modify: `test/weekly-sheet-writer.test.js`

**Interfaces:**
- Consumes: `locateWeeklyTemplateTargets(values, options)` from Task 1.
- Produces: `WeeklySheetWriter.readSheetValues(sheetConfig, sheetId, options?)`.
- Produces: `WeeklySheetWriter.discoverTemplateTargets(sheetConfig, sheetId, options?)`.
- Extends `listSheets()` results with `rowCount` and `columnCount`.

- [x] **Step 1: Write failing API-read and read-only-template tests**

Add tests to `test/weekly-sheet-writer.test.js` that capture requests:

```js
test('reads copied sheet matrix and returns dynamic targets', async () => {
  const requests = [];
  const writer = new WeeklySheetWriter({
    request: async payload => {
      requests.push(payload);
      if (payload.url.includes('/sheets/query')) {
        return { data: { sheets: [{
          sheet_id: 'week_1',
          title: '本周周报',
          grid_properties: { row_count: 29, column_count: 3 },
        }] } };
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
```

Reuse the Task 1 matrix through a local `buildTemplateRows()` fixture in this test file; do not import test code from another test file.

- [x] **Step 2: Run writer tests and verify they fail**

Run: `node --test test/weekly-sheet-writer.test.js`

Expected: FAIL because `discoverTemplateTargets` is missing and `ensureWeeklySheet` still returns the template when copy is disabled.

- [x] **Step 3: Preserve grid metadata and add the values reader**

Import the locator:

```js
import { locateWeeklyTemplateTargets } from './weekly-template-locator.js';
```

Extend `listSheets()` mapping:

```js
const grid = sheet.grid_properties || sheet.gridProperties || {};
return {
  spreadsheetToken,
  sheetId: sheet.sheet_id || sheet.sheetId,
  title: sheet.title || '',
  index: sheet.index,
  rowCount: Number(grid.row_count || grid.rowCount || 0),
  columnCount: Number(grid.column_count || grid.columnCount || 0),
};
```

Add these methods to `WeeklySheetWriter`:

```js
async readSheetValues(sheetConfig, sheetId, { endRow = 0 } = {}) {
  const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
  const sheet = (await this.listSheets(resolvedConfig.spreadsheetToken))
    .find(item => item.sheetId === sheetId);
  if (!sheet) throw new Error(`周报工作表不存在：${sheetId}`);
  const rowCount = Number(endRow || sheet.rowCount);
  if (!rowCount) throw new Error(`周报工作表行数无效：${sheetId}`);
  const range = `${sheetId}!A1:C${rowCount}`;
  const res = await this.client.request({
    method: 'GET',
    url: `/open-apis/sheets/v2/spreadsheets/${resolvedConfig.spreadsheetToken}/values/${encodeURIComponent(range)}`,
  });
  return res?.data?.valueRange?.values || res?.data?.value_range?.values || [];
}

async discoverTemplateTargets(sheetConfig, sheetId, options = {}) {
  const values = await this.readSheetValues(sheetConfig, sheetId, options);
  return locateWeeklyTemplateTargets(values, options);
}
```

- [x] **Step 4: Enforce template read-only behavior**

Replace the final `copyTemplate === false` fallback in `ensureWeeklySheet` with:

```js
if (sheetConfig.copyTemplate === false) {
  throw new Error('未找到本周实例，禁止直接写入周报模板');
}
```

Keep reuse-by-title before this check. Enhance `copyTemplateSheet` to include returned grid metadata when present, while preserving the existing fallback lookup by title.

- [x] **Step 5: Run focused and full tests**

Run: `node --test test/weekly-sheet-writer.test.js test/weekly-template-locator.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass.

- [x] **Step 6: Commit Sheet read and validation support**

```bash
git add src/weekly-sheet-writer.js test/weekly-sheet-writer.test.js
git commit -m "feat: inspect copied weekly sheets"
```

### Task 3: ISO Week And Coordinate-Free Configuration

**Files:**
- Modify: `src/date-utils.js`
- Create: `test/date-utils.test.js`
- Modify: `src/config.js`
- Modify: `test/config.test.js`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`

**Interfaces:**
- Produces: `getIsoWeekInfo(ymd): { isoYear: number, isoWeek: number, key: string }`.
- Produces: top-level `config.weeklyInstanceCreation` with `{ enabled, dayOfWeek, time, timezone }`.
- Produces: per-group `weeklyInstanceTable` normalized with `WEEKLY_INSTANCE_FIELD_KEYS`.
- Replaces coordinate-bearing defaults with `weeklySheet.entityAliases` only.

- [x] **Step 1: Write failing ISO boundary and configuration tests**

Create `test/date-utils.test.js`:

```js
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
```

Extend `test/config.test.js`:

```js
const config = normalizeConfig({
  weeklyInstanceCreation: { enabled: true, time: '09:05' },
  weeklyInstanceTable: {
    appToken: 'base_token',
    tableId: 'instance_table',
    fieldTypes: { weekStart: 'date', weekEnd: 'date', createdAt: 'datetime', updatedAt: 'datetime' },
  },
  weeklySheet: { spreadsheetToken: 'sheet_token', templateSheetId: 'template' },
  groups: [{ enabled: true, chatId: 'chat_1', project: '公司项目组' }],
});

assert.deepEqual(config.weeklyInstanceCreation, {
  enabled: true,
  dayOfWeek: 1,
  time: '09:05',
  timezone: 'Asia/Shanghai',
});
assert.equal(config.groups[0].weeklyInstanceTable.fields.instanceKey, '周报实例唯一键');
assert.equal(config.groups[0].weeklySheet.cellMap, undefined);
assert.deepEqual(config.groups[0].weeklySheet.entityAliases.agileProjects['融羲项目组'], ['融羲']);
```

- [x] **Step 2: Run tests and verify they fail**

Run: `node --test test/date-utils.test.js test/config.test.js`

Expected: FAIL because ISO-week and weekly-instance configuration do not exist and `cellMap` still contains coordinates.

- [x] **Step 3: Implement ISO week calculation**

Add to `src/date-utils.js`:

```js
export function getIsoWeekInfo(ymd) {
  const parsed = parseYmd(ymd);
  if (!parsed) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return {
    isoYear,
    isoWeek,
    key: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
  };
}
```

- [x] **Step 4: Add weekly instance fields and disabled-by-default schedule**

Add to `src/config.js`:

```js
export const WEEKLY_INSTANCE_FIELD_KEYS = {
  instanceKey: '周报实例唯一键',
  isoYear: 'ISO年份',
  isoWeek: 'ISO周次',
  weekStart: '周开始日期',
  weekEnd: '周结束日期',
  spreadsheetToken: 'SpreadsheetToken',
  sheetId: 'SheetID',
  sheetTitle: '工作表名称',
  sheetUrl: '周报链接',
  status: '实例状态',
  createdAt: '创建时间',
  updatedAt: '更新时间',
};
```

Normalize the schedule before group mapping:

```js
const weeklyInstanceCreation = {
  enabled: raw.weeklyInstanceCreation?.enabled === true,
  dayOfWeek: Number(raw.weeklyInstanceCreation?.dayOfWeek ?? 1),
  time: raw.weeklyInstanceCreation?.time || '09:00',
  timezone: raw.weeklyInstanceCreation?.timezone || timezone,
};
```

Normalize each group table and return the schedule:

```js
weeklyInstanceTable: normalizeTableConfig(
  group.weeklyInstanceTable || raw.weeklyInstanceTable,
  WEEKLY_INSTANCE_FIELD_KEYS,
),
```

```js
return {
  timezone,
  botNames,
  errorReporting,
  weeklyPush,
  weeklyInstanceCreation,
  dailySupervisorPush,
  dailyFactSync,
  groups,
};
```

- [x] **Step 5: Remove coordinate defaults and retain aliases only**

Replace `WEEKLY_SHEET_CELL_MAP` with `WEEKLY_SHEET_ENTITY_ALIASES` containing only names and aliases:

```js
export const WEEKLY_SHEET_ENTITY_ALIASES = {
  agileProjects: {
    融羲项目组: ['融羲'],
    收单项目组: ['收单'],
    线上营业厅项目组: ['线上营业厅', '对公线上营业厅'],
    手机银行项目组: ['手机银行'],
    新核心项目组: ['新核心'],
  },
  management: {
    零售客群经营: ['零售大众客群', '零售', '大众客群', '客群经营', '营销活动'],
    对公客群经营及场景建设: ['对公客群', '对公', '场景建设', '医院', '企业'],
    渠道创新建设: ['渠道创新', '渠道', '线上营业厅', '手机银行'],
    业务风控合规: ['风控', '合规', '风险', '反洗钱', '风险交易', '分级分类', '核查'],
    业务转型推动: ['业务转型', '转型推动', '新核心', '人工智能', '培训'],
  },
};
```

Change `normalizeWeeklySheetConfig` to return:

```js
entityAliases: mergeEntityAliases(
  WEEKLY_SHEET_ENTITY_ALIASES,
  sheet.entityAliases || sheet.entity_aliases || {},
),
```

Implement `mergeEntityAliases` by shallow-merging the two section maps. Do not return `cellMap`, and delete `mergeWeeklySheetCellMap`.

Add disabled example blocks to both config files without real system identifiers:

```json
"weeklyInstanceCreation": {
  "enabled": false,
  "dayOfWeek": 1,
  "time": "09:00",
  "timezone": "Asia/Shanghai"
}
```

In `groups.formal.example.json`, include an example `weeklyInstanceTable` object with empty resource identifiers, exact field names, and date/datetime field types. In `groups.personal.json`, do not invent the table token or ID; add the block only after the personal Base table is created in Task 8.

- [x] **Step 6: Run focused and full tests**

Run: `node --test test/date-utils.test.js test/config.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass. Existing weekly content/reporter unit fixtures may still construct a local `cellMap`; production configuration must not.

- [x] **Step 7: Commit ISO and configuration changes**

```bash
git add src/date-utils.js src/config.js test/date-utils.test.js test/config.test.js config/groups.personal.json config/groups.formal.example.json
git commit -m "feat: configure weekly instance creation"
```

### Task 4: Persistent Weekly Instance Registry

**Files:**
- Modify: `src/bitable-service.js`
- Modify: `test/bitable-service.test.js`

**Interfaces:**
- Consumes: `group.weeklyInstanceTable` from Task 3.
- Produces: `BitableService.findWeeklyInstanceRecord(group, instanceKey)`.
- Produces: `BitableService.upsertWeeklyInstance(group, instance, context?)`.
- `instance` contains `{ instanceKey, isoYear, isoWeek, weekStart, weekEnd, spreadsheetToken, sheetId, sheetTitle, sheetUrl, status }`.

- [x] **Step 1: Write failing registry lookup and upsert tests**

Add focused tests to `test/bitable-service.test.js`:

```js
test('finds weekly instance by persistent ISO week key outside a view', async () => {
  let listPayload;
  const service = new BitableService({
    bitable: { appTableRecord: { list: async payload => {
      listPayload = payload;
      return { data: { items: [
        { record_id: 'rec_other', fields: { 周报实例唯一键: '2026-W28' } },
        { record_id: 'rec_week', fields: { 周报实例唯一键: '2026-W29', SheetID: 'week_29' } },
      ] } };
    } } },
  });
  const group = buildWeeklyInstanceGroup();
  const record = await service.findWeeklyInstanceRecord(group, '2026-W29');
  assert.equal(record.record_id, 'rec_week');
  assert.equal(listPayload.params.view_id, undefined);
});

test('creates weekly instance with date and datetime field conversion', async () => {
  let createPayload;
  const service = new BitableService({
    bitable: { appTableRecord: {
      list: async () => ({ data: { items: [] } }),
      create: async payload => {
        createPayload = payload;
        return { data: { record: { record_id: 'rec_week' } } };
      },
    } },
  });
  const result = await service.upsertWeeklyInstance(buildWeeklyInstanceGroup(), {
    instanceKey: '2026-W29', isoYear: 2026, isoWeek: 29,
    weekStart: '2026-07-13', weekEnd: '2026-07-17',
    spreadsheetToken: 'sheet_token', sheetId: 'week_29',
    sheetTitle: '数字金融部周报 2026-07-13-2026-07-17',
    sheetUrl: 'https://example.invalid/week', status: '已创建',
  }, { now: new Date('2026-07-13T01:00:00.000Z'), timezone: 'Asia/Shanghai' });
  assert.equal(result.created, true);
  assert.equal(createPayload.data.fields['周报实例唯一键'], '2026-W29');
  assert.equal(createPayload.data.fields['周开始日期'], Date.UTC(2026, 6, 13));
  assert.equal(typeof createPayload.data.fields['创建时间'], 'number');
});
```

The shared fixture must configure all keys and:

```js
fieldTypes: {
  weekStart: 'date', weekEnd: 'date', createdAt: 'datetime', updatedAt: 'datetime',
},
```

Add an update test asserting an existing row is updated instead of duplicated and its original `创建时间` is not overwritten.

- [x] **Step 2: Run focused tests and verify they fail**

Run: `node --test --test-name-pattern="weekly instance" test/bitable-service.test.js`

Expected: FAIL because both registry methods are missing.

- [x] **Step 3: Implement lookup and upsert**

Add methods to `BitableService`:

```js
async findWeeklyInstanceRecord(group, instanceKey) {
  if (!tableIsConfigured(group.weeklyInstanceTable) || !instanceKey) return null;
  const records = await this.listRecords(
    group.weeklyInstanceTable,
    'weeklyInstance.findByKey',
    { includeView: false },
  );
  const fieldName = group.weeklyInstanceTable.fields.instanceKey;
  return records.find(record => (
    normalizeFieldValue(record.fields?.[fieldName]) === String(instanceKey)
  )) || null;
}

async upsertWeeklyInstance(group, instance, context = {}) {
  const table = await this.resolveTableConfig(group.weeklyInstanceTable, 'weeklyInstanceTable');
  assertTable(table, 'weeklyInstanceTable');
  const existing = context.existingRecord
    || await this.findWeeklyInstanceRecord(group, instance.instanceKey);
  const fields = buildWeeklyInstanceFields(table, instance, {
    ...context,
    existing,
  });
  if (existing) {
    const res = await withBitableErrorContext('weeklyInstance.update', table, () => (
      this.client.bitable.appTableRecord.update({
        path: { app_token: table.appToken, table_id: table.tableId, record_id: existing.record_id },
        data: { fields },
      })
    ));
    return { created: false, updated: true, record: extractRecordFromResponse(res), fields };
  }
  const res = await withBitableErrorContext('weeklyInstance.create', table, () => (
    this.client.bitable.appTableRecord.create({
      path: { app_token: table.appToken, table_id: table.tableId },
      data: { fields },
    })
  ));
  return { created: true, updated: false, record: extractRecordFromResponse(res), fields };
}
```

Add the field builder near `buildWeeklyFields`:

```js
function buildWeeklyInstanceFields(table, instance, context = {}) {
  const recordFields = {};
  for (const key of [
    'instanceKey', 'isoYear', 'isoWeek', 'weekStart', 'weekEnd',
    'spreadsheetToken', 'sheetId', 'sheetTitle', 'sheetUrl', 'status',
  ]) {
    setMappedField(recordFields, table, key, instance[key], context);
  }
  const now = context.now || new Date();
  if (!context.existing) setMappedField(recordFields, table, 'createdAt', now.getTime(), context);
  setMappedField(recordFields, table, 'updatedAt', now.getTime(), context);
  return recordFields;
}
```

- [x] **Step 4: Run focused and full tests**

Run: `node --test --test-name-pattern="weekly instance" test/bitable-service.test.js`

Expected: all weekly-instance registry tests pass.

Run: `npm test`

Expected: all tests pass.

- [x] **Step 5: Commit persistent instance state**

```bash
git add src/bitable-service.js test/bitable-service.test.js
git commit -m "feat: persist weekly sheet instances"
```

### Task 5: Idempotent Weekly Instance Orchestrator

**Files:**
- Create: `src/weekly-instance-service.js`
- Create: `test/weekly-instance-service.test.js`

**Interfaces:**
- Consumes: `getWorkWeekRange`, `getIsoWeekInfo`, `WeeklySheetWriter`, and Task 4 registry methods.
- Produces: `ensureWeeklyInstanceForGroup({ group, bitable, sheetWriter, now, timezone })`.
- Produces: `ensureWeeklyInstancesForAllGroups({ config, bitable, sheetWriter, now })`.
- A template-copy operation is attempted at most three times with a configurable test delay; title reuse makes recovery after an ambiguous first attempt idempotent.

- [ ] **Step 1: Write failing create, reuse, and recovery tests**

Create `test/weekly-instance-service.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureWeeklyInstanceForGroup,
  ensureWeeklyInstancesForAllGroups,
} from '../src/weekly-instance-service.js';

test('copies, validates, writes only report period, then registers instance', async () => {
  const calls = [];
  const group = buildGroup();
  const result = await ensureWeeklyInstanceForGroup({
    group,
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async (_group, instance) => {
        calls.push(['register', instance]);
        return { created: true };
      },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '本周周报', created: true, reused: false,
      }),
      discoverTemplateTargets: async () => ({ reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} }),
      writeCells: async (_config, sheetId, values) => calls.push(['write', sheetId, values]),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(result.instanceKey, '2026-W29');
  assert.deepEqual(calls[0], ['write', 'week_29', { B2: '2026-07-13 至 2026-07-17' }]);
  assert.equal(calls[1][0], 'register');
  assert.equal(calls[1][1].status, '已创建');
});

test('returns persistent instance without copying or writing', async () => {
  let sheetCalls = 0;
  const result = await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: { findWeeklyInstanceRecord: async () => ({ record_id: 'rec_week', fields: {} }) },
    sheetWriter: { ensureWeeklySheet: async () => { sheetCalls += 1; } },
    now: new Date('2026-07-13T01:00:00.000Z'),
  });
  assert.equal(result.reused, true);
  assert.equal(result.record.record_id, 'rec_week');
  assert.equal(sheetCalls, 0);
});
```

Add a recovery test: Base lookup returns null, `ensureWeeklySheet` returns `{ reused: true }` because a prior attempt copied the titled sheet, and the service still validates and registers it without another copy.

Add a retry test with `retryDelayMs: 0`: make `ensureWeeklySheet` throw twice and succeed on the third call, then assert it was called exactly three times. Add a terminal failure test that always throws and assert the original error is returned after exactly three calls.

Add an all-groups test asserting disabled/unconfigured groups are skipped with reasons and configured groups run sequentially.

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test test/weekly-instance-service.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement orchestration and fail-closed ordering**

Create `src/weekly-instance-service.js`:

```js
import { tableIsConfigured } from './config.js';
import { getIsoWeekInfo, getWorkWeekRange } from './date-utils.js';
import { buildWeeklySheetUrl } from './weekly-sheet-writer.js';

export async function ensureWeeklyInstanceForGroup({
  group,
  bitable,
  sheetWriter,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  retryDelayMs = 1000,
}) {
  if (!group.weeklySheet?.enabled) return { skipped: true, reason: 'weekly_sheet_disabled' };
  if (!tableIsConfigured(group.weeklyInstanceTable)) {
    return { skipped: true, reason: 'weekly_instance_table_not_configured' };
  }

  const { start: weekStart, end: weekEnd } = getWorkWeekRange(now, timezone);
  const { isoYear, isoWeek, key: instanceKey } = getIsoWeekInfo(weekStart);
  const existing = await bitable.findWeeklyInstanceRecord(group, instanceKey);
  if (existing) return { skipped: false, reused: true, instanceKey, record: existing };

  const sheet = await retryOperation(
    () => sheetWriter.ensureWeeklySheet(group.weeklySheet, { weekStart, weekEnd }),
    { attempts: 3, delayMs: retryDelayMs },
  );
  const effectiveConfig = {
    ...group.weeklySheet,
    spreadsheetToken: sheet.spreadsheetToken || group.weeklySheet.spreadsheetToken,
  };
  const targets = await sheetWriter.discoverTemplateTargets(
    effectiveConfig,
    sheet.sheetId,
    { aliasMap: group.weeklySheet.entityAliases },
  );
  await sheetWriter.writeCells(effectiveConfig, sheet.sheetId, {
    [targets.reportPeriod]: `${weekStart} 至 ${weekEnd}`,
  });

  const instance = {
    instanceKey,
    isoYear,
    isoWeek,
    weekStart,
    weekEnd,
    spreadsheetToken: effectiveConfig.spreadsheetToken,
    sheetId: sheet.sheetId,
    sheetTitle: sheet.title,
    sheetUrl: buildWeeklySheetUrl(effectiveConfig, sheet.sheetId),
    status: '已创建',
  };
  const persisted = await bitable.upsertWeeklyInstance(group, instance, { now, timezone });
  return { skipped: false, reused: sheet.reused, instanceKey, sheet, targets, instance, persisted };
}

export async function ensureWeeklyInstancesForAllGroups({ config, bitable, sheetWriter, now = new Date() }) {
  const results = [];
  for (const group of config.groups) {
    try {
      results.push({
        group: group.project || group.chatId,
        ...(await ensureWeeklyInstanceForGroup({
          group,
          bitable,
          sheetWriter,
          now,
          timezone: config.weeklyInstanceCreation?.timezone || config.timezone,
        })),
      });
    } catch (error) {
      results.push({ group: group.project || group.chatId, skipped: false, error });
    }
  }
  return results;
}

async function retryOperation(operation, { attempts, delayMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
```

Preserve the ordering exactly: persistent lookup, ensure/reuse copy, dynamic validation, report-period write, Base registration. This ordering allows a retry after Base failure to recover the already copied sheet by title.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/weekly-instance-service.test.js`

Expected: all orchestrator tests pass.

- [ ] **Step 5: Commit the orchestrator**

```bash
git add src/weekly-instance-service.js test/weekly-instance-service.test.js
git commit -m "feat: ensure idempotent weekly instances"
```

### Task 6: Dynamic Map In Existing Weekly Generation

**Files:**
- Modify: `src/weekly-reporter.js`
- Modify: `test/weekly-reporter.test.js`
- Modify: `test/weekly-sheet-content.test.js`

**Interfaces:**
- Consumes: `WeeklySheetWriter.discoverTemplateTargets()` from Task 2.
- Produces: every `summarizeWeeklySheet` and `buildWeeklySheetValues` call receives the freshly discovered `cellMap`.
- Removes: all production reliance on `group.weeklySheet.cellMap`.

- [x] **Step 1: Update reporter tests to require dynamic discovery**

In the weekly-sheet reporter fixture, add:

```js
const discoveredMap = {
  reportPeriod: 'B2',
  metrics: { 手机银行月活: 'C6' },
  agileProjects: {
    融羲项目组: { current: 'C10', next: 'C11', aliases: ['融羲'] },
  },
  management: {
    零售客群经营: {
      current: ['C17', 'C18', 'C19'],
      next: ['C21', 'C22', 'C23'],
      aliases: ['零售'],
    },
  },
};
```

Make the `sheetWriter` double expose:

```js
discoverTemplateTargets: async (_config, sheetId, options) => {
  assert.equal(sheetId, 'week');
  assert.deepEqual(options.aliasMap, group.weeklySheet.entityAliases);
  return discoveredMap;
},
```

Capture the AI provider input and assert:

```js
assert.equal(sheetAiInput.cellMap, discoveredMap);
```

Add a rejection test where discovery throws `缺少模块：三、部门管理工作`; assert `writeCells`, `upsertWeeklySummary`, and messenger methods are never called.

Update `test/weekly-sheet-content.test.js` fixtures to pass a local semantic `cellMap` directly. These unit tests test content mapping, not configuration normalization.

- [x] **Step 2: Run reporter/content tests and verify they fail**

Run: `node --test test/weekly-reporter.test.js test/weekly-sheet-content.test.js`

Expected: reporter assertions fail because it still passes `group.weeklySheet.cellMap` and never calls discovery.

- [x] **Step 3: Discover the copied instance map before content generation**

In `generateWeeklySheetForGroup`, immediately after `effectiveSheetConfig`:

```js
const cellMap = await writer.discoverTemplateTargets(
  effectiveSheetConfig,
  sheet.sheetId,
  { aliasMap: group.weeklySheet.entityAliases },
);
```

Pass this local `cellMap` to both branches:

```js
cellMap,
```

Do not catch locator errors inside `generateWeeklySheetForGroup`; the existing scheduler/error reporter must receive the failure and no cells should be written.

- [x] **Step 4: Run focused and full tests**

Run: `node --test test/weekly-reporter.test.js test/weekly-sheet-content.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass with no coordinate-bearing production configuration.

- [x] **Step 5: Commit dynamic reporter integration**

```bash
git add src/weekly-reporter.js test/weekly-reporter.test.js test/weekly-sheet-content.test.js
git commit -m "feat: write weekly reports by semantic targets"
```

### Task 7: Monday Scheduler And Manual Command

**Files:**
- Modify: `src/scheduler.js`
- Modify: `test/scheduler.test.js`
- Modify: `src/index.js`
- Modify: `src/error-reporter.js`
- Modify: `test/error-reporter.test.js`
- Create: `scripts/ensure-weekly-instance.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `shouldRunWeeklyInstanceCreation(now, schedule)`.
- Produces: `startWeeklyInstanceScheduler({ config, onRun, logger, intervalMs })`.
- Produces: `reportScheduledError({ err, task, scope, messenger, config })` for administrator-only failure notification.
- Produces: `npm run weekly:ensure` for controlled manual execution using the active groups config.

- [ ] **Step 1: Write failing Monday/timezone scheduler tests**

Extend `test/scheduler.test.js`:

```js
import {
  shouldRunWeeklyInstanceCreation,
  shouldRunDailyFactSync,
  shouldRunDailySupervisorPush,
  shouldRunWeeklyPush,
} from '../src/scheduler.js';

test('runs weekly instance creation Monday at configured Shanghai time', () => {
  const schedule = { enabled: true, dayOfWeek: 1, time: '09:00', timezone: 'Asia/Shanghai' };
  assert.equal(shouldRunWeeklyInstanceCreation(
    new Date('2026-07-13T01:00:00.000Z'), schedule,
  ), true);
  assert.equal(shouldRunWeeklyInstanceCreation(
    new Date('2026-07-13T01:01:00.000Z'), schedule,
  ), false);
});
```

Add a fake-timer-free `startWeeklyInstanceScheduler` test by passing an `intervalMs` and a disabled config; assert it logs `weekly instance creation disabled` and returns a working `stop()` method without calling `onRun`.

- [ ] **Step 2: Run scheduler tests and verify they fail**

Run: `node --test test/scheduler.test.js`

Expected: FAIL because the new scheduler exports are missing.

- [ ] **Step 3: Add scheduler functions using the existing weekly pattern**

Add to `src/scheduler.js`:

```js
export function startWeeklyInstanceScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.weeklyInstanceCreation;
  if (!schedule?.enabled) {
    logger.log('[scheduler] weekly instance creation disabled');
    return { stop() {} };
  }

  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunWeeklyInstanceCreation(now, schedule)) return;
    const runKey = `${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);
    logger.log(`[scheduler] weekly instance creation triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error('[scheduler] weekly instance creation failed', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop() { clearInterval(timer); } };
}

export function shouldRunWeeklyInstanceCreation(now, schedule) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || '09:00').split(':').map(Number);
  return parts.dayOfWeek === Number(schedule.dayOfWeek ?? 1)
    && parts.hour === hour
    && parts.minute === minute;
}
```

- [ ] **Step 4: Wire the scheduler into the service process**

First add a failing test to `test/error-reporter.test.js`:

```js
import {
  buildErrorSummary,
  formatLarkErrorForLog,
  reportHandlerError,
  reportScheduledError,
} from '../src/error-reporter.js';

test('notifies configured admins about a scheduled task failure', async () => {
  const sent = [];
  await reportScheduledError({
    err: new Error('复制模板失败'),
    task: '周报实例创建',
    scope: '公司项目组',
    messenger: {
      sendTextToOpenId: async (id, text) => sent.push(['open', id, text]),
      sendText: async (id, text) => sent.push(['chat', id, text]),
    },
    config: {
      errorReporting: { adminOpenIds: ['ou_admin'], adminChatIds: ['oc_admin'] },
    },
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0][2], /周报实例创建/);
  assert.match(sent[0][2], /公司项目组/);
  assert.match(sent[0][2], /复制模板失败/);
});
```

Run: `node --test test/error-reporter.test.js`

Expected: FAIL because `reportScheduledError` is not exported.

Add to `src/error-reporter.js`, reusing the configured administrator destinations and `Promise.allSettled` behavior:

```js
export async function reportScheduledError({ err, task, scope, messenger, config }) {
  const errorReporting = config?.errorReporting || {};
  const summary = [
    '【数金小助手定时任务异常】',
    `任务：${task}`,
    `范围：${scope}`,
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `错误信息：${truncateText(err?.message || String(err || ''), 500)}`,
  ].filter(line => !line.endsWith('：')).join('\n');
  const tasks = [
    ...(errorReporting.adminOpenIds || []).map(openId => (
      messenger.sendTextToOpenId(openId, summary, buildErrorUuid('scheduled-open', openId, { message_id: `${task}-${scope}-${Date.now()}` }))
    )),
    ...(errorReporting.adminChatIds || []).map(chatId => (
      messenger.sendText(chatId, summary, buildErrorUuid('scheduled-chat', chatId, { message_id: `${task}-${scope}-${Date.now()}` }))
    )),
  ];
  const results = await Promise.allSettled(tasks);
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    console.warn('[error-report] failed to notify admins', failed.map(result => result.reason?.message || result.reason));
  }
}
```

Run: `node --test test/error-reporter.test.js`

Expected: all error reporter tests pass.

Then in `src/index.js`, import `startWeeklyInstanceScheduler`, `ensureWeeklyInstancesForAllGroups`, and `reportScheduledError`, then add before `startWeeklyScheduler`:

```js
startWeeklyInstanceScheduler({
  config,
  onRun: async now => {
    const results = await ensureWeeklyInstancesForAllGroups({
      config,
      bitable,
      sheetWriter,
      now,
    });
    for (const result of results) {
      if (result.error) {
        console.error(`[weekly-instance] failed for ${result.group}`, formatLarkErrorForLog(result.error));
        await reportScheduledError({
          err: result.error,
          task: '周报实例创建',
          scope: result.group,
          messenger,
          config,
        });
      } else {
        console.log('[weekly-instance] result', {
          group: result.group,
          skipped: result.skipped,
          reason: result.reason,
          reused: result.reused,
          instanceKey: result.instanceKey,
        });
      }
    }
  },
});
```

Do not log `sheetId`, token, URL, table ID, or raw record fields.

- [ ] **Step 5: Add the manual command**

Create `scripts/ensure-weekly-instance.js` using the same environment/config initialization as `src/index.js`, but without starting WSClient:

```js
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { ensureWeeklyInstancesForAllGroups } from '../src/weekly-instance-service.js';
import { WeeklySheetWriter } from '../src/weekly-sheet-writer.js';

const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');
const config = loadGroupConfig();
const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});
const results = await ensureWeeklyInstancesForAllGroups({
  config,
  bitable: new BitableService(client),
  sheetWriter: new WeeklySheetWriter(client),
  now: new Date(),
});
console.log(JSON.stringify(results.map(result => ({
  group: result.group,
  skipped: result.skipped,
  reason: result.reason,
  reused: result.reused,
  instanceKey: result.instanceKey,
  error: result.error?.message,
})), null, 2));
if (results.some(result => result.error)) process.exitCode = 1;
```

Add to `package.json` scripts:

```json
"weekly:ensure": "node scripts/ensure-weekly-instance.js"
```

- [ ] **Step 6: Run full verification**

Run: `node --test test/scheduler.test.js test/weekly-instance-service.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass.

Run: `rg -n "C(2[0-9]|3[0-9]|4[0-9]|5[0-9]|6[0-9])" src config`

Expected: no static weekly target coordinates in production source or configuration.

- [ ] **Step 7: Commit scheduling and manual execution**

```bash
git add src/scheduler.js test/scheduler.test.js src/index.js src/error-reporter.js test/error-reporter.test.js scripts/ensure-weekly-instance.js package.json
git commit -m "feat: schedule weekly instance creation"
```

### Task 8: Base Setup Documentation And Personal Live Verification

**Files:**
- Create: `docs/weekly-instance-table-setup.md`
- Modify after resource creation: `config/groups.personal.json`
- Create after verification: `docs/superpowers/verification/2026-07-12-personal-weekly-instance.md`

**Interfaces:**
- Consumes: all Stage 2 code and the existing personal Wiki weekly template.
- Produces: a configured personal `周报实例表`, one controlled weekly instance, and read-back evidence that rerunning is idempotent.

- [ ] **Step 1: Document the exact Base schema before creating resources**

Create `docs/weekly-instance-table-setup.md` with this field table:

```markdown
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| 周报实例唯一键 | 单行文本 | 是 | `ISO年份-W周次`，例如 `2026-W29` |
| ISO年份 | 数字 | 是 | ISO 周所属年份 |
| ISO周次 | 数字 | 是 | 1-53 |
| 周开始日期 | 日期 | 是 | 周一 |
| 周结束日期 | 日期 | 是 | 周五 |
| SpreadsheetToken | 单行文本 | 是 | 仅供服务端定位，不在群聊发送 |
| SheetID | 单行文本 | 是 | 周工作表 ID |
| 工作表名称 | 单行文本 | 是 | 复制后的标题 |
| 周报链接 | 超链接 | 是 | 指向本周工作表 |
| 实例状态 | 单选 | 是 | `已创建`、`创建失败`、`已发布` |
| 创建时间 | 日期时间 | 是 | 首次登记时间 |
| 更新时间 | 日期时间 | 是 | 最近状态更新时间 |
```

Document that the primary view may filter rows but code lookup always reads outside the view. State that tokens and IDs must not be pasted into verification documents or chat logs.

- [ ] **Step 2: Pause for explicit approval before personal Base changes**

Ask the user to choose either:

1. Create `周报实例表` manually using the documented schema and provide its Base link.
2. Authorize the agent to create the table and fields through Feishu Base tooling.

Do not create, rename, or delete any live Base field without this approval.

- [ ] **Step 3: Configure the approved personal table while keeping schedules disabled**

Add the real personal table link or tokens only to `config/groups.personal.json` under `weeklyInstanceTable`. Configure:

```json
"fieldTypes": {
  "weekStart": "date",
  "weekEnd": "date",
  "createdAt": "datetime",
  "updatedAt": "datetime"
}
```

Keep:

```json
"weeklyInstanceCreation": { "enabled": false }
```

Do not commit secrets; app/table/sheet identifiers already managed by the repository's established config policy may be committed only if `git diff` confirms no credentials or API keys are present.

- [ ] **Step 4: Run a read-only locator check against the template**

On the server, use the deployed branch and explicit personal config:

```bash
cd /home/ubuntu/lark-report-bot-git
GROUPS_CONFIG_PATH=config/groups.personal.json node --input-type=module -e '
import "dotenv/config";
import * as lark from "@larksuiteoapi/node-sdk";
import { loadGroupConfig } from "./src/config.js";
import { WeeklySheetWriter } from "./src/weekly-sheet-writer.js";
const config = loadGroupConfig();
const group = config.groups[0];
const client = new lark.Client({ appId: process.env.APP_ID, appSecret: process.env.APP_SECRET, domain: lark.Domain.Feishu });
const writer = new WeeklySheetWriter(client);
const resolved = await writer.resolveSheetConfig(group.weeklySheet);
const targets = await writer.discoverTemplateTargets(resolved, group.weeklySheet.templateSheetId, { aliasMap: group.weeklySheet.entityAliases });
console.log(JSON.stringify({
  reportPeriodLocated: Boolean(targets.reportPeriod),
  metricCount: Object.keys(targets.metrics).length,
  agileProjectCount: Object.keys(targets.agileProjects).length,
  managementCount: Object.keys(targets.management).length,
  managementWidths: Object.values(targets.management).map(item => [item.current.length, item.next.length]),
}, null, 2));'
```

Expected: report period is located, all five agile projects are located, all management widths are `[3,3]`, and no write API is called.

- [ ] **Step 5: Run one controlled creation and read back the result**

Temporarily enable only `weeklySheet.enabled` for the selected personal group; keep the scheduler disabled. Commit the completed implementation, push it from the local workspace, and deploy it on the server:

```bash
git push origin codex/daily-fact-data-layer
git push gitee codex/daily-fact-data-layer
ssh -i /Users/linjingwang/claude_workspace/lark-report-bot/lark_bot_key.pem ubuntu@49.232.202.36
cd /home/ubuntu/lark-report-bot-git
git fetch github codex/daily-fact-data-layer
git switch codex/daily-fact-data-layer
git pull --ff-only github codex/daily-fact-data-layer
npm test
```

Expected: the server is on the pushed commit and the complete test suite passes. Then run:

```bash
cd /home/ubuntu/lark-report-bot-git
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:ensure
```

Expected sanitized output:

```json
[
  {
    "group": "公司项目组",
    "skipped": false,
    "reused": false
  }
]
```

The actual output also contains `instanceKey`; assert that it matches `/^\d{4}-W\d{2}$/` and equals `getIsoWeekInfo(getWorkWeekRange(now).start).key` for the execution time.

Verify in Feishu UI:

- Exactly one copied sheet exists for the current Monday-Friday period.
- `报告周期` contains the current Monday-Friday range.
- Template content is unchanged.
- `周报实例表` has exactly one row for the ISO week key.
- Module 1 metric values remain unchanged/blank.
- No AI content, poster, or group message was generated.

- [ ] **Step 6: Rerun to prove persistent idempotency**

Run the same `npm run weekly:ensure` command again.

Expected: `reused: true`, no second copied sheet, and no second Base record. Restarting PM2 before this second run is allowed and should not change the result.

- [ ] **Step 7: Record sanitized verification evidence and keep schedule disabled**

Create the dated verification document with:

```markdown
# Personal Weekly Instance Verification

- Branch: `codex/daily-fact-data-layer`
- Commit: output of `git rev-parse --short HEAD` captured at verification time
- Template locator: passed
- Module 2 project count: `5`
- Module 3 target widths: every content type is `3`
- First manual ensure: created one instance
- Second manual ensure: reused the same persistent instance
- Template unchanged: confirmed
- Report period read-back: passed
- Weekly-instance Base row count for key: `1`
- Scheduler state after verification: disabled
```

Do not include live tokens, IDs, URLs, OpenIDs, or raw weekly content.

- [ ] **Step 8: Run final local verification and commit documentation/config**

Run: `npm test`

Expected: all tests pass.

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only intended Stage 2 configuration and verification files are listed.

```bash
git add docs/weekly-instance-table-setup.md config/groups.personal.json docs/superpowers/verification/2026-07-12-personal-weekly-instance.md
git commit -m "docs: verify personal weekly instance workflow"
```

Do not enable the Monday scheduler in this commit. Enabling it is a separate production decision after the user reviews the copied sheet and registry row.
