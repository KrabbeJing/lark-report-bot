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
