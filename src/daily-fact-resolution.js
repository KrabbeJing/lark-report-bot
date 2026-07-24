import crypto from 'node:crypto';
import { normalizeContentForFingerprint } from './daily-record-utils.js';

export const DAILY_FACT_CONTENT_KEYS = Object.freeze([
  'workItems',
  'tomorrowPlanItems',
  'riskItems',
]);

const FIELD_LABELS = Object.freeze({
  workItems: '今日工作总结',
  tomorrowPlanItems: '明日工作计划',
  riskItems: '遇到的问题',
});

/**
 * Applies one source delta to a persisted daily fact. All state needed by the
 * next call is ordinary JSON data under fieldSources; it never contains report
 * body text.
 */
export function resolveDailyFactFields({
  existing = null,
  incoming,
}) {
  if (!incoming) throw new Error('An incoming daily fact candidate is required');
  assertSupportedSource(incoming.source);

  const existingValues = existing?.values || {};
  const values = {};
  const fieldSources = {};

  for (const key of DAILY_FACT_CONTENT_KEYS) {
    const field = normalizeExistingField(
      existingValues[key],
      existing?.fieldSources?.[key],
      existing,
    );
    const next = applyIncomingField(field, incoming.values?.[key], incoming);
    values[key] = next.value;
    fieldSources[key] = next.source;
  }

  return buildResolution({
    values,
    fieldSources,
    observedSources: joinSources([
      ...splitSources(existing?.observedSources),
      ...splitSources(existing?.source),
      incoming.source,
      ...DAILY_FACT_CONTENT_KEYS
        .flatMap(key => Object.keys(fieldSources[key].sources)),
    ]),
    existing,
    matchingStatuses: [incoming.matchingStatus],
    preservesConflict: existing?.conflictStatus === '已自动处理',
  });
}

/**
 * Rebuilds a daily fact from the complete candidate set. Candidate body text
 * exists only in this call's local accumulator and is not returned as state.
 */
export function rebuildDailyFactFields({ candidates, existingFactStatus = '' }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('At least one daily fact candidate is required');
  }

  const candidatesBySource = {
    form: {},
    chat: {},
  };
  const observedSources = [];

  for (const candidate of candidates) {
    assertSupportedSource(candidate?.source);
    observedSources.push(candidate.source);
    for (const key of DAILY_FACT_CONTENT_KEYS) {
      const value = candidate.values?.[key];
      if (!normalizeText(value)) continue;

      const next = rebuildFieldCandidate(candidate, value);
      const current = candidatesBySource[candidate.source][key];
      if (!current || compareSameSourceCandidates(next, current) > 0) {
        candidatesBySource[candidate.source][key] = next;
      }
    }
  }

  const values = {};
  const fieldSources = {};

  for (const key of DAILY_FACT_CONTENT_KEYS) {
    const selection = chooseRebuildField(
      candidatesBySource.form[key],
      candidatesBySource.chat[key],
    );
    values[key] = selection.value;
    fieldSources[key] = selection.source;
  }

  return buildResolution({
    values,
    fieldSources,
    observedSources: joinSources(observedSources),
    existing: { factStatus: existingFactStatus },
    matchingStatuses: candidates.map(candidate => candidate.matchingStatus),
    preservesConflict: false,
  });
}

function rebuildFieldCandidate(incoming, value) {
  return {
    value: normalizeValue(value),
    source: incoming.source,
    sourceTime: Number(incoming.sourceTime) || 0,
    fingerprint: fingerprint(value),
  };
}

function compareSameSourceCandidates(left, right) {
  if (left.sourceTime !== right.sourceTime) return left.sourceTime - right.sourceTime;
  const fingerprintOrder = compareStableText(left.fingerprint, right.fingerprint);
  if (fingerprintOrder !== 0) return fingerprintOrder;
  return compareStableText(left.value, right.value);
}

function compareStableText(left, right) {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function chooseRebuildField(form, chat) {
  if (!form && !chat) {
    return { value: '', source: emptyFieldSource() };
  }
  if (!form || !chat) {
    const winner = form || chat;
    return {
      value: winner.value,
      source: buildFieldSource(winner, {
        [winner.source]: sourceMetadata(winner),
      }),
    };
  }

  const relation = form.fingerprint === chat.fingerprint ? 'same' : 'conflict';
  const winner = chooseCrossSourceCandidate(form, chat);
  return {
    value: winner.value,
    source: buildFieldSource(winner, {
      form: sourceMetadata(form),
      chat: sourceMetadata(chat),
    }, { relation }),
  };
}

function chooseCrossSourceCandidate(form, chat) {
  if (form.sourceTime === chat.sourceTime) return form;
  return form.sourceTime > chat.sourceTime ? form : chat;
}

function sourceMetadata(candidate) {
  return {
    sourceTime: candidate.sourceTime,
    fingerprint: candidate.fingerprint,
  };
}

function buildResolution({
  values,
  fieldSources,
  observedSources,
  existing,
  matchingStatuses,
  preservesConflict,
}) {
  const relations = Object.fromEntries(
    DAILY_FACT_CONTENT_KEYS.map(key => [key, fieldSources[key].relation]),
  );
  const hasAmbiguousFields = DAILY_FACT_CONTENT_KEYS
    .some(key => fieldSources[key].ambiguous);
  const effectiveSources = joinSources(
    [
      ...DAILY_FACT_CONTENT_KEYS
        .filter(key => normalizeText(values[key]))
        .map(key => fieldSources[key]?.source),
      ...(hasAmbiguousFields
        ? splitSources(existing?.effectiveSources || existing?.effectiveSource || existing?.source)
        : []),
    ],
  );
  const sourceTime = Math.max(
    0,
    ...DAILY_FACT_CONTENT_KEYS
      .filter(key => normalizeText(values[key]))
      .map(key => Number(fieldSources[key]?.sourceTime) || 0),
  );
  const hasConflict = preservesConflict || Object.values(relations).includes('conflict');
  const mergeStatus = deriveMergeStatus({
    observedSources,
    fieldSources,
    values,
    hasConflict,
    existingMergeStatus: existing?.mergeStatus,
  });
  const conflictStatus = hasConflict ? '已自动处理' : '无冲突';
  const factStatus = deriveFactStatus(existing?.factStatus, matchingStatuses);
  const hasLocatedConflict = Object.values(relations).includes('conflict');

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
      ? (hasLocatedConflict
        ? buildAutoResolutionNote(values, fieldSources)
        : existing?.autoResolutionNote || buildAutoResolutionNote(values, fieldSources))
      : '',
  };
}

function normalizeExistingField(value, snapshot, existing) {
  const normalizedValue = normalizeValue(value);
  if (!normalizeText(normalizedValue)) {
    return { value: '', source: emptyFieldSource() };
  }

  const selectedSource = normalizeSource(snapshot?.source);
  const selectedTime = Number(
    snapshot?.sourceTime
      ?? snapshot?.sources?.[selectedSource]?.sourceTime
      ?? existing?.sourceTime,
  ) || 0;
  const selectedFingerprint = fingerprint(normalizedValue);
  const sources = normalizeSourceMetadata(snapshot?.sources);
  let ambiguous = Boolean(snapshot?.ambiguous);

  if (selectedSource) {
    sources[selectedSource] = {
      sourceTime: selectedTime,
      fingerprint: selectedFingerprint,
    };
  } else if (!snapshot?.source) {
    const legacySources = splitSources(
      existing?.effectiveSources || existing?.effectiveSource || existing?.source,
    );
    if (legacySources.length === 1) {
      sources[legacySources[0]] = {
        sourceTime: selectedTime,
        fingerprint: selectedFingerprint,
      };
      return {
        value: normalizedValue,
        source: buildFieldSource({
          source: legacySources[0],
          sourceTime: selectedTime,
          fingerprint: selectedFingerprint,
        }, sources, {
          relation: snapshot?.relation,
          conflict: snapshot?.relation === 'conflict',
        }),
      };
    }
    ambiguous = true;
  }

  return {
    value: normalizedValue,
    source: buildFieldSource({
      source: selectedSource,
      sourceTime: selectedTime,
      fingerprint: selectedFingerprint,
    }, sources, {
      ambiguous,
      relation: snapshot?.relation,
      conflict: snapshot?.relation === 'conflict',
    }),
  };
}

function applyIncomingField(field, incomingValue, incoming) {
  if (!normalizeText(incomingValue)) {
    return field;
  }

  const incomingCandidate = rebuildFieldCandidate(incoming, incomingValue);
  const sources = {
    ...field.source.sources,
  };
  const currentForSource = sources[incoming.source];
  if (!shouldReplaceSourceCandidate(field, currentForSource, incomingCandidate)) {
    return field;
  }
  sources[incoming.source] = sourceMetadata(incomingCandidate);

  let selected = {
    value: field.value,
    source: field.source.source,
    sourceTime: field.source.sourceTime,
    fingerprint: field.source.fingerprint,
  };
  if (!normalizeText(field.value)
    || shouldSelectIncomingField(selected, incomingCandidate, field.source.ambiguous)) {
    selected = incomingCandidate;
  }

  const ambiguous = Boolean(field.source.ambiguous);
  const conflict = field.source.relation === 'conflict';
  return {
    value: selected.value,
    source: buildFieldSource(selected, sources, { ambiguous, conflict }),
  };
}

function shouldReplaceSourceCandidate(field, current, incoming) {
  if (!current) return true;
  if (incoming.sourceTime !== current.sourceTime) {
    return incoming.sourceTime > current.sourceTime;
  }
  const fingerprintOrder = compareStableText(incoming.fingerprint, current.fingerprint);
  if (fingerprintOrder !== 0) return fingerprintOrder > 0;
  if (field.source.source !== incoming.source) return false;
  return compareStableText(incoming.value, field.value) > 0;
}

function shouldSelectIncomingField(selected, incoming, selectedIsAmbiguous) {
  if (!selected.source) {
    if (!selectedIsAmbiguous) return true;
    return incoming.sourceTime >= selected.sourceTime;
  }
  if (selected.source === incoming.source) return true;
  return chooseCrossSourceCandidate(
    selected.source === 'form' ? selected : incoming,
    selected.source === 'chat' ? selected : incoming,
  ) === incoming;
}

function buildFieldSource(selected, sources, {
  ambiguous = false,
  conflict = false,
  relation = '',
} = {}) {
  const normalizedSources = normalizeSourceMetadata(sources);
  const selectedSource = normalizeSource(selected?.source);
  const selectedTime = Number(selected?.sourceTime) || 0;
  const selectedFingerprint = normalizeFingerprint(selected?.fingerprint);
  if (selectedSource) {
    normalizedSources[selectedSource] = {
      sourceTime: selectedTime,
      fingerprint: selectedFingerprint,
    };
  }

  return {
    source: selectedSource,
    sourceTime: selectedTime,
    fingerprint: selectedFingerprint || fingerprint(''),
    sources: normalizedSources,
    relation: deriveFieldRelation(normalizedSources, ambiguous, conflict, relation),
    ...(ambiguous ? { ambiguous: true } : {}),
  };
}

function emptyFieldSource() {
  return {
    source: '',
    sourceTime: 0,
    fingerprint: fingerprint(''),
    sources: {},
    relation: 'missing',
  };
}

function normalizeSourceMetadata(value) {
  const result = {};
  for (const source of ['form', 'chat']) {
    const metadata = value?.[source];
    const normalizedFingerprint = normalizeFingerprint(metadata?.fingerprint);
    if (!metadata || !normalizedFingerprint) continue;
    result[source] = {
      sourceTime: Number(metadata.sourceTime) || 0,
      fingerprint: normalizedFingerprint,
    };
  }
  return result;
}

function deriveFieldRelation(sources, ambiguous, conflict, relation) {
  if (conflict || relation === 'conflict') return 'conflict';
  if (ambiguous) return 'ambiguous';
  const candidates = Object.values(sources);
  if (candidates.length === 0) return 'missing';
  if (candidates.length === 1) return 'single';
  return candidates[0].fingerprint === candidates[1].fingerprint ? 'same' : 'conflict';
}

function normalizeFingerprint(value) {
  const text = String(value || '').toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : '';
}

function normalizeSource(value) {
  return value === 'form' || value === 'chat' ? value : '';
}

function assertSupportedSource(source) {
  if (source !== 'form' && source !== 'chat') {
    throw new Error(`Unsupported daily fact source: ${source}`);
  }
}

function deriveMergeStatus({
  observedSources,
  fieldSources,
  values,
  hasConflict,
  existingMergeStatus,
}) {
  if (splitSources(observedSources).length <= 1) return '单来源';
  if (hasConflict) return '按字段取最新';

  const populatedFields = DAILY_FACT_CONTENT_KEYS
    .filter(key => normalizeText(values[key]))
    .map(key => fieldSources[key]);
  if (populatedFields.some(source => source.ambiguous)) {
    return ['重复已合并', '互补已合并'].includes(existingMergeStatus)
      ? existingMergeStatus
      : '重复已合并';
  }

  const knownSources = new Set(
    populatedFields.flatMap(source => Object.keys(source.sources)),
  );
  if (knownSources.has('form')
    && knownSources.has('chat')
    && populatedFields.some(source => Object.keys(source.sources).length === 1)) {
    return '互补已合并';
  }
  return '重复已合并';
}

function deriveFactStatus(existingFactStatus, matchingStatuses) {
  if (existingFactStatus === '忽略') return '忽略';
  const hasMatchedCandidate = matchingStatuses
    .some(status => status !== '未匹配');
  if (existingFactStatus === '有效' || hasMatchedCandidate) return '有效';
  return '待人工确认';
}

function buildAutoResolutionNote(values, fieldSources) {
  return DAILY_FACT_CONTENT_KEYS
    .filter(key => normalizeText(values[key]))
    .map(key => {
      const source = sourceLabel(fieldSources[key]?.source);
      return fieldSources[key]?.relation === 'conflict'
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

/*
 * The following compatibility exports preserve the pre-Task-3 whole-record
 * call sites. Task 3 should use the two field-level APIs above.
 */
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
