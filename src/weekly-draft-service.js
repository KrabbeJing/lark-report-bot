import { createHash } from 'node:crypto';

const AI_NOTE = 'AI总结生成，仅供参考';

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

  const entries = normalizePreviewCells(preview?.cells);
  const cells = Object.keys(entries);
  const currentValues = cells.length
    ? await writer.readCells(sheetConfig, sheetId, cells)
    : {};
  const previousSnapshot = normalizeSnapshot(instance.aiDraftSnapshot);
  const writtenCells = {};
  const lockedCells = [];
  const skippedCells = [];

  for (const [cell, entry] of Object.entries(entries)) {
    const current = normalizeText(currentValues[cell]);
    const allowed = mode === 'initial'
      ? !current
      : Boolean(previousSnapshot[cell]?.text)
        && current === normalizeText(previousSnapshot[cell].text);
    if (!entry.text || !allowed) {
      (allowed ? skippedCells : lockedCells).push(cell);
      continue;
    }
    writtenCells[cell] = {
      text: entry.text,
      hash: hashText(entry.text),
      writtenAt: now.getTime(),
      evidenceIds: entry.evidenceIds,
    };
  }

  const valuesToWrite = Object.fromEntries(
    Object.entries(writtenCells).map(([cell, value]) => [cell, value.text]),
  );
  if (Object.keys(valuesToWrite).length) {
    await writer.writeCells(sheetConfig, sheetId, valuesToWrite);
    if (typeof writer.markAiCells === 'function') {
      await writer.markAiCells(sheetConfig, sheetId, valuesToWrite, AI_NOTE);
    }
  }

  const snapshot = {
    ...previousSnapshot,
    ...writtenCells,
  };
  const evidenceSnapshot = {
    ...normalizeSnapshot(instance.aiEvidenceSnapshot),
  };
  for (const [cell, value] of Object.entries(writtenCells)) {
    evidenceSnapshot[cell] = value.evidenceIds;
  }

  const status = mode === 'initial' ? '已生成' : '已刷新';
  await persistInstancePatch(bitable, instance, {
    aiDraftSnapshot: snapshot,
    aiEvidenceSnapshot: evidenceSnapshot,
    aiGenerationStatus: status,
    ...(mode === 'initial' ? { aiInitialAt: now.getTime() } : { aiRefreshAt: now.getTime() }),
  }, now);

  return {
    writtenCells,
    skippedCells,
    lockedCells,
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

function normalizePreviewCells(cells) {
  const result = {};
  for (const [cell, raw] of Object.entries(cells || {})) {
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const text = normalizeText(entry?.text ?? entry);
    const evidenceIds = [...new Set((entry?.evidenceIds || []).map(value => String(value).trim()).filter(Boolean))];
    result[cell] = { text, evidenceIds };
  }
  return result;
}

function normalizeSnapshot(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}

export function hashText(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
