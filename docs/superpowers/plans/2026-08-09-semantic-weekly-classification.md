# Semantic Weekly Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans in the main session for this repository. Subagents may edit and test only when explicitly requested; the main session owns every Git operation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace department-weekly keyword admission with source-mapping-bounded AI semantic classification, preserve strict fact validation, expose low-confidence items for later owner cards, and prevent scheduled AI drafts from writing business Cells automatically.

**Architecture:** Keep existing daily-fact selection and member-mapping identity logic, but split weekly processing into three explicit boundaries: deterministic candidate construction, target-scoped AI classification, and existing target-scoped AI summarization. Keywords and examples become prompt hints only. The classifier may select exactly one target from each item's allowed targets; deterministic validation rejects every unauthorized or malformed result without fallback. Draft/refresh persists read-only snapshots and never writes a Sheet Cell.

**Tech Stack:** Node.js 20+, JavaScript ESM, `node:test`, OpenAI-compatible/Zhipu chat completions, Feishu Base and Sheets adapters, JSON configuration.

## Global Constraints

- The daily fact table remains the only current-week fact source.
- Only facts with `事实记录状态=有效` and dates inside the requested closed interval are eligible.
- Source mappings are the only hard classification boundary. Include/exclude topics, business scope, and examples are soft AI hints.
- AI input must not contain reporter names, OpenIDs, supervisors, contact record IDs, or mapping record IDs.
- One work item keeps one `evidenceId`; the model cannot split, merge, or rewrite it.
- `targetId` is `周报板块规则表.规则唯一键`, never a Cell coordinate.
- High/medium confidence enters summarization. Low confidence is visible in `pendingOwnerReview` and never enters summary evidence.
- Missing/duplicate mappings, missing/duplicate rules, invalid JSON, missing results, duplicate results, or unauthorized targets fail closed per item.
- Do not restore keyword routing, template summary, cross-target evidence, or another model as fallback.
- Module II uses one current multi-line Cell. Module III uses one to three current Cells. No next-plan Cell is generated.
- AI draft and refresh may read Sheet Cells but must not call `writeCells` or `markAiCells`.
- Small-team classification/posters are outside this plan. Keep their existing legacy route isolated until their own redesign.
- New schedules remain disabled. Do not call external AI, write Feishu, send messages, deploy, or push without explicit approval.
- Preserve untracked `AGENTS.md` and QR images; never stage them.

---

## Task 1: Extend Weekly Rule Semantics And Schema

**Files:**

- Modify: `src/config.js`
- Modify: `src/weekly-config-repository.js`
- Modify: `scripts/validate-report-table-schema.js`
- Modify: `config/groups.formal.json`
- Modify: `docs/report-agent-table-catalog.md`
- Modify: `test/config.test.js`
- Modify: `test/weekly-config-repository.test.js`
- Modify: `test/report-table-schema.test.js`

**Contract:** Every enabled rule normalizes to a stable target descriptor:

```js
{
  targetId: '模块三-对公客群经营及场景建设-本周工作进展',
  module: '模块三',
  target: '对公客群经营及场景建设',
  contentType: '本周工作进展',
  businessScope: '云缴费、云充值、网联前置、银联前置、银企直联、客诉、生态场景建设',
  includeTopics: ['云缴费', '银企直联'],
  excludeTopics: ['收单项目阶段成果'],
  positiveExamples: ['完成银企直联证书更新并通过验证'],
  negativeExamples: ['收单商户进件属于收单项目组'],
}
```

- [x] **Step 1: Add failing normalization and schema tests**

Extend the rule fixture in `test/weekly-config-repository.test.js` and assert:

```js
assert.deepEqual(normalizeWeeklySectionRule(record, table), {
  recordId: 'rec_rule',
  targetId: '模块三-对公客群经营及场景建设-本周工作进展',
  module: '模块三',
  target: '对公客群经营及场景建设',
  contentType: '本周工作进展',
  businessScope: '负责云缴费、云充值和银企直联等对公客群经营事项',
  includeTopics: ['云缴费', '银企直联'],
  excludeTopics: ['收单项目阶段成果'],
  positiveExamples: ['完成银企直联证书更新并通过验证'],
  negativeExamples: ['收单商户进件属于收单项目组'],
  owners: [{ openId: 'ou_owner', name: '负责人' }],
  remindOwners: true,
  order: 10,
  enabled: true,
});
```

In schema tests, require `业务范围说明`, `分类正例`, and `分类反例` as `longText`. Keep `包含主题` required for useful hints, but do not describe it as a routing condition.

- [x] **Step 2: Run focused tests and verify RED**

```bash
node --test test/config.test.js test/weekly-config-repository.test.js test/report-table-schema.test.js
```

Expected: failures for missing field keys and normalized properties.

- [x] **Step 3: Add field keys and normalized values**

Extend `WEEKLY_SECTION_RULE_FIELD_KEYS`:

```js
export const WEEKLY_SECTION_RULE_FIELD_KEYS = {
  ruleKey: '规则唯一键',
  module: '模块',
  target: '周报板块',
  contentType: '内容类型',
  businessScope: '业务范围说明',
  includeTopics: '包含主题',
  excludeTopics: '排除主题',
  positiveExamples: '分类正例',
  negativeExamples: '分类反例',
  owners: '周报负责人',
  remindOwners: '负责人提醒',
  order: '排序',
  enabled: '是否启用',
  note: '备注',
};
```

Update `normalizeWeeklySectionRule` so `targetId` comes only from `ruleKey`, long-text example fields are split with the existing `texts()` helper, and empty values remain empty rather than being inferred.

- [x] **Step 4: Update formal mapping and table catalog**

Add the three exact field mappings to `config/groups.formal.json`. Update Table 6 in the catalog:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| 业务范围说明 | 多行文本 | 是 | 描述业务边界，不作为硬关键词 |
| 分类正例 | 多行文本 | 否 | 一行一个已确认正例 |
| 分类反例 | 多行文本 | 否 | 一行一个易误分反例 |

Change `包含主题` wording to “高置信度语义提示”. Do not add another Base table.

- [x] **Step 5: Run focused and full tests**

```bash
node --test test/config.test.js test/weekly-config-repository.test.js test/report-table-schema.test.js
npm test
```

Expected: all tests pass with no cancelled tests.

- [x] **Step 6: Commit the semantic rule schema**

```bash
git add src/config.js src/weekly-config-repository.js scripts/validate-report-table-schema.js config/groups.formal.json docs/report-agent-table-catalog.md test/config.test.js test/weekly-config-repository.test.js test/report-table-schema.test.js
git commit -m "feat: add semantic weekly rule fields"
```

**Manual Feishu work after this task:** Add the three fields to the formal `周报板块规则表`, then populate `业务范围说明`. Positive and negative examples may be expanded gradually.

---

## Task 2: Build Allowed Classification Candidates Without Keyword Filtering

**Files:**

- Modify: `src/weekly-source-router.js`
- Modify: `test/weekly-source-router.test.js`

**Interfaces:**

```js
export function buildWeeklyClassificationCandidates({
  facts, mappings, rules, cellMap, period,
}) {
  return { candidates, diagnostics };
}
```

Each candidate has internal source data and a model-safe target list:

```js
{
  evidenceId: 'rec_fact_1:current:workItems:0',
  factRecordId: 'rec_fact_1',
  date: '2026-07-28',
  text: '完成银企直联证书更新并通过验证',
  allowedTargets: [{
    targetId: '模块三-对公客群经营及场景建设-本周工作进展',
    module: 'module3',
    target: '对公客群经营及场景建设',
    contentType: '本周工作进展',
    cells: ['C45', 'C46', 'C47'],
    businessScope: '...',
    includeTopics: ['银企直联'],
    excludeTopics: [],
    positiveExamples: ['...'],
    negativeExamples: ['...'],
  }],
}
```

- [x] **Step 1: Add failing candidate-construction tests**

Cover these behaviors:

1. A mapped item receives every enabled module II/module III target allowed by its source mapping even when no keyword appears.
2. Include/exclude topics remain target metadata and never remove a target.
3. No mapping returns `unmapped_member` and no candidate.
4. A duplicate active mapping blocks all items for that canonical member across the period.
5. A mapped target absent from rules returns `missing_target_rule`.
6. Duplicate enabled `targetId` or duplicate module/target/content rules return `duplicate_target_rule`.
7. A rule absent from the discovered Cell map returns `target_not_in_cell_map`.
8. Reporter identity never appears in `allowedTargets`.
9. Routine meeting, communication, discussion, and coordination items are retained.

Representative assertion:

```js
const result = buildWeeklyClassificationCandidates({
  facts: [fact({ workItems: ['协调查明银联代付短款原因'] })],
  mappings: [mapping({ module2Targets: ['收单项目组'], module3Target: '对公客群经营及场景建设' })],
  rules: semanticRules(),
  cellMap,
  period,
});

assert.deepEqual(
  result.candidates[0].allowedTargets.map(item => item.targetId),
  [
    '模块二-收单项目组-本周重点事项说明',
    '模块三-对公客群经营及场景建设-本周工作进展',
  ],
);
assert.ok(!result.diagnostics.some(item => item.code === 'no_topic_match'));
```

- [x] **Step 2: Run router tests and verify RED**

```bash
node --test test/weekly-source-router.test.js
```

Expected: `buildWeeklyClassificationCandidates` is not exported.

- [x] **Step 3: Extract candidate construction around existing identity logic**

Reuse `isEligibleFact`, `buildMappingIdentityComponents`, `activeComponentViews`, `findMemberMappings`, `toSource`, and duplicate-period blocking. Add deterministic rule indexes keyed by both `targetId` and `${module}:${target}:${contentType}`.

Do not call `matchesTopics` from the new path. Preserve `routeWeeklyFacts` temporarily for small-team code only; add a comment naming it as legacy small-team routing so department preview cannot accidentally import it.

Build allowed targets by source mapping:

```js
const allowed = [
  ...mapping.module2Targets.map(target => ({ module: 'module2', target })),
  ...(mapping.module3Target ? [{ module: 'module3', target: mapping.module3Target }] : []),
];
```

Resolve exactly one enabled rule and exactly one current Cell specification for each allowed pair. Sort candidates by date/evidenceId and targets by rule order/targetId for reproducible prompts.

- [x] **Step 4: Run focused and full tests**

```bash
node --test test/weekly-source-router.test.js
npm test
```

Expected: old small-team routing tests and new candidate tests both pass.

- [x] **Step 5: Commit candidate construction**

```bash
git add src/weekly-source-router.js test/weekly-source-router.test.js
git commit -m "feat: build bounded weekly classification candidates"
```

---

## Task 3: Add Strict Batched AI Semantic Classification

**Files:**

- Create: `src/weekly-semantic-classifier.js`
- Create: `test/weekly-semantic-classifier.test.js`
- Modify: `src/ai-providers.js`
- Modify: `test/ai-providers.test.js`

**Provider interface:**

```js
await aiProvider.classifyWeeklyEvidence({ items: modelItems });
// => { classifications: [{ evidenceId, targetId, confidence, reason }], provider, model }
```

**Classifier interface:**

```js
await classifyWeeklyCandidates({
  candidates,
  aiProvider,
  maxItems: 20,
  maxCharacters: 12000,
  maxAttempts: 2,
});
// => { accepted, pendingOwnerReview, diagnostics, provider, model }
```

- [x] **Step 1: Add failing provider prompt tests**

Capture the request body and prove:

- JSON mode is enabled and temperature is `0.1`.
- Input contains evidence/date/text and allowed target semantics.
- Input does not contain reporter name, OpenID, owner, mapping IDs, Cell coordinates, or targets belonging only to another item.
- Prompt explicitly says topics/examples are hints, exactly one allowed target is required, and confidence must be high/medium/low.
- Invalid JSON and HTTP/timeout failures produce fixed safe errors with no response body or key leakage.

The model payload must be built explicitly rather than serializing the internal candidate:

```js
function toModelItem(candidate) {
  return {
    evidenceId: candidate.evidenceId,
    date: candidate.date,
    text: candidate.text,
    allowedTargets: candidate.allowedTargets.map(target => ({
      targetId: target.targetId,
      module: target.module,
      target: target.target,
      contentType: target.contentType,
      businessScope: target.businessScope,
      includeTopics: target.includeTopics,
      excludeTopics: target.excludeTopics,
      positiveExamples: target.positiveExamples,
      negativeExamples: target.negativeExamples,
    })),
  };
}
```

- [x] **Step 2: Add failing classifier validation tests**

Test deterministic batches with `maxItems=2`, then cover:

- high/medium results enter `accepted`;
- low results enter `pendingOwnerReview` only;
- unauthorized target, unknown evidence, missing result, duplicate result, invalid confidence, and missing reason fail only the affected item;
- one item cannot appear in both outputs;
- the provider cannot add/split/merge evidence IDs;
- a provider error retries once, then records `classification_provider_error` for that batch;
- invalid semantic output does not invoke a keyword or template fallback;
- an item whose serialized model input exceeds `maxCharacters` returns `classification_input_too_large` without a model call;
- results and diagnostics are deterministic regardless of provider return order.

- [x] **Step 3: Run focused tests and verify RED**

```bash
node --test test/ai-providers.test.js test/weekly-semantic-classifier.test.js
```

Expected: missing provider method and classifier module.

- [x] **Step 4: Implement the strict provider method**

Add optional `temperature` to `requestChatCompletion`; preserve `0.2` for current summary calls and use `0.1` only for classification. Parse only a strict top-level object with a `classifications` array. Return structural data to the classifier; do not validate target authorization in the provider.

Use a classification system message equivalent to:

```text
你是企业周报事项分类器。来源映射给出的 allowedTargets 是唯一边界。
你必须逐条选择且只能选择一个 allowed target。主题词和正反例只是语义提示。
不得拆分、合并、改写事项，不得输出人员信息，只输出严格 JSON。
```

- [x] **Step 5: Implement batching, retry, and authorization validation**

In `weekly-semantic-classifier.js`:

1. Convert each candidate with `toModelItem`.
2. Build batches capped by both item count and serialized character count; never split one item.
3. Retry safe provider failures once (`maxAttempts=2` total), without delay in unit tests.
4. Group returned rows by evidenceId before validation so duplicates invalidate that evidence.
5. Require exactly one row per input and target membership in that candidate's allowed target IDs.
6. Join validated metadata back to the original internal candidate; never trust model-supplied target descriptions.
7. Return low items separately with their original redacted display text for later cards.

Do not retry deterministic JSON/authorization failures because the same response is already complete and retrying can hide quality problems.

- [x] **Step 6: Run focused and full tests**

```bash
node --test test/ai-providers.test.js test/weekly-semantic-classifier.test.js
npm test
```

Expected: all tests pass; mock fetch/provider only, no network calls.

- [x] **Step 7: Commit semantic classification**

```bash
git add src/ai-providers.js src/weekly-semantic-classifier.js test/ai-providers.test.js test/weekly-semantic-classifier.test.js
git commit -m "feat: classify weekly evidence semantically"
```

---

## Task 4: Integrate Classification Before Target Summarization

**Files:**

- Modify: `src/weekly-ai-preview.js`
- Modify: `test/weekly-ai-preview.test.js`
- Modify: `src/weekly-workflow.js`
- Modify: `src/weekly-workflow-services.js`
- Modify: `test/weekly-workflow-services.test.js` if present; otherwise add the regression to `test/weekly-workflow.test.js`

**Output additions:**

```js
{
  classifications: [{
    evidenceId,
    targetId,
    module,
    target,
    confidence,
    reason,
    evidenceHash,
    status: 'accepted',
  }],
  pendingOwnerReview: [{
    evidenceId,
    targetId,
    module,
    target,
    confidence: 'low',
    reason,
    date,
    text,
  }],
}
```

- [x] **Step 1: Replace preview fixtures with a two-stage provider**

Update the main preview test provider:

```js
const aiProvider = {
  name: 'fake',
  model: 'fake-model',
  classifyWeeklyEvidence: async ({ items }) => ({
    classifications: items.map(item => ({
      evidenceId: item.evidenceId,
      targetId: item.allowedTargets[0].targetId,
      confidence: 'high',
      reason: 'test classification',
    })),
  }),
  generateWeeklySheetPreview: async input => summaryFor(input),
};
```

Assert classification calls happen before summary calls and summary evidence contains only accepted high/medium items.

- [x] **Step 2: Add failing integration cases**

Cover:

1. A no-keyword item is classified and summarized inside its mapping boundary.
2. A low-confidence item is visible in `pendingOwnerReview`, absent from summary input, and leaves Cells blank if it is the only item.
3. An unauthorized classification leaves only that item blank while another target still summarizes.
4. Classification errors and target-summary errors remain isolated.
5. The same item never enters two target buckets.
6. `classifications` omits full daily text; `pendingOwnerReview` retains only the one display item needed for manual judgment.
7. `no_topic_match` never appears in department preview diagnostics.
8. Existing name redaction, 3–5 final style examples, protected numbers/dates/status, no next plan, module II shape, and module III three-item limit still pass.

- [x] **Step 3: Run focused tests and verify RED**

```bash
node --test test/weekly-ai-preview.test.js test/weekly-workflow.test.js
```

Expected: preview still calls `routeWeeklyFacts` and has no classifications.

- [x] **Step 4: Build target buckets only from accepted classifications**

In `runWeeklyAiPreview`:

```js
const candidateResult = buildWeeklyClassificationCandidates({
  facts,
  mappings: weeklyConfiguration.mappings,
  rules: weeklyConfiguration.rules,
  cellMap,
  period,
});
const knownNames = collectKnownNames(facts, candidateResult);
const classified = await classifyWeeklyCandidates({
  candidates: candidateResult.candidates.map(candidate => ({
    ...candidate,
    text: redactKnownNames(candidate.text, knownNames),
  })),
  aiProvider,
});
const routing = buildClassifiedWeeklyRouting(classified.accepted);
```

`buildClassifiedWeeklyRouting` must derive module, target, Cells, and evidence from trusted candidate/target objects, never model text. Continue to run the existing `buildTargetContext` and `validateTargetResult` summary checks.

This redaction must happen before classification, not only before summarization. Drop candidates whose text becomes empty after redaction with `empty_evidence_after_redaction`. Calculate `evidenceHash` with SHA-256 over the exact normalized date/redacted-text classifier input. Keep classifications deterministic by sorting by evidenceId.

- [x] **Step 5: Remove department workflow dependence on legacy routing**

The `ai.generate` service already reloads facts/configuration inside `runWeeklyAiPreview`; keep that single authoritative path. In `src/weekly-workflow.js`, remove `routeFacts(...)` from `runDraft` and `runRefresh`. Generate the preview directly and, only for backward-compatible return shape, expose `routing: preview.routing || { buckets: [], diagnostics: [] }`. Update workflow tests so the expected order no longer includes `route`.

Remove the department-level `sourceRouter` service from `createWeeklyWorkflowServices`. Keep the private legacy `routeWeeklyFacts` call only inside `smallTeam.generate` until the small-team redesign.

Do not pass the legacy routing result into department preview as a fallback.

- [x] **Step 6: Run focused and full tests**

```bash
node --test test/weekly-source-router.test.js test/weekly-semantic-classifier.test.js test/weekly-ai-preview.test.js test/weekly-workflow.test.js
npm test
```

Expected: all department preview tests use semantic classification; small-team legacy tests remain unchanged.

- [ ] **Step 7: Commit two-stage preview integration**

```bash
git add src/weekly-ai-preview.js src/weekly-workflow.js src/weekly-workflow-services.js test/weekly-ai-preview.test.js test/weekly-workflow.test.js
git commit -m "feat: summarize semantically classified weekly evidence"
```

---

## Task 5: Make AI Draft And Refresh Snapshot-Only

**Files:**

- Modify: `src/weekly-draft-service.js`
- Modify: `test/weekly-draft-service.test.js`
- Modify: `test/weekly-workflow.test.js`
- Modify: `docs/report-agent-table-catalog.md`

**Behavior:** Friday draft and Sunday refresh may read current Cells to avoid preparing drafts for completed targets. They persist AI draft/evidence/classification metadata, but never write or annotate a business Cell. Only the later owner-card callback may write after explicit approval.

- [ ] **Step 1: Replace write assertions with failing no-write tests**

Use spies that throw if called:

```js
const writer = {
  readCells: async () => ({ C26: '', C27: '负责人已填写' }),
  writeCells: async () => { throw new Error('must_not_write'); },
  markAiCells: async () => { throw new Error('must_not_mark'); },
};
```

Assert:

- blank `C26` draft is saved in `aiDraftSnapshot` but not written;
- nonblank `C27` is listed as completed/locked and excluded from the new snapshot;
- refresh replaces the saved draft for a still-empty Cell;
- refresh drops or marks completed any target whose Sheet Cell is now nonblank;
- low-confidence classifications are preserved as metadata for owner cards without full duplicate daily bodies;
- workflow `draft`/`refresh` performs zero `writeCells` calls.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
node --test test/weekly-draft-service.test.js test/weekly-workflow.test.js
```

Expected: current service writes and marks AI Cells.

- [ ] **Step 3: Refactor the service to persist snapshots only**

Keep `writeInitialWeeklyDraft` and `refreshWeeklyDraft` names for callers, but remove both Sheet write calls. Read current Cell values, normalize preview entries, and build:

```js
const snapshotEntry = {
  text: entry.text,
  hash: hashText(entry.text),
  generatedAt: now.getTime(),
  evidenceIds: entry.evidenceIds,
  targetId: entry.targetId || '',
};
```

Persist `aiDraftSnapshot`, generation status/time, and a versioned `aiEvidenceSnapshot` that does not duplicate daily text:

```js
{
  version: 2,
  cells: { C26: ['rec_fact_1:current:workItems:0'] },
  classifications: [{
    evidenceId: 'rec_fact_1:current:workItems:0',
    targetId: '模块二-收单项目组-本周重点事项说明',
    confidence: 'high',
    reason: '事项明确涉及收单项目',
    evidenceHash: 'sha256...',
    status: 'accepted',
  }],
  pendingOwnerReview: [{
    evidenceId: 'rec_fact_2:current:workItems:0',
    targetId: '模块三-对公客群经营及场景建设-本周工作进展',
    confidence: 'low',
    reason: '事项描述过于宽泛',
    evidenceHash: 'sha256...',
    status: 'pending_owner_review',
  }],
}
```

The future owner-card service will reload display text from the fact table by `evidenceId`; do not persist that text again. Update the Table 9 catalog description to document version 2. Return `{ preparedCells, completedCells, skippedCells, snapshot }`; keep a temporary `writtenCells: {}` compatibility property only if an existing caller requires it.

Do not write the `AI总结生成，仅供参考` note to the Sheet. That label belongs in the future owner card.

- [ ] **Step 4: Run focused and full tests**

```bash
node --test test/weekly-draft-service.test.js test/weekly-owner-notifier.test.js test/weekly-workflow.test.js
npm test
```

Expected: all tests pass and no automated draft path writes a Sheet Cell.

- [ ] **Step 5: Commit the safety boundary**

```bash
git add src/weekly-draft-service.js test/weekly-draft-service.test.js test/weekly-workflow.test.js docs/report-agent-table-catalog.md
git commit -m "fix: keep weekly AI drafts snapshot only"
```

---

## Task 6: Add A Repeatable Classification Quality Gate

**Files:**

- Create: `src/weekly-classification-evaluation.js`
- Create: `scripts/evaluate-weekly-classification.js`
- Create: `test/weekly-classification-evaluation.test.js`
- Modify: `package.json`
- Create: `docs/superpowers/verification/2026-08-09-semantic-weekly-classification.md`

**Local label-file schema:** Store real-report label files under ignored `out/`, never Git:

```json
{
  "items": [{
    "evidenceId": "case-001",
    "date": "2026-07-28",
    "text": "完成银企直联证书更新并通过验证",
    "allowedTargets": [{
      "targetId": "模块三-对公客群经营及场景建设-本周工作进展",
      "module": "module3",
      "target": "对公客群经营及场景建设",
      "contentType": "本周工作进展",
      "businessScope": "...",
      "includeTopics": ["银企直联"],
      "excludeTopics": [],
      "positiveExamples": [],
      "negativeExamples": []
    }],
    "expectedTargetId": "模块三-对公客群经营及场景建设-本周工作进展"
  }]
}
```

- [ ] **Step 1: Add failing evaluator tests**

Test pure metric calculation with synthetic/non-sensitive cases:

- total, classified, correct, low-confidence, failed, and unauthorized counts;
- accuracy is `correct / (high + medium + low valid classifications)`;
- gate passes only when accuracy is at least 90%, unauthorized is zero, duplicate/multi-target is zero, and every low item is returned visibly;
- secrets and full provider errors are absent from the report.

- [ ] **Step 2: Run the evaluator test and verify RED**

```bash
node --test test/weekly-classification-evaluation.test.js
```

Expected: evaluation module is missing.

- [ ] **Step 3: Implement evaluation and CLI**

Add:

```json
"weekly:classification-eval": "node scripts/evaluate-weekly-classification.js"
```

CLI usage:

```bash
GROUPS_CONFIG_PATH=config/groups.formal.json \
npm run weekly:classification-eval -- \
  --input out/weekly-classification-labels.json \
  --output out/weekly-classification-evaluation.json
```

Require explicit input/output paths under the current working directory, reject existing/symlink outputs using the same safe-output policy as `weekly:ai-preview`, call only `classifyWeeklyCandidates`, and never write Feishu.

- [ ] **Step 4: Write the verification runbook**

Document:

1. Manually label about 50 real work items across explicit topics, abbreviations, no-keyword semantics, routine work orders, communication work, and module II/III ambiguity.
2. Keep the label JSON local under `out/`.
3. Run evaluation with approved external-AI access.
4. Require zero unauthorized targets, zero multi-target results, all low items visible, and at least 90% accuracy.
5. Improve rule scope/examples/prompt when below target; do not add online self-learning or keyword hard gates.
6. Run a read-only weekly preview and manually verify no invented numbers, dates, status, responsibility, or names.

- [ ] **Step 5: Run all local verification**

```bash
node --test test/weekly-classification-evaluation.test.js
npm test
git diff --check
git status --short
```

Expected: tests pass, tracked diff is limited to this task, and `AGENTS.md`/QR images remain untracked.

- [ ] **Step 6: Commit the quality gate**

```bash
git add src/weekly-classification-evaluation.js scripts/evaluate-weekly-classification.js test/weekly-classification-evaluation.test.js package.json docs/superpowers/verification/2026-08-09-semantic-weekly-classification.md
git commit -m "test: add weekly classification quality gate"
```

---

## Final Acceptance Checkpoint

- [ ] Run the complete local suite:

```bash
npm test
git diff --check
git status --short
```

- [ ] Validate the formal Base schema after the three new fields are created:

```bash
GROUPS_CONFIG_PATH=config/groups.formal.json npm run tables:validate
```

- [ ] With explicit approval for external AI, run the 50-item local quality file and a read-only preview.
- [ ] Confirm no Base/Sheet write, message send, deployment, or schedule enablement occurred.
- [ ] Record exact test counts and quality metrics in the verification document.
- [ ] Do not enable Friday/Sunday schedules yet. The next implementation plan is the owner interactive-card submission, authorization, conflict, and overwrite flow.
