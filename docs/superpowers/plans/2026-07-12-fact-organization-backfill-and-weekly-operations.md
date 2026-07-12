# Fact Organization Backfill And Weekly Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make team contacts authoritative for daily-fact organization snapshots, add idempotent date-range backfill, report in-process workflow failures to operations chats, and create short-named weekly sheets at the front of the annual workbook.

**Architecture:** A pure organization-snapshot policy separates contact identity from form/chat content resolution. The existing daily-fact service accepts explicit date ranges and a narrowly scoped repair flag, while a new CLI provides historical backfill. A shared operational reporter aggregates and masks failures across scheduled and manual workflows. Weekly sheet creation renders Friday `MMDD`, reuses copies by title, moves the target sheet to index `0`, then validates and registers it.

**Tech Stack:** Node.js 22, Feishu Node SDK, Sheets OpenAPI v2/v3, Bitable OpenAPI v1, PM2, Node test runner.

## Global Constraints

- `groups[]` is an ingestion/delivery scope, not an agile team.
- Team contacts are authoritative for `日报提交人姓名`, `直属上级`, `敏捷小组`, and `分管领导`.
- Normal synchronization freezes an existing matched organization snapshot.
- Previously unmatched facts may fill blank snapshots after contact matching.
- Only explicit `--repair-organization` may replace an existing matched snapshot.
- Manually ignored facts remain `忽略` under every automatic operation.
- Unmatched facts keep contact-derived fields blank, remain `待人工确认`, and do not enter AI aggregation.
- `lookbackDays: 7` remains seven inclusive calendar dates, including the execution date.
- Backfill ranges are inclusive and must not create duplicate fact records.
- All in-process terminal failures notify configured operations recipients when messaging is available.
- Batch record errors are aggregated; they do not produce one notification per record.
- Notifications and logs must not expose secrets, full OpenIDs, chat IDs, spreadsheet/Base/table/sheet tokens, or raw report content.
- Process-start, credential-bootstrap, host, and network failures remain the responsibility of external monitoring.
- Each year uses a separately configured weekly-report spreadsheet.
- Weekly sheet titles use Friday `MMDD`, for example `数字金融部周报0710`.
- New and recovered weekly sheets move to workbook index `0` before Base registration.
- Moving the tab is not navigation authority; distributed links must contain the copied sheet ID.
- All new schedules remain disabled until personal-environment verification succeeds and the user separately approves enabling them.

---

### Task 1: Pure Organization Snapshot Policy

**Files:**
- Create: `src/organization-snapshot.js`
- Create: `test/organization-snapshot.test.js`

**Interfaces:**
- Consumes: normalized contact objects from `normalizeContactRecord()` and normalized existing fact snapshots.
- Produces: `snapshotFromContact(contact)`, `resolveOrganizationSnapshot(options)`, and `isMatchedOrganizationStatus(status)`.
- `resolveOrganizationSnapshot({ contact, existingSnapshot, repairOrganization })` returns `{ snapshot, matched, source }`, where `source` is `contact`, `existing`, or `unmatched`.

- [ ] **Step 1: Write failing snapshot policy tests**

Create `test/organization-snapshot.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrganizationSnapshot,
  snapshotFromContact,
} from '../src/organization-snapshot.js';

const contact = {
  teamMember: '刘喜双',
  teamMemberId: 'ou_member',
  agileGroup: '收单项目组',
  supervisor: '王经理',
  supervisorOpenId: 'ou_supervisor',
  divisionalLeader: '李总',
  divisionalLeaderOpenId: 'ou_leader',
  matchingStatus: '已匹配',
  matchMethod: 'open_id',
};

test('builds the complete contact-derived snapshot', () => {
  assert.deepEqual(snapshotFromContact(contact), {
    reporterNameText: '刘喜双',
    memberOpenId: 'ou_member',
    agileGroup: '收单项目组',
    supervisor: '王经理',
    supervisorOpenId: 'ou_supervisor',
    divisionalLeader: '李总',
    divisionalLeaderOpenId: 'ou_leader',
    matchingStatus: '已匹配',
    matchMethod: 'open_id',
  });
});

test('preserves an existing matched snapshot during normal sync', () => {
  const existingSnapshot = {
    ...snapshotFromContact(contact),
    agileGroup: '历史敏捷组',
    supervisor: '历史上级',
    matchingStatus: '已匹配',
  };
  const result = resolveOrganizationSnapshot({ contact, existingSnapshot });
  assert.equal(result.source, 'existing');
  assert.equal(result.snapshot.agileGroup, '历史敏捷组');
  assert.equal(result.snapshot.supervisor, '历史上级');
});

test('fills a previously unmatched snapshot after contact matching', () => {
  const result = resolveOrganizationSnapshot({
    contact,
    existingSnapshot: { matchingStatus: '未匹配' },
  });
  assert.equal(result.source, 'contact');
  assert.equal(result.matched, true);
  assert.equal(result.snapshot.reporterNameText, '刘喜双');
});

test('repair mode replaces an existing matched snapshot', () => {
  const result = resolveOrganizationSnapshot({
    contact,
    existingSnapshot: {
      ...snapshotFromContact(contact),
      agileGroup: '错误敏捷组',
      matchingStatus: '已匹配',
    },
    repairOrganization: true,
  });
  assert.equal(result.source, 'contact');
  assert.equal(result.snapshot.agileGroup, '收单项目组');
});

test('returns blank contact-derived fields when no match exists', () => {
  const result = resolveOrganizationSnapshot({
    contact: null,
    existingSnapshot: {
      reporterNameText: '群聊标题姓名',
      agileGroup: '群配置敏捷组',
      matchingStatus: '未匹配',
    },
  });
  assert.equal(result.source, 'unmatched');
  assert.equal(result.matched, false);
  assert.equal(result.snapshot.reporterNameText, '');
  assert.equal(result.snapshot.agileGroup, '');
  assert.equal(result.snapshot.supervisor, '');
  assert.equal(result.snapshot.divisionalLeader, '');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/organization-snapshot.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `organization-snapshot.js`.

- [ ] **Step 3: Implement the pure snapshot policy**

Create `src/organization-snapshot.js`:

```js
const MATCHED_STATUSES = new Set(['已匹配', '姓名匹配']);

const EMPTY_SNAPSHOT = Object.freeze({
  reporterNameText: '',
  memberOpenId: '',
  agileGroup: '',
  supervisor: '',
  supervisorOpenId: '',
  divisionalLeader: '',
  divisionalLeaderOpenId: '',
  matchingStatus: '未匹配',
  matchMethod: '',
});

export function isMatchedOrganizationStatus(status) {
  return MATCHED_STATUSES.has(String(status || '').trim());
}

export function snapshotFromContact(contact) {
  if (!contact) return { ...EMPTY_SNAPSHOT };
  return {
    reporterNameText: contact.teamMember || '',
    memberOpenId: contact.teamMemberId || '',
    agileGroup: contact.agileGroup || '',
    supervisor: contact.supervisor || '',
    supervisorOpenId: contact.supervisorOpenId || '',
    divisionalLeader: contact.divisionalLeader || '',
    divisionalLeaderOpenId: contact.divisionalLeaderOpenId || '',
    matchingStatus: contact.matchingStatus || '已匹配',
    matchMethod: contact.matchMethod || '',
  };
}

export function resolveOrganizationSnapshot({
  contact = null,
  existingSnapshot = {},
  repairOrganization = false,
} = {}) {
  const existingMatched = isMatchedOrganizationStatus(existingSnapshot.matchingStatus);
  if (contact && (repairOrganization || !existingMatched)) {
    return { snapshot: snapshotFromContact(contact), matched: true, source: 'contact' };
  }
  if (existingMatched) {
    return { snapshot: { ...EMPTY_SNAPSHOT, ...existingSnapshot }, matched: true, source: 'existing' };
  }
  return { snapshot: { ...EMPTY_SNAPSHOT }, matched: false, source: 'unmatched' };
}
```

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test test/organization-snapshot.test.js
npm test
```

Expected: focused tests PASS and the existing suite remains green.

- [ ] **Step 5: Commit**

```bash
git add src/organization-snapshot.js test/organization-snapshot.test.js
git commit -m "feat: define daily fact organization snapshots"
```

---

### Task 2: Contact-Authoritative Fact Integration And Agile Config Removal

**Files:**
- Modify: `src/bitable-service.js`
- Modify: `src/config.js`
- Modify: `src/message-router.js`
- Modify: `src/weekly-summary.js`
- Modify: `src/weekly-sheet-content.js`
- Modify: `config/groups.json`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`
- Modify: `test/bitable-service.test.js`
- Modify: `test/config.test.js`
- Modify: `test/message-router.test.js`
- Modify: `test/weekly-summary.test.js`
- Modify: `test/weekly-sheet-content.test.js`

**Interfaces:**
- Consumes: `resolveOrganizationSnapshot()` from Task 1.
- Produces: daily fact writes whose contact-derived snapshot is independent from content conflict resolution.
- Extends: `syncDailyFactRecordsForGroup(group, { startDate?, endDate?, lookbackDays?, repairOrganization? })`.

- [ ] **Step 1: Write failing integration tests for authority, freezing, repair, and ignore**

Add focused tests to `test/bitable-service.test.js` using existing Bitable client fakes:

```js
test('does not use group agileGroup when contact matching fails', () => {
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      project: '分管领导群',
      agileGroup: '错误群级敏捷组',
      dailyFactTable: { appToken: 'bas', tableId: 'tbl_fact' },
    }],
  }).groups[0];
  const service = new BitableService({});
  const fields = service.buildDailyRecordFields(group, {
    reportDate: '2026-07-10',
    reporterName: '群聊标题姓名',
    workItems: [],
  }, { contact: null, source: 'chat' });
  assert.equal(fields['日报提交人姓名'], '');
  assert.equal(fields['敏捷小组'], '');
  assert.equal(fields['直属上级'], undefined);
  assert.equal(fields['事实记录状态'], '待人工确认');
});

test('ordinary upsert preserves an existing matched organization snapshot', async () => {
  const { service, group, existingRecord, input, getUpdatePayload } = buildOrganizationUpsertFixture();
  await service.upsertDailyFactRecord(group, input, { existingRecord });
  const fields = getUpdatePayload().data.fields;
  assert.equal(fields['日报提交人姓名'], '历史姓名');
  assert.equal(fields['敏捷小组'], '历史敏捷组');
  assert.deepEqual(fields['直属上级'], [{ id: 'ou_old_mgr', name: '历史上级' }]);
  assert.deepEqual(fields['分管领导'], [{ id: 'ou_old_leader', name: '历史领导' }]);
  assert.equal(fields['今日工作总结'], '更新后的日报内容');
});

test('organization repair replaces a matched snapshot from contact', async () => {
  const { service, group, existingRecord, input, getUpdatePayload } = buildOrganizationUpsertFixture();
  await service.upsertDailyFactRecord(group, input, {
    existingRecord,
    repairOrganization: true,
  });
  const fields = getUpdatePayload().data.fields;
  assert.equal(fields['日报提交人姓名'], '刘喜双');
  assert.equal(fields['敏捷小组'], '收单项目组');
  assert.deepEqual(fields['直属上级'], [{ id: 'ou_new_mgr', name: '新上级' }]);
  assert.deepEqual(fields['分管领导'], [{ id: 'ou_new_leader', name: '新领导' }]);
});

function buildOrganizationUpsertFixture() {
  let updatePayload;
  const group = normalizeConfig({
    groups: [{
      chatId: 'oc_test',
      dailyFactTable: {
        appToken: 'bas_test',
        tableId: 'tbl_fact',
        fieldTypes: {
          reporterName: 'user', supervisor: 'user', divisionalLeader: 'user',
          reportDate: 'date', sourceTime: 'datetime', syncedAt: 'datetime',
        },
      },
    }],
  }).groups[0];
  const service = new BitableService({
    bitable: {
      appTableRecord: {
        update: async payload => {
          updatePayload = payload;
          return { data: { record: { record_id: 'rec_fact', fields: payload.data.fields } } };
        },
      },
    },
  });
  const existingRecord = {
    record_id: 'rec_fact',
    fields: {
      事实唯一键: 'open_id:ou_member:2026-07-10',
      日报日期: Date.UTC(2026, 6, 10),
      日报提交人姓名: '历史姓名',
      实际日报提交人: [{ id: 'ou_member', name: '历史姓名' }],
      成员OpenID: 'ou_member',
      敏捷小组: '历史敏捷组',
      直属上级: [{ id: 'ou_old_mgr', name: '历史上级' }],
      分管领导: [{ id: 'ou_old_leader', name: '历史领导' }],
      匹配状态: '已匹配',
      匹配方式: 'open_id',
      今日工作总结: '旧日报内容',
      内容指纹: 'old-fingerprint',
      日报来源: 'chat',
      来源时间: Date.UTC(2026, 6, 10, 1),
      事实记录状态: '有效',
    },
  };
  const input = {
    factKey: 'open_id:ou_member:2026-07-10',
    reportDate: '2026-07-10',
    source: 'chat',
    sourceTime: Date.UTC(2026, 6, 10, 2),
    workSummaryText: '更新后的日报内容',
    contact: {
      teamMember: '刘喜双',
      teamMemberId: 'ou_member',
      agileGroup: '收单项目组',
      supervisor: '新上级',
      supervisorOpenId: 'ou_new_mgr',
      divisionalLeader: '新领导',
      divisionalLeaderOpenId: 'ou_new_leader',
      matchingStatus: '已匹配',
      matchMethod: 'open_id',
    },
  };
  return { service, group, existingRecord, input, getUpdatePayload: () => updatePayload };
}
```

Extend the existing `preserves an ignored fact when a newer source is synchronized` test
with assertions that `事实记录状态` remains `忽略` under both normal and repair options.

Add `test/config.test.js` coverage:

```js
test('does not normalize group agileGroup as organization configuration', () => {
  const group = normalizeConfig({
    groups: [{ chatId: 'oc_test', agileGroup: '不应保留' }],
  }).groups[0];
  assert.equal(Object.hasOwn(group, 'agileGroup'), false);
});
```

Add `test/weekly-sheet-content.test.js` coverage proving an agile project bucket uses only
`report.agileGroup`, not group config or item text:

```js
test('groups agile weekly content only by fact agileGroup', () => {
  const result = buildWeeklySheetValues({
    group: { project: '分管领导群', agileGroup: '融羲项目组' },
    reports: [{
      reporterName: '甲',
      agileGroup: '收单项目组',
      workItems: ['讨论融羲项目但本人属于收单项目组'],
      tomorrowPlanItems: [],
      riskItems: [],
    }],
    cellMap: {
      agileProjects: {
        融羲项目组: { current: 'C1', next: 'C2', aliases: [] },
        收单项目组: { current: 'C3', next: 'C4', aliases: [] },
      },
      management: {},
    },
  });
  assert.equal(result.values.C1, '');
  assert.match(result.values.C3, /讨论融羲项目/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/bitable-service.test.js test/config.test.js test/weekly-sheet-content.test.js
```

Expected: FAIL because `group.agileGroup` is still normalized and used as fallback, and
existing organization fields still follow the content winner.

- [ ] **Step 3: Remove group-level agile-team configuration and fallbacks**

In `src/config.js`, remove:

```js
agileGroup: group.agileGroup || '',
```

Delete `agileGroup` from every object in the three group config files. Update tests and
fixtures so a group's scope is represented by `chatId`, `project`, and contact-derived
`divisionalLeader`, never by a single agile team.

In `src/bitable-service.js`, remove every `|| group.agileGroup` fallback from:

- `buildDailyRecordFields()`
- form fact input
- chat raw fact input
- `listDailyReportsForRange()` project fallback candidates
- `normalizeDailyRecord()`
- `normalizeChatRawRecord()`

In `src/message-router.js`, replace:

```js
agileGroup: contact?.agileGroup || group.agileGroup || '',
```

with:

```js
agileGroup: contact?.agileGroup || '',
```

Remove `agileGroup: group.agileGroup` from `buildWeeklySummary()` output. In
`weekly-sheet-content.js`, introduce a strict agile matcher:

```js
function filterReportsForAgileBucket(reports, spec, bucketName) {
  const aliases = buildAliases(spec, bucketName);
  return reports.filter(report => (
    aliases.some(alias => includesNormalized(report.agileGroup || '', alias))
  ));
}
```

Use it only for Module 2 agile buckets. Keep existing item-text classification for Module 3
management topics.

- [ ] **Step 4: Integrate organization snapshot resolution into fact writes**

Import Task 1 helpers in `src/bitable-service.js`. Add an internal normalizer:

```js
function normalizeExistingOrganizationSnapshot(existingFields, fields) {
  const reporter = normalizePersonValue(existingFields[fields.reporterName]);
  const supervisor = normalizePersonValue(existingFields[fields.supervisor]);
  const leader = normalizePersonValue(existingFields[fields.divisionalLeader]);
  return {
    reporterNameText: normalizeFieldValue(existingFields[fields.reporterNameText]),
    memberOpenId: normalizeFieldValue(existingFields[fields.memberOpenId]) || reporter.id,
    agileGroup: normalizeFieldValue(existingFields[fields.agileGroup]),
    supervisor: supervisor.name,
    supervisorOpenId: supervisor.id,
    divisionalLeader: leader.name,
    divisionalLeaderOpenId: leader.id,
    matchingStatus: normalizeFieldValue(existingFields[fields.matchingStatus]),
    matchMethod: normalizeFieldValue(existingFields[fields.matchMethod]),
  };
}
```

Pass `contact` on both form and chat inputs. In `buildDailyFactFields()`, resolve the
snapshot independently from `useIncomingContent`:

```js
const organization = resolveOrganizationSnapshot({
  contact: input.contact || null,
  existingSnapshot: normalizeExistingOrganizationSnapshot(existingFields, fields),
  repairOrganization: options.repairOrganization === true,
});
const snapshot = organization.snapshot;
```

Write snapshot fields with ordinary `setMappedField()`, not `setCanonicalField()`:

```js
setMappedField(recordFields, table, 'reporterNameText', snapshot.reporterNameText);
setMappedField(recordFields, table, 'reporterName', snapshot.reporterNameText, {
  senderOpenId: snapshot.memberOpenId,
});
setMappedField(recordFields, table, 'memberOpenId', snapshot.memberOpenId);
setMappedField(recordFields, table, 'agileGroup', snapshot.agileGroup);
setMappedField(recordFields, table, 'supervisor', snapshot.supervisor, {
  supervisorOpenId: snapshot.supervisorOpenId,
});
setMappedField(recordFields, table, 'divisionalLeader', snapshot.divisionalLeader, {
  divisionalLeaderOpenId: snapshot.divisionalLeaderOpenId,
});
setMappedField(recordFields, table, 'matchingStatus', snapshot.matchingStatus);
setMappedField(recordFields, table, 'matchMethod', snapshot.matchMethod);
```

Set fact status after content resolution:

```js
const existingFactStatus = normalizeFieldValue(existingFields[fields.factStatus]);
const factStatus = existingFactStatus === '忽略'
  ? '忽略'
  : organization.matched ? resolution.factStatus : '待人工确认';
setMappedField(recordFields, table, 'factStatus', factStatus);
```

Change the internal builder signature to
`buildDailyFactFields(table, input, existing, options = {})`, and pass the complete options
object from `upsertDailyFactRecord()`. Pass
`{ repairOrganization: options.repairOrganization === true }` through every sync call to
`upsertDailyFactRecord()`.

For immediate chat creation through `buildDailyRecordFields()`, resolve a new snapshot with
an empty existing snapshot and apply the same field/status policy. Keep fact-key identity
construction separate so an unmatched sender OpenID can still prevent duplicate facts.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/organization-snapshot.test.js test/bitable-service.test.js test/config.test.js test/message-router.test.js test/weekly-summary.test.js test/weekly-sheet-content.test.js
npm test
```

Expected: all tests PASS; no config or runtime assertion depends on `group.agileGroup`.

- [ ] **Step 6: Scan for forbidden runtime fallbacks**

Run:

```bash
rg -n "group\.agileGroup|groups\.agileGroup|\"agileGroup\"" src config
```

Expected: no `group.agileGroup` or configured group-level agile-team value. Field mappings
such as `contactTable.fields.agileGroup` and `dailyFactTable.fields.agileGroup` remain.

- [ ] **Step 7: Commit**

```bash
git add src/bitable-service.js src/config.js src/message-router.js src/weekly-summary.js src/weekly-sheet-content.js config/groups.json config/groups.personal.json config/groups.formal.example.json test/bitable-service.test.js test/config.test.js test/message-router.test.js test/weekly-summary.test.js test/weekly-sheet-content.test.js
git commit -m "fix: source fact organization from team contacts"
```

---

### Task 3: Explicit Date-Range Backfill Command

**Files:**
- Create: `src/daily-fact-backfill.js`
- Create: `scripts/backfill-daily-facts.js`
- Create: `test/daily-fact-backfill.test.js`
- Modify: `src/daily-fact-sync.js`
- Modify: `test/daily-fact-sync.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseDailyFactBackfillArgs(argv)` and `runDailyFactBackfill(dependencies)`.
- Extends: `syncDailyFactsForAllGroups({ config, bitable, now, startDate?, endDate?, repairOrganization? })`.
- CLI: `npm run daily-fact:backfill -- --start YYYY-MM-DD --end YYYY-MM-DD [--repair-organization]`.

- [ ] **Step 1: Write failing argument and forwarding tests**

Create `test/daily-fact-backfill.test.js`:

```js
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
    () => parseDailyFactBackfillArgs(['--start', '2026\/07\/01', '--end', '2026-07-12']),
    /YYYY-MM-DD/,
  );
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
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/daily-fact-backfill.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement argument parsing and backfill orchestration**

Create `src/daily-fact-backfill.js`:

```js
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDailyFactBackfillArgs(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--repair-organization') {
      values.set(key, true);
    } else if (key === '--start' || key === '--end') {
      values.set(key, argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  const startDate = values.get('--start') || '';
  const endDate = values.get('--end') || '';
  if (!YMD_RE.test(startDate) || !YMD_RE.test(endDate)) {
    throw new Error('--start 和 --end 必须使用 YYYY-MM-DD');
  }
  if (startDate > endDate) throw new Error('start 不能晚于 end');
  return {
    startDate,
    endDate,
    repairOrganization: values.get('--repair-organization') === true,
  };
}

export async function runDailyFactBackfill({ config, bitable, options }) {
  const results = [];
  for (const group of config.groups) {
    try {
      const result = await bitable.syncDailyFactRecordsForGroup(group, {
        startDate: options.startDate,
        endDate: options.endDate,
        repairOrganization: options.repairOrganization,
        timezone: config.dailyFactSync?.timezone || config.timezone,
      });
      results.push({ group: group.project || group.chatId, ...result });
    } catch (error) {
      results.push({ group: group.project || group.chatId, failed: true, error });
    }
  }
  return results;
}
```

Extend `syncDailyFactsForAllGroups()` with optional explicit range and repair parameters and
forward them exactly. Keep the scheduled caller unchanged, so it continues to use
`lookbackDays`.

- [ ] **Step 4: Create the executable script and package command**

Create `scripts/backfill-daily-facts.js` using the safe client options already used by
`scripts/ensure-weekly-instance.js`:

```js
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import {
  parseDailyFactBackfillArgs,
  runDailyFactBackfill,
} from '../src/daily-fact-backfill.js';
import { buildLarkClientOptions } from '../src/lark-client.js';

const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');
const config = loadGroupConfig();
const client = new lark.Client(buildLarkClientOptions({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
}));
const options = parseDailyFactBackfillArgs(process.argv.slice(2));
const results = await runDailyFactBackfill({
  config,
  bitable: new BitableService(client),
  options,
});
console.log(JSON.stringify(results.map(result => ({
  group: result.group,
  created: result.created || 0,
  updated: result.updated || 0,
  unchanged: result.unchanged || 0,
  filtered: result.filtered || 0,
  errorCount: result.errors?.length || (result.error ? 1 : 0),
})), null, 2));
if (results.some(result => result.failed || result.error || result.errors?.length)) {
  process.exitCode = 1;
}
```

Add to `package.json`:

```json
"daily-fact:backfill": "node scripts/backfill-daily-facts.js"
```

- [ ] **Step 5: Run focused tests, CLI validation, and full tests**

Run:

```bash
node --test test/daily-fact-backfill.test.js test/daily-fact-sync.test.js
npm run daily-fact:backfill -- --start invalid --end 2026-07-12
npm test
```

Expected: tests PASS; invalid CLI exits nonzero before any API call; full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daily-fact-backfill.js scripts/backfill-daily-facts.js src/daily-fact-sync.js test/daily-fact-backfill.test.js test/daily-fact-sync.test.js package.json
git commit -m "feat: add explicit daily fact backfill"
```

---

### Task 4: Masked And Aggregated Operational Error Reporter

**Files:**
- Modify: `src/error-reporter.js`
- Modify: `test/error-reporter.test.js`

**Interfaces:**
- Produces: `reportOperationalFailure(options)` and `sanitizeOperationalText(value)`.
- `reportOperationalFailure({ task, scope, stage?, errors, messenger, config, now? })` sends one summary to every configured admin recipient.
- Preserves: `reportHandlerError()` as a compatibility wrapper using the same sanitizer and delivery helper.

- [ ] **Step 1: Write failing masking, aggregation, and recipient tests**

Add to `test/error-reporter.test.js`:

```js
test('aggregates batch errors into one masked operations message per recipient', async () => {
  const sent = [];
  const messenger = {
    sendText: async (chatId, text) => sent.push({ kind: 'chat', chatId, text }),
    sendTextToOpenId: async (openId, text) => sent.push({ kind: 'open', openId, text }),
  };
  await reportOperationalFailure({
    task: '日报事实同步',
    scope: '公司项目组',
    stage: 'write_daily_fact',
    errors: [
      new Error('appToken=CjCM123456789 tableId=tbl123456 open_id=ou_abcdef'),
      new Error('second failure'),
    ],
    messenger,
    config: {
      errorReporting: { adminChatIds: ['oc_admin'], adminOpenIds: ['ou_admin'] },
    },
    now: new Date('2026-07-12T02:00:00.000Z'),
  });
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /失败数量：2/);
  assert.match(sent[0].text, /阶段：write_daily_fact/);
  assert.doesNotMatch(sent[0].text, /CjCM123456789|tbl123456|ou_abcdef/);
});

test('limits the displayed error sample', async () => {
  let summary = '';
  await reportOperationalFailure({
    task: '批量任务',
    scope: '测试范围',
    errors: ['one', 'two', 'three', 'four', 'five'].map(value => new Error(value)),
    messenger: {
      sendText: async (_chatId, text) => { summary = text; },
      sendTextToOpenId: async () => {},
    },
    config: { errorReporting: { adminChatIds: ['oc_admin'], adminOpenIds: [] } },
  });
  assert.match(summary, /1\. one/);
  assert.match(summary, /2\. two/);
  assert.match(summary, /3\. three/);
  assert.doesNotMatch(summary, /4\. four|5\. five/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/error-reporter.test.js
```

Expected: FAIL because `reportOperationalFailure` is not exported.

- [ ] **Step 3: Implement sanitization and aggregated delivery**

Add stable masking patterns for known Feishu identifiers and credential-bearing key/value
text. Do not try to preserve partial identifiers in notifications:

```js
export function sanitizeOperationalText(value) {
  return String(value || '')
    .replace(/\b(?:ou|oc|om|tbl|vew|rec)_[A-Za-z0-9_-]+\b/g, '[masked-id]')
    .replace(/\b(?:tbl|vew|rec)[A-Za-z0-9_-]{6,}\b/g, '[masked-id]')
    .replace(/\b(?:appToken|app_token|tableId|table_id|sheetId|sheet_id|spreadsheetToken)\s*[=:]\s*[^\s,\]]+/gi, '$1=[masked]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [masked]');
}
```

Implement one delivery helper and `reportOperationalFailure()`:

```js
export async function reportOperationalFailure({
  task,
  scope,
  stage = '',
  errors = [],
  messenger,
  config,
  now = new Date(),
}) {
  const list = errors.map(error => sanitizeOperationalText(
    error?.response?.data?.msg || error?.message || String(error || ''),
  ));
  const summary = [
    '【数金小助手任务异常】',
    `任务：${task}`,
    `范围：${scope}`,
    stage ? `阶段：${stage}` : '',
    `时间：${now.toLocaleString('zh-CN', {
      hour12: false,
      timeZone: config.timezone || 'Asia/Shanghai',
    })}`,
    `失败数量：${list.length}`,
    ...list.slice(0, 3).map((message, index) => `${index + 1}. ${truncateText(message, 300)}`),
  ].filter(Boolean).join('\n');
  return deliverToOperations({ summary, task, scope, messenger, config });
}
```

Refactor `reportHandlerError()` and `reportScheduledError()` to use the same masked delivery
helper. Keep `Promise.allSettled()` so one unavailable recipient does not block others.

- [ ] **Step 4: Run focused and full tests**

Run:

```bash
node --test test/error-reporter.test.js test/lark-client.test.js
npm test
```

Expected: PASS; no test output contains unmasked request headers or full identifiers.

- [ ] **Step 5: Commit**

```bash
git add src/error-reporter.js test/error-reporter.test.js
git commit -m "feat: aggregate operational error alerts"
```

---

### Task 5: Wire Every In-Process Workflow To Operations Alerts

**Files:**
- Create: `src/scheduled-workflows.js`
- Create: `test/scheduled-workflows.test.js`
- Modify: `src/index.js`
- Modify: `src/daily-fact-sync.js`
- Modify: `scripts/ensure-weekly-instance.js`
- Modify: `scripts/backfill-daily-facts.js`
- Modify: `test/daily-fact-sync.test.js`
- Modify: `test/error-reporter.test.js`
- Modify: `test/weekly-instance-service.test.js`

**Interfaces:**
- Consumes: `reportOperationalFailure()` from Task 4.
- Produces: `runGroupedWorkflow(options)` for sequential per-group operations.
- Produces: one notification for each failed task/group/run, including aggregated record failures.

- [ ] **Step 1: Write failing workflow-wiring tests**

Add a `notifyFailure` dependency to orchestration tests rather than mocking module imports.
For `syncDailyFactsForAllGroups()`, add:

```js
test('reports one aggregated failure for record errors in a group', async () => {
  const alerts = [];
  await syncDailyFactsForAllGroups({
    config: {
      timezone: 'Asia/Shanghai',
      dailyFactSync: { lookbackDays: 7 },
      groups: [{ project: '公司项目组' }],
    },
    bitable: {
      syncDailyFactRecordsForGroup: async () => ({
        created: 0,
        updated: 0,
        errors: [{ message: 'first' }, { message: 'second' }],
      }),
    },
    notifyFailure: async alert => alerts.push(alert),
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].task, '日报事实同步');
  assert.equal(alerts[0].errors.length, 2);
});
```

Create `test/scheduled-workflows.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGroupedWorkflow } from '../src/scheduled-workflows.js';

test('reports one terminal throw for a grouped workflow', async () => {
  const alerts = [];
  const results = await runGroupedWorkflow({
    task: 'AI周报生成',
    stage: 'generate_weekly',
    groups: [{ project: '公司项目组' }],
    operation: async () => { throw new Error('provider unavailable'); },
    notifyFailure: async alert => alerts.push(alert),
  });
  assert.equal(results[0].failed, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].task, 'AI周报生成');
  assert.equal(alerts[0].stage, 'generate_weekly');
  assert.equal(alerts[0].errors[0].message, 'provider unavailable');
});

test('aggregates returned record errors without throwing', async () => {
  const alerts = [];
  const results = await runGroupedWorkflow({
    task: '日报事实同步',
    stage: 'write_daily_fact',
    groups: [{ project: '公司项目组' }],
    operation: async () => ({ errors: [{ message: 'row one' }, { message: 'row two' }] }),
    notifyFailure: async alert => alerts.push(alert),
  });
  assert.equal(results[0].errors.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].errors.length, 2);
});

test('processes workflow groups sequentially', async () => {
  const order = [];
  await runGroupedWorkflow({
    task: '直属上级日报推送',
    stage: 'deliver_supervisor_digest',
    groups: [{ project: '一组' }, { project: '二组' }],
    operation: async group => { order.push(group.project); return { delivered: true }; },
    notifyFailure: async () => {},
  });
  assert.deepEqual(order, ['一组', '二组']);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/daily-fact-sync.test.js test/error-reporter.test.js test/scheduled-workflows.test.js test/weekly-instance-service.test.js
```

Expected: FAIL because orchestration does not accept or call `notifyFailure` consistently.

- [ ] **Step 3: Add injectable reporting to batch orchestrators**

Extend `syncDailyFactsForAllGroups()`:

```js
export async function syncDailyFactsForAllGroups({
  config,
  bitable,
  now = new Date(),
  logger = console,
  notifyFailure = async () => {},
  startDate,
  endDate,
  repairOrganization = false,
}) {
  const results = [];
  for (const group of config.groups) {
    const scope = group.project || group.chatId;
    try {
      const result = await bitable.syncDailyFactRecordsForGroup(group, {
        now,
        timezone: config.dailyFactSync?.timezone || config.timezone,
        lookbackDays: config.dailyFactSync?.lookbackDays,
        startDate,
        endDate,
        repairOrganization,
      });
      results.push({ group: scope, ...result });
      if (result.errors?.length) {
        await notifyFailure({
          task: '日报事实同步', scope, stage: 'write_daily_fact', errors: result.errors,
        });
      }
    } catch (error) {
      results.push({ group: scope, failed: true, error });
      await notifyFailure({
        task: '日报事实同步', scope, stage: 'sync_group', errors: [error],
      });
    }
  }
  return results;
}
```

Create `src/scheduled-workflows.js`:

```js
export async function runGroupedWorkflow({
  task,
  stage,
  groups,
  operation,
  notifyFailure = async () => {},
}) {
  const results = [];
  for (const group of groups) {
    const scope = group.project || group.chatId;
    try {
      const result = await operation(group);
      results.push({ group: scope, ...result });
      if (result?.errors?.length) {
        await notifyFailure({ task, scope, stage, errors: result.errors });
      }
    } catch (error) {
      results.push({ group: scope, failed: true, error });
      await notifyFailure({
        task,
        scope,
        stage: error.weeklyInstanceStage || stage,
        errors: [error],
      });
    }
  }
  return results;
}
```

Use `runGroupedWorkflow()` for weekly instance creation by calling
`ensureWeeklyInstanceForGroup()` once per group, for weekly generation by calling
`generateWeeklyReportForGroup()`, and for daily supervisor delivery by calling
`pushDailyReportsToSupervisors()`. Daily fact synchronization keeps its existing
orchestrator but must use the same `notifyFailure` object shape. Bind `notifyFailure` in
`src/index.js` to:

```js
await reportOperationalFailure({
  task,
  scope: group.project || group.chatId,
  stage,
  errors,
  messenger,
  config,
});
```

`src/index.js` should only construct dependencies and pass each runner to its scheduler.
Do not duplicate error-report calls in both the runner and scheduler callback.

- [ ] **Step 4: Add manual-command alerting**

In both manual scripts, construct `LarkMessenger` from the initialized client. After the
run, call `reportOperationalFailure()` once per failed group. Preserve nonzero exit status.
Do not attempt alerting if config or client initialization itself failed.

For weekly instance errors, preserve the stable stage attached in Task 6. For backfill,
use `stage: 'write_daily_fact'` for record failures and `stage: 'backfill_group'` for a
group-level throw.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
node --test test/daily-fact-sync.test.js test/error-reporter.test.js test/scheduled-workflows.test.js test/scheduler.test.js test/weekly-instance-service.test.js
npm test
```

Expected: PASS; every in-process workflow has an assertion proving its terminal error calls
the shared reporter exactly once per group/run.

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/daily-fact-sync.js src/scheduled-workflows.js scripts/ensure-weekly-instance.js scripts/backfill-daily-facts.js test/daily-fact-sync.test.js test/error-reporter.test.js test/scheduled-workflows.test.js test/scheduler.test.js test/weekly-instance-service.test.js
git commit -m "feat: report workflow failures to operations"
```

---

### Task 6: Friday MMDD Weekly Titles And First-Tab Placement

**Files:**
- Modify: `src/weekly-sheet-writer.js`
- Modify: `src/weekly-instance-service.js`
- Modify: `src/config.js`
- Modify: `config/groups.json`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`
- Modify: `test/weekly-sheet-writer.test.js`
- Modify: `test/weekly-instance-service.test.js`
- Modify: `test/config.test.js`

**Interfaces:**
- Extends: `renderWeeklySheetTitle()` with `{{weekEndMMDD}}`.
- Produces: `WeeklySheetWriter.moveSheet(sheetConfig, sheetId, targetIndex)`.
- Extends: weekly instance errors with `error.weeklyInstanceStage`.

- [ ] **Step 1: Write failing title and move tests**

Add to `test/weekly-sheet-writer.test.js`:

```js
test('renders Friday MMDD weekly title', () => {
  assert.equal(
    renderWeeklySheetTitle('数字金融部周报{{weekEndMMDD}}', {
      weekStart: '2026-07-06',
      weekEnd: '2026-07-10',
    }),
    '数字金融部周报0710',
  );
});

test('moves a sheet to workbook index zero', async () => {
  let request;
  const writer = new WeeklySheetWriter({
    request: async payload => {
      request = payload;
      return { data: { replies: [] } };
    },
  });
  const result = await writer.moveSheet({ spreadsheetToken: 'sheet_token' }, 'week_28', 0);
  assert.equal(result.targetIndex, 0);
  assert.equal(request.url, '/open-apis/sheets/v2/spreadsheets/sheet_token/sheets_batch_update');
  assert.deepEqual(request.data.requests, [{
    updateSheet: {
      properties: { sheetId: 'week_28', index: 0 },
      fields: 'index',
    },
  }]);
});
```

Before accepting the payload above, run a zero-write `lark-cli sheets +sheet-move --dry-run`
or check the current official `更新工作表属性` request schema. If the live schema uses a
different casing or update mask shape, update the test and implementation together before
GREEN; do not send an unverified move payload to the personal workbook.

Add to `test/weekly-instance-service.test.js`:

```js
test('moves a new sheet before template validation and Base registration', async () => {
  const order = [];
  await ensureWeeklyInstanceForGroup({
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => { order.push('base'); return { created: true }; },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => {
        order.push('ensure');
        return {
          spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '数字金融部周报0717',
          created: true, reused: false,
        };
      },
      moveSheet: async () => { order.push('move'); },
      discoverTemplateTargets: async () => {
        order.push('discover');
        return { reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {} };
      },
      writeCells: async () => { order.push('write'); },
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    retryDelayMs: 0,
  });
  assert.deepEqual(order, ['ensure', 'move', 'discover', 'write', 'base']);
});

test('move failure is staged and retry reuses the copied sheet', async () => {
  let moveAttempts = 0;
  let baseCalls = 0;
  const dependencies = {
    group: buildGroup(),
    bitable: {
      findWeeklyInstanceRecord: async () => null,
      upsertWeeklyInstance: async () => { baseCalls += 1; return { created: true }; },
    },
    sheetWriter: {
      ensureWeeklySheet: async () => ({
        spreadsheetToken: 'sheet_token', sheetId: 'week_29', title: '数字金融部周报0717',
        created: moveAttempts === 0, reused: moveAttempts > 0,
      }),
      moveSheet: async () => {
        moveAttempts += 1;
        if (moveAttempts === 1) throw new Error('move failed');
      },
      discoverTemplateTargets: async () => ({
        reportPeriod: 'B2', metrics: {}, agileProjects: {}, management: {},
      }),
      writeCells: async () => ({ rangeCount: 1 }),
    },
    now: new Date('2026-07-13T01:00:00.000Z'),
    retryDelayMs: 0,
  };
  await assert.rejects(
    ensureWeeklyInstanceForGroup(dependencies),
    error => error.weeklyInstanceStage === 'move_sheet',
  );
  assert.equal(baseCalls, 0);
  const recovered = await ensureWeeklyInstanceForGroup(dependencies);
  assert.equal(recovered.reused, true);
  assert.equal(baseCalls, 1);
});
```

Replace comments with complete fakes based on the existing recovery test.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test test/weekly-sheet-writer.test.js test/weekly-instance-service.test.js test/config.test.js
```

Expected: FAIL because the title token and `moveSheet()` do not exist and the instance
service does not move before validation.

- [ ] **Step 3: Add MMDD rendering and configure annual workbook titles**

Add:

```js
function monthDay(ymd) {
  const match = String(ymd || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}${match[2]}` : '';
}
```

Extend title rendering:

```js
.replaceAll('{{weekEndMMDD}}', monthDay(weekEnd))
```

Set every weekly sheet config example to:

```json
"titlePattern": "数字金融部周报{{weekEndMMDD}}"
```

Document that the spreadsheet is replaced annually before duplicate MMDD titles can
occur. Do not automate annual workbook creation.

- [ ] **Step 4: Implement and schema-verify sheet movement**

After confirming the current request shape, implement `moveSheet()` with resolved Wiki
configuration, a non-empty sheet ID, integer target index validation, and a structured
return:

```js
async moveSheet(sheetConfig, sheetId, targetIndex = 0) {
  const resolvedConfig = await this.resolveSheetConfig(sheetConfig);
  if (!sheetId) throw new Error('sheetId 为空，无法移动周报工作表');
  if (!Number.isInteger(targetIndex) || targetIndex < 0) {
    throw new Error(`工作表目标位置无效：${targetIndex}`);
  }
  const response = await this.client.request({
    method: 'POST',
    url: `/open-apis/sheets/v2/spreadsheets/${resolvedConfig.spreadsheetToken}/sheets_batch_update`,
    data: {
      requests: [{
        updateSheet: {
          properties: { sheetId, index: targetIndex },
          fields: 'index',
        },
      }],
    },
  });
  return { moved: true, targetIndex, response };
}
```

If schema verification shows another request shape, use the verified shape in both code
and tests. Do not fall back to delete/recreate or rename existing sheets.

- [ ] **Step 5: Stage weekly instance failures and enforce operation order**

Add a small wrapper in `src/weekly-instance-service.js`:

```js
async function runWeeklyStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    error.weeklyInstanceStage = stage;
    throw error;
  }
}
```

Use these stages around the existing sequence:

```js
const sheet = await runWeeklyStage('copy_sheet', () => retryOperation(
  () => sheetWriter.ensureWeeklySheet(group.weeklySheet, { weekStart, weekEnd }),
  { attempts: 3, delayMs: retryDelayMs },
));
await runWeeklyStage('move_sheet', () => sheetWriter.moveSheet(effectiveConfig, sheet.sheetId, 0));
const targets = await runWeeklyStage('locate_template', () => (
  sheetWriter.discoverTemplateTargets(effectiveConfig, sheet.sheetId, {
    aliasMap: group.weeklySheet.entityAliases,
  })
));
await runWeeklyStage('write_period', () => sheetWriter.writeCells(
  effectiveConfig,
  sheet.sheetId,
  { [targets.reportPeriod]: `${weekStart} 至 ${weekEnd}` },
));
const persisted = await runWeeklyStage('write_instance_base', () => (
  bitable.upsertWeeklyInstance(group, instance, { now, timezone })
));
```

Preserve persistent Base lookup first. A Base record found by ISO week still returns without
copying, moving, or writing. A title-recovered sheet moves before Base retry.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test test/weekly-sheet-writer.test.js test/weekly-instance-service.test.js test/config.test.js
npm test
```

Expected: PASS; operation-order test proves Base registration cannot precede movement.

- [ ] **Step 7: Commit**

```bash
git add src/weekly-sheet-writer.js src/weekly-instance-service.js src/config.js config/groups.json config/groups.personal.json config/groups.formal.example.json test/weekly-sheet-writer.test.js test/weekly-instance-service.test.js test/config.test.js
git commit -m "feat: place compact weekly sheets first"
```

---

### Task 7: Documentation, Regression Gate, And Controlled Personal Verification

**Files:**
- Modify: `docs/daily-fact-table-setup.md`
- Modify: `docs/weekly-instance-table-setup.md`
- Create after verification: `docs/superpowers/verification/2026-07-12-fact-organization-and-weekly-operations.md`

**Interfaces:**
- Consumes: all Tasks 1-6.
- Produces: operator commands and sanitized evidence for backfill, alerting, and weekly-sheet behavior.

- [ ] **Step 1: Update operator documentation**

Document these exact rules:

- Group config has no agile-team value.
- Contact table owns real name, supervisor, agile team, and divisional leader.
- Normal sync freezes matched snapshots.
- Backfill command syntax and inclusive range semantics.
- `--repair-organization` is an explicit corrective write and must not be placed in a
  recurring scheduler.
- Weekly spreadsheet rotation is annual and manual.
- Weekly title is Friday MMDD and copied sheets move to the first tab.
- Direct links must include the copied sheet ID.
- `errorReporting.adminChatIds` covers in-process failures; external monitoring covers
  startup/host failures.

- [ ] **Step 2: Run complete local verification**

Run:

```bash
npm test
git diff --check
rg -n "group\.agileGroup|groups\.agileGroup" src config test
git status --short
```

Expected:

- Full suite PASS.
- No whitespace errors.
- No runtime/config `group.agileGroup` references; historical test descriptions may only
  mention it to prove rejection.
- Only intended files are modified.

- [ ] **Step 3: Commit implementation documentation**

```bash
git add docs/daily-fact-table-setup.md docs/weekly-instance-table-setup.md
git commit -m "docs: document fact repair and weekly operations"
```

- [ ] **Step 4: Push and deploy only after user approval**

Do not push or restart automatically. After approval:

```bash
git push github codex/daily-fact-data-layer
git push gitee codex/daily-fact-data-layer
ssh -i /Users/linjingwang/claude_workspace/lark-report-bot/lark_bot_key.pem ubuntu@49.232.202.36
cd /home/ubuntu/lark-report-bot-git
git pull --ff-only github codex/daily-fact-data-layer
npm ci
npm test
```

Expected: server commit matches the pushed commit and full tests PASS. Keep all new
schedules disabled.

- [ ] **Step 5: Run a read-only organization audit before repair**

Use the explicit personal config and a read-only script that lists source, fact, and contact
records for the approved date range. Output only counts and masked mismatch categories:

```text
matched_facts
unmatched_facts
real_name_mismatches
agile_group_mismatches
supervisor_mismatches
divisional_leader_mismatches
```

Do not print names, OpenIDs, raw report content, tokens, or record IDs in the verification
document. Present counts to the user and obtain explicit approval before repair.

- [ ] **Step 6: Run one controlled organization repair**

After approval, run on the server:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run daily-fact:backfill -- --start 2026-07-01 --end 2026-07-12 --repair-organization
```

Expected: exit `0`, no duplicate fact keys, matched rows receive contact values, unmatched
rows remain pending, and ignored rows remain ignored. If any record fails, exit nonzero and
one aggregated operations alert is sent.

- [ ] **Step 7: Rerun without repair to prove idempotency**

Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run daily-fact:backfill -- --start 2026-07-01 --end 2026-07-12
```

Expected: no duplicate rows, organization snapshots remain unchanged, and content results
are unchanged or updated only according to source-time conflict rules.

- [ ] **Step 8: Run one controlled weekly-sheet verification**

Temporarily enable only `weeklySheet.enabled` for the personal group; keep
`weeklyInstanceCreation.enabled` and all delivery schedules disabled. Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:ensure
```

Verify:

- The title equals `数字金融部周报MMDD` using that work week's Friday.
- Exactly one sheet exists for the title.
- The sheet index is `0`.
- The report period is correct.
- The weekly instance Base contains one ISO-week row.
- The stored URL opens the copied sheet directly.
- No AI content, poster, or group message is generated.

Run the command again and verify the same sheet and Base row are reused. Restore
`weeklySheet.enabled` to `false` immediately after verification.

- [ ] **Step 9: Verify one masked operations notification**

Use a test-only injected failure or a manual command fixture that does not mutate business
data. Verify the operations chat receives one message containing task, scope, stage, and
failure count, without full identifiers or raw content. Do not deliberately break the live
Base schema or application credentials.

- [ ] **Step 10: Record sanitized evidence and commit**

Create the verification document with:

```markdown
# Fact Organization And Weekly Operations Verification

- Branch and commit
- Full test count and result
- Audit mismatch counts before repair
- Backfill range
- Repair result counts
- Idempotent rerun result counts
- Unmatched pending count
- Ignored-preserved count
- Operations alert: passed
- Weekly title format: passed
- Weekly sheet index zero: passed
- Direct sheet link: passed
- Single Base instance row: passed
- All schedules after verification: disabled
```

Do not include tokens, IDs, names, raw reports, or full links.

```bash
git add docs/superpowers/verification/2026-07-12-fact-organization-and-weekly-operations.md
git commit -m "docs: verify fact repair and weekly operations"
```

---

## Completion Gate

Before declaring this implementation complete:

```bash
npm test
git diff --check
git status --short --branch
```

Required evidence:

- Full local and server suites pass.
- Personal repair and idempotent rerun are verified.
- Weekly title, index `0`, direct link, and recovery are verified.
- One masked operations alert is observed.
- All schedules are disabled after verification.
- No uncommitted implementation files remain.
