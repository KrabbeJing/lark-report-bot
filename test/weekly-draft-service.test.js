import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshWeeklyDraft,
  writeInitialWeeklyDraft,
} from '../src/weekly-draft-service.js';
import { BitableService } from '../src/bitable-service.js';
import { normalizeConfig } from '../src/config.js';

test('prepares Friday AI drafts for blank cells without writing or marking Sheet cells', async () => {
  const updates = [];
  const result = await writeInitialWeeklyDraft({
    instance: buildInstance(),
    preview: {
      cells: {
        C26: [{ text: 'AI draft', evidenceIds: ['fact-1'], targetId: 'target-1' }],
        C27: [{ text: 'AI must not overwrite', evidenceIds: ['fact-2'] }],
      },
      classifications: [{
        evidenceId: 'fact-1',
        targetId: 'target-1',
        confidence: 'high',
        reason: 'classified',
        evidenceHash: 'hash-1',
        status: 'accepted',
      }],
      pendingOwnerReview: [{
        evidenceId: 'fact-low',
        targetId: 'target-2',
        confidence: 'low',
        reason: 'too broad',
        evidenceHash: 'hash-low',
        status: 'pending_owner_review',
        text: 'daily body must not be persisted',
      }],
    },
    writer: {
      readCells: async () => ({ C26: '', C27: 'manual value' }),
      writeCells: async () => { throw new Error('must_not_write'); },
      markAiCells: async () => { throw new Error('must_not_mark'); },
    },
    bitable: {
      updateWeeklyInstance: async (_instance, patch) => updates.push(patch),
    },
    now: new Date('2026-07-24T08:30:00+08:00'),
  });

  assert.deepEqual(result.writtenCells, {});
  assert.equal(result.preparedCells.C26.text, 'AI draft');
  assert.equal(result.preparedCells.C26.evidenceIds[0], 'fact-1');
  assert.equal(result.preparedCells.C26.targetId, 'target-1');
  assert.match(result.preparedCells.C26.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.completedCells, ['C27']);
  assert.deepEqual(updates[0].aiDraftSnapshot, result.snapshot);
  assert.deepEqual(updates[0].aiEvidenceSnapshot, {
    version: 2,
    cells: { C26: ['fact-1'] },
    classifications: [{
      evidenceId: 'fact-1',
      targetId: 'target-1',
      confidence: 'high',
      reason: 'classified',
      evidenceHash: 'hash-1',
      status: 'accepted',
    }],
    pendingOwnerReview: [{
      evidenceId: 'fact-low',
      targetId: 'target-2',
      confidence: 'low',
      reason: 'too broad',
      evidenceHash: 'hash-low',
      status: 'pending_owner_review',
    }],
  });
  assert.equal(JSON.stringify(updates[0].aiEvidenceSnapshot).includes('daily body'), false);
  assert.equal(updates[0].aiGenerationStatus, '已生成');
  assert.equal(updates[0].aiInitialAt, 1784853000000);
});

test('Sunday refresh replaces only still-blank drafts and drops completed or empty targets', async () => {
  const updates = [];
  const result = await refreshWeeklyDraft({
    instance: {
      ...buildInstance(),
      aiDraftSnapshot: {
        C26: { text: 'Friday AI', hash: 'old', evidenceIds: ['fact-1'], targetId: 'target-1' },
        C27: { text: 'Friday edited later', hash: 'old', evidenceIds: ['fact-2'] },
        C28: { text: 'Friday cleared later', hash: 'old', evidenceIds: ['fact-3'] },
      },
    },
    preview: {
      cells: {
        C26: [{ text: 'Sunday AI', evidenceIds: ['fact-4'], targetId: 'target-1' }],
        C27: [{ text: 'Must stay edited', evidenceIds: ['fact-5'] }],
        C28: [],
      },
    },
    writer: {
      readCells: async () => ({ C26: '', C27: 'Human edit', C28: '' }),
      writeCells: async () => { throw new Error('must_not_write'); },
      markAiCells: async () => { throw new Error('must_not_mark'); },
    },
    bitable: {
      updateWeeklyInstance: async (_instance, patch) => updates.push(patch),
    },
    now: new Date('2026-07-25T09:30:00+08:00'),
  });

  assert.deepEqual(result.writtenCells, {});
  assert.deepEqual(Object.keys(result.preparedCells), ['C26']);
  assert.equal(updates[0].aiGenerationStatus, '已刷新');
  assert.equal(result.snapshot.C26.text, 'Sunday AI');
  assert.equal(result.snapshot.C27, undefined);
  assert.equal(result.snapshot.C28, undefined);
  assert.deepEqual(result.completedCells, ['C27']);
  assert.deepEqual(result.skippedCells, ['C28']);
});

test('keeps every module two summary entry and infers one trusted target id in the snapshot', async () => {
  const result = await writeInitialWeeklyDraft({
    instance: buildInstance(),
    preview: {
      cells: {
        C26: [
          { text: 'First outcome', evidenceIds: ['fact-1'] },
          { text: 'Second outcome', evidenceIds: ['fact-2', 'fact-1'] },
        ],
      },
      classifications: [
        { evidenceId: 'fact-1', targetId: 'target-1', confidence: 'high' },
        { evidenceId: 'fact-2', targetId: 'target-1', confidence: 'medium' },
      ],
    },
    writer: {
      readCells: async () => ({ C26: '' }),
      writeCells: async () => { throw new Error('must_not_write'); },
      markAiCells: async () => { throw new Error('must_not_mark'); },
    },
    now: new Date('2026-07-24T08:30:00+08:00'),
  });

  assert.equal(result.snapshot.C26.text, 'First outcome\nSecond outcome');
  assert.deepEqual(result.snapshot.C26.evidenceIds, ['fact-1', 'fact-2']);
  assert.equal(result.snapshot.C26.targetId, 'target-1');
});

test('persists a draft through the real BitableService instance update overload', async () => {
  let updatePayload;
  const bitable = new BitableService({
    bitable: {
      appTableRecord: {
        update: async payload => {
          updatePayload = payload;
          return { data: { record: { record_id: 'rec_week' } } };
        },
      },
    },
  });

  await writeInitialWeeklyDraft({
    instance: {
      ...buildInstance(),
      group: normalizeConfig({
        groups: [{
          weeklyInstanceTable: { appToken: 'base_token', tableId: 'instance_table' },
        }],
      }).groups[0],
      recordId: 'rec_week',
    },
    preview: { cells: { C26: [{ text: 'AI draft', evidenceIds: ['fact-1'] }] } },
    writer: {
      readCells: async () => ({ C26: '' }),
      writeCells: async () => { throw new Error('must_not_write'); },
      markAiCells: async () => { throw new Error('must_not_mark'); },
    },
    bitable,
    now: new Date('2026-07-24T08:30:00+08:00'),
  });

  assert.equal(updatePayload.path.record_id, 'rec_week');
  assert.equal(updatePayload.data.fields['AI生成状态'], '已生成');
  assert.match(updatePayload.data.fields['AI草稿快照'], /AI draft/);
});

function buildInstance() {
  return {
    sheetConfig: { spreadsheetToken: 'sheet_token' },
    sheetId: 'week_1',
    aiDraftSnapshot: {},
  };
}
