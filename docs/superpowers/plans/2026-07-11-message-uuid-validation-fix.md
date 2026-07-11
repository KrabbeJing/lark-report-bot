# Feishu Message UUID Validation Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix scheduled weekly-report and administrator-error messages that fail Feishu validation because their idempotency UUID exceeds 50 characters.

**Architecture:** Normalize every outbound proactive-message UUID in `LarkMessenger`, preserving short UUIDs and replacing overlong UUIDs with a deterministic namespace plus SHA-256 digest. Improve scheduled error logging so future nested Feishu `field_violations` remain visible in PM2 logs.

**Tech Stack:** Node.js 22, `node:crypto`, Node test runner, Feishu Node SDK, PM2.

## Global Constraints

- Feishu message `uuid` must contain at most 50 characters.
- The same logical message must always produce the same normalized UUID.
- Different logical messages must not share a normalized UUID.
- Do not modify Tencent Cloud or restart PM2 until local tests pass and the user approves deployment.
- Do not expose app secrets, access tokens, full report text, or table tokens in logs.

---

### Task 1: Centralize Message UUID Normalization

**Files:**
- Modify: `src/lark-messenger.js`
- Create: `test/lark-messenger.test.js`

**Interfaces:**
- Consumes: existing `LarkMessenger.sendText`, `sendTextToOpenId`, and `sendImage` UUID arguments.
- Produces: `normalizeMessageUuid(value: string): string | undefined` and proactive-message payloads whose UUID length is at most 50.

- [ ] **Step 1: Write failing normalization tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { LarkMessenger, normalizeMessageUuid } from '../src/lark-messenger.js';

test('keeps valid short message uuid unchanged', () => {
  assert.equal(normalizeMessageUuid('weekly-2026-W28'), 'weekly-2026-W28');
});

test('normalizes overlong message uuid deterministically below Feishu limit', () => {
  const input = `weekly-${'oc_'.padEnd(35, 'a')}-2026-07-06`;
  const first = normalizeMessageUuid(input);
  const second = normalizeMessageUuid(input);
  assert.equal(first, second);
  assert.ok(first.length <= 50);
  assert.notEqual(first, normalizeMessageUuid(`${input}-other`));
});

test('sendImage applies uuid normalization before calling Feishu', async () => {
  let payload;
  const client = {
    im: {
      message: {
        create: async input => { payload = input; },
      },
    },
  };
  const messenger = new LarkMessenger(client);
  const input = `weekly-${'oc_'.padEnd(35, 'a')}-2026-07-06`;
  await messenger.sendImage('oc_test', 'img_test', input);
  assert.ok(payload.data.uuid.length <= 50);
  assert.equal(payload.data.uuid, normalizeMessageUuid(input));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/lark-messenger.test.js`

Expected: FAIL because `normalizeMessageUuid` is not exported.

- [ ] **Step 3: Implement UUID normalization at the message boundary**

Add to `src/lark-messenger.js`:

```js
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function normalizeMessageUuid(value) {
  const uuid = String(value || '').trim();
  if (!uuid) return undefined;
  if (uuid.length <= 50) return uuid;
  const digest = createHash('sha256').update(uuid).digest('hex').slice(0, 32);
  return `msg-${digest}`;
}

function withMessageUuid(data, uuid) {
  const normalized = normalizeMessageUuid(uuid);
  return normalized ? { ...data, uuid: normalized } : data;
}
```

Wrap the `data` object in `sendText`, `sendTextToOpenId`, and `sendImage` with `withMessageUuid(...)`. Do not add UUIDs to reply APIs because replies do not currently accept a UUID argument in this service.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test test/lark-messenger.test.js`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: all existing tests plus the 3 new tests pass.

- [ ] **Step 6: Commit the UUID fix**

```bash
git add src/lark-messenger.js test/lark-messenger.test.js
git commit -m "fix: normalize Feishu message UUIDs"
```

### Task 2: Preserve Nested Feishu Validation Details

**Files:**
- Modify: `src/error-reporter.js`
- Modify: `src/index.js`
- Modify: `test/error-reporter.test.js`

**Interfaces:**
- Consumes: SDK errors containing `response.data.error.field_violations` or top-level `response.data.error`.
- Produces: `formatLarkErrorForLog(err): string` with masked, pretty-printed diagnostic data.

- [ ] **Step 1: Write a failing nested-error formatting test**

```js
import { formatLarkErrorForLog } from '../src/error-reporter.js';

test('formats nested Feishu field violations for PM2 logs', () => {
  const output = formatLarkErrorForLog({
    response: {
      data: {
        code: 99992402,
        msg: 'field validation failed',
        error: {
          log_id: 'log_test',
          field_violations: [{ field: 'uuid', description: 'max length is 50' }],
        },
      },
    },
  });
  assert.match(output, /uuid/);
  assert.match(output, /max length is 50/);
  assert.match(output, /log_test/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/error-reporter.test.js`

Expected: FAIL because `formatLarkErrorForLog` does not exist.

- [ ] **Step 3: Implement safe structured formatting**

Add to `src/error-reporter.js`:

```js
export function formatLarkErrorForLog(err) {
  const data = err?.response?.data;
  if (data) return JSON.stringify(data, null, 2);
  return JSON.stringify({
    code: err?.code || '',
    message: err?.message || String(err || ''),
  }, null, 2);
}
```

Update the weekly, daily-supervisor, and daily-fact catch blocks in `src/index.js` to log `formatLarkErrorForLog(err)` instead of passing nested response objects directly to `console.error`.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/error-reporter.test.js`

Expected: all error reporter tests pass.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit diagnostic logging**

```bash
git add src/error-reporter.js src/index.js test/error-reporter.test.js
git commit -m "chore: preserve Feishu validation details"
```

### Task 3: Personal-Organization Integration Verification

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: personal-organization config and the existing Saturday scheduled send path.
- Produces: one successfully delivered test weekly image and PM2 logs with no UUID field violation.

- [ ] **Step 1: Confirm branch and test evidence before deployment**

Run: `git status --short --branch`

Expected: `codex/daily-fact-data-layer` and no uncommitted source changes.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Push the tested commits to both remotes**

```bash
git push origin codex/daily-fact-data-layer
git push gitee codex/daily-fact-data-layer
```

- [ ] **Step 3: Update Tencent Cloud from Gitee after explicit deployment approval**

```bash
ssh -i lark_bot_key.pem ubuntu@49.232.202.36 git -C /home/ubuntu/lark-report-bot-git pull --ff-only origin codex/daily-fact-data-layer
ssh -i lark_bot_key.pem ubuntu@49.232.202.36 "bash -lc 'pm2 restart lark-bot-git --update-env'"
```

- [ ] **Step 4: Verify process health**

Run: `ssh -i lark_bot_key.pem ubuntu@49.232.202.36 "bash -lc 'pm2 describe lark-bot-git'"`

Expected: status `online`, restart count increased once, and the current commit matches Gitee.

- [ ] **Step 5: Trigger one personal-group scheduled-send verification**

Temporarily set the personal test schedule to the next available minute, restart only after explicit approval, and observe one run. Restore the configured schedule immediately after the message arrives.

Expected PM2 evidence:

```text
[scheduler] weekly push triggered
```

Expected user-visible evidence: one new weekly image appears in the configured personal test group. Expected error evidence: no `field validation failed` and no UUID violation.

---

## Completion Gate

- `npm test` passes.
- Every proactive-message UUID is at most 50 characters.
- PM2 logs show nested validation details as JSON.
- One actual scheduled image send succeeds in the personal test group.
- Production schedule is restored after the integration test.

