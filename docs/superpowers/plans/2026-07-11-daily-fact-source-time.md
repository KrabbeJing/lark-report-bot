# Daily Fact Source-Time Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile form and chat daily reports by latest source time, preserve the selected source and explanation, filter AI input to effective facts, and deduplicate multi-day submissions before summarization.

**Architecture:** Fetch Feishu automatic record timestamps for form submissions, normalize all source times to milliseconds, and move deterministic merge decisions into a pure resolver. Keep one fact row per member per day, then create a separate AI-input normalization layer keyed by the effective original source ID.

**Tech Stack:** Node.js 22, Feishu Bitable v1 SDK, Node test runner, existing Base tables.

## Global Constraints

- Fact-table grain remains one member plus one report date.
- Chat source time is the message send time.
- Form source time is `last_modified_time`, falling back to `created_time`.
- A later source wins; an exact tie is won by the form source.
- Different content resolved by time has `合并状态=按时间取最新`, `冲突状态=已自动处理`, and `事实记录状态=有效`.
- `事实记录状态=忽略` must survive every automatic resync.
- Only `事实记录状态=有效` may enter AI summaries.
- Multi-day rows from one effective original submission appear once in AI input.
- Distinct original submissions are never dropped merely because their text is equal.
- `直属上级` and `分管领导` remain independent fields.

---

### Task 1: Configure New Fact Metadata Fields

**Files:**
- Modify: `src/config.js`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`
- Modify: `test/config.test.js`

**Interfaces:**
- Consumes: Base fields already created in the personal test environment.
- Produces: logical field keys `sourceTime`, `effectiveSource`, and `autoResolutionNote`.

- [ ] **Step 1: Write failing config assertions**

Add assertions to `test/config.test.js`:

```js
assert.equal(group.dailyFactTable.fields.sourceTime, '来源时间');
assert.equal(group.dailyFactTable.fields.effectiveSource, '有效来源');
assert.equal(group.dailyFactTable.fields.autoResolutionNote, '自动处理说明');
assert.equal(group.dailyFactTable.fields.divisionalLeader, '分管领导');
assert.equal(group.dailyFactTable.fieldTypes.sourceTime, 'datetime');
```

- [ ] **Step 2: Run the config test and verify it fails**

Run: `node --test test/config.test.js`

Expected: FAIL because the new logical fields are not mapped.

- [ ] **Step 3: Add default field mappings**

Extend `DAILY_FACT_FIELD_KEYS` in `src/config.js`:

```js
sourceTime: '来源时间',
effectiveSource: '有效来源',
autoResolutionNote: '自动处理说明',
```

Map `divisionalLeader` to `分管领导` in personal and formal configuration. Add `sourceTime: "datetime"` to each fact table's `fieldTypes`. Keep the existing `supervisor: "user"` and add `divisionalLeader: "user"` only when the Base field is a Person field.

- [ ] **Step 4: Run config and full tests**

Run: `node --test test/config.test.js`

Expected: all config tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit field configuration**

```bash
git add src/config.js config/groups.personal.json config/groups.formal.example.json test/config.test.js
git commit -m "feat: configure daily fact source metadata"
```

### Task 2: Fetch and Normalize Form Modification Time

**Files:**
- Modify: `src/bitable-service.js`
- Modify: `src/message-router.js`
- Modify: `test/bitable-service.test.js`
- Modify: `test/message-router.test.js`

**Interfaces:**
- Consumes: Feishu record `last_modified_time` and `created_time` returned when `automatic_fields=true`.
- Produces: `sourceTime` as a millisecond timestamp on every form and chat fact input.

- [ ] **Step 1: Write failing automatic-field and timestamp tests**

Add a list-record test that captures SDK parameters and asserts:

```js
assert.equal(listPayload.params.automatic_fields, true);
```

Add form and chat sync assertions:

```js
assert.equal(formInput.sourceTime, 1783699200123);
assert.equal(chatInput.sourceTime, 1783695600456);
```

The form fixture must include:

```js
{
  record_id: 'rec_form',
  created_time: 1783600000000,
  last_modified_time: 1783699200123,
  fields: { /* existing fixture fields */ },
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test test/bitable-service.test.js`

Expected: FAIL because list calls do not request automatic fields and source inputs lack `sourceTime`.

- [ ] **Step 3: Request automatic fields only where needed**

Extend `listRecords` parameters in `src/bitable-service.js`:

```js
automatic_fields: options.automaticFields === true || undefined,
```

Change the form source call in `syncDailyFactRecordsForGroup` to:

```js
const formRecords = await this.listRecords(
  group.dailyTable,
  'dailyFactSync.form.list',
  { automaticFields: true },
);
```

Add a pure timestamp helper:

```js
export function normalizeSourceTimestamp(value) {
  if (value == null || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 100000000000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
```

Set form input time from `last_modified_time || created_time`. Set scheduled chat input time from the raw record's `messageTime`. In the real-time message path, pass `sourceTime: messageTime.getTime()` in every `factInput`. Do not use the fact synchronization time as source time.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/bitable-service.test.js test/message-router.test.js`

Expected: all Bitable tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit source timestamp extraction**

```bash
git add src/bitable-service.js src/message-router.js test/bitable-service.test.js test/message-router.test.js
git commit -m "feat: read daily report source timestamps"
```

### Task 3: Resolve Complete Source Candidate Sets by Time

**Files:**
- Create: `src/daily-fact-resolution.js`
- Create: `test/daily-fact-resolution.test.js`
- Modify: `src/bitable-service.js`
- Modify: `test/bitable-service.test.js`

**Interfaces:**
- Produces: `resolveDailyFactCandidates({ form, chat, existingFactStatus })` returning the canonical candidate and final states.
- Produces: `resolveIncrementalDailyFact({ existing, incoming })` for immediate chat writes before the next complete reconciliation.
- Consumes: at most one latest form candidate and one latest main-chat candidate for the same fact key.

- [ ] **Step 1: Write the resolver's failing decision-table tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDailyFactCandidates } from '../src/daily-fact-resolution.js';

test('marks equal form and chat content as duplicate merged', () => {
  const result = resolveDailyFactCandidates({
    form: { source: 'form', sourceTime: 1000, fingerprint: 'same', matchingStatus: '已匹配' },
    chat: { source: 'chat', sourceTime: 2000, fingerprint: 'same', matchingStatus: '已匹配' },
    existingFactStatus: '有效',
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.mergeStatus, '重复已合并');
  assert.equal(result.conflictStatus, '无冲突');
  assert.equal(result.factStatus, '有效');
});

test('uses later chat content when form content is older', () => {
  const result = resolveDailyFactCandidates({
    form: { source: 'form', sourceTime: 1000, fingerprint: 'form', matchingStatus: '已匹配' },
    chat: { source: 'chat', sourceTime: 2000, fingerprint: 'chat', matchingStatus: '已匹配' },
  });
  assert.equal(result.winner.source, 'chat');
  assert.equal(result.effectiveSource, 'chat');
  assert.equal(result.mergeStatus, '按时间取最新');
  assert.equal(result.conflictStatus, '已自动处理');
});

test('uses form on exact source-time tie', () => {
  const result = resolveDailyFactCandidates({
    form: { source: 'form', sourceTime: 2000, fingerprint: 'form', matchingStatus: '姓名匹配' },
    chat: { source: 'chat', sourceTime: 2000, fingerprint: 'chat', matchingStatus: '已匹配' },
  });
  assert.equal(result.winner.source, 'form');
  assert.equal(result.effectiveSource, 'form');
});

test('preserves manual ignore status during resync', () => {
  const result = resolveDailyFactCandidates({
    form: null,
    chat: { source: 'chat', sourceTime: 2000, fingerprint: 'new', matchingStatus: '已匹配' },
    existingFactStatus: '忽略',
  });
  assert.equal(result.factStatus, '忽略');
});

test('marks unmatched facts pending without treating them as content conflict', () => {
  const result = resolveDailyFactCandidates({
    form: null,
    chat: { source: 'chat', sourceTime: 2000, fingerprint: 'new', matchingStatus: '未匹配' },
  });
  assert.equal(result.factStatus, '待人工确认');
  assert.equal(result.conflictStatus, '无冲突');
});
```

- [ ] **Step 2: Run resolver tests and verify they fail**

Run: `node --test test/daily-fact-resolution.test.js`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement the pure resolver**

Implement these exact rules in `src/daily-fact-resolution.js`:

```js
const MATCHED_STATUSES = new Set(['已匹配', '姓名匹配']);

export function resolveDailyFactCandidates({ form = null, chat = null, existingFactStatus = '' }) {
  if (!form && !chat) throw new Error('At least one daily fact candidate is required');
  const hasBothSources = Boolean(form && chat);
  const sameContent = hasBothSources && form.fingerprint === chat.fingerprint;
  const winner = chooseWinner(form, chat);
  const hasMatchedCandidate = [form, chat]
    .filter(Boolean)
    .some(candidate => MATCHED_STATUSES.has(candidate.matchingStatus));
  const factStatus = existingFactStatus === '忽略'
    ? '忽略'
    : existingFactStatus === '有效' || hasMatchedCandidate ? '有效' : '待人工确认';

  return {
    hasBothSources,
    winner,
    effectiveSource: winner.source,
    sourceTime: winner.sourceTime,
    mergeStatus: hasBothSources ? (sameContent ? '重复已合并' : '按时间取最新') : '单来源',
    conflictStatus: hasBothSources && !sameContent ? '已自动处理' : '无冲突',
    factStatus,
    autoResolutionNote: hasBothSources && !sameContent
      ? buildResolutionNote(winner.source, winner.sourceTime)
      : '',
  };
}

function chooseWinner(form, chat) {
  if (!form) return chat;
  if (!chat) return form;
  if (form.sourceTime === chat.sourceTime) return form;
  return form.sourceTime > chat.sourceTime ? form : chat;
}
```

Implement `buildResolutionNote` in the same file. It must produce either`按来源时间采用表单版本`or`按来源时间采用群聊版本`without copying report content.

Add an incremental wrapper for the real-time path:

```js
export function resolveIncrementalDailyFact({ existing = null, incoming }) {
  if (!existing) {
    return resolveDailyFactCandidates({
      form: incoming.source === 'form' ? incoming : null,
      chat: incoming.source === 'chat' ? incoming : null,
    });
  }

  const existingCandidate = {
    source: existing.effectiveSource || firstSource(existing.source),
    sourceTime: existing.sourceTime,
    fingerprint: existing.fingerprint,
    matchingStatus: existing.matchingStatus,
  };
  const candidates = { form: null, chat: null };
  candidates[existingCandidate.source] = existingCandidate;
  candidates[incoming.source] = incoming;
  const result = resolveDailyFactCandidates({
    ...candidates,
    existingFactStatus: existing.factStatus,
  });

  if (sourceHas(existing.source, 'form') && sourceHas(existing.source, 'chat')) {
    return {
      ...result,
      hasBothSources: true,
      mergeStatus: existingCandidate.source === incoming.source
        ? (existing.mergeStatus || '按时间取最新')
        : result.mergeStatus,
      conflictStatus: existingCandidate.source === incoming.source
        ? (existing.conflictStatus || '已自动处理')
        : result.conflictStatus,
    };
  }
  return result;
}
```

Implement private `sourceHas` and `firstSource` helpers in the same module. The incremental wrapper is deliberately conservative when the non-effective source body is unavailable; the complete scheduled reconciliation below recalculates the exact duplicate/conflict state.

- [ ] **Step 4: Collect complete candidate sets before writing facts**

Refactor `syncDailyFactRecordsForGroup` so the form loop and chat loop normalize source records into candidates but do not write facts immediately. Store candidates in:

```js
Map<factKey, { form: Candidate | null, chat: Candidate | null }>
```

When multiple candidates exist for the same source and fact key, retain the candidate with the greatest `sourceTime`; on a same-source timestamp tie, retain the candidate with the lexicographically greater source ID for deterministic behavior.

After both source loops finish, iterate the map once. Resolve each pair with `resolveDailyFactCandidates`, then call a new `upsertResolvedDailyFactRecord` method once per fact key with the winner's canonical fields plus both source references. This makes the scheduled reconciliation independent of API record order and avoids running the legacy incremental merge logic a second time.

- [ ] **Step 5: Write resolved candidates into fact fields**

Use `resolution.winner` for work, plan, risk, fingerprint, raw text, organizational fields, and canonical source time. Write:

```js
setMappedField(recordFields, table, 'effectiveSource', resolution.effectiveSource);
setMappedField(recordFields, table, 'sourceTime', resolution.sourceTime);
setMappedField(recordFields, table, 'autoResolutionNote', resolution.autoResolutionNote);
setMappedField(recordFields, table, 'mergeStatus', resolution.mergeStatus);
setMappedField(recordFields, table, 'conflictStatus', resolution.conflictStatus);
setMappedField(recordFields, table, 'factStatus', resolution.factStatus);
```

Keep `日报来源=form+chat` and both source references when both candidates exist. Write the form candidate's record ID to`来源记录ID`and the chat candidate's message ID to`来源消息ID`, regardless of which candidate wins.

Add this Bitable service interface:

```js
async upsertResolvedDailyFactRecord(group, resolvedInput, options = {})
```

`resolvedInput` must already contain `factKey`, the winner's canonical business fields, `source`, `sourceRecordId`, `messageId`, `sourceRefs`, `effectiveSource`, `sourceTime`, `autoResolutionNote`, `mergeStatus`, `conflictStatus`, and `factStatus`. Its field builder writes those values directly and performs only create/update/unchanged detection; it must not recalculate source priority.

Update the existing `buildDailyFactFields` immediate path to call `resolveIncrementalDailyFact`. It must write only the new select values and preserve`忽略`. The scheduled complete-candidate reconciliation is authoritative and must correct any conservative interim state before weekly AI input is generated.

- [ ] **Step 6: Update old integration assertions**

Replace expectations of `内容冲突/待人工确认` with `按时间取最新/已自动处理/有效`. Add integration coverage for later chat winning, later form winning, exact tie form winning, and existing `忽略` surviving resync.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/daily-fact-resolution.test.js test/bitable-service.test.js`

Expected: all resolver and Bitable tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit deterministic fact resolution**

```bash
git add src/daily-fact-resolution.js src/bitable-service.js test/daily-fact-resolution.test.js test/bitable-service.test.js
git commit -m "feat: resolve daily facts by source time"
```

### Task 4: Filter Effective Facts and Deduplicate AI Input

**Files:**
- Create: `src/ai-input-normalizer.js`
- Create: `test/ai-input-normalizer.test.js`
- Modify: `src/bitable-service.js`
- Modify: `src/weekly-reporter.js`
- Modify: `test/weekly-reporter.test.js`

**Interfaces:**
- Produces: `buildWeeklyAiInputs(reports): NormalizedAiReport[]`.
- Consumes: fact records containing status, effective source, source IDs, report date, and canonical content.

- [ ] **Step 1: Write failing AI-input normalization tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyAiInputs } from '../src/ai-input-normalizer.js';

test('collapses multi-day rows from one source into one AI input', () => {
  const reports = [
    { recordId: 'fact_1', reportDate: '2026-06-29', messageId: 'om_1', effectiveSource: 'chat', workItems: ['完成A'] },
    { recordId: 'fact_2', reportDate: '2026-06-30', messageId: 'om_1', effectiveSource: 'chat', workItems: ['完成A'] },
  ];
  const result = buildWeeklyAiInputs(reports);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reportDates, ['2026-06-29', '2026-06-30']);
  assert.equal(result[0].dateRange, '2026-06-29~2026-06-30');
});

test('keeps equal text from distinct original submissions', () => {
  const reports = [
    { reportDate: '2026-06-29', messageId: 'om_1', effectiveSource: 'chat', workItems: ['持续推进A'] },
    { reportDate: '2026-06-30', messageId: 'om_2', effectiveSource: 'chat', workItems: ['持续推进A'] },
  ];
  assert.equal(buildWeeklyAiInputs(reports).length, 2);
});

test('uses the effective source id as the grouping key', () => {
  const reports = [
    { reportDate: '2026-07-01', sourceRecordId: 'rec_form', messageId: 'om_old', effectiveSource: 'form', workItems: ['表单内容'] },
    { reportDate: '2026-07-02', sourceRecordId: 'rec_form', messageId: 'om_other', effectiveSource: 'form', workItems: ['表单内容'] },
  ];
  assert.equal(buildWeeklyAiInputs(reports).length, 1);
});
```

- [ ] **Step 2: Run normalizer tests and verify they fail**

Run: `node --test test/ai-input-normalizer.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Expose fact metadata in normalized records**

Extend `normalizeDailyRecord` to include:

```js
factStatus,
effectiveSource,
sourceRecordId,
messageId,
sourceRefs,
contentFingerprint,
reportType,
dateRange,
sourceTime,
```

When reading a configured fact table, `listDailyReportsForRange` and `listAllDailyReportsForRange` must require `factStatus === '有效'`. Legacy daily tables without a configured status field retain their existing behavior.

- [ ] **Step 4: Implement source-ID grouping**

In `src/ai-input-normalizer.js`, choose the grouping key in this order:

```js
effectiveSource === 'form' && sourceRecordId -> `form:${sourceRecordId}`
effectiveSource === 'chat' && messageId -> `chat:${messageId}`
sourceRecordId -> `form:${sourceRecordId}`
messageId -> `chat:${messageId}`
fallback -> `fact:${recordId || reporterName}:${reportDate}`
```

For each group, sort and deduplicate report dates, set the first date as `reportDate`, set `dateRange` from the first and last in-range date, preserve the canonical text once, and attach all contributing `factRecordIds` for audit.

- [ ] **Step 5: Apply normalization only at the AI boundary**

In `generateWeeklyReportForGroup`:

```js
const factReports = await listReportsForWeeklyOutput(bitable, group, weekStart, weekEnd);
const reports = buildWeeklyAiInputs(factReports);
```

Use `reports` for the current template and external AI providers. Preserve `factReports.length` separately if later completeness metrics require the per-day count.

- [ ] **Step 6: Add status-filter and reporter integration tests**

Verify that `待人工确认` and `忽略` rows never reach `aiProvider.summarizeWeeklyReports`, while two daily fact rows from the same message reach it as one input containing both dates.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/ai-input-normalizer.test.js test/weekly-reporter.test.js test/bitable-service.test.js`

Expected: all focused tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 8: Commit AI input normalization**

```bash
git add src/ai-input-normalizer.js src/bitable-service.js src/weekly-reporter.js test/ai-input-normalizer.test.js test/weekly-reporter.test.js test/bitable-service.test.js
git commit -m "feat: normalize effective facts for AI summaries"
```

### Task 5: Personal-Organization Fact Reconciliation Verification

**Files:**
- No source changes expected after implementation.

**Interfaces:**
- Consumes: personal Base tables with the new fields and select values.
- Produces: verified form/chat conflict rows and deduplicated weekly AI input.

- [ ] **Step 1: Run all local verification**

Run: `git diff --check`

Expected: no output.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Exercise the four fact scenarios in the personal Base**

Create or submit test data for one member and date per scenario:

1. Chat only.
2. Form and chat with equal content.
3. Older form plus later chat with different content.
4. Older chat plus later form with different content.

Expected statuses respectively:

```text
单来源 / 无冲突 / 有效
重复已合并 / 无冲突 / 有效
按时间取最新 / 已自动处理 / 有效 / 有效来源=chat
按时间取最新 / 已自动处理 / 有效 / 有效来源=form
```

- [ ] **Step 3: Verify manual exclusion behavior**

Set one fact to`忽略`, rerun reconciliation, and confirm it remains`忽略` and is absent from weekly AI input.

- [ ] **Step 4: Verify multi-day AI deduplication**

Submit one multi-day chat report covering two dates. Confirm two fact rows exist, then run a weekly summary in reply mode and confirm the source appears once with a two-date coverage range.

- [ ] **Step 5: Record evidence before deployment**

Capture fact record IDs, status values, effective source, source time, and the weekly AI input count in the test notes. Do not copy full report content into deployment logs.

---

## Completion Gate

- All tests pass.
- Every form sync requests automatic record fields.
- Latest source time wins and exact ties favor form.
- Existing manual `忽略` survives reconciliation.
- Only `有效` facts enter AI input.
- One multi-day submission remains multiple fact rows but one AI input.
- Equal text from different submissions remains separate evidence.
- The four personal-organization reconciliation scenarios are verified before any formal-organization rollout.
