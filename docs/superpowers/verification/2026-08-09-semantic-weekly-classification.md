# Semantic Weekly Classification Verification

## Scope

This runbook verifies the department weekly-report path:

1. source mapping limits allowed module II/III targets;
2. AI classifies within that boundary without keyword admission gates;
3. only high/medium classifications enter target summarization;
4. low-confidence items remain visible for owner review;
5. Friday/Sunday jobs persist snapshots only and never write business Cells.

The local evaluator never reads or writes Feishu. Real label files and evaluation output belong under ignored `out/` and must not be committed.

## Prepare Labels

Manually label about 50 real, non-sensitive work items in `out/weekly-classification-labels.json`. Include explicit topics, abbreviations, no-keyword semantics, routine work orders, communication/coordination work, and module II/III ambiguity. Each item must contain `evidenceId`, `date`, `text`, `allowedTargets`, and one `expectedTargetId` present in `allowedTargets`.

Do not add automatic self-learning or hard keyword admission rules. When labels expose errors, improve `业务范围说明`, positive/negative examples, or the classifier prompt and rerun the same frozen label set.

## Run Quality Gate

External AI approval is required before running:

Configure `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in the local ignored `.env`, then run:

```bash
npm run weekly:classification-eval -- \
  --input out/weekly-classification-labels.json \
  --output out/weekly-classification-evaluation.json
```

The output path must not already exist. A passing result requires:

- accuracy at least 90%;
- zero unauthorized targets;
- zero duplicate/multi-target results;
- every low-confidence result visible in `pendingOwnerReview`.

## Read-Only Preview

After the gate passes, run one approved external-AI preview and inspect module II/III outputs for invented numbers, dates, status, responsibility, or names. Confirm no next-plan content appears and module III contains no more than three items.

Do not enable Friday/Sunday schedules during this verification. Do not send messages, deploy, write a Sheet, or modify a Base beyond the separately approved formal schema validation.

## Local Evidence

- Focused evaluator tests: 5 passed, 0 failed.
- Full local suite: 484 passed, 0 failed, 0 cancelled, 0 skipped.
- External AI quality run: not run; requires user approval and a manually labeled local file.
- Formal Base schema validation: pending final acceptance checkpoint.
