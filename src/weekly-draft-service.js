import { createHash } from 'node:crypto';

export async function writeInitialWeeklyDraft({ instance, preview, writer, bitable, now = new Date() }) {
  return writeWeeklyDraft({
    instance,
    preview,
    writer,
    bitable,
    now,
    mode: 'initial',
  });
}

export async function refreshWeeklyDraft({ instance, preview, writer, bitable, now = new Date() }) {
  return writeWeeklyDraft({
    instance,
    preview,
    writer,
    bitable,
    now,
    mode: 'refresh',
  });
}

async function writeWeeklyDraft({ instance, preview, writer, bitable, now, mode }) {
  const sheetConfig = instance.sheetConfig || instance.weeklySheet || instance.group?.weeklySheet;
  const sheetId = instance.sheetId;
  if (!sheetConfig || !sheetId) throw new Error('周报实例缺少工作表配置或 SheetID');

  const entries = normalizePreviewCells(preview?.cells, preview?.classifications);
  const cells = Object.keys(entries);
  const currentValues = cells.length
    ? await writer.readCells(sheetConfig, sheetId, cells)
    : {};
  const preparedCells = {};
  const completedCells = [];
  const skippedCells = [];

  for (const [cell, entry] of Object.entries(entries)) {
    const current = normalizeText(currentValues[cell]);
    if (current) {
      completedCells.push(cell);
      continue;
    }
    if (!entry.text) {
      skippedCells.push(cell);
      continue;
    }
    preparedCells[cell] = {
      text: entry.text,
      hash: hashText(entry.text),
      generatedAt: now.getTime(),
      evidenceIds: entry.evidenceIds,
      targetId: entry.targetId,
    };
  }

  const snapshot = preparedCells;
  const evidenceSnapshot = buildEvidenceSnapshot(preview, preparedCells);

  const status = mode === 'initial' ? '已生成' : '已刷新';
  await persistInstancePatch(bitable, instance, {
    aiDraftSnapshot: snapshot,
    aiEvidenceSnapshot: evidenceSnapshot,
    aiGenerationStatus: status,
    ...(mode === 'initial' ? { aiInitialAt: now.getTime() } : { aiRefreshAt: now.getTime() }),
  }, now);

  return {
    preparedCells,
    completedCells,
    skippedCells,
    writtenCells: {},
    lockedCells: completedCells,
    snapshot,
    evidenceSnapshot,
    aiGenerationStatus: status,
  };
}

async function persistInstancePatch(bitable, instance, patch, now) {
  if (!bitable) return null;
  if (typeof bitable.updateWeeklyInstance === 'function') {
    return bitable.updateWeeklyInstance(instance, patch, { now });
  }
  if (typeof bitable.upsertWeeklyInstance === 'function' && instance.group) {
    return bitable.upsertWeeklyInstance(instance.group, {
      ...instance,
      ...patch,
    }, { existingRecord: instance.record, now });
  }
  return null;
}

function normalizePreviewCells(cells, classifications = []) {
  const result = {};
  const targetIdsByEvidence = new Map((classifications || [])
    .map(item => [normalizeText(item?.evidenceId), normalizeText(item?.targetId)]));
  for (const [cell, raw] of Object.entries(cells || {})) {
    if (!Array.isArray(raw) && (!raw || typeof raw !== 'object')) continue;
    const entries = Array.isArray(raw) ? raw : [raw];
    const text = entries.map(entry => normalizeText(entry?.text)).filter(Boolean).join('\n');
    const evidenceIds = [...new Set(entries.flatMap(entry => entry?.evidenceIds || [])
      .map(normalizeText)
      .filter(Boolean))];
    const targetIds = [...new Set([
      ...entries.map(entry => normalizeText(entry?.targetId)),
      ...evidenceIds.map(evidenceId => targetIdsByEvidence.get(evidenceId)),
    ].filter(Boolean))];
    result[cell] = { text, evidenceIds, targetId: targetIds.length === 1 ? targetIds[0] : '' };
  }
  return result;
}

function buildEvidenceSnapshot(preview, preparedCells) {
  return {
    version: 2,
    cells: Object.fromEntries(Object.entries(preparedCells)
      .map(([cell, entry]) => [cell, entry.evidenceIds])),
    classifications: (preview?.classifications || []).map(item => evidenceMetadata(item, 'accepted')),
    pendingOwnerReview: (preview?.pendingOwnerReview || [])
      .map(item => evidenceMetadata(item, 'pending_owner_review')),
  };
}

function evidenceMetadata(item, status) {
  return {
    evidenceId: normalizeText(item?.evidenceId),
    targetId: normalizeText(item?.targetId),
    confidence: normalizeText(item?.confidence),
    reason: normalizeText(item?.reason),
    evidenceHash: normalizeText(item?.evidenceHash),
    status,
  };
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

export function hashText(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
