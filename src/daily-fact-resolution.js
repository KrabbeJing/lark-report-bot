import crypto from 'node:crypto';
import { normalizeContentForFingerprint } from './daily-record-utils.js';

export const DAILY_FACT_CONTENT_KEYS = Object.freeze([
  'workItems',
  'tomorrowPlanItems',
  'riskItems',
]);

export const DAILY_FACT_RESOLUTION_MODES = Object.freeze({
  PERSISTED_INCREMENTAL: 'persisted-incremental',
  SOURCE_REBUILD: 'source-rebuild',
});

const FIELD_LABELS = Object.freeze({
  workItems: '今日工作总结',
  tomorrowPlanItems: '明日工作计划',
  riskItems: '遇到的问题',
});

/**
 * Resolves daily-fact content independently per field. The returned provenance
 * is safe to persist because it deliberately contains no report text. The
 * default mode retains conflict history read from a persisted fact; callers
 * replaying source records must pass mode: 'source-rebuild' to recompute it.
 */
export function resolveDailyFactFields({
  existing = null,
  incoming,
  mode = DAILY_FACT_RESOLUTION_MODES.PERSISTED_INCREMENTAL,
}) {
  if (!incoming) throw new Error('An incoming daily fact candidate is required');

  const existingValues = existing?.values || {};
  const existingSources = existing?.fieldSources || {};
  const values = {};
  const fieldSources = {};
  const relations = {};

  for (const key of DAILY_FACT_CONTENT_KEYS) {
    const selection = chooseField(
      existingValues[key],
      existingProvenance(existingSources[key], existing, existingValues[key]),
      incoming.values?.[key],
      incoming,
    );
    values[key] = selection.value;
    fieldSources[key] = selection.source;
    relations[key] = selection.relation;
  }

  const observedSources = joinSources([
    ...splitSources(existing?.observedSources || existing?.source),
    incoming.source,
  ]);
  const effectiveSources = joinSources(
    DAILY_FACT_CONTENT_KEYS
      .filter(key => normalizeText(values[key]))
      .map(key => fieldSources[key]?.source),
  );
  const sourceTime = Math.max(
    0,
    ...DAILY_FACT_CONTENT_KEYS
      .filter(key => normalizeText(values[key]))
      .map(key => Number(fieldSources[key]?.sourceTime) || 0),
  );
  const preservesConflict = mode === DAILY_FACT_RESOLUTION_MODES.PERSISTED_INCREMENTAL
    && existing?.conflictStatus === '已自动处理';
  const hasConflict = preservesConflict || Object.values(relations).includes('conflict');
  const mergeStatus = deriveMergeStatus(observedSources, relations, hasConflict);
  const conflictStatus = hasConflict ? '已自动处理' : '无冲突';
  const factStatus = deriveFactStatus(existing?.factStatus, incoming.matchingStatus);

  return {
    values,
    fieldSources,
    observedSources,
    effectiveSources,
    sourceTime,
    mergeStatus,
    conflictStatus,
    factStatus,
    autoResolutionNote: conflictStatus === '已自动处理'
      ? buildAutoResolutionNote(values, fieldSources, relations)
      : '',
  };
}

function chooseField(existingValue, existingSource, incomingValue, incoming) {
  if (!normalizeText(incomingValue)) {
    return { value: normalizeValue(existingValue), source: existingSource, relation: 'missing' };
  }
  if (!normalizeText(existingValue)) {
    return {
      value: normalizeValue(incomingValue),
      source: provenance(incoming, incomingValue),
      relation: 'complement',
    };
  }

  if (fingerprint(existingValue) === fingerprint(incomingValue)) {
    return shouldChooseIncoming(existingSource, incoming, incomingValue)
      ? { value: normalizeValue(incomingValue), source: provenance(incoming, incomingValue), relation: 'same' }
      : { value: normalizeValue(existingValue), source: existingSource, relation: 'same' };
  }

  const relation = existingSource?.source === incoming.source ? 'revision' : 'conflict';
  return shouldChooseIncoming(existingSource, incoming, incomingValue)
    ? { value: normalizeValue(incomingValue), source: provenance(incoming, incomingValue), relation }
    : { value: normalizeValue(existingValue), source: existingSource, relation };
}

function shouldChooseIncoming(existingSource, incoming, incomingValue) {
  const existingTime = Number(existingSource?.sourceTime) || 0;
  const incomingTime = Number(incoming.sourceTime) || 0;
  if (incomingTime !== existingTime) return incomingTime > existingTime;

  const existingSourceName = existingSource?.source || '';
  if (incoming.source !== existingSourceName) return incoming.source === 'form';

  // Same-source equal timestamps are uncommon, but a stable hash tie-breaker
  // makes replaying candidates independent of their arrival order as well.
  return fingerprint(incomingValue).localeCompare(existingSource?.fingerprint || '') >= 0;
}

function existingProvenance(source, existing, value) {
  if (!normalizeText(value)) {
    return {
      source: '',
      sourceTime: 0,
      fingerprint: fingerprint(''),
    };
  }
  if (source?.source) return source;
  const fallbackSource = splitSources(existing?.effectiveSources || existing?.effectiveSource || existing?.source)[0] || '';
  return {
    source: fallbackSource,
    sourceTime: Number(existing?.sourceTime) || 0,
    fingerprint: fingerprint(value),
  };
}

function provenance(candidate, value) {
  return {
    source: candidate.source || '',
    sourceTime: Number(candidate.sourceTime) || 0,
    fingerprint: fingerprint(value),
  };
}

function deriveMergeStatus(observedSources, relations, hasConflict) {
  if (splitSources(observedSources).length <= 1) return '单来源';
  if (hasConflict) return '按字段取最新';
  if (Object.values(relations).includes('complement')) return '互补已合并';
  return '重复已合并';
}

function deriveFactStatus(existingFactStatus, incomingMatchingStatus) {
  if (existingFactStatus === '忽略') return '忽略';
  if (existingFactStatus === '有效' || incomingMatchingStatus !== '未匹配') return '有效';
  return '待人工确认';
}

function buildAutoResolutionNote(values, fieldSources, relations) {
  return DAILY_FACT_CONTENT_KEYS
    .filter(key => normalizeText(values[key]))
    .map(key => {
      const source = sourceLabel(fieldSources[key]?.source);
      return relations[key] === 'conflict'
        ? `${FIELD_LABELS[key]}按来源时间采用${source}`
        : `${FIELD_LABELS[key]}保留${source}`;
    })
    .join('；');
}

function joinSources(sources) {
  const found = new Set(sources.flatMap(splitSources).filter(Boolean));
  return ['form', 'chat'].filter(source => found.has(source)).join('+');
}

function splitSources(value) {
  return String(value || '').split('+').filter(source => source === 'form' || source === 'chat');
}

function sourceLabel(source) {
  return source === 'form' ? '表单' : source === 'chat' ? '群聊' : '未知来源';
}

function normalizeValue(value) {
  return value == null ? '' : String(value);
}

function normalizeText(value) {
  return normalizeContentForFingerprint(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(normalizeText(value)).digest('hex');
}

// These two exports preserve the pre-Task-3 call sites until they begin
// supplying values and persisted field provenance to the resolver above.
export function resolveDailyFactCandidates({ form = null, chat = null, existingFactStatus = '' }) {
  if (!form && !chat) throw new Error('At least one daily fact candidate is required');

  const hasBothSources = Boolean(form && chat);
  const sameContent = hasBothSources && form.fingerprint === chat.fingerprint;
  const winner = chooseWinner(form, chat);
  const hasMatchedCandidate = [form, chat]
    .filter(Boolean)
    .some(candidate => candidate.matchingStatus !== '未匹配');
  const factStatus = existingFactStatus === '忽略'
    ? '忽略'
    : existingFactStatus === '有效' || hasMatchedCandidate ? '有效' : '待人工确认';

  return {
    winner,
    hasBothSources,
    effectiveSource: winner.source,
    sourceTime: winner.sourceTime,
    mergeStatus: hasBothSources ? (sameContent ? '重复已合并' : '按时间取最新') : '单来源',
    conflictStatus: hasBothSources && !sameContent ? '已自动处理' : '无冲突',
    factStatus,
    autoResolutionNote: hasBothSources && !sameContent
      ? `按来源时间采用${winner.source === 'form' ? '表单' : '群聊'}版本`
      : '',
  };
}

export function resolveIncrementalDailyFact({ existing = null, incoming }) {
  if (!existing) {
    return resolveDailyFactCandidates({
      form: incoming.source === 'form' ? incoming : null,
      chat: incoming.source === 'chat' ? incoming : null,
    });
  }

  const existingCandidate = {
    source: existing.effectiveSource || firstSource(existing.source),
    sourceTime: Number(existing.sourceTime) || 0,
    fingerprint: existing.fingerprint,
    matchingStatus: existing.matchingStatus,
  };
  const candidates = { form: null, chat: null };
  candidates[existingCandidate.source] = existingCandidate;
  const currentIncoming = candidates[incoming.source];
  if (!currentIncoming || incoming.sourceTime >= currentIncoming.sourceTime) {
    candidates[incoming.source] = incoming;
  }
  const result = resolveDailyFactCandidates({
    ...candidates,
    existingFactStatus: existing.factStatus,
  });

  const existingHadBoth = sourceHas(existing.source, 'form') && sourceHas(existing.source, 'chat');
  if (existingHadBoth && !(candidates.form && candidates.chat)) {
    return {
      ...result,
      hasBothSources: true,
      mergeStatus: existing.mergeStatus || '按时间取最新',
      conflictStatus: existing.conflictStatus || '已自动处理',
      autoResolutionNote: existing.autoResolutionNote
        || (existing.conflictStatus === '已自动处理'
          ? `按来源时间采用${result.winner.source === 'form' ? '表单' : '群聊'}版本`
          : ''),
    };
  }
  return result;
}

function chooseWinner(form, chat) {
  if (!form) return chat;
  if (!chat) return form;
  if (form.sourceTime === chat.sourceTime) return form;
  return form.sourceTime > chat.sourceTime ? form : chat;
}

function sourceHas(source, expected) {
  return String(source || '').split('+').includes(expected);
}

function firstSource(source) {
  return sourceHas(source, 'form') ? 'form' : 'chat';
}
