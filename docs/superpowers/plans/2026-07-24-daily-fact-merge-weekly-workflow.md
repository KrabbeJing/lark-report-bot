# Daily Fact Merge And Weekly Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement field-level daily fact merging, explicit weekly source routing, style-guided current-week AI summaries, protected Wiki Sheet writes, owner reminders, Saturday refresh, and poster delivery.

**Architecture:** Keep the existing Base tables as the system of record, add four collaborative configuration tables, and persist weekly idempotency in the existing weekly instance table. Resolve daily facts in a pure field-level module, route work items deterministically before invoking AI, and isolate Sheet writing, private notification, and scheduling behind focused services.

**Tech Stack:** Node.js ESM, `@larksuiteoapi/node-sdk`, Feishu Base, Feishu Sheets/Wiki, Node test runner, OpenAI-compatible Zhipu API, PM2.

## Global Constraints

- The weekly fact window is the closed interval from the previous Friday through the current Thursday.
- Friday 16:30 performs explicit fact sync and first AI generation.
- Friday 17:00 privately messages weekly owners and reminds missing core-metric owners once.
- Saturday 09:30 refreshes only cells still owned by AI.
- Saturday 11:00 sends the deterministic Node.js poster.
- Module II and Module III are mutually exclusive per work item.
- Generate only Module II `本周重点事项说明` and Module III `本周工作进展`.
- Do not generate next-week plans or core metric values.
- Empty incoming fields never erase existing non-empty facts.
- No evidence means no AI output.
- Do not display report coverage, missing reporters, personnel type, or agile-team identity.
- Team contact `团队名称` maps to daily fact `所属板块`.
- Remove agile-group and divisional-leader dependencies from contacts and daily facts.
- Historical account matching is out of scope.
- AI style samples must be final, reviewed versions only.
- All new schedules stay disabled until controlled manual verification is complete.
- Subagents modify files, run tests, and report only. The main session performs every `git add` and `git commit`.
- Table schema SSOT: `docs/report-agent-table-catalog.md`.
- Approved design: `docs/superpowers/specs/2026-07-20-weekly-source-mapping-current-summary-design.md`.

---

## Required Data Assets

The current phase requires nine Base tables and one annual weekly workbook.

| No. | Asset | State Before Work | Action |
| --- | --- | --- | --- |
| 1 | 表单日报表 | Existing | Keep; confirm required fields |
| 2 | 群聊日报原始表 | Existing | Keep; confirm select options |
| 3 | 日报统一事实表 | Existing | Add field-source snapshot and new merge options; later remove agile/divisional fields |
| 4 | 团队通讯录 | Existing | Keep current eight fields; remove config dependency on agile group |
| 5 | 周报来源映射表 | Missing | Create |
| 6 | 周报板块规则表 | Missing | Create |
| 7 | 周报风格样例表 | Missing | Create |
| 8 | 核心指标负责人表 | Missing | Create |
| 9 | 周报实例表 | Existing | Extend with AI, notification, poster, and period fields |
| 10 | 年度周报工作簿 | Existing | Reuse template; copy weekly Sheet |

The complete fields, types, required flags, and select options are defined in `docs/report-agent-table-catalog.md`. Do not duplicate or improvise option names in code.

## File Structure

### New files

- `src/weekly-config-repository.js`: Read and normalize the four weekly configuration tables.
- `src/weekly-source-router.js`: Route valid work items to one allowed weekly target.
- `src/weekly-draft-service.js`: Generate, validate, snapshot, write, and safely refresh AI-owned cells.
- `src/weekly-owner-notifier.js`: Build and send consolidated private owner messages and core-metric reminders.
- `src/weekly-workflow.js`: Orchestrate Friday generation, Friday notification, Saturday refresh, and Saturday publish.
- `scripts/run-weekly-workflow.js`: Controlled manual runner with explicit stage and date.
- `scripts/validate-report-table-schema.js`: Read-only schema validator for all configured Base tables.
- `test/weekly-config-repository.test.js`
- `test/weekly-source-router.test.js`
- `test/weekly-draft-service.test.js`
- `test/weekly-owner-notifier.test.js`
- `test/weekly-workflow.test.js`
- `test/report-table-schema.test.js`

### Modified files

- `src/config.js`: Remove agile/divisional defaults, add field-source snapshot, weekly table configs, and schedules.
- `src/date-utils.js`: Add Friday-anchored report period.
- `src/daily-fact-resolution.js`: Replace whole-record winner logic with field-level resolution.
- `src/organization-snapshot.js`: Keep only real name, OpenID, and supervisor organization snapshot.
- `src/bitable-service.js`: Persist field provenance and read/update weekly instance technical fields.
- `src/daily-fact-sync.js`: Recompute the explicit period idempotently.
- `src/message-router.js`: Use the same field-level merger for real-time chat facts.
- `src/weekly-sheet-content.js`: Remove agile-group and next-plan buckets.
- `src/weekly-ai-preview.js`: Load mappings/rules/styles and route before AI.
- `src/ai-providers.js`: Accept routed evidence and final style samples; output current-week cells only.
- `src/weekly-sheet-writer.js`: Read target cells, write allowed cells, and attach AI markers.
- `src/weekly-instance-service.js`: Use Friday report date and Friday-to-Thursday fact period.
- `src/weekly-reporter.js`: Delegate staged generation/publish to the new workflow.
- `src/scheduler.js`: Add four explicit weekly schedules with deterministic run keys.
- `src/index.js`: Wire the new services and schedules.
- `config/groups.json`
- `config/groups.personal.json`
- `config/groups.formal.example.json`
- `package.json`
- `docs/daily-fact-table-setup.md`
- `docs/weekly-instance-table-setup.md`

---

### Task 1: Friday-Anchored Period And Configuration Schema

**Files:**
- Modify: `src/date-utils.js`
- Modify: `src/config.js`
- Modify: `config/groups.json`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`
- Test: `test/date-utils.test.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `getWeeklyReportRange(now, timezone) -> { reportDate, start, end }`
- Produces: normalized group properties `weeklySourceMappingTable`, `weeklySectionRuleTable`, `weeklyStyleExampleTable`, and `coreMetricOwnerTable`
- Produces schedules `weeklyDraft`, `weeklyOwnerReminder`, `weeklyRefresh`, and `weeklyPush`
- Produces `weeklyDelivery.departmentChatId` and `weeklyDelivery.smallTeams[]`

- [ ] **Step 1: Add failing Friday/Saturday period tests**

```js
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
```

- [ ] **Step 2: Run period tests and confirm failure**

Run:

```bash
node --test test/date-utils.test.js
```

Expected: FAIL because `getWeeklyReportRange` does not exist.

- [ ] **Step 3: Implement the Friday anchor**

```js
export function getWeeklyReportRange(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const today = formatYmd(now, timeZone);
  const parsed = parseYmd(today);
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const fridayOffset = day === 6 ? -1 : day <= 5 ? 5 - day : -2;
  const reportDate = addDaysToYmd(today, fridayOffset);
  return {
    reportDate,
    start: addDaysToYmd(reportDate, -7),
    end: addDaysToYmd(reportDate, -1),
  };
}
```

- [ ] **Step 4: Add failing config assertions**

Assert that:

```js
assert.equal(group.contactTable.fields.agileGroup, undefined);
assert.equal(group.contactTable.fields.divisionalLeader, undefined);
assert.equal(group.dailyFactTable.fields.agileGroup, undefined);
assert.equal(group.dailyFactTable.fields.divisionalLeader, undefined);
assert.equal(group.dailyFactTable.fields.fieldSourceSnapshot, '字段来源快照');
assert.ok(group.weeklySourceMappingTable);
assert.ok(group.weeklySectionRuleTable);
assert.ok(group.weeklyStyleExampleTable);
assert.ok(group.coreMetricOwnerTable);
assert.deepEqual(config.weeklyDraft, {
  enabled: false,
  dayOfWeek: 5,
  time: '16:30',
  timezone: 'Asia/Shanghai',
});
assert.deepEqual(group.weeklyDelivery.smallTeams[0], {
  key: 'team-a',
  name: '测试小团队A',
  enabled: true,
  chatId: 'oc_test',
  sectionTargets: ['融羲项目组', '零售客群经营'],
});
```

- [ ] **Step 5: Implement config constants and normalization**

Add exact field-key maps matching `docs/report-agent-table-catalog.md`. Remove `agileGroup` and `divisionalLeader` from `DAILY_FIELD_KEYS`, `DAILY_FACT_FIELD_KEYS`, and `CONTACT_FIELD_KEYS`. Add:

```js
fieldSourceSnapshot: '字段来源快照',
```

Normalize the four table configs and four schedules. Every new schedule defaults to `enabled: false`.

Normalize delivery targets with this JSON shape:

```json
{
  "weeklyDelivery": {
    "departmentChatId": "oc_department",
    "smallTeams": [
      {
        "key": "team-a",
        "name": "测试小团队A",
        "enabled": true,
        "chatId": "oc_test",
        "sectionTargets": ["融羲项目组", "零售客群经营"]
      }
    ]
  }
}
```

The three logical teams may temporarily share the same test `chatId`. Formal entries without an approved ChatID remain `enabled: false`. Team filtering uses `sectionTargets`, not supervisor, divisional leader, or contact labels.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/date-utils.test.js test/config.test.js
```

Expected: PASS.

- [ ] **Step 7: Main session commit**

```bash
git add src/date-utils.js src/config.js config/groups.json config/groups.personal.json config/groups.formal.example.json test/date-utils.test.js test/config.test.js
git commit -m "refactor: align report period and table config"
```

---

### Task 2: Pure Field-Level Daily Fact Resolution

**Files:**
- Modify: `src/daily-fact-resolution.js`
- Test: `test/daily-fact-resolution.test.js`

**Interfaces:**
- Consumes: candidate `{ source, sourceTime, matchingStatus, values }`
- Produces: `resolveDailyFactFields({ existing, incoming })`
- Returns:

```js
{
  values: { workItems, tomorrowPlanItems, riskItems },
  fieldSources,
  observedSources,
  effectiveSources,
  sourceTime,
  mergeStatus,
  conflictStatus,
  factStatus,
  autoResolutionNote,
}
```

- [ ] **Step 1: Replace whole-record tests with field-level failing tests**

```js
test('later chat work keeps earlier non-empty form plan', () => {
  const form = candidate('form', 1000, {
    workItems: '表单总结',
    tomorrowPlanItems: '表单计划',
    riskItems: '',
  });
  const afterForm = resolveDailyFactFields({ incoming: form });
  const result = resolveDailyFactFields({
    existing: afterForm,
    incoming: candidate('chat', 2000, {
      workItems: '群聊总结',
      tomorrowPlanItems: '',
      riskItems: '',
    }),
  });

  assert.deepEqual(result.values, {
    workItems: '群聊总结',
    tomorrowPlanItems: '表单计划',
    riskItems: '',
  });
  assert.equal(result.fieldSources.workItems.source, 'chat');
  assert.equal(result.fieldSources.tomorrowPlanItems.source, 'form');
  assert.equal(result.mergeStatus, '按字段取最新');
  assert.equal(result.conflictStatus, '已自动处理');
});
```

Add separate tests for:

- identical overlapping fields -> `重复已合并`
- non-overlapping fields -> `互补已合并`
- same timestamp -> form wins
- later blank from the same source -> existing non-empty value survives
- existing `忽略` survives
- no matched candidate -> `待人工确认`
- replaying the same candidates in opposite arrival order returns the same values and provenance

- [ ] **Step 2: Run the resolution tests**

Run:

```bash
node --test test/daily-fact-resolution.test.js
```

Expected: FAIL under whole-record winner behavior.

- [ ] **Step 3: Implement field-by-field choice**

Use the exact content keys:

```js
export const DAILY_FACT_CONTENT_KEYS = Object.freeze([
  'workItems',
  'tomorrowPlanItems',
  'riskItems',
]);
```

For each key:

```js
function chooseField(existingValue, existingSource, incomingValue, incoming) {
  if (!normalizeText(incomingValue)) {
    return { value: existingValue, source: existingSource, relation: 'missing' };
  }
  if (!normalizeText(existingValue)) {
    return {
      value: incomingValue,
      source: provenance(incoming, incomingValue),
      relation: 'complement',
    };
  }
  if (fingerprint(existingValue) === fingerprint(incomingValue)) {
    return incoming.sourceTime >= Number(existingSource?.sourceTime || 0)
      ? { value: incomingValue, source: provenance(incoming, incomingValue), relation: 'same' }
      : { value: existingValue, source: existingSource, relation: 'same' };
  }
  return incoming.sourceTime >= Number(existingSource?.sourceTime || 0)
    ? { value: incomingValue, source: provenance(incoming, incomingValue), relation: 'conflict' }
    : { value: existingValue, source: existingSource, relation: 'conflict' };
}
```

On exact cross-source timestamp ties, explicitly prefer form instead of relying on arrival order.

For incremental updates, preserve an existing `已自动处理` conflict marker until a full form-and-chat reconstruction proves that no conflict remains. This prevents a later same-source refresh from erasing known cross-source conflict history.

- [ ] **Step 4: Derive statuses from field relations**

Rules:

```text
one observed source                         -> 单来源 / 无冲突
two sources, all populated overlap equal    -> 重复已合并 / 无冲突
two sources, at least one complementary key -> 互补已合并 / 无冲突
any populated overlap differs               -> 按字段取最新 / 已自动处理
```

Build notes from field labels and selected sources only. Do not include content text.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/daily-fact-resolution.test.js
```

Expected: PASS.

- [ ] **Step 6: Main session commit**

```bash
git add src/daily-fact-resolution.js test/daily-fact-resolution.test.js
git commit -m "feat: merge daily facts by field"
```

---

### Task 3: Persist Field Provenance And Remove Agile Snapshots

**Files:**
- Modify: `src/organization-snapshot.js`
- Modify: `src/bitable-service.js`
- Modify: `src/daily-fact-sync.js`
- Modify: `src/message-router.js`
- Modify: `scripts/backfill-daily-facts.js`
- Test: `test/organization-snapshot.test.js`
- Test: `test/bitable-service.test.js`
- Test: `test/daily-fact-sync.test.js`
- Test: `test/message-router.test.js`
- Test: `test/daily-fact-backfill.test.js`

**Interfaces:**
- Consumes: `resolveDailyFactFields`
- Persists: `字段来源快照` JSON
- Preserves: real name, member OpenID, team name as project, and supervisor
- Stops persisting: agile group and divisional leader

- [ ] **Step 1: Add failing payload tests**

For a form-first/chat-later case, assert:

```js
assert.equal(fields['今日工作总结'], '群聊总结');
assert.equal(fields['明日工作计划'], '表单计划');
assert.equal(fields['日报来源'], 'form+chat');
assert.equal(fields['有效来源'], 'form+chat');
assert.equal(fields['合并状态'], '按字段取最新');
assert.equal(fields['冲突状态'], '已自动处理');
assert.equal(fields['敏捷小组'], undefined);
assert.equal(fields['分管领导'], undefined);
assert.deepEqual(JSON.parse(fields['字段来源快照']).tomorrowPlanItems.source, 'form');
```

- [ ] **Step 2: Run integration tests and confirm failure**

Run:

```bash
node --test test/organization-snapshot.test.js test/bitable-service.test.js test/daily-fact-sync.test.js test/message-router.test.js
```

Expected: FAIL because payload construction still selects one whole-record winner and writes agile fields.

- [ ] **Step 3: Simplify organization snapshot**

`EMPTY_SNAPSHOT` and `snapshotFromContact` retain only:

```js
{
  reporterNameText,
  memberOpenId,
  supervisor,
  supervisorOpenId,
  matchingStatus,
  matchMethod,
}
```

`project` remains a canonical fact field sourced from `contact.teamName`; it is not part of the person-field snapshot.

- [ ] **Step 4: Integrate the field merger into Base writes**

In `buildDailyFactFields`:

1. Read current business values.
2. Parse `字段来源快照`, falling back to current `有效来源` and `来源时间`.
3. Call `resolveDailyFactFields`.
4. Write merged values, new fingerprint, statuses, source time, and JSON snapshot.
5. Preserve manual `忽略`.
6. Do not call `setMappedField` for agile or divisional leader.

- [ ] **Step 5: Make scheduled and real-time paths converge**

Both paths must construct the same candidate:

```js
{
  source: 'form' | 'chat',
  sourceTime,
  matchingStatus,
  values: {
    workItems,
    tomorrowPlanItems,
    riskItems,
  },
}
```

Add a test that feeds the same candidates through:

- scheduled form then chat
- real-time chat then scheduled form

and compares persisted business fields and source snapshot.

- [ ] **Step 6: Add controlled migration behavior**

Backfill rules:

- source records available -> rebuild provenance from both source tables
- source records unavailable -> initialize provenance from current fact and preserve content
- no automatic blank-field deletion
- no automatic change from `忽略`

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test test/organization-snapshot.test.js test/bitable-service.test.js test/daily-fact-sync.test.js test/message-router.test.js test/daily-fact-backfill.test.js
```

Expected: PASS.

- [ ] **Step 8: Main session commit**

```bash
git add src/organization-snapshot.js src/bitable-service.js src/daily-fact-sync.js src/message-router.js scripts/backfill-daily-facts.js test/organization-snapshot.test.js test/bitable-service.test.js test/daily-fact-sync.test.js test/message-router.test.js test/daily-fact-backfill.test.js
git commit -m "refactor: persist field-level fact provenance"
```

---

### Task 4: Weekly Configuration Repository

**Files:**
- Create: `src/weekly-config-repository.js`
- Create: `test/weekly-config-repository.test.js`
- Modify: `src/bitable-service.js`
- Test: `test/bitable-service.test.js`

**Interfaces:**
- Produces:

```js
loadWeeklyConfiguration({ group, bitable, period }) -> {
  mappings,
  rules,
  styleExamples,
  metricOwners,
  warnings,
}
```

- [ ] **Step 1: Write failing normalization tests**

Cover:

- one linked contact record and Lookup arrays
- multiple Module II selections
- empty Module III
- multi-person weekly owners
- inactive and out-of-period mappings excluded
- duplicate active mappings returned as a warning, not silently selected
- only enabled, reviewed style examples included

- [ ] **Step 2: Run repository tests**

Run:

```bash
node --test test/weekly-config-repository.test.js
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement focused normalizers**

Export:

```js
function raw(record, table, key) {
  return record?.fields?.[table?.fields?.[key]];
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return String(value.text || value.name || value.id || '').trim();
  return String(value || '').trim();
}

function texts(value) {
  if (!Array.isArray(value)) return text(value) ? [text(value)] : [];
  return value.map(text).filter(Boolean);
}

function people(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map(item => ({ openId: String(item?.id || ''), name: String(item?.name || '') }))
    .filter(item => item.openId);
}

export function normalizeWeeklySourceMapping(record, table) {
  return {
    recordId: record.record_id,
    contactRecordIds: texts(raw(record, table, 'member')),
    memberName: text(raw(record, table, 'memberRealName')),
    memberOpenId: text(raw(record, table, 'memberOpenId')),
    module2Targets: texts(raw(record, table, 'module2Targets')),
    module3Target: text(raw(record, table, 'module3Target')),
    effectiveFrom: text(raw(record, table, 'effectiveFrom')),
    effectiveTo: text(raw(record, table, 'effectiveTo')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeWeeklySectionRule(record, table) {
  return {
    recordId: record.record_id,
    module: text(raw(record, table, 'module')),
    target: text(raw(record, table, 'target')),
    contentType: text(raw(record, table, 'contentType')),
    includeTopics: texts(raw(record, table, 'includeTopics')),
    excludeTopics: texts(raw(record, table, 'excludeTopics')),
    owners: people(raw(record, table, 'owners')),
    remindOwners: Boolean(raw(record, table, 'remindOwners')),
    order: Number(text(raw(record, table, 'order')) || 0),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeWeeklyStyleExample(record, table) {
  return {
    recordId: record.record_id,
    module: text(raw(record, table, 'module')),
    target: text(raw(record, table, 'target')),
    contentType: text(raw(record, table, 'contentType')),
    weekKey: text(raw(record, table, 'weekKey')),
    finalText: text(raw(record, table, 'finalText')),
    reviewedAt: text(raw(record, table, 'reviewedAt')),
    highQuality: Boolean(raw(record, table, 'highQuality')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeCoreMetricOwner(record, table) {
  return {
    recordId: record.record_id,
    metricName: text(raw(record, table, 'metricName')),
    owners: people(raw(record, table, 'owners')),
    remindersEnabled: Boolean(raw(record, table, 'remindersEnabled')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

function isMappingActive(mapping, period) {
  const startsBeforeEnd = !mapping.effectiveFrom || mapping.effectiveFrom <= period.end;
  const endsAfterStart = !mapping.effectiveTo || mapping.effectiveTo >= period.start;
  return startsBeforeEnd && endsAfterStart;
}

function nextYmd(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

function findMappingConflicts(mappings, period) {
  const conflicts = new Set();
  for (let date = period.start; date <= period.end; date = nextYmd(date)) {
    const counts = new Map();
    for (const mapping of mappings.filter(item => isMappingActive(item, { start: date, end: date }))) {
      const key = mapping.memberOpenId || mapping.memberName;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [memberKey, count] of counts) {
      if (count > 1) conflicts.add(`duplicate_active_mapping:${date}:${memberKey}`);
    }
  }
  return [...conflicts];
}

export async function loadWeeklyConfiguration({ group, bitable, period }) {
  const [
    mappingRecords,
    ruleRecords,
    styleRecords,
    metricRecords,
  ] = await Promise.all([
    bitable.listRecords(group.weeklySourceMappingTable, 'weeklyConfig.mappings', { includeView: false }),
    bitable.listRecords(group.weeklySectionRuleTable, 'weeklyConfig.rules', { includeView: false }),
    bitable.listRecords(group.weeklyStyleExampleTable, 'weeklyConfig.styles', { includeView: false }),
    bitable.listRecords(group.coreMetricOwnerTable, 'weeklyConfig.metrics', { includeView: false }),
  ]);
  const mappings = mappingRecords
    .map(record => normalizeWeeklySourceMapping(record, group.weeklySourceMappingTable))
    .filter(item => item.enabled && isMappingActive(item, period));
  return {
    mappings,
    rules: ruleRecords
      .map(record => normalizeWeeklySectionRule(record, group.weeklySectionRuleTable))
      .filter(item => item.enabled),
    styleExamples: styleRecords
      .map(record => normalizeWeeklyStyleExample(record, group.weeklyStyleExampleTable))
      .filter(item => item.enabled && item.highQuality && item.finalText),
    metricOwners: metricRecords
      .map(record => normalizeCoreMetricOwner(record, group.coreMetricOwnerTable))
      .filter(item => item.enabled),
    warnings: findMappingConflicts(mappings, period),
  };
}
```

Never expose Base record objects to routing or AI code. Normalize people to:

```js
{ openId: 'ou_xxx', name: '负责人姓名' }
```

- [ ] **Step 4: Add Bitable list methods**

Use existing paginated `listRecords`. Do not add one-off raw SDK calls. Each method must identify its operation name for masked error reporting.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/weekly-config-repository.test.js test/bitable-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Main session commit**

```bash
git add src/weekly-config-repository.js src/bitable-service.js test/weekly-config-repository.test.js test/bitable-service.test.js
git commit -m "feat: load weekly configuration tables"
```

---

### Task 5: Deterministic Item Routing With Module Exclusivity

**Files:**
- Create: `src/weekly-source-router.js`
- Create: `test/weekly-source-router.test.js`
- Modify: `src/weekly-sheet-content.js`
- Test: `test/weekly-sheet-content.test.js`

**Interfaces:**
- Consumes valid facts, normalized mappings, normalized rules, and semantic Sheet targets
- Produces:

```js
routeWeeklyFacts({ facts, mappings, rules, cellMap, period }) -> {
  buckets,
  evidence,
  diagnostics,
}
```

- [ ] **Step 1: Write failing routing tests**

Required scenarios:

```js
test('routes receipt work to module II and cloud payment work to module III', () => {
  const result = routeWeeklyFacts({
    facts: [fact({
      memberOpenId: 'ou_a',
      workItems: ['完成收单接口联调', '完成云缴费对账方案评审'],
    })],
    mappings: [mapping({
      memberOpenId: 'ou_a',
      module2Targets: ['收单项目组'],
      module3Target: '对公客群经营及场景建设',
    })],
    rules: [
      rule('模块二', '收单项目组', ['收单']),
      rule('模块三', '对公客群经营及场景建设', ['云缴费']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
  assert.deepEqual(texts(result, '对公客群经营及场景建设'), ['完成云缴费对账方案评审']);
});
```

Also test:

- same item never appears in both modules
- Module II match wins over Module III
- member cannot enter a target absent from their mapping
- multiple possible targets -> skipped diagnostic
- no topic match -> skipped diagnostic
- routine meeting without result -> excluded
- only `事实记录状态=有效` and in-period facts enter

- [ ] **Step 2: Run routing tests**

Run:

```bash
node --test test/weekly-source-router.test.js test/weekly-sheet-content.test.js
```

Expected: FAIL because current code routes by agile group, group name, and broad aliases.

- [ ] **Step 3: Implement item splitting and normalized matching**

Use stable evidence IDs:

```js
`${factRecordId}:current:workItems:${itemIndex}`
```

Apply each rule in this order:

1. member mapping allows target
2. no exclusion topic matches
3. at least one inclusion topic matches
4. one unique Module II result wins
5. otherwise one fixed Module III result wins
6. ambiguity is skipped

- [ ] **Step 4: Remove next-plan and agile routing**

`weekly-sheet-content.js` must stop:

- reading `report.agileGroup`
- building next buckets
- inferring follow-up items with `FOLLOW_UP_RE`
- routing by `group.project` or group name

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test test/weekly-source-router.test.js test/weekly-sheet-content.test.js
```

Expected: PASS.

- [ ] **Step 6: Main session commit**

```bash
git add src/weekly-source-router.js src/weekly-sheet-content.js test/weekly-source-router.test.js test/weekly-sheet-content.test.js
git commit -m "feat: route weekly evidence by explicit source rules"
```

---

### Task 6: Style-Guided Read-Only AI Preview

**Files:**
- Modify: `src/weekly-ai-preview.js`
- Modify: `src/ai-providers.js`
- Modify: `src/weekly-ai-preview-cli.js`
- Modify: `scripts/preview-weekly-ai.js`
- Test: `test/weekly-ai-preview.test.js`
- Test: `test/ai-providers.test.js`

**Interfaces:**
- Consumes routed buckets and target-specific final style samples
- Produces current-week cell entries:

```js
{
  cells: {
    C26: [{ text: '完成收单接口联调', evidenceIds: ['rec_fact_1:current:workItems:0'] }],
  },
  provider,
  model,
}
```

- [ ] **Step 1: Add failing preview tests**

Assert:

- repository configuration is loaded before routing
- prompt contains only routed current work items
- prompt contains three to five enabled final samples for the same target
- prompt omits names by default
- prompt does not contain `tomorrowPlanItems`
- output to any next-plan cell is rejected
- every output entry has current-target evidence
- Module III uses no more than three cells
- no evidence leaves the target blank

- [ ] **Step 2: Run AI tests**

Run:

```bash
node --test test/weekly-ai-preview.test.js test/ai-providers.test.js
```

Expected: FAIL because preview currently uses broad buckets and builds next-plan targets.

- [ ] **Step 3: Change preview input**

`runWeeklyAiPreview` must:

1. list valid facts
2. load weekly configuration
3. route facts
4. attach exact style examples
5. call AI once per target
6. validate evidence and target cells

- [ ] **Step 4: Tighten prompt and parser**

Prompt rules include:

```text
只总结本周期事实。
不得生成下周计划。
不得添加来源中不存在的项目、数字、日期、状态或责任人。
历史样例只用于风格，不是事实。
没有足够证据时返回空数组。
```

Keep strict JSON mode and timeout-safe errors. Do not fall back to a template that invents next plans.

- [ ] **Step 5: Run focused tests and one local preview fixture**

Run:

```bash
node --test test/weekly-ai-preview.test.js test/ai-providers.test.js
node scripts/preview-weekly-ai.js --start 2026-07-10 --end 2026-07-16 --output out/weekly-ai-preview-plan-check.json
```

Expected:

- tests PASS
- preview command either produces validated JSON or a safe provider error
- no Sheet writes or messages occur

- [ ] **Step 6: Main session commit**

```bash
git add src/weekly-ai-preview.js src/ai-providers.js src/weekly-ai-preview-cli.js scripts/preview-weekly-ai.js test/weekly-ai-preview.test.js test/ai-providers.test.js
git commit -m "feat: generate routed style-guided weekly previews"
```

---

### Task 7: Weekly Instance Period And AI-Owned Cell Protection

**Files:**
- Create: `src/weekly-draft-service.js`
- Create: `test/weekly-draft-service.test.js`
- Modify: `src/weekly-instance-service.js`
- Modify: `src/weekly-sheet-writer.js`
- Modify: `src/bitable-service.js`
- Test: `test/weekly-instance-service.test.js`
- Test: `test/weekly-sheet-writer.test.js`
- Test: `test/bitable-service.test.js`

**Interfaces:**
- Produces:

```js
writeInitialWeeklyDraft({ instance, preview, writer, bitable, now })
refreshWeeklyDraft({ instance, preview, writer, bitable, now })
```

- [ ] **Step 1: Add failing weekly instance period tests**

For Friday 2026-07-24 assert:

```js
assert.equal(instance.reportDate, '2026-07-24');
assert.equal(instance.periodStart, '2026-07-17');
assert.equal(instance.periodEnd, '2026-07-23');
assert.equal(instance.sheetTitle, '数字金融部周报0724');
```

The copied Sheet must move to index `0` and rerunning must reuse it.

Update `renderWeeklySheetTitle` to support `{{reportDateMMDD}}`, set the configured pattern to `数字金融部周报{{reportDateMMDD}}`, and compute the ISO instance key from `reportDate`. Do not use `periodEnd` for the MMDD title because that date is Thursday.

- [ ] **Step 2: Add failing cell ownership tests**

Cover:

- Friday writes only blank targets
- existing manual value stays unchanged
- snapshot stores exact written text and hash
- Saturday refresh updates a cell still equal to the Friday AI value
- manually edited cell is locked
- manually cleared cell stays empty
- one locked Module III cell does not lock the other two
- failed or empty refresh retains prior AI value

- [ ] **Step 3: Run focused tests**

Run:

```bash
node --test test/weekly-instance-service.test.js test/weekly-sheet-writer.test.js test/weekly-draft-service.test.js
```

Expected: FAIL because the writer cannot yet read target values or persist ownership snapshots.

- [ ] **Step 4: Add Sheet read and marker interfaces**

Add:

```js
writer.readCells(sheetConfig, sheetId, cells) -> { [cell]: string }
writer.writeCells(sheetConfig, sheetId, values)
writer.markAiCells(sheetConfig, sheetId, cells, 'AI总结生成，仅供参考')
```

Implement `markAiCells` as a non-printing Sheet cell `note`, using `/open-apis/sheet_ai/v2/spreadsheets/{spreadsheetToken}/tools/invoke_write`, the same API family already used by `moveSheet`. The write cell object is:

```js
{
  value: currentCellValue,
  note: 'AI总结生成，仅供参考',
}
```

The note is metadata and must not be appended to the visible cell value.

- [ ] **Step 5: Implement ownership logic**

Persist:

```js
{
  "C26": {
    "text": "AI draft",
    "hash": "25de01314c1bd3a1b7609a387be65083d267310214804345e4e1ce89c64a46b7",
    "writtenAt": 1784872200000,
    "evidenceIds": ["rec_fact_1:current:workItems:0"]
  }
}
```

Friday eligible condition: current value is blank.

Saturday eligible condition:

```js
currentValue === snapshot[cell].text
```

An empty current value with a non-empty snapshot is a manual clear and is not eligible.

- [ ] **Step 6: Persist weekly instance statuses**

Add Bitable update helpers for all fields in Table 9. Writes must preserve unrelated status details and serialize JSON deterministically.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test test/weekly-instance-service.test.js test/weekly-sheet-writer.test.js test/weekly-draft-service.test.js test/bitable-service.test.js
```

Expected: PASS.

- [ ] **Step 8: Main session commit**

```bash
git add src/weekly-draft-service.js src/weekly-instance-service.js src/weekly-sheet-writer.js src/bitable-service.js test/weekly-draft-service.test.js test/weekly-instance-service.test.js test/weekly-sheet-writer.test.js test/bitable-service.test.js
git commit -m "feat: protect AI-owned weekly sheet cells"
```

---

### Task 8: Weekly Owner And Core Metric Private Notifications

**Files:**
- Create: `src/weekly-owner-notifier.js`
- Create: `test/weekly-owner-notifier.test.js`
- Modify: `src/lark-messenger.js`
- Test: `test/lark-messenger.test.js`

**Interfaces:**
- Produces:

```js
notifyWeeklyOwners({ rules, instance, draft, messenger, bitable, now })
notifyMissingCoreMetricOwners({ metricOwners, metricCells, instance, writer, messenger, bitable, now })
```

- [ ] **Step 1: Add failing owner-message tests**

Cover:

- one owner with two sections receives one consolidated message
- message contains section names, available draft text, and direct weekly Sheet link
- empty draft uses `本期暂无可用 AI 草稿，请直接进入周报表填写`
- message contains no coverage, missing-person list, personnel type, or agile group
- disabled reminder sends nothing
- missing OpenID records a safe failure
- already successful recipient in instance details is not sent again

- [ ] **Step 2: Add failing metric reminder tests**

Cover:

- blank metric target -> one private reminder
- filled target -> no reminder
- multiple blank metrics for one owner -> one consolidated reminder
- rerun after successful send -> no duplicate
- no Saturday second reminder

- [ ] **Step 3: Run notifier tests**

Run:

```bash
node --test test/weekly-owner-notifier.test.js test/lark-messenger.test.js
```

Expected: FAIL because notifier service does not exist.

- [ ] **Step 4: Implement deterministic recipient grouping**

Group by OpenID:

```js
Map<openId, {
  ownerName,
  sections: Array<{ module, section, draftText }>,
  missingMetrics: string[],
}>
```

Use stable message UUIDs:

```text
weekly-owner:{instanceKey}:{openId}
weekly-metric:{instanceKey}:{openId}
```

The existing messenger UUID normalization handles the 50-character limit.

- [ ] **Step 5: Persist per-recipient results**

`负责人通知明细` and `核心指标提醒明细` must record:

```js
{
  openId,
  status: '成功' | '失败',
  sentAt,
  idempotencyKey,
  errorCode: ''
}
```

Do not store message text or complete exception objects.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test test/weekly-owner-notifier.test.js test/lark-messenger.test.js
```

Expected: PASS.

- [ ] **Step 7: Main session commit**

```bash
git add src/weekly-owner-notifier.js src/lark-messenger.js test/weekly-owner-notifier.test.js test/lark-messenger.test.js
git commit -m "feat: privately notify weekly owners"
```

---

### Task 9: Staged Weekly Workflow And Schedulers

**Files:**
- Create: `src/weekly-workflow.js`
- Create: `scripts/run-weekly-workflow.js`
- Create: `test/weekly-workflow.test.js`
- Modify: `src/scheduler.js`
- Modify: `src/index.js`
- Modify: `src/weekly-reporter.js`
- Modify: `src/scheduled-workflows.js`
- Modify: `package.json`
- Test: `test/scheduler.test.js`
- Test: `test/scheduled-workflows.test.js`
- Test: `test/weekly-reporter.test.js`

**Interfaces:**
- Produces:

```js
runWeeklyWorkflowStage({
  stage: 'draft' | 'notify' | 'refresh' | 'publish',
  group,
  services,
  now,
})
```

- [ ] **Step 1: Add failing stage-order tests**

`draft` order:

```text
ensure instance
sync facts for explicit period
load config
route
generate
write protected cells
persist status
```

`notify` order:

```text
load instance and rules
read current draft snapshot
notify weekly owners
check and notify blank metrics
persist status
```

`refresh` order:

```text
sync facts
load config
route
generate
refresh eligible cells
persist status
```

`publish` order:

```text
read current Sheet
render deterministic poster
validate image
send department image
send enabled small-team summaries
persist publish status
```

Small-team summaries include only routed sections listed in that target's `sectionTargets`. Add tests proving that three logical targets may share one test ChatID while each receives its own idempotency key and section-filtered content.

- [ ] **Step 2: Add failing scheduler tests**

Assert exact defaults:

```text
Friday 16:30 draft
Friday 17:00 notify
Saturday 09:30 refresh
Saturday 11:00 publish
Asia/Shanghai
all disabled by default
```

Run keys must contain stage and Friday instance key.

- [ ] **Step 3: Run workflow tests**

Run:

```bash
node --test test/weekly-workflow.test.js test/scheduler.test.js test/scheduled-workflows.test.js test/weekly-reporter.test.js
```

Expected: FAIL because stages are currently combined in one weekly push.

- [ ] **Step 4: Implement workflow stages**

Each stage:

- operates on one group
- catches per-section AI failures without aborting other sections
- throws infrastructure failures for grouped operational alerting
- updates instance status before and after external side effects
- skips already successful recipient/poster operations

- [ ] **Step 5: Add manual runner**

Supported commands:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage draft --date 2026-07-24 --dry-run
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage draft --date 2026-07-24
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage notify --date 2026-07-24
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage refresh --date 2026-07-25
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage publish --date 2026-07-25
```

`--dry-run` may read Base and Sheets and call AI preview, but must not write Sheets, update Base, or send messages.

- [ ] **Step 6: Wire schedulers in `src/index.js`**

Do not reuse `dailySupervisorPush` for weekly owner reminders. Keep the daily supervisor feature independently disabled unless separately approved.

Retire the standalone Monday `weeklyInstanceCreation` scheduler from startup. Friday `draft` owns idempotent instance creation; `npm run weekly:ensure` remains available as an operator-only recovery command.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test test/weekly-workflow.test.js test/scheduler.test.js test/scheduled-workflows.test.js test/weekly-reporter.test.js
```

Expected: PASS.

- [ ] **Step 8: Main session commit**

```bash
git add src/weekly-workflow.js scripts/run-weekly-workflow.js src/scheduler.js src/index.js src/weekly-reporter.js src/scheduled-workflows.js package.json test/weekly-workflow.test.js test/scheduler.test.js test/scheduled-workflows.test.js test/weekly-reporter.test.js
git commit -m "feat: orchestrate staged weekly automation"
```

---

### Task 10: Read-Only Table Schema Validator And Setup Documentation

**Files:**
- Create: `scripts/validate-report-table-schema.js`
- Create: `test/report-table-schema.test.js`
- Modify: `docs/daily-fact-table-setup.md`
- Modify: `docs/weekly-instance-table-setup.md`
- Modify: `package.json`

**Interfaces:**
- Produces command:

```bash
npm run tables:validate
```

- [ ] **Step 1: Add failing schema catalog tests**

Test that the validator expects:

- all nine configured tables
- exact required field names
- exact select/multiselect option sets
- no agile or divisional field in contact/fact required schema
- date/person/url fields have compatible types

- [ ] **Step 2: Run schema tests**

Run:

```bash
node --test test/report-table-schema.test.js
```

Expected: FAIL because validator does not exist.

- [ ] **Step 3: Implement read-only validator**

The validator:

1. resolves each configured Wiki/Base link
2. lists table fields
3. compares names, types, and options
4. prints JSON-safe diagnostics
5. exits `0` only when required schema is valid
6. never creates, updates, or deletes fields

- [ ] **Step 4: Update setup docs**

Replace old:

- agile-group requirements
- personnel type/member status suggestions
- whole-record `按时间取最新`
- Monday-to-Friday weekly period

with the approved catalog and link to `docs/report-agent-table-catalog.md`.

- [ ] **Step 5: Run docs/schema tests**

Run:

```bash
node --test test/report-table-schema.test.js test/config.test.js
```

Expected: PASS.

- [ ] **Step 6: Main session commit**

```bash
git add scripts/validate-report-table-schema.js test/report-table-schema.test.js docs/daily-fact-table-setup.md docs/weekly-instance-table-setup.md package.json
git commit -m "docs: add report table schema validation"
```

---

### Task 11: Controlled Personal-Organization Verification

**Files:**
- Create: `docs/superpowers/verification/2026-07-24-field-merge-weekly-workflow.md`
- Modify only after explicit approval: `config/groups.personal.json`

**Interfaces:**
- Consumes all previous tasks
- Produces read-back evidence without secrets or full daily report text

- [ ] **Step 1: Operator creates and extends Base tables**

Follow `docs/report-agent-table-catalog.md` in this order:

1. add `字段来源快照` and select options to the fact table
2. create four new config tables
3. extend weekly instance table
4. populate source mappings, section rules, owners, and at least three final style samples per tested target

- [ ] **Step 2: Add the four table links to personal config**

Keep all schedules disabled:

```json
{
  "weeklyDraft": { "enabled": false },
  "weeklyOwnerReminder": { "enabled": false },
  "weeklyRefresh": { "enabled": false },
  "weeklyPush": { "enabled": false }
}
```

- [ ] **Step 3: Validate live table schema**

Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run tables:validate
```

Expected: all nine tables valid.

- [ ] **Step 4: Run fact backfill for the test period**

Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run daily-fact:backfill -- --start 2026-07-10 --end 2026-07-17
```

Verify:

- later chat summary is retained
- earlier form plan is retained when chat plan is blank
- field-source snapshot names both sources
- rerun reports no unnecessary updates

- [ ] **Step 5: Run read-only weekly draft**

Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage draft --date 2026-07-24 --dry-run
```

Verify:

- range is 2026-07-17 through 2026-07-23
- no next-plan cells have output
- no item appears in both modules
- all output has evidence
- no message or Sheet write occurred

- [ ] **Step 6: Obtain explicit approval before write and message stages**

After approval, run draft, inspect Sheet, manually edit one AI cell, then run refresh and verify the edited cell stays unchanged.

- [ ] **Step 7: Verify private notifications with approved test recipient**

Confirm recipient, exact message text, and bot identity before sending. Verify one consolidated message and no coverage/personnel labels.

- [ ] **Step 8: Verify poster**

Generate from the current Sheet, check dimensions/nonblank image, and send only to the approved test group.

- [ ] **Step 9: Write verification record**

Record:

- commit SHA
- commands
- test counts
- table schema result
- fact merge counts
- routed/skipped item counts
- AI cells written/skipped/locked
- notification success counts
- poster dimensions and send result

Do not record full text, OpenIDs, ChatIDs, tokens, or API keys.

- [ ] **Step 10: Main session commit**

```bash
git add docs/superpowers/verification/2026-07-24-field-merge-weekly-workflow.md config/groups.personal.json
git commit -m "docs: verify field merge and weekly workflow"
```

---

### Task 12: Full Regression, Deployment, And Schedule Enablement Gate

**Files:**
- No planned source changes; verification failures return to the task that owns the failing behavior
- Verify: all `test/*.test.js`

**Interfaces:**
- Produces deployable commit on `codex/daily-fact-data-layer`

- [ ] **Step 1: Run full local verification**

Run:

```bash
npm test
```

Expected:

```text
fail 0
cancelled 0
```

- [ ] **Step 2: Run config and schema validation**

Run:

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run tables:validate
```

Expected: PASS.

- [ ] **Step 3: Review diff for secrets and scope**

Run:

```bash
git diff --check
git status --short
git diff --stat origin/codex/daily-fact-data-layer...HEAD
```

Expected:

- no whitespace errors
- no `.env`, key, generated poster, or raw preview output staged
- changes limited to this plan

- [ ] **Step 4: Request code review**

Use `superpowers:requesting-code-review`. Resolve all correctness findings before deployment.

- [ ] **Step 5: Push from the main session**

```bash
git push origin codex/daily-fact-data-layer
git push gitee codex/daily-fact-data-layer
```

If Gitee is unavailable, deploy only after confirming the server remote and exact GitHub commit SHA.

- [ ] **Step 6: Deploy with schedules still disabled**

On the server:

```bash
cd /home/ubuntu/lark-report-bot-git
git fetch origin
git switch codex/daily-fact-data-layer
git pull --ff-only origin codex/daily-fact-data-layer
npm ci
npm test
pm2 restart lark-bot-git --update-env
pm2 logs lark-bot-git --lines 120 --nostream
```

Expected:

- tests have zero failures/cancellations
- process is online
- no startup or permission errors

- [ ] **Step 7: Run one server-side dry run**

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run weekly:workflow -- --stage draft --date 2026-07-24 --dry-run
```

Expected: validated output and no external writes.

- [ ] **Step 8: Enable schedules one at a time after separate approval**

Enablement order:

1. `weeklyDraft`
2. `weeklyOwnerReminder`
3. `weeklyRefresh`
4. `weeklyPush`

Observe one successful run before enabling the next schedule. Keep daily supervisor push independent.

- [ ] **Step 9: Delete deprecated Base fields only after read-back verification**

After deployed code no longer reads or writes them:

- delete fact table `敏捷小组`
- delete fact table `分管领导` if present

Do not delete historical facts or source records.

- [ ] **Step 10: Final main-session commit if deployment documentation changed**

```bash
git add docs/superpowers/verification/2026-07-24-field-merge-weekly-workflow.md
git commit -m "docs: record weekly workflow deployment"
```

## Completion Criteria

- Field-level merge preserves unique content from both form and chat.
- Fact sync is idempotent and real-time/scheduled arrival order does not alter the result.
- Contact and fact schemas contain no agile-group or divisional-leader dependency.
- All four weekly configuration tables are loaded from Base.
- Every routed work item has exactly zero or one weekly target.
- AI uses only current-period evidence and final style samples.
- No next-plan or core-metric value is generated.
- Friday write and Saturday refresh protect all manual edits.
- Owner reminders are private, consolidated, idempotent, and contain no coverage or personnel labels.
- Saturday poster reads final Sheet text and sends once.
- `npm test` reports zero failures and zero cancellations.
- All schedules remain separately controllable and default disabled.
