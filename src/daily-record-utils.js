import crypto from 'node:crypto';

export function normalizeContentForFingerprint(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^(\d+)\s*[.)）]\s*/, '$1、'))
    .join('\n');
}

export function buildContentFingerprint({ workItems = '', tomorrowPlanItems = '', riskItems = '' } = {}) {
  const normalized = [
    normalizeContentForFingerprint(workItems),
    normalizeContentForFingerprint(tomorrowPlanItems),
    normalizeContentForFingerprint(riskItems),
  ].join('\n---\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function buildFactKey({ openId = '', name = '', reportDate }) {
  const date = String(reportDate || '').trim();
  const id = String(openId || '').trim();
  const displayName = String(name || '').trim();
  if (id) return `open_id:${id}:${date}`;
  return `name:${displayName}:${date}`;
}

export function buildSourceRefs({ sourceRecordId = '', messageId = '' } = {}) {
  return [
    sourceRecordId ? `form:${sourceRecordId}` : '',
    messageId ? `chat:${messageId}` : '',
  ].filter(Boolean).join('\n');
}

export function hasSameContentFingerprint(a, b) {
  return Boolean(a && b && a === b);
}
