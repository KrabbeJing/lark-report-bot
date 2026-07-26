import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshWeeklyDraft,
  writeInitialWeeklyDraft,
} from '../src/weekly-draft-service.js';

test('writes Friday AI drafts only into blank cells and persists exact ownership snapshots', async () => {
  const writes = [];
  const marks = [];
  const updates = [];
  const result = await writeInitialWeeklyDraft({
    instance: buildInstance(),
    preview: {
      cells: {
        C26: [{ text: 'AI draft', evidenceIds: ['fact-1'] }],
        C27: [{ text: 'AI must not overwrite', evidenceIds: ['fact-2'] }],
      },
    },
    writer: {
      readCells: async () => ({ C26: '', C27: 'manual value' }),
      writeCells: async (_config, _sheetId, values) => writes.push(values),
      markAiCells: async (_config, _sheetId, values) => marks.push(values),
    },
    bitable: {
      updateWeeklyInstance: async (_instance, patch) => updates.push(patch),
    },
    now: new Date('2026-07-24T08:30:00+08:00'),
  });

  assert.deepEqual(writes, [{ C26: 'AI draft' }]);
  assert.deepEqual(marks, [{ C26: 'AI draft' }]);
  assert.equal(result.writtenCells.C26.text, 'AI draft');
  assert.equal(result.writtenCells.C26.evidenceIds[0], 'fact-1');
  assert.match(result.writtenCells.C26.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(updates[0].aiDraftSnapshot, result.snapshot);
  assert.deepEqual(updates[0].aiEvidenceSnapshot, { C26: ['fact-1'] });
  assert.equal(updates[0].aiGenerationStatus, '已生成');
  assert.equal(updates[0].aiInitialAt, 1784853000000);
});

test('Saturday refresh updates only unchanged AI cells and keeps edited or cleared cells locked', async () => {
  const writes = [];
  const updates = [];
  const result = await refreshWeeklyDraft({
    instance: {
      ...buildInstance(),
      aiDraftSnapshot: {
        C26: { text: 'Friday AI', hash: 'old', evidenceIds: ['fact-1'] },
        C27: { text: 'Friday edited later', hash: 'old', evidenceIds: ['fact-2'] },
        C28: { text: 'Friday cleared later', hash: 'old', evidenceIds: ['fact-3'] },
      },
    },
    preview: {
      cells: {
        C26: [{ text: 'Saturday AI', evidenceIds: ['fact-4'] }],
        C27: [{ text: 'Must stay edited', evidenceIds: ['fact-5'] }],
        C28: [{ text: 'Must stay cleared', evidenceIds: ['fact-6'] }],
      },
    },
    writer: {
      readCells: async () => ({ C26: 'Friday AI', C27: 'Human edit', C28: '' }),
      writeCells: async (_config, _sheetId, values) => writes.push(values),
      markAiCells: async () => {},
    },
    bitable: {
      updateWeeklyInstance: async (_instance, patch) => updates.push(patch),
    },
    now: new Date('2026-07-25T09:30:00+08:00'),
  });

  assert.deepEqual(writes, [{ C26: 'Saturday AI' }]);
  assert.deepEqual(Object.keys(result.writtenCells), ['C26']);
  assert.equal(updates[0].aiGenerationStatus, '已刷新');
  assert.equal(result.snapshot.C27.text, 'Friday edited later');
  assert.equal(result.snapshot.C28.text, 'Friday cleared later');
});

function buildInstance() {
  return {
    sheetConfig: { spreadsheetToken: 'sheet_token' },
    sheetId: 'week_1',
    aiDraftSnapshot: {},
  };
}
