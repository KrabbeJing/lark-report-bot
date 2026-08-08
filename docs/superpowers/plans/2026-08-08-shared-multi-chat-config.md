# Shared Multi-Chat Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans in the main session for this repository. Subagents may edit and test only when explicitly requested; the main session owns every Git operation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple Feishu daily-report chats that share one set of Base tables and one department weekly workflow, without duplicate synchronization, weekly generation, or owner notifications.

**Architecture:** Normalize `sharedResources` into one reporting unit and keep `groups` as lightweight chat metadata. Preserve merged group contexts for real-time message handling, while every scheduled data and weekly workflow iterates `reportingUnits` exactly once. Keep a one-release compatibility path for the existing single-group configuration.

**Tech Stack:** Node.js 20+, JavaScript ESM, `node:test`, Feishu Node SDK, JSON configuration, existing Bitable and weekly workflow services.

## Global Constraints

- Preserve all existing uncommitted user changes in `config/groups*.json`; restructure them without reverting schedule or small-team edits.
- Do not expose or add App Secrets, API keys, OpenIDs, Chat IDs, Base tokens, Wiki tokens, or production exports in tests, logs, docs, or commit messages.
- `sharedResources` is the only owner of shared tables, weekly Sheet, weekly delivery, and weekly configuration tables.
- Enabled chat groups contain only `enabled`, `chatId`, `name`, `project`, and `pushChatId`.
- `chatId` must be unique; `pushChatId` may be shared during testing.
- Group `project` is source metadata only and must not override contact-derived fact organization.
- Form sync, fact reconciliation, supervisor digest, AI preview, weekly instance, staged weekly workflow, and schema validation run once per reporting unit.
- Chat replay runs once per enabled chat group and writes through its merged reporting context.
- New and migrated schedules remain disabled by default.
- Keep old single-group configuration readable for one transition release.
- Use TDD and commit only the files named by each task.

---

## File Structure

**Configuration boundary**

- Modify `src/config.js`: normalize shared resources, chat groups, reporting units, legacy configuration, uniqueness validation, and lookup helpers.
- Modify `test/config.test.js`: define the normalized topology contract and migration behavior.

**Chat ingress**

- Modify `src/chat-daily-replay.js`: iterate chat groups and resolve each merged context.
- Modify `test/chat-daily-replay.test.js`: prove two chats replay independently into one shared resource set.
- Verify `src/message-router.js` through existing `findGroupByChatId`; change only if the new helper contract requires it.
- Modify `test/message-router.test.js` only for a shared-resource regression test.

**Reporting-unit workflows**

- Modify `src/daily-fact-sync.js`, `src/daily-fact-backfill.js`, and `src/index.js`: iterate reporting units for daily workflows.
- Modify `src/weekly-ai-preview.js`, `src/weekly-instance-service.js`, `scripts/run-weekly-workflow.js`, and `scripts/validate-report-table-schema.js`: iterate reporting units for weekly and validation workflows.
- Modify the corresponding focused tests named in each task.

**Configuration artifacts and docs**

- Modify `config/groups.json`, `config/groups.personal.json`, `config/groups.formal.example.json`, and `config/groups.formal.json`: move shared resources out of the first group while preserving current local values and disabled schedules.
- Modify `docs/daily-fact-table-setup.md` and `docs/report-agent-table-catalog.md`: document topology, execution granularity, and migration checks.

---

### Task 1: Normalize Shared Resources And Chat Groups

**Files:**

- Modify: `src/config.js:205-315,452-454`
- Modify: `test/config.test.js`

**Interfaces:**

- Consumes: raw JSON `{ sharedResources?, groups?, ...globalSettings }`.
- Produces: `normalizeConfig(raw): Config` with `chatGroups`, `reportingUnits`, and backward-compatible merged `groups`.
- Produces: `getReportingUnits(config): ReportingUnit[]`.
- Produces: `findGroupByChatId(config, chatId): MergedChatContext | null`.
- `ReportingUnit` contains normalized shared tables plus `{ key, name, project }`.
- `MergedChatContext` contains reporting-unit resources plus chat-specific `{ chatId, name, project, pushChatId, reportingUnitKey }`.

- [ ] **Step 1: Add failing shared-topology tests**

Add tests using placeholder IDs only:

```js
test('normalizes one shared reporting unit and two lightweight chat groups', () => {
  const config = normalizeConfig({
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      dailyTable: { appToken: 'bas_shared', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas_shared', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A', pushChatId: 'oc_test' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B', pushChatId: 'oc_test' },
    ],
  });

  assert.equal(config.chatGroups.length, 2);
  assert.equal(config.reportingUnits.length, 1);
  assert.equal(config.reportingUnits[0].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(config.chatGroups[0].dailyFactTable, undefined);
  assert.equal(config.groups[1].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(config.groups[1].project, '板块B');
  assert.equal(config.groups[1].reportingUnitKey, 'digital-finance');
});
```

Add assertions that disabled groups are omitted, duplicate chat IDs throw `duplicate_chat_id` even if one duplicate is disabled, a group-level shared table throws `group_shared_resource_override`, and the same pushChatId is accepted.

- [ ] **Step 2: Add failing legacy-compatibility tests**

```js
test('keeps one legacy group as one chat and one reporting unit', () => {
  const config = normalizeConfig({
    groups: [{
      chatId: 'oc_legacy',
      name: '旧日报群',
      project: '公司项目组',
      dailyFactTable: { appToken: 'bas_legacy', tableId: 'tbl_fact' },
    }],
  });

  assert.equal(config.chatGroups.length, 1);
  assert.equal(config.reportingUnits.length, 1);
  assert.equal(config.reportingUnits[0].dailyFactTable.tableId, 'tbl_fact');
  assert.equal(findGroupByChatId(config, 'oc_legacy').project, '公司项目组');
});
```

- [ ] **Step 3: Run the config tests and verify RED**

Run:

```bash
node --test test/config.test.js
```

Expected: FAIL because `chatGroups`, `reportingUnits`, `getReportingUnits`, and new validation do not exist.

- [ ] **Step 4: Implement the normalized topology**

Add the shared-resource key list and helper boundaries in `src/config.js`:

```js
const SHARED_RESOURCE_KEYS = [
  'dailyTable',
  'chatDailyRawTable',
  'dailyFactTable',
  'contactTable',
  'weeklyTable',
  'weeklyInstanceTable',
  'weeklySourceMappingTable',
  'weeklySectionRuleTable',
  'weeklyStyleExampleTable',
  'coreMetricOwnerTable',
  'weeklySheet',
  'weeklyDelivery',
];

export function getReportingUnits(config) {
  return Array.isArray(config?.reportingUnits) ? config.reportingUnits : (config?.groups || []);
}
```

In the new shape, normalize shared resources once, normalize chat metadata separately, reject any chat group containing a key from `SHARED_RESOURCE_KEYS`, and build compatibility contexts with shared resources applied before chat metadata. In the legacy shape, normalize existing groups exactly as before, then expose them as both chat contexts and reporting units.

Update `findGroupByChatId` to search merged contexts by `chatId` only. `pushChatId` is an output destination and must not identify an inbound message.

- [ ] **Step 5: Run focused and full config tests**

Run:

```bash
node --test test/config.test.js
npm test
```

Expected: all tests pass with no cancelled tests.

- [ ] **Step 6: Commit the topology contract**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: normalize shared multi-chat topology"
```

---

### Task 2: Route Real-Time And Replayed Messages Through Shared Resources

**Files:**

- Modify: `src/chat-daily-replay.js:1-181`
- Verify only: `src/message-router.js:1-40` already resolves inbound chats through `findGroupByChatId`.
- Modify: `test/chat-daily-replay.test.js`
- Modify: `test/message-router.test.js`

**Interfaces:**

- Consumes: `findGroupByChatId(config, chatId): MergedChatContext | null` from Task 1.
- Consumes: `config.chatGroups: ChatGroup[]` from Task 1.
- Changes: `replayChatDailyReports({ ..., reconcileFacts = true })`; manual single-chat replay keeps reconciliation enabled by default.
- Produces: `replayRecentChatDailyReports(...) -> { chatResults, reportingUnitSyncResults }`.
- Preserves: message handling receives a merged group with shared Base tables and chat-specific source metadata.

- [ ] **Step 1: Add a failing real-time shared-resource regression test**

Build a normalized config with two groups and one shared raw/fact table. Send an event from `oc_b` through `handleMessageEvent` and assert the Bitable mock receives:

```js
assert.equal(receivedGroup.chatId, 'oc_b');
assert.equal(receivedGroup.name, '日报群B');
assert.equal(receivedGroup.project, '板块B');
assert.equal(receivedGroup.chatDailyRawTable.tableId, 'tbl_raw');
assert.equal(receivedGroup.dailyFactTable.tableId, 'tbl_fact');
```

Also assert contact-derived fact organization is not replaced by `group.project`.

- [ ] **Step 2: Add a failing two-chat replay test**

Inject two chat groups sharing `tbl_raw`. Capture message-list container IDs and handled contexts:

```js
assert.deepEqual(listedChatIds, ['oc_a', 'oc_b']);
assert.deepEqual(handledProjects, ['板块A', '板块B']);
assert.ok(handledGroups.every(group => group.chatDailyRawTable.tableId === 'tbl_raw'));
```

Import `replayRecentChatDailyReports`, run it with two chats, and assert both chat reads use `reconcileFacts: false` internally. Then assert the Bitable mock receives exactly one reconciliation call:

```js
assert.deepEqual(listedChatIds, ['oc_a', 'oc_b']);
assert.equal(syncCalls.length, 1);
assert.equal(syncCalls[0].group.key, 'digital-finance');
assert.deepEqual(syncCalls[0].options, {
  startDate: '2026-08-07',
  endDate: '2026-08-08',
  includeHistoricalChat: true,
  repairOrganization: true,
  timezone: 'Asia/Shanghai',
});
assert.equal(result.chatResults.length, 2);
assert.equal(result.reportingUnitSyncResults.length, 1);
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test test/message-router.test.js test/chat-daily-replay.test.js
```

Expected: replay still iterates `config.groups` as resource-owning groups or synchronizes the shared fact table more than once.

- [ ] **Step 4: Update chat replay orchestration**

Add `reconcileFacts = true` to `replayChatDailyReports`. Guard its existing `syncDailyFactRecordsForGroup` call with that flag and return `syncResult: null` when disabled, so the manual replay CLI retains its current default behavior.

In `replayRecentChatDailyReports`, iterate `config.chatGroups || config.groups`. For each chat group, resolve its merged context with `findGroupByChatId`, skip only when that context lacks a configured raw table, and call `replayChatDailyReports` with `reconcileFacts: false`. After all chat reads, iterate `getReportingUnits(config)` and call `syncDailyFactRecordsForGroup` once per unit with the combined recent report range and the existing `includeHistoricalChat`, `repairOrganization`, and timezone options. Return `{ chatResults, reportingUnitSyncResults }`; record a failed unit result instead of suppressing the other chat results.

Do not change parser behavior, raw-history semantics, or message idempotency.

- [ ] **Step 5: Run focused and full tests**

```bash
node --test test/message-router.test.js test/chat-daily-replay.test.js
npm test
```

Expected: all tests pass; two inbound chats retain distinct source metadata while sharing table identities.

- [ ] **Step 6: Commit chat ingress support**

```bash
git add src/chat-daily-replay.js test/chat-daily-replay.test.js test/message-router.test.js
git commit -m "feat: route shared daily report chats"
```

---

### Task 3: Run Daily Workflows Once Per Reporting Unit

**Files:**

- Modify: `src/daily-fact-sync.js:3-79`
- Modify: `src/daily-fact-backfill.js:40-56`
- Modify: `src/index.js:132-157`
- Modify: `test/daily-fact-sync.test.js`
- Modify: `test/daily-fact-backfill.test.js`
- Verify: `test/daily-supervisor-push.test.js`

**Interfaces:**

- Consumes: `getReportingUnits(config): ReportingUnit[]` from Task 1.
- Produces: one sync/backfill/supervisor operation per reporting unit.
- Preserves: existing function names and sanitized result structure for CLI and scheduler callers.

- [ ] **Step 1: Add a failing single-sync test**

```js
function sharedConfigWithTwoChats() {
  return {
    timezone: 'Asia/Shanghai',
    sharedResources: {
      key: 'digital-finance',
      name: '数字金融部',
      dailyTable: { appToken: 'bas_shared', tableId: 'tbl_daily' },
      chatDailyRawTable: { appToken: 'bas_shared', tableId: 'tbl_raw' },
      dailyFactTable: { appToken: 'bas_shared', tableId: 'tbl_fact' },
    },
    groups: [
      { chatId: 'oc_a', name: '日报群A', project: '板块A', pushChatId: 'oc_test' },
      { chatId: 'oc_b', name: '日报群B', project: '板块B', pushChatId: 'oc_test' },
    ],
  };
}

test('syncs one shared reporting unit once for multiple chats', async () => {
  const calls = [];
  const config = normalizeConfig(sharedConfigWithTwoChats());
  await syncDailyFactsForAllGroups({
    config,
    logger: { log() {}, error() {} },
    bitable: {
      syncDailyFactRecordsForGroup: async unit => {
        calls.push(unit.key);
        return { created: 0, updated: 0, errors: [] };
      },
    },
  });
  assert.deepEqual(calls, ['digital-finance']);
});
```

Repeat the helper locally in `test/daily-fact-backfill.test.js`, add the same invariant for `runDailyFactBackfill`, and preserve existing legacy multi-group tests by supplying configs without `reportingUnits`.

- [ ] **Step 2: Lock the reporting-unit selection contract**

In `test/config.test.js`, assert `getReportingUnits(normalizeConfig(sharedConfigWithTwoChats()))` returns one item and that the item has no inbound `chatId`. This test is the dependency used by `src/index.js`; do not add a second scheduler-selection abstraction solely for testing.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test test/config.test.js test/daily-fact-sync.test.js test/daily-fact-backfill.test.js
```

Expected: current loops call the shared tables once per chat.

- [ ] **Step 4: Switch daily workflows to reporting units**

Import and use `getReportingUnits(config)` in sync and backfill. In `src/index.js`, compute `const reportingUnits = getReportingUnits(config)` once after configuration loading and pass that exact collection to `runGroupedWorkflow` for supervisor digests; the daily fact synchronizer resolves reporting units internally.

Use `unit.name || unit.project || unit.key` as operational scope. Do not use a chat ID as the shared workflow scope.

- [ ] **Step 5: Run focused and full tests**

```bash
node --test test/daily-fact-sync.test.js test/daily-fact-backfill.test.js test/daily-supervisor-push.test.js test/scheduled-workflows.test.js
npm test
```

Expected: all tests pass and shared daily operations execute once.

- [ ] **Step 6: Commit daily workflow migration**

```bash
git add src/daily-fact-sync.js src/daily-fact-backfill.js src/index.js test/config.test.js test/daily-fact-sync.test.js test/daily-fact-backfill.test.js
git commit -m "fix: run shared daily workflows once"
```

---

### Task 4: Run Weekly Workflows And Schema Validation Once

**Files:**

- Modify: `src/weekly-ai-preview.js:59-132`
- Modify: `src/weekly-instance-service.js:247-280`
- Modify: `src/index.js:112-130`
- Modify: `scripts/run-weekly-workflow.js:51-62`
- Modify: `scripts/validate-report-table-schema.js:308-326`
- Modify: `test/weekly-ai-preview.test.js`
- Modify: `test/weekly-instance-service.test.js`
- Verify: `test/weekly-workflow.test.js`
- Modify: `test/report-table-schema.test.js`

**Interfaces:**

- Consumes: `getReportingUnits(config): ReportingUnit[]` from Task 1.
- Produces: one department preview, instance, staged workflow result, and schema group per reporting unit.
- Preserves: existing group-level domain service signatures by passing one normalized reporting unit as `group`.

- [ ] **Step 1: Add failing weekly single-run tests**

For AI preview and instance creation, normalize two chat groups sharing one unit and assert:

```js
assert.equal(factListCalls, 1);
assert.equal(instanceCalls, 1);
assert.equal(result.groups.length, 1);
assert.equal(result.groups[0].name, '数字金融部');
```

In both tests, construct the config through `normalizeConfig` with two lightweight chats. The production scheduler and CLI use the already-tested `getReportingUnits(config)` helper directly; do not introduce a second selector abstraction.

- [ ] **Step 2: Add a failing schema-validation test**

Call `validateConfiguredReportTables({ groups: getReportingUnits(config), listFields })` and assert every one of `REPORT_TABLE_KEYS` is listed once, regardless of chat-group count:

```js
assert.equal(result.groups.length, 1);
assert.equal(result.groups[0].name, '数字金融部');
assert.deepEqual(
  result.groups[0].tables.map(table => table.tableKey),
  REPORT_TABLE_KEYS,
);
assert.equal(listFieldsCalls.length, REPORT_TABLE_KEYS.length);
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
node --test test/weekly-ai-preview.test.js test/weekly-instance-service.test.js test/weekly-workflow.test.js test/report-table-schema.test.js
```

Expected: current preview, instance, scheduler, CLI, or validator paths still iterate merged chat groups.

- [ ] **Step 4: Migrate weekly and validation loops**

Use `getReportingUnits(config)` in both source modules. In `src/index.js`, pass the `reportingUnits` constant created in Task 3 to all four weekly stages. In `scripts/run-weekly-workflow.js`, dynamically import both `loadGroupConfig` and `getReportingUnits`, then iterate `getReportingUnits(config)`. In `scripts/validate-report-table-schema.js`, import `getReportingUnits` and pass `getReportingUnits(config)` into `validateConfiguredReportTables` from `main()`.

Keep single-group result compatibility in AI preview: top-level `cells`, `evidence`, and `diagnostics` remain populated when there is one reporting unit.

Do not alter AI routing, prompt behavior, Sheet writes, poster behavior, or schedule times in this task.

- [ ] **Step 5: Run focused and full tests**

```bash
node --test test/weekly-ai-preview.test.js test/weekly-instance-service.test.js test/weekly-workflow.test.js test/report-table-schema.test.js
npm test
```

Expected: all tests pass and every shared weekly operation executes once.

- [ ] **Step 6: Commit weekly workflow migration**

```bash
git add src/weekly-ai-preview.js src/weekly-instance-service.js src/index.js scripts/run-weekly-workflow.js scripts/validate-report-table-schema.js test/weekly-ai-preview.test.js test/weekly-instance-service.test.js test/report-table-schema.test.js
git commit -m "fix: run shared weekly workflows once"
```

---

### Task 5: Migrate Configuration Files And Operator Documentation

**Files:**

- Modify: `config/groups.json`
- Modify: `config/groups.personal.json`
- Modify: `config/groups.formal.example.json`
- Modify: `config/groups.formal.json`
- Modify: `docs/daily-fact-table-setup.md`
- Modify: `docs/report-agent-table-catalog.md`
- Modify: `test/config.test.js`

**Interfaces:**

- Consumes: new JSON contract from Task 1.
- Produces: four valid configs with one `sharedResources` object and one or more lightweight groups.
- Produces: operator guidance for adding a chat without copying table configuration.

- [ ] **Step 1: Capture and protect current config changes**

Run read-only checks before editing:

```bash
git status --short
git diff -- config/groups.json config/groups.personal.json config/groups.formal.example.json config/groups.formal.json
```

Record which current schedule, Wiki-token, and small-team changes must survive the structural move. Do not reset or recreate any config from `HEAD`.

- [ ] **Step 2: Add failing configuration-file assertions**

Update the file-backed config test to require:

```js
const SHARED_RESOURCE_KEYS_FOR_TEST = [
  'dailyTable',
  'chatDailyRawTable',
  'dailyFactTable',
  'contactTable',
  'weeklyTable',
  'weeklyInstanceTable',
  'weeklySourceMappingTable',
  'weeklySectionRuleTable',
  'weeklyStyleExampleTable',
  'coreMetricOwnerTable',
  'weeklySheet',
  'weeklyDelivery',
];

assert.ok(raw.sharedResources);
assert.equal(config.reportingUnits.length, 1);
assert.ok(config.chatGroups.length >= 1);
for (const group of raw.groups) {
  for (const key of SHARED_RESOURCE_KEYS_FOR_TEST) assert.equal(group[key], undefined);
}
```

For the formal example, assert all Chat IDs and resource tokens remain placeholders or empty values. Continue checking that all schedules are disabled.

- [ ] **Step 3: Run config tests and verify RED**

```bash
node --test test/config.test.js
```

Expected: existing files still place resources inside `groups[0]`.

- [ ] **Step 4: Restructure all four JSON files**

Move every shared table, `weeklySheet`, and `weeklyDelivery` from the first group to `sharedResources`. Keep only the five allowed group fields. Preserve current uncommitted schedule times and table identifiers exactly; do not add a second real chat ID unless the user has supplied one.

Keep every global schedule `enabled: false`. Preserve the formal example's placeholder policy.

- [ ] **Step 5: Document operator behavior**

Add an example showing that a new group requires only:

```json
{
  "enabled": true,
  "chatId": "oc_new_daily_chat",
  "name": "新日报群",
  "project": "来源板块名称",
  "pushChatId": "oc_test_or_future_target"
}
```

Document that table validation and scheduled workflows operate once on `sharedResources`, while replay reads each chat separately. State that `project` does not set fact ownership.

- [ ] **Step 6: Run schema, config, and full local verification**

```bash
node --test test/config.test.js test/report-table-schema.test.js
npm test
```

Expected: all local tests pass with zero failures and zero cancellations. Do not run `tables:validate` against the formal example because placeholder resources intentionally cannot pass live Feishu schema validation. After deployment configuration is present, the operator may run `GROUPS_CONFIG_PATH=config/groups.formal.json npm run tables:validate` as a separately approved, read-only environment check.

- [ ] **Step 7: Scan staged changes for credentials and unrelated files**

```bash
git diff --check
git status --short
git diff --cached --name-only
```

Before staging, inspect config diffs for newly introduced secrets or identifiers. Do not stage `AGENTS.md`, QR images, output previews, `.env`, or unrelated user files.

- [ ] **Step 8: Commit configuration and documentation**

```bash
git add config/groups.json config/groups.personal.json config/groups.formal.example.json config/groups.formal.json docs/daily-fact-table-setup.md docs/report-agent-table-catalog.md test/config.test.js
git commit -m "docs: migrate shared multi-chat configuration"
```

If local environment config files contain secrets that must not be committed, stage only the safe example, docs, and tests; report the required manual migration commands separately.

---

## Final Verification Gate

- [ ] `npm test` reports zero failures and zero cancelled tests.
- [ ] Two chat groups resolve to distinct source metadata and the same shared table objects.
- [ ] Replay lists both chat IDs but reconciles the fact table once.
- [ ] Daily sync, backfill, supervisor digest, weekly preview, instance creation, staged workflows, and schema validation each run once per reporting unit.
- [ ] No chat group can override a shared table.
- [ ] Duplicate inbound chat IDs fail before the service starts.
- [ ] Existing single-group configuration remains readable for one transition release.
- [ ] All automatic schedules remain disabled.
- [ ] Git staging contains only files belonging to the completed task.
- [ ] No external Base writes, messages, deployment, push, or schedule enablement occur during local implementation.

## Follow-On Plans

After this plan passes its final gate:

1. Write `semantic-weekly-classification` implementation plan for two-stage classification and summary.
2. Write `weekly-owner-interactive-card` implementation plan for card callbacks, Cell conflict handling, core metrics, and four-stage delivery.
3. Keep small-team posters and monthly reports outside both plans.
