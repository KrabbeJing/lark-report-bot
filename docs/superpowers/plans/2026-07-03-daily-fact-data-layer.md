# Daily Fact Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-phase data layer that captures chat daily reports, syncs form daily reports, and maintains one normalized fact record per member per day.

**Architecture:** Keep existing poster and weekly-report behavior intact. Add a chat raw table path, normalize both chat and form sources into a daily fact table, and reconcile conflicts with form priority. Use config-driven table mappings so the user manually creates Feishu Bitable tables and fields.

**Tech Stack:** Node.js ESM, `@larksuiteoapi/node-sdk`, Feishu Bitable APIs, `node:test`, current `config/groups.json` configuration pattern.

---

## Scope Check

This plan implements only the first-phase data layer from `docs/superpowers/specs/2026-07-03-daily-fact-data-layer-design.md`.

Included:

- `群聊日报原始表` configuration and write path.
- `日报统一事实表` configuration, source reconciliation, and upsert path.
- Multi-day daily report parsing and fact splitting.
- Contact matching with OpenID first and name fallback.
- Form-priority conflict handling.
- Daily scheduled reconciliation.
- Tests for parser, config, contact matching, raw chat table write, fact upsert, and scheduler behavior.

Excluded:

- AI weekly summary.
- Wiki sheet writing.
- Poster generation changes.
- Timed push changes.
- Automatic Bitable table or field creation.

## File Structure

- `src/config.js`
  - Owns config normalization and default field key maps.
  - Add `CHAT_DAILY_RAW_FIELD_KEYS`.
  - Expand `DAILY_FACT_FIELD_KEYS`.
  - Normalize `chatDailyRawTable`.

- `config/groups.json`
  - Add disabled/null `chatDailyRawTable`.
  - Keep `dailyFactTable` disabled/null until the user creates real tables.

- `src/daily-report-parser.js`
  - Extend date parsing to support date ranges like `6.29-6.30`.
  - Return `reportDates`, `dateRange`, and `reportType`.

- `src/daily-record-utils.js`
  - New pure utility module for content normalization, content fingerprinting, fact-key creation, date expansion helpers, and source comparison.

- `src/bitable-service.js`
  - Keep Bitable transport helpers.
  - Add focused methods for chat raw records and fact-table upserts.
  - Refactor current `dailyFactTable` partial behavior to match the approved design.

- `src/message-router.js`
  - Route high-confidence chat reports through the new raw-table and fact-table path when configured.
  - Fall back to current daily table write when new tables are not configured.

- `src/daily-fact-sync.js`
  - Reconcile form records and chat raw records into fact table for all configured groups.

- `src/scheduler.js`
  - Keep current daily fact sync scheduler and ensure tests cover it.

- Tests:
  - `test/config.test.js`
  - `test/daily-report-parser.test.js`
  - `test/daily-record-utils.test.js`
  - `test/bitable-service.test.js`
  - `test/message-router.test.js`
  - `test/daily-fact-sync.test.js`
  - `test/scheduler.test.js`

---

### Task 1: Add Configuration Surface for Chat Raw and Fact Tables

**Files:**
- Modify: `src/config.js`
- Modify: `config/groups.json`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing config test**

Add this test to `test/config.test.js`:

```js
test('normalizes chat raw and daily fact table configs', () => {
  const config = normalizeConfig({
    dailyFactSync: {
      enabled: true,
      time: '18:10',
      lookbackDays: 5,
    },
    groups: [{
      chatId: 'oc_test',
      dailyTable: {
        appToken: 'bas_test',
        tableId: 'tbl_daily',
      },
      chatDailyRawTable: {
        appToken: 'bas_test',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          rawText: '原始消息文本',
        },
      },
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reporterNameText: '日报提交人姓名',
        },
      },
    }],
  });

  const group = config.groups[0];
  assert.equal(config.dailyFactSync.enabled, true);
  assert.equal(config.dailyFactSync.lookbackDays, 5);
  assert.equal(group.chatDailyRawTable.tableId, 'tbl_chat_raw');
  assert.equal(group.chatDailyRawTable.fields.messageId, '消息ID');
  assert.equal(group.chatDailyRawTable.fields.reportDateRange, '日报日期范围');
  assert.equal(group.dailyFactTable.fields.factKey, '事实唯一键');
  assert.equal(group.dailyFactTable.fields.contentFingerprint, '内容指纹');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- test/config.test.js
```

Expected: fail because `chatDailyRawTable`, `factKey`, or `contentFingerprint` defaults are missing.

- [ ] **Step 3: Update `src/config.js` field maps**

Add this export near the other field key constants:

```js
export const CHAT_DAILY_RAW_FIELD_KEYS = {
  messageId: '消息ID',
  chatId: '群ID',
  chatName: '群名称',
  senderOpenId: '发送人OpenID',
  reporterName: '标题姓名',
  reportDateRange: '日报日期范围',
  reportDates: '拆分日期列表',
  rawText: '原始消息文本',
  workSummaryText: '解析后工作总结',
  contentFingerprint: '内容指纹',
  messageTime: '消息时间',
  receivedAt: '接收时间',
  parseStatus: '解析状态',
  rawRecordStatus: '原始记录状态',
};
```

Replace the current `DAILY_FACT_FIELD_KEYS` export with:

```js
export const DAILY_FACT_FIELD_KEYS = {
  factKey: '事实唯一键',
  reportDate: '日报日期',
  reporterName: '实际日报提交人',
  reporterNameText: '日报提交人姓名',
  memberOpenId: '成员OpenID',
  project: '所属板块',
  agileGroup: '敏捷小组',
  supervisor: '直属上级',
  divisionalLeader: '分管领导',
  workItems: '今日工作总结',
  tomorrowPlanItems: '明日工作计划',
  riskItems: '遇到的问题',
  contentFingerprint: '内容指纹',
  source: '日报来源',
  sourceRecordId: '来源记录ID',
  messageId: '来源消息ID',
  sourceRefs: '来源组合',
  reportType: '日报类型',
  dateRange: '日期覆盖范围',
  matchMethod: '匹配方式',
  matchingStatus: '匹配状态',
  mergeStatus: '合并状态',
  conflictStatus: '冲突状态',
  factStatus: '事实记录状态',
  syncedAt: '同步时间',
};
```

In `normalizeConfig`, add `chatDailyRawTable` to each normalized group:

```js
chatDailyRawTable: normalizeTableConfig(group.chatDailyRawTable || group.chat_daily_raw_table, CHAT_DAILY_RAW_FIELD_KEYS),
```

- [ ] **Step 4: Update `config/groups.json` defaults**

Add this field beside `dailyTable` and `dailyFactTable`:

```json
"chatDailyRawTable": null,
```

Keep `dailyFactTable` as `null` until the user creates the real table.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
npm test -- test/config.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.js config/groups.json test/config.test.js
git commit -m "Add daily fact table config surface"
```

---

### Task 2: Extend Daily Report Parser for Date Ranges

**Files:**
- Modify: `src/daily-report-parser.js`
- Test: `test/daily-report-parser.test.js`

- [ ] **Step 1: Write parser tests for multi-day reports**

Add these tests to `test/daily-report-parser.test.js`:

```js
test('parses date range daily report into multiple report dates', () => {
  const parsed = parseDailyReportText(`刘喜双 6.29-6.30 工作日报
1、完成开发区一中云充值取数逻辑梳理
2、整理千分卡考核指标`, {
    messageTime: new Date('2026-07-01T01:30:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.highConfidence, true);
  assert.equal(parsed.reporterName, '刘喜双');
  assert.equal(parsed.reportDate, '2026-06-29');
  assert.deepEqual(parsed.reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(parsed.dateRange, '2026-06-29~2026-06-30');
  assert.equal(parsed.reportType, '多日合并');
  assert.equal(parsed.workSummaryText, `1、完成开发区一中云充值取数逻辑梳理
2、整理千分卡考核指标`);
});

test('uses title date instead of next-day message time', () => {
  const parsed = parseDailyReportText(`刘喜双6.30工作日报
1、补发昨日数据提取进展`, {
    messageTime: new Date('2026-07-01T00:30:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  assert.equal(parsed.reportDate, '2026-06-30');
  assert.deepEqual(parsed.reportDates, ['2026-06-30']);
  assert.equal(parsed.reportType, '单日');
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
npm test -- test/daily-report-parser.test.js
```

Expected: fail because `reportDates`, `dateRange`, and `reportType` are not implemented.

- [ ] **Step 3: Add date-range parsing helpers**

In `src/daily-report-parser.js`, import `addDaysToYmd`:

```js
import { addDaysToYmd, coerceLarkTimestamp, formatYmd } from './date-utils.js';
```

Add this date-range pattern above `DATE_PATTERNS`:

```js
const DATE_RANGE_PATTERNS = [
  /(?<startYear>20\d{2})?\s*(?<startMonth>\d{1,2})\s*[-/.月]\s*(?<startDay>\d{1,2})\s*(?:日)?\s*[-~至到]\s*(?:(?<endYear>20\d{2})\s*[-/.年]\s*)?(?:(?<endMonth>\d{1,2})\s*[-/.月]\s*)?(?<endDay>\d{1,2})\s*日?/,
];
```

Replace the `dateInfo` assignment with:

```js
const dateInfo = extractDateInfo(title, fallbackDate, timezone);
```

Add these helper functions:

```js
function extractDateInfo(title, fallbackDate, timezone) {
  const range = extractDateRange(title, fallbackDate, timezone);
  if (range) return range;

  const single = extractDate(title, fallbackDate, timezone);
  return {
    ...single,
    dates: [single.ymd],
    rangeText: single.ymd,
    reportType: '单日',
  };
}

function extractDateRange(title, fallbackDate, timezone) {
  for (const pattern of DATE_RANGE_PATTERNS) {
    const match = String(title || '').match(pattern);
    if (!match?.groups) continue;

    const fallbackYear = Number(formatYmd(fallbackDate, timezone).slice(0, 4));
    const startYear = match.groups.startYear ? Number(match.groups.startYear) : fallbackYear;
    const endYear = match.groups.endYear ? Number(match.groups.endYear) : startYear;
    const startMonth = Number(match.groups.startMonth);
    const startDay = Number(match.groups.startDay);
    const endMonth = Number(match.groups.endMonth || match.groups.startMonth);
    const endDay = Number(match.groups.endDay);

    if (!isValidMonthDay(startMonth, startDay) || !isValidMonthDay(endMonth, endDay)) continue;

    const start = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    const dates = expandDateRange(start, end);
    if (dates.length < 2) continue;

    return {
      raw: match[0],
      ymd: dates[0],
      dates,
      rangeText: `${dates[0]}~${dates[dates.length - 1]}`,
      reportType: '多日合并',
    };
  }
  return null;
}

function expandDateRange(start, end) {
  const dates = [];
  let current = start;
  for (let i = 0; i < 31; i += 1) {
    dates.push(current);
    if (current === end) return dates;
    current = addDaysToYmd(current, 1);
  }
  return [];
}
```

In the returned parsed object, add:

```js
reportDates: dateInfo.dates,
dateRange: dateInfo.rangeText,
reportType: dateInfo.reportType,
```

- [ ] **Step 4: Run parser tests and verify pass**

Run:

```bash
npm test -- test/daily-report-parser.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/daily-report-parser.js test/daily-report-parser.test.js
git commit -m "Parse multi-day daily reports"
```

---

### Task 3: Add Daily Record Utility Module

**Files:**
- Create: `src/daily-record-utils.js`
- Test: `test/daily-record-utils.test.js`

- [ ] **Step 1: Write utility tests**

Create `test/daily-record-utils.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentFingerprint,
  buildFactKey,
  buildSourceRefs,
  normalizeContentForFingerprint,
} from '../src/daily-record-utils.js';

test('normalizes content for stable fingerprinting', () => {
  assert.equal(
    normalizeContentForFingerprint(' 1. 完成测试\\n\\n2、整理材料 '),
    '1、完成测试\\n2、整理材料',
  );
});

test('builds same fingerprint for equivalent list markers', () => {
  const a = buildContentFingerprint({ workItems: '1. 完成测试' });
  const b = buildContentFingerprint({ workItems: '1、完成测试' });
  assert.equal(a, b);
});

test('builds fact key with open id first and name fallback', () => {
  assert.equal(buildFactKey({ openId: 'ou_1', name: '张三', reportDate: '2026-07-01' }), 'open_id:ou_1:2026-07-01');
  assert.equal(buildFactKey({ openId: '', name: '张三', reportDate: '2026-07-01' }), 'name:张三:2026-07-01');
});

test('builds compact source refs', () => {
  assert.equal(buildSourceRefs({ sourceRecordId: 'rec_1', messageId: 'om_1' }), 'form:rec_1\\nchat:om_1');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- test/daily-record-utils.test.js
```

Expected: fail because the module does not exist.

- [ ] **Step 3: Create utility module**

Create `src/daily-record-utils.js`:

```js
import crypto from 'node:crypto';

export function normalizeContentForFingerprint(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^(\d+)\s*[.)）]\s*/, '$1、'))
    .join('\n');
}

export function buildContentFingerprint({ workItems = '', tomorrowPlanItems = '', riskItems = '' } = {}) {
  const normalized = [
    normalizeContentForFingerprint(workItems),
    normalizeContentForFingerprint(tomorrowPlanItems),
    normalizeContentForFingerprint(riskItems),
  ].join('\n---\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function buildFactKey({ openId = '', name = '', reportDate }) {
  const date = String(reportDate || '').trim();
  const id = String(openId || '').trim();
  const displayName = String(name || '').trim();
  if (id) return `open_id:${id}:${date}`;
  return `name:${displayName}:${date}`;
}

export function buildSourceRefs({ sourceRecordId = '', messageId = '' } = {}) {
  return [
    sourceRecordId ? `form:${sourceRecordId}` : '',
    messageId ? `chat:${messageId}` : '',
  ].filter(Boolean).join('\n');
}

export function hasSameContentFingerprint(a, b) {
  return Boolean(a && b && a === b);
}
```

- [ ] **Step 4: Run utility tests and verify pass**

Run:

```bash
npm test -- test/daily-record-utils.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/daily-record-utils.js test/daily-record-utils.test.js
git commit -m "Add daily record utilities"
```

---

### Task 4: Improve Contact Matching for Real Names and Account Migration

**Files:**
- Modify: `src/config.js`
- Modify: `src/bitable-service.js`
- Test: `test/bitable-service.test.js`

- [ ] **Step 1: Write contact matching tests**

Add these tests to `test/bitable-service.test.js`:

```js
test('matches contact by open id and uses real name for display', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      contactTable: {
        appToken: 'bas',
        tableId: 'tbl_contacts',
        fields: {
          teamName: '团队名称',
          teamMember: '团队成员',
          memberRealName: '成员真实姓名',
          memberAliases: '成员别名',
          currentOpenId: '当前OpenID',
          supervisor: '直属上级',
          divisionalLeader: '分管领导',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_contact',
              fields: {
                团队名称: '零售大众客群经营',
                团队成员: [{ id: 'ou_external', name: '用户400276' }],
                成员真实姓名: '刘喜双',
                成员别名: '喜双\\n小刘',
                当前OpenID: 'ou_external',
                直属上级: [{ id: 'ou_mgr', name: '王经理' }],
                分管领导: [{ id: 'ou_leader', name: '李总' }],
              },
            }],
          },
        }),
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '刘喜双', senderOpenId: 'ou_external' });
  assert.equal(contact.teamMember, '刘喜双');
  assert.equal(contact.accountDisplayName, '用户400276');
  assert.equal(contact.teamMemberId, 'ou_external');
  assert.equal(contact.matchMethod, 'open_id');
  assert.equal(contact.matchingStatus, '已匹配');
  assert.equal(contact.divisionalLeader, '李总');
  assert.equal(contact.divisionalLeaderOpenId, 'ou_leader');
});

test('matches contact by alias when open id is unavailable', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      contactTable: {
        appToken: 'bas',
        tableId: 'tbl_contacts',
        fields: {
          teamMember: '团队成员',
          memberRealName: '成员真实姓名',
          memberAliases: '成员别名',
        },
      },
    }],
  }).groups[0];

  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_contact',
              fields: {
                团队成员: [{ id: 'ou_1', name: '用户400276' }],
                成员真实姓名: '刘喜双',
                成员别名: '喜双\\n小刘',
              },
            }],
          },
        }),
      },
    },
  });

  const contact = await service.findTeamContact(group, { reporterName: '小刘' });
  assert.equal(contact.teamMember, '刘喜双');
  assert.equal(contact.matchMethod, 'name_fallback');
  assert.equal(contact.matchingStatus, '姓名匹配');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: fail because contact fields and matching logic do not handle real names or aliases yet.

- [ ] **Step 3: Expand contact field defaults**

In `src/config.js`, replace `CONTACT_FIELD_KEYS` with:

```js
export const CONTACT_FIELD_KEYS = {
  teamName: '团队名称',
  teamMember: '团队成员',
  memberRealName: '成员真实姓名',
  memberAliases: '成员别名',
  currentOpenId: '当前OpenID',
  historicalOpenIds: '历史OpenID/历史账号说明',
  accountType: '账号类型',
  memberStatus: '成员状态',
  teamRole: '团队身份',
  agileGroup: '敏捷小组',
  supervisor: '直属上级',
  divisionalLeader: '分管领导',
};
```

- [ ] **Step 4: Update contact normalization and matching**

In `src/bitable-service.js`, update `normalizeContactRecord` to include real name, aliases, current OpenID, and leaders:

```js
function normalizeContactRecord(record, fields) {
  const f = record.fields || {};
  const member = normalizePersonValue(fields.teamMember ? f[fields.teamMember] : '');
  const supervisor = normalizePersonValue(fields.supervisor ? f[fields.supervisor] : '');
  const divisionalLeader = normalizePersonValue(fields.divisionalLeader ? f[fields.divisionalLeader] : '');
  const realName = normalizeFieldValue(fields.memberRealName ? f[fields.memberRealName] : '');
  const aliases = splitMultiline(fields.memberAliases ? f[fields.memberAliases] : '');
  const currentOpenId = normalizeFieldValue(fields.currentOpenId ? f[fields.currentOpenId] : '') || member.id;
  return {
    recordId: record.record_id,
    teamName: normalizeFieldValue(fields.teamName ? f[fields.teamName] : ''),
    teamMember: realName || member.name,
    accountDisplayName: member.name,
    teamMemberId: currentOpenId,
    memberAliases: aliases,
    teamRole: normalizeFieldValue(fields.teamRole ? f[fields.teamRole] : ''),
    agileGroup: normalizeFieldValue(fields.agileGroup ? f[fields.agileGroup] : ''),
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    divisionalLeader: divisionalLeader.name,
    divisionalLeaderOpenId: divisionalLeader.id,
  };
}
```

Update `findBestContact`:

```js
function findBestContact(contacts, { reporterName = '', senderOpenId = '' } = {}) {
  const exactOpenId = senderOpenId
    ? contacts.find(contact => contact.teamMemberId === senderOpenId)
    : null;
  if (exactOpenId) {
    return { ...exactOpenId, matchMethod: 'open_id', matchingStatus: '已匹配' };
  }

  const name = String(reporterName || '').trim();
  const exactName = name
    ? contacts.find(contact => contact.teamMember === name || contact.memberAliases?.includes(name))
    : null;
  if (exactName) {
    return { ...exactName, matchMethod: 'name_fallback', matchingStatus: '姓名匹配' };
  }

  return null;
}
```

- [ ] **Step 5: Run focused tests and verify pass**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/bitable-service.js test/bitable-service.test.js
git commit -m "Improve team directory contact matching"
```

---

### Task 5: Write Chat Reports to Raw Table and Preserve History

**Files:**
- Modify: `src/bitable-service.js`
- Test: `test/bitable-service.test.js`

- [ ] **Step 1: Write raw table tests**

Add this test to `test/bitable-service.test.js`:

```js
test('creates chat raw daily record and marks previous version historical', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: {
        appToken: 'bas',
        tableId: 'tbl_chat_raw',
        fields: {
          messageId: '消息ID',
          chatId: '群ID',
          senderOpenId: '发送人OpenID',
          reporterName: '标题姓名',
          reportDateRange: '日报日期范围',
          reportDates: '拆分日期列表',
          rawText: '原始消息文本',
          workSummaryText: '解析后工作总结',
          contentFingerprint: '内容指纹',
          rawRecordStatus: '原始记录状态',
        },
      },
    }],
  }).groups[0];

  const updates = [];
  let createPayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_old',
              fields: {
                发送人OpenID: 'ou_liu',
                拆分日期列表: '2026-07-01',
                原始记录状态: '主版本',
              },
            }],
          },
        }),
        update: async (payload) => {
          updates.push(payload);
          return { data: { data: { record: { record_id: payload.path.record_id } } } };
        },
        create: async (payload) => {
          createPayload = payload;
          return { data: { data: { record: { record_id: 'rec_new', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.createChatDailyRawRecord(group, {
    reporterName: '刘喜双',
    reportDate: '2026-07-01',
    reportDates: ['2026-07-01'],
    dateRange: '2026-07-01',
    reportType: '单日',
    rawText: '刘喜双7.1工作日报\\n1、完成数据提取',
    workSummaryText: '1、完成数据提取',
    workItems: ['完成数据提取'],
  }, {
    messageId: 'om_new',
    chatId: 'oc_test',
    senderOpenId: 'ou_liu',
  });

  assert.equal(result.created, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].path.record_id, 'rec_old');
  assert.equal(updates[0].data.fields['原始记录状态'], '历史版本');
  assert.equal(createPayload.data.fields['消息ID'], 'om_new');
  assert.equal(createPayload.data.fields['原始记录状态'], '主版本');
  assert.equal(createPayload.data.fields['拆分日期列表'], '2026-07-01');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: fail because `createChatDailyRawRecord` is not implemented.

- [ ] **Step 3: Add raw table methods**

In `src/bitable-service.js`, import utilities:

```js
import { buildContentFingerprint } from './daily-record-utils.js';
```

Add class methods:

```js
async createChatDailyRawRecord(group, report, context = {}) {
  assertTable(group.chatDailyRawTable, 'chatDailyRawTable');
  await this.markPreviousChatRawRecordsHistorical(group, report, context);
  const fields = buildChatRawFields(group.chatDailyRawTable, report, context);
  const res = await withBitableErrorContext('chatDailyRaw.create', group.chatDailyRawTable, () => (
    this.client.bitable.appTableRecord.create({
      path: {
        app_token: group.chatDailyRawTable.appToken,
        table_id: group.chatDailyRawTable.tableId,
      },
      params: { user_id_type: 'open_id' },
      data: { fields },
    })
  ));
  return { created: true, record: extractRecordFromResponse(res), fields };
}

async markPreviousChatRawRecordsHistorical(group, report, context = {}) {
  if (!tableIsConfigured(group.chatDailyRawTable)) return { updated: 0 };
  const records = await this.listRecords(group.chatDailyRawTable, 'chatDailyRaw.findPrevious', { includeView: false });
  const fields = group.chatDailyRawTable.fields;
  const dates = new Set(report.reportDates || [report.reportDate]);
  const candidates = records.filter(record => {
    const f = record.fields || {};
    const sameSender = normalizeFieldValue(f[fields.senderOpenId]) === String(context.senderOpenId || '');
    const sameName = normalizeFieldValue(f[fields.reporterName]) === String(report.reporterName || '');
    const recordDates = splitMultiline(f[fields.reportDates]);
    const overlaps = recordDates.some(date => dates.has(date));
    const isMain = normalizeFieldValue(f[fields.rawRecordStatus]) === '主版本';
    return overlaps && isMain && (sameSender || sameName);
  });

  for (const record of candidates) {
    await withBitableErrorContext('chatDailyRaw.markHistorical', group.chatDailyRawTable, () => (
      this.client.bitable.appTableRecord.update({
        path: {
          app_token: group.chatDailyRawTable.appToken,
          table_id: group.chatDailyRawTable.tableId,
          record_id: record.record_id,
        },
        data: { fields: { [fields.rawRecordStatus]: '历史版本' } },
      })
    ));
  }
  return { updated: candidates.length };
}
```

Add helper:

```js
function buildChatRawFields(table, report, context = {}) {
  const recordFields = {};
  setMappedField(recordFields, table, 'messageId', context.messageId || '', context);
  setMappedField(recordFields, table, 'chatId', context.chatId || '', context);
  setMappedField(recordFields, table, 'chatName', context.chatName || '', context);
  setMappedField(recordFields, table, 'senderOpenId', context.senderOpenId || '', context);
  setMappedField(recordFields, table, 'reporterName', report.reporterName || '', context);
  setMappedField(recordFields, table, 'reportDateRange', report.dateRange || report.reportDate || '', context);
  setMappedField(recordFields, table, 'reportDates', report.reportDates || [report.reportDate], context);
  setMappedField(recordFields, table, 'rawText', report.rawText || '', context);
  setMappedField(recordFields, table, 'workSummaryText', report.workSummaryText || report.workItems || [], context);
  setMappedField(recordFields, table, 'contentFingerprint', buildContentFingerprint({
    workItems: report.workSummaryText || report.workItems || '',
    tomorrowPlanItems: report.tomorrowPlanItems || '',
    riskItems: report.riskItems || '',
  }), context);
  setMappedField(recordFields, table, 'messageTime', context.messageTimeText || '', context);
  setMappedField(recordFields, table, 'receivedAt', context.receivedAtText || formatDateTime(new Date(), DEFAULT_TIMEZONE), context);
  setMappedField(recordFields, table, 'parseStatus', report.highConfidence ? '已解析' : '低置信度', context);
  setMappedField(recordFields, table, 'rawRecordStatus', '主版本', context);
  return recordFields;
}
```

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/bitable-service.js test/bitable-service.test.js
git commit -m "Write chat reports to raw table"
```

---

### Task 6: Reconcile Sources Into Daily Fact Table

**Files:**
- Modify: `src/bitable-service.js`
- Test: `test/bitable-service.test.js`

- [ ] **Step 1: Write fact reconciliation tests**

Add this test to `test/bitable-service.test.js`:

```js
test('reconciles form and chat sources with form priority and conflict status', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      dailyFactTable: {
        appToken: 'bas',
        tableId: 'tbl_fact',
        fields: {
          factKey: '事实唯一键',
          reportDate: '日报日期',
          reporterNameText: '日报提交人姓名',
          memberOpenId: '成员OpenID',
          workItems: '今日工作总结',
          contentFingerprint: '内容指纹',
          source: '日报来源',
          sourceRecordId: '来源记录ID',
          messageId: '来源消息ID',
          sourceRefs: '来源组合',
          mergeStatus: '合并状态',
          conflictStatus: '冲突状态',
          factStatus: '事实记录状态',
        },
        fieldTypes: { reportDate: 'date' },
      },
    }],
  }).groups[0];

  let updatePayload = null;
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        list: async () => ({
          data: {
            items: [{
              record_id: 'rec_fact',
              fields: {
                事实唯一键: 'open_id:ou_liu:2026-07-01',
                今日工作总结: '1、群聊内容',
                内容指纹: 'chat-fingerprint',
                日报来源: 'chat',
              },
            }],
          },
        }),
        update: async (payload) => {
          updatePayload = payload;
          return { data: { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } } };
        },
      },
    },
  });

  const result = await service.upsertDailyFactRecord(group, {
    factKey: 'open_id:ou_liu:2026-07-01',
    reportDate: '2026-07-01',
    reporterName: '刘喜双',
    memberOpenId: 'ou_liu',
    workSummaryText: '1、表单内容',
    source: 'form',
    sourceRecordId: 'rec_form',
    messageId: 'om_chat',
    existingChatFingerprint: 'chat-fingerprint',
  });

  assert.equal(result.updated, true);
  assert.equal(updatePayload.path.record_id, 'rec_fact');
  assert.equal(updatePayload.data.fields['日报来源'], 'form+chat');
  assert.equal(updatePayload.data.fields['今日工作总结'], '1、表单内容');
  assert.equal(updatePayload.data.fields['合并状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['冲突状态'], '内容冲突');
  assert.equal(updatePayload.data.fields['事实记录状态'], '待人工确认');
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: fail because `upsertDailyFactRecord` is not implemented with conflict handling.

- [ ] **Step 3: Implement fact upsert**

In `src/bitable-service.js`, import:

```js
import { buildContentFingerprint, buildSourceRefs, hasSameContentFingerprint } from './daily-record-utils.js';
```

Add class method:

```js
async upsertDailyFactRecord(group, input) {
  assertTable(group.dailyFactTable, 'dailyFactTable');
  const existing = await this.findDailyFactRecordByFactKey(group, input.factKey);
  const fields = buildDailyFactFields(group.dailyFactTable, input, existing);
  if (existing) {
    const res = await withBitableErrorContext('dailyFact.update', group.dailyFactTable, () => (
      this.client.bitable.appTableRecord.update({
        path: {
          app_token: group.dailyFactTable.appToken,
          table_id: group.dailyFactTable.tableId,
          record_id: existing.record_id,
        },
        params: { user_id_type: 'open_id' },
        data: { fields },
      })
    ));
    return { updated: true, record: extractRecordFromResponse(res), fields };
  }

  const res = await withBitableErrorContext('dailyFact.create', group.dailyFactTable, () => (
    this.client.bitable.appTableRecord.create({
      path: {
        app_token: group.dailyFactTable.appToken,
        table_id: group.dailyFactTable.tableId,
      },
      params: { user_id_type: 'open_id' },
      data: { fields },
    })
  ));
  return { created: true, record: extractRecordFromResponse(res), fields };
}

async findDailyFactRecordByFactKey(group, factKey) {
  if (!factKey || !tableIsConfigured(group.dailyFactTable)) return null;
  const fieldName = group.dailyFactTable.fields.factKey;
  if (!fieldName) return null;
  const records = await this.listRecords(group.dailyFactTable, 'dailyFact.findByFactKey', { includeView: false });
  return records.find(record => String(record.fields?.[fieldName] || '') === String(factKey)) || null;
}
```

Add helper:

```js
function buildDailyFactFields(table, input, existing) {
  const existingFields = existing?.fields || {};
  const fields = table.fields;
  const incomingFingerprint = buildContentFingerprint({
    workItems: input.workSummaryText || input.workItems || '',
    tomorrowPlanItems: input.tomorrowPlanItems || '',
    riskItems: input.riskItems || '',
  });
  const existingFingerprint = normalizeFieldValue(fields.contentFingerprint ? existingFields[fields.contentFingerprint] : '');
  const existingSource = normalizeFieldValue(fields.source ? existingFields[fields.source] : '');
  const hasChatAndForm = (existingSource === 'chat' && input.source === 'form')
    || (existingSource === 'form' && input.source === 'chat')
    || existingSource === 'form+chat';
  const sameContent = hasSameContentFingerprint(existingFingerprint, incomingFingerprint);
  const mergedSource = hasChatAndForm ? 'form+chat' : input.source;
  const mergeStatus = hasChatAndForm ? (sameContent ? '重复已合并' : '内容冲突') : '单来源';
  const conflictStatus = mergeStatus === '内容冲突' ? '内容冲突' : '无冲突';
  const factStatus = mergeStatus === '内容冲突' ? '待人工确认' : '有效';
  const useIncomingContent = input.source === 'form' || existingSource !== 'form';

  const recordFields = {};
  setMappedField(recordFields, table, 'factKey', input.factKey);
  setMappedField(recordFields, table, 'reportDate', input.reportDate);
  setMappedField(recordFields, table, 'reporterName', input.reporterName || '');
  setMappedField(recordFields, table, 'reporterNameText', input.reporterName || '');
  setMappedField(recordFields, table, 'memberOpenId', input.memberOpenId || '');
  setMappedField(recordFields, table, 'workItems', useIncomingContent ? input.workSummaryText || input.workItems || '' : existingFields[fields.workItems]);
  setMappedField(recordFields, table, 'contentFingerprint', useIncomingContent ? incomingFingerprint : existingFingerprint);
  setMappedField(recordFields, table, 'source', mergedSource);
  setMappedField(recordFields, table, 'sourceRecordId', input.sourceRecordId || normalizeFieldValue(fields.sourceRecordId ? existingFields[fields.sourceRecordId] : ''));
  setMappedField(recordFields, table, 'messageId', input.messageId || normalizeFieldValue(fields.messageId ? existingFields[fields.messageId] : ''));
  setMappedField(recordFields, table, 'sourceRefs', buildSourceRefs({ sourceRecordId: input.sourceRecordId, messageId: input.messageId }));
  setMappedField(recordFields, table, 'mergeStatus', mergeStatus);
  setMappedField(recordFields, table, 'conflictStatus', conflictStatus);
  setMappedField(recordFields, table, 'factStatus', factStatus);
  setMappedField(recordFields, table, 'syncedAt', formatDateTime(new Date(), DEFAULT_TIMEZONE));
  return recordFields;
}
```

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
npm test -- test/bitable-service.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/bitable-service.js test/bitable-service.test.js
git commit -m "Reconcile daily fact records"
```

---

### Task 7: Route Chat Reports Through Raw and Fact Tables

**Files:**
- Modify: `src/message-router.js`
- Test: `test/message-router.test.js`

- [ ] **Step 1: Write routing test**

Add this test to `test/message-router.test.js`:

```js
test('writes configured chat reports to raw table and fact table', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_liu' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-07-01T00:30:00+08:00').getTime()),
        content: JSON.stringify({
          text: `刘喜双6.30工作日报
1、补发昨日数据提取进展`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      findTeamContact: async () => ({ teamMember: '刘喜双', teamMemberId: 'ou_liu', matchingStatus: '已匹配' }),
      createChatDailyRawRecord: async (group, parsed, context) => {
        calls.push({ type: 'raw', group, parsed, context });
        return { created: true, record: { record_id: 'rec_raw' } };
      },
      upsertDailyFactRecord: async (group, input) => {
        calls.push({ type: 'fact', group, input });
        return { created: true, record: { record_id: 'rec_fact' } };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls[0].type, 'raw');
  assert.equal(calls[0].parsed.reportDate, '2026-06-30');
  assert.equal(calls[1].type, 'fact');
  assert.equal(calls[1].input.factKey, 'open_id:ou_liu:2026-06-30');
  assert.equal(calls[1].input.source, 'chat');
});
```

- [ ] **Step 2: Run routing tests and verify failure**

Run:

```bash
npm test -- test/message-router.test.js
```

Expected: fail because `message-router` does not call the new raw/fact path.

- [ ] **Step 3: Update message router path**

In `src/message-router.js`, import utilities:

```js
import { buildFactKey } from './daily-record-utils.js';
```

Replace the direct `createDailyReportRecord` block with:

```js
const contact = typeof bitable.findTeamContact === 'function'
  ? await findTeamContactSafely(bitable, group, {
    reporterName: parsed.reporterName,
    senderOpenId: getSenderOpenId(data),
  })
  : null;

if (group.chatDailyRawTable && group.dailyFactTable && typeof bitable.createChatDailyRawRecord === 'function') {
  const rawResult = await bitable.createChatDailyRawRecord(group, parsed, {
    messageId: message.message_id,
    chatId: message.chat_id,
    senderOpenId: getSenderOpenId(data),
    messageTimeText: formatDateTime(messageTime, config.timezone),
    contact,
  });

  for (const reportDate of parsed.reportDates || [parsed.reportDate]) {
    await bitable.upsertDailyFactRecord(group, {
      factKey: buildFactKey({
        openId: contact?.teamMemberId || getSenderOpenId(data),
        name: contact?.teamMember || parsed.reporterName,
        reportDate,
      }),
      reportDate,
      reporterName: contact?.teamMember || parsed.reporterName,
      memberOpenId: contact?.teamMemberId || getSenderOpenId(data),
      workSummaryText: parsed.workSummaryText,
      tomorrowPlanItems: parsed.tomorrowPlanItems,
      riskItems: parsed.riskItems,
      source: 'chat',
      messageId: message.message_id,
      rawRecordId: rawResult.record?.record_id || '',
      reportType: parsed.reportType || '单日',
      dateRange: parsed.dateRange || reportDate,
      contact,
    });
  }
  console.log('[daily-report] chat raw/fact write result', {
    messageId: message.message_id,
    chatId: message.chat_id,
    reporterName: parsed.reporterName,
    reportDates: parsed.reportDates || [parsed.reportDate],
    rawRecordId: rawResult.record?.record_id || '',
  });
} else {
  const result = await bitable.createDailyReportRecord(group, parsed, {
    messageId: message.message_id,
    chatId: message.chat_id,
    senderOpenId: getSenderOpenId(data),
    source: mentioned ? 'mention_chat' : 'chat',
    messageTimeText: formatDateTime(messageTime, config.timezone),
    contact,
  });
  console.log('[daily-report] record write result', {
    messageId: message.message_id,
    chatId: message.chat_id,
    reporterName: parsed.reporterName,
    reportDate: parsed.reportDate,
    created: result.created,
    recordId: result.record?.record_id || result.record?.recordId || '',
    verifiedOutsideView: result.verifiedOutsideView || false,
    responseSummary: result.responseSummary,
    workItemCount: parsed.workItems.length,
  });
}
```

- [ ] **Step 4: Run routing tests and verify pass**

Run:

```bash
npm test -- test/message-router.test.js
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/message-router.js test/message-router.test.js
git commit -m "Route chat reports through raw and fact tables"
```

---

### Task 8: Reconcile Form and Chat Sources in Daily Sync

**Files:**
- Modify: `src/daily-fact-sync.js`
- Modify: `src/bitable-service.js`
- Test: `test/daily-fact-sync.test.js`
- Test: `test/bitable-service.test.js`

- [ ] **Step 1: Write daily sync orchestration test**

Add to `test/daily-fact-sync.test.js`:

```js
test('passes daily fact sync options through to bitable service', async () => {
  const config = normalizeConfig({
    dailyFactSync: { enabled: true, lookbackDays: 3, time: '18:10' },
    groups: [{
      chatId: 'oc_1',
      project: '板块1',
      dailyTable: { appToken: 'bas', tableId: 'tbl_source' },
      chatDailyRawTable: { appToken: 'bas', tableId: 'tbl_chat_raw' },
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  });
  const calls = [];
  await syncDailyFactsForAllGroups({
    config,
    now: new Date('2026-07-03T10:10:00.000Z'),
    logger: { log() {}, error() {} },
    bitable: {
      syncDailyFactRecordsForGroup: async (group, options) => {
        calls.push({ group, options });
        return { created: 1, updated: 1, conflicts: 0 };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].group.chatDailyRawTable.tableId, 'tbl_chat_raw');
  assert.equal(calls[0].options.lookbackDays, 3);
});
```

- [ ] **Step 2: Write Bitable sync test for source coverage**

Add to `test/bitable-service.test.js`:

```js
test('daily fact sync skips when raw or fact tables are not configured', async () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyTable: { appToken: 'bas', tableId: 'tbl_daily' },
    }],
  }).groups[0];
  const service = new BitableService({});
  const result = await service.syncDailyFactRecordsForGroup(group);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not configured/);
});
```

- [ ] **Step 3: Run tests and verify expected failures**

Run:

```bash
npm test -- test/daily-fact-sync.test.js test/bitable-service.test.js
```

Expected: `daily fact sync skips when raw or fact tables are not configured` fails because `syncDailyFactRecordsForGroup` currently skips only when `dailyTable` or `dailyFactTable` is missing.

- [ ] **Step 4: Update sync precondition**

In `syncDailyFactRecordsForGroup`, change precondition to:

```js
if (!tableIsConfigured(group.dailyTable) || !tableIsConfigured(group.chatDailyRawTable) || !tableIsConfigured(group.dailyFactTable)) {
  return { skipped: true, reason: 'dailyTable, chatDailyRawTable, or dailyFactTable not configured' };
}
```

- [ ] **Step 5: Extend sync implementation**

Update `syncDailyFactRecordsForGroup` to:

```js
const formRecords = await this.listRecords(group.dailyTable, 'dailyFactSync.form.list');
const chatRawRecords = await this.listRecords(group.chatDailyRawTable, 'dailyFactSync.chatRaw.list', { includeView: false });
```

Then process:

- form records first, using `source='form'`
- chat raw records second, using `source='chat'`
- both paths call `upsertDailyFactRecord`

Use these exact source labels:

```js
const FORM_SOURCE = 'form';
const CHAT_SOURCE = 'chat';
```

For every processed record, increment one of:

```js
created += result.created ? 1 : 0;
updated += result.updated ? 1 : 0;
conflicts += result.fields?.[group.dailyFactTable.fields.conflictStatus] === '内容冲突' ? 1 : 0;
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```bash
npm test -- test/daily-fact-sync.test.js test/bitable-service.test.js
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/daily-fact-sync.js src/bitable-service.js test/daily-fact-sync.test.js test/bitable-service.test.js
git commit -m "Sync form and chat sources into facts"
```

---

### Task 9: Update Scheduler and End-to-End Regression Tests

**Files:**
- Modify: `test/scheduler.test.js`
- Modify: `test/message-router.test.js`
- Existing: `src/scheduler.js`
- Existing: `src/index.js`

- [ ] **Step 1: Verify scheduler tests already cover daily fact sync**

Run:

```bash
npm test -- test/scheduler.test.js
```

Expected: pass with `runs daily fact sync at configured time in Asia Shanghai`.

- [ ] **Step 2: Add fallback routing regression test**

Add to `test/message-router.test.js`:

```js
test('falls back to legacy daily table write when raw and fact tables are absent', async () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '支付平台',
      dailyTable: { appToken: 'bas_test', tableId: 'tbl_daily' },
    }],
  });
  const calls = [];

  await handleMessageEvent({
    data: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_fallback',
        chat_id: 'oc_test',
        chat_type: 'group',
        message_type: 'text',
        create_time: String(new Date('2026-06-26T09:00:00+08:00').getTime()),
        content: JSON.stringify({
          text: `王治坤6.26日工作日报
1、参加案例评审`,
        }),
      },
    },
    client: {},
    messenger: { replyText: async () => {} },
    bitable: {
      createDailyReportRecord: async (group, parsed, context) => {
        calls.push({ group, parsed, context });
        return { created: true };
      },
    },
    config,
    aiProvider: {},
    outDir: '/tmp',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].parsed.reporterName, '王治坤');
  assert.equal(calls[0].context.senderOpenId, 'ou_1');
});
```

- [ ] **Step 3: Run routing regression tests**

Run:

```bash
npm test -- test/message-router.test.js test/scheduler.test.js
```

Expected: pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/message-router.test.js test/scheduler.test.js
git commit -m "Cover daily fact sync regressions"
```

---

### Task 10: Configuration Documentation and Manual Table Checklist

**Files:**
- Create: `docs/daily-fact-table-setup.md`

- [ ] **Step 1: Create setup checklist document**

Create `docs/daily-fact-table-setup.md`:

```md
# 日报数据层表格配置清单

## 需要手动新增的数据表

在现有日报多维表格 Base 内新增：

1. `群聊日报原始表`
2. `日报统一事实表`

机器人不会自动建表或建字段。

## 群聊日报原始表字段

- 消息ID：文本
- 群ID：文本
- 群名称：文本
- 发送人OpenID：文本
- 标题姓名：文本
- 日报日期范围：文本
- 拆分日期列表：文本
- 原始消息文本：长文本
- 解析后工作总结：长文本
- 内容指纹：文本
- 消息时间：文本或日期时间
- 接收时间：文本或日期时间
- 解析状态：单选或文本
- 原始记录状态：单选或文本

## 日报统一事实表字段

- 事实唯一键：文本
- 日报日期：日期
- 实际日报提交人：人员
- 日报提交人姓名：文本
- 成员OpenID：文本
- 所属板块：文本
- 敏捷小组：文本
- 直属上级：人员或文本
- 分管领导：人员或文本
- 今日工作总结：长文本
- 明日工作计划：长文本
- 遇到的问题：长文本
- 内容指纹：文本
- 日报来源：单选或文本
- 来源记录ID：文本
- 来源消息ID：文本
- 来源组合：长文本
- 日报类型：单选或文本
- 日期覆盖范围：文本
- 匹配方式：单选或文本
- 匹配状态：单选或文本
- 合并状态：单选或文本
- 冲突状态：单选或文本
- 事实记录状态：单选或文本
- 同步时间：文本或日期时间

## 团队通讯录建议补充字段

- 成员真实姓名：文本
- 成员别名：长文本
- 当前OpenID：文本，机器人后续可回填
- 历史OpenID/历史账号说明：长文本
- 账号类型：单选或文本
- 成员状态：单选或文本
- 敏捷小组：文本
- 分管领导：人员或文本

## 启用步骤

1. 建好两张新表和字段。
2. 在 URL 或多维表格 API 中确认新表 `tableId`。
3. 更新 `config/groups.json` 的 `chatDailyRawTable` 和 `dailyFactTable`。
4. 保持 `dailyFactSync.enabled=false`，先用群聊日报手动测试实时链路。
5. 测试通过后设置 `dailyFactSync.enabled=true`。
6. 重启机器人服务。
```

- [ ] **Step 2: Run document placeholder scan**

Run:

```bash
rg -n "T[B]D|T[O]DO|待[定]|[P]LACEHOLDER" docs/daily-fact-table-setup.md docs/superpowers/specs/2026-07-03-daily-fact-data-layer-design.md
```

Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add docs/daily-fact-table-setup.md
git commit -m "Document daily fact table setup"
```

---

## Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Check git history**

```bash
git log --oneline -8
```

Expected: commits from Tasks 1-10 are visible above the current base.

- [ ] **Step 3: Confirm working tree is clean**

```bash
git status --short --branch
```

Expected:

```text
## main...gitee/main [ahead N]
```

or clean relative to the chosen implementation branch.

---

## Self-Review

Spec coverage:

- Raw chat table is covered by Tasks 1, 5, and 7.
- Daily fact table is covered by Tasks 1, 6, 8, and 10.
- Event realtime plus scheduled calibration is covered by Tasks 7, 8, and 9.
- OpenID-first/name-fallback matching is covered by Task 4.
- External account display-name handling is covered by Tasks 4 and 10.
- Form-priority conflict handling is covered by Task 6.
- Latest chat report as main version is covered by Task 5.
- Multi-day report parsing and split facts are covered by Task 2 and used by Task 7.
- Manual table creation and config-driven operation is covered by Task 10.

Document completeness scan:

- The plan contains no incomplete sections, and no vague “write tests later” steps.

Type consistency:

- Config keys use `chatDailyRawTable`, `dailyFactTable`, and `dailyFactSync`.
- Field keys use `factKey`, `reporterNameText`, `memberOpenId`, `contentFingerprint`, and `sourceRefs`.
- Routing uses `createChatDailyRawRecord` and `upsertDailyFactRecord`.
- Sync uses `syncDailyFactRecordsForGroup`.
