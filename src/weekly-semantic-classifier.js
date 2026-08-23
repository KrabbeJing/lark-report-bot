const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_MAX_CHARACTERS = 12000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;
const VALID_CONFIDENCES = new Set(['high', 'medium', 'low']);

export async function classifyWeeklyCandidates({
  candidates = [],
  aiProvider,
  maxItems = DEFAULT_MAX_ITEMS,
  maxCharacters = DEFAULT_MAX_CHARACTERS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait = waitFor,
} = {}) {
  const limits = {
    maxItems: positiveInteger(maxItems, DEFAULT_MAX_ITEMS),
    maxCharacters: positiveInteger(maxCharacters, DEFAULT_MAX_CHARACTERS),
    maxAttempts: positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS),
  };
  const prepared = prepareCandidates(candidates, limits.maxCharacters);
  const batches = buildBatches(prepared.ready, limits);
  const accepted = [];
  const pendingOwnerReview = [];
  const diagnostics = [...prepared.diagnostics];
  let provider = String(aiProvider?.name || '');
  let model = String(aiProvider?.model || '');

  for (const batch of batches) {
    let result;
    try {
      result = await classifyBatch({
        aiProvider,
        items: batch.map(item => item.modelItem),
        maxAttempts: limits.maxAttempts,
        wait,
      });
    } catch {
      diagnostics.push(...batch.map(({ candidate }) => diagnostic(
        candidate.evidenceId,
        'classification_provider_error',
      )));
      continue;
    }

    provider = String(result?.provider || provider);
    model = String(result?.model || model);
    const validated = validateBatchResults(batch, result?.classifications);
    accepted.push(...validated.accepted);
    pendingOwnerReview.push(...validated.pendingOwnerReview);
    diagnostics.push(...validated.diagnostics);
  }

  return {
    accepted: accepted.sort(compareEvidence),
    pendingOwnerReview: pendingOwnerReview.sort(compareEvidence),
    diagnostics: diagnostics.sort(compareDiagnostics),
    provider,
    model,
  };
}

function prepareCandidates(candidates, maxCharacters) {
  const ready = [];
  const diagnostics = [];
  const counts = new Map();
  for (const candidate of candidates || []) {
    const evidenceId = normalized(candidate?.evidenceId);
    counts.set(evidenceId, (counts.get(evidenceId) || 0) + 1);
  }

  for (const candidate of [...(candidates || [])].sort(compareEvidence)) {
    const evidenceId = normalized(candidate?.evidenceId);
    if (!evidenceId || counts.get(evidenceId) !== 1) {
      diagnostics.push(diagnostic(evidenceId, 'classification_duplicate_input'));
      continue;
    }
    const modelItem = toModelItem(candidate);
    if (!modelItem.allowedTargets.length) {
      diagnostics.push(diagnostic(evidenceId, 'classification_no_allowed_target'));
      continue;
    }
    if (JSON.stringify([modelItem]).length > maxCharacters) {
      diagnostics.push(diagnostic(evidenceId, 'classification_input_too_large'));
      continue;
    }
    ready.push({ candidate, modelItem });
  }
  return { ready, diagnostics };
}

function toModelItem(candidate) {
  const text = normalized(candidate?.text);
  return {
    evidenceId: normalized(candidate?.evidenceId),
    date: normalized(candidate?.date),
    text,
    allowedTargets: (candidate?.allowedTargets || []).map(target => {
      const includeTopics = stringArray(target?.includeTopics);
      const excludeTopics = stringArray(target?.excludeTopics);
      return {
        targetId: normalized(target?.targetId),
        module: normalized(target?.module),
        target: normalized(target?.target),
        contentType: normalized(target?.contentType),
        businessScope: normalized(target?.businessScope),
        includeTopics,
        excludeTopics,
        matchedIncludeTopics: includeTopics.filter(topic => topicMatches(text, topic)),
        matchedExcludeTopics: excludeTopics.filter(topic => topicMatches(text, topic)),
        positiveExamples: stringArray(target?.positiveExamples),
        negativeExamples: stringArray(target?.negativeExamples),
      };
    }),
  };
}

function buildBatches(items, { maxItems, maxCharacters }) {
  const batches = [];
  let current = [];
  for (const item of items) {
    const next = [...current, item];
    const exceedsCount = next.length > maxItems;
    const exceedsCharacters = JSON.stringify(next.map(entry => entry.modelItem)).length > maxCharacters;
    if (current.length && (exceedsCount || exceedsCharacters)) {
      batches.push(current);
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function classifyBatch({ aiProvider, items, maxAttempts, wait }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await aiProvider.classifyWeeklyEvidence({ items });
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) break;
      if (attempt < maxAttempts) {
        await wait(retryDelayMs(error?.retryAfterMs));
      }
    }
  }
  throw lastError || new Error('classification_provider_error');
}

function retryDelayMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(milliseconds, 30000);
}

function waitFor(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function validateBatchResults(batch, rawClassifications) {
  const accepted = [];
  const pendingOwnerReview = [];
  const diagnostics = [];
  const candidatesById = new Map(batch.map(item => [item.candidate.evidenceId, item.candidate]));
  const rowsByEvidenceId = new Map();
  const rows = Array.isArray(rawClassifications) ? rawClassifications : [];

  for (const row of rows) {
    const evidenceId = normalized(row?.evidenceId);
    if (!candidatesById.has(evidenceId)) {
      diagnostics.push(diagnostic(evidenceId, 'classification_unknown_evidence'));
      continue;
    }
    if (!rowsByEvidenceId.has(evidenceId)) rowsByEvidenceId.set(evidenceId, []);
    rowsByEvidenceId.get(evidenceId).push(row);
  }

  for (const { candidate } of batch) {
    const rowsForCandidate = rowsByEvidenceId.get(candidate.evidenceId) || [];
    if (!rowsForCandidate.length) {
      diagnostics.push(diagnostic(candidate.evidenceId, 'classification_missing_result'));
      continue;
    }
    if (rowsForCandidate.length !== 1) {
      diagnostics.push(diagnostic(candidate.evidenceId, 'classification_duplicate_result'));
      continue;
    }

    const row = rowsForCandidate[0];
    const targetId = normalized(row?.targetId);
    const selectedTarget = (candidate.allowedTargets || [])
      .find(target => normalized(target?.targetId) === targetId);
    if (!selectedTarget) {
      diagnostics.push(diagnostic(candidate.evidenceId, 'classification_unauthorized_target'));
      continue;
    }
    const confidence = normalized(row?.confidence).toLowerCase();
    if (!VALID_CONFIDENCES.has(confidence)) {
      diagnostics.push(diagnostic(candidate.evidenceId, 'classification_invalid_confidence'));
      continue;
    }
    const reason = normalized(row?.reason);
    if (!reason) {
      diagnostics.push(diagnostic(candidate.evidenceId, 'classification_invalid_reason'));
      continue;
    }

    const joined = {
      ...candidate,
      selectedTarget,
      classification: {
        evidenceId: candidate.evidenceId,
        targetId: normalized(selectedTarget.targetId),
        confidence,
        reason,
      },
    };
    (confidence === 'low' ? pendingOwnerReview : accepted).push(joined);
  }

  return { accepted, pendingOwnerReview, diagnostics };
}

function diagnostic(evidenceId, code) {
  return { evidenceId: normalized(evidenceId), code };
}

function compareEvidence(left, right) {
  return normalized(left?.evidenceId).localeCompare(normalized(right?.evidenceId));
}

function compareDiagnostics(left, right) {
  return compareEvidence(left, right) || normalized(left?.code).localeCompare(normalized(right?.code));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function stringArray(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .map(normalized)
    .filter(Boolean);
}

function topicMatches(text, topic) {
  const normalizedText = normalizeTopicText(text);
  const normalizedTopic = normalizeTopicText(topic);
  return Boolean(normalizedText && normalizedTopic && normalizedText.includes(normalizedTopic));
}

function normalizeTopicText(value) {
  return normalized(value).toLowerCase().replace(/[\s，。；;、:：【】\[\]（）()]/g, '');
}

function normalized(value) {
  return String(value || '').trim();
}
