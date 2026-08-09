import { tableIsConfigured } from './config.js';
import { DEFAULT_TIMEZONE, formatDateTime, formatYmd } from './date-utils.js';

function raw(record, table, key) {
  return record?.fields?.[table?.fields?.[key]];
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return String(value.text || value.name || value.id || '').trim();
  return String(value || '').trim();
}

function texts(value) {
  if (!Array.isArray(value)) return text(value) ? [text(value)] : [];
  return value.map(text).filter(Boolean);
}

function lines(value) {
  return texts(value)
    .flatMap(item => item.split(/\r?\n/))
    .map(item => item.trim())
    .filter(Boolean);
}

function people(value) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map(item => ({ openId: String(item?.id || ''), name: String(item?.name || '') }))
    .filter(item => item.openId);
}

function baseTimestamp(value) {
  if (Array.isArray(value)) return baseTimestamp(value[0]);
  if (value && typeof value === 'object') {
    return baseTimestamp(value.timestamp ?? value.date ?? value.value ?? value.text ?? '');
  }
  const normalized = String(value ?? '').trim();
  if (!/^\d{10,13}$/.test(normalized)) return null;
  const numeric = Number(normalized);
  const milliseconds = numeric < 100000000000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateText(value) {
  const timestamp = baseTimestamp(value);
  return timestamp ? formatYmd(timestamp, DEFAULT_TIMEZONE) : text(value);
}

function dateTimeText(value) {
  const timestamp = baseTimestamp(value);
  return timestamp ? formatDateTime(timestamp, DEFAULT_TIMEZONE) : text(value);
}

export function normalizeWeeklySourceMapping(record, table) {
  return {
    recordId: record.record_id,
    contactRecordIds: texts(raw(record, table, 'member')),
    memberName: text(raw(record, table, 'memberRealName')),
    memberOpenId: text(raw(record, table, 'memberOpenId')),
    module2Targets: texts(raw(record, table, 'module2Targets')),
    module3Target: text(raw(record, table, 'module3Target')),
    effectiveFrom: dateText(raw(record, table, 'effectiveFrom')),
    effectiveTo: dateText(raw(record, table, 'effectiveTo')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeWeeklySectionRule(record, table) {
  return {
    recordId: record.record_id,
    targetId: text(raw(record, table, 'ruleKey')),
    module: text(raw(record, table, 'module')),
    target: text(raw(record, table, 'target')),
    contentType: text(raw(record, table, 'contentType')),
    businessScope: text(raw(record, table, 'businessScope')),
    includeTopics: lines(raw(record, table, 'includeTopics')),
    excludeTopics: lines(raw(record, table, 'excludeTopics')),
    positiveExamples: lines(raw(record, table, 'positiveExamples')),
    negativeExamples: lines(raw(record, table, 'negativeExamples')),
    owners: people(raw(record, table, 'owners')),
    remindOwners: Boolean(raw(record, table, 'remindOwners')),
    order: Number(text(raw(record, table, 'order')) || 0),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeWeeklyStyleExample(record, table) {
  return {
    recordId: record.record_id,
    module: text(raw(record, table, 'module')),
    target: text(raw(record, table, 'target')),
    contentType: text(raw(record, table, 'contentType')),
    weekKey: text(raw(record, table, 'weekKey')),
    finalText: text(raw(record, table, 'finalText')),
    reviewedAt: dateTimeText(raw(record, table, 'reviewedAt')),
    highQuality: Boolean(raw(record, table, 'highQuality')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

export function normalizeCoreMetricOwner(record, table) {
  return {
    recordId: record.record_id,
    metricName: text(raw(record, table, 'metricName')),
    owners: people(raw(record, table, 'owners')),
    remindersEnabled: Boolean(raw(record, table, 'remindersEnabled')),
    enabled: Boolean(raw(record, table, 'enabled')),
  };
}

function isMappingActive(mapping, period) {
  const startsBeforeEnd = !mapping.effectiveFrom || mapping.effectiveFrom <= period.end;
  const endsAfterStart = !mapping.effectiveTo || mapping.effectiveTo >= period.start;
  return startsBeforeEnd && endsAfterStart;
}

function nextYmd(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

function findMappingConflicts(mappings, period) {
  const conflicts = new Set();
  for (let date = period.start; date <= period.end; date = nextYmd(date)) {
    const counts = new Map();
    for (const mapping of mappings.filter(item => isMappingActive(item, { start: date, end: date }))) {
      const contactRecordIds = [...new Set(mapping.contactRecordIds)].sort();
      const keys = contactRecordIds.length
        ? contactRecordIds
        : [mapping.memberOpenId || mapping.memberName].filter(Boolean);
      for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const memberKey of [...counts.keys()].sort()) {
      const count = counts.get(memberKey);
      if (count > 1) conflicts.add(`duplicate_active_mapping:${date}:${memberKey}`);
    }
  }
  return [...conflicts];
}

const TABLES = [
  { groupKey: 'weeklySourceMappingTable', resultKey: 'mappings', warningKey: 'mappings', operation: 'weeklyConfig.mappings' },
  { groupKey: 'weeklySectionRuleTable', resultKey: 'rules', warningKey: 'rules', operation: 'weeklyConfig.rules' },
  { groupKey: 'weeklyStyleExampleTable', resultKey: 'styleExamples', warningKey: 'styles', operation: 'weeklyConfig.styles' },
  { groupKey: 'coreMetricOwnerTable', resultKey: 'metricOwners', warningKey: 'metrics', operation: 'weeklyConfig.metrics' },
];

export async function loadWeeklyConfiguration({ group, bitable, period }) {
  const warnings = [];
  const recordsByKey = Object.fromEntries(await Promise.all(TABLES.map(async ({
    groupKey, resultKey, warningKey, operation,
  }) => {
    const table = group[groupKey];
    if (!tableIsConfigured(table)) {
      warnings.push(`weekly_config_table_not_configured:${warningKey}`);
      return [resultKey, []];
    }
    const records = await bitable.listRecords(table, operation, { includeView: false });
    return [resultKey, records];
  })));

  const mappings = recordsByKey.mappings
    .map(record => normalizeWeeklySourceMapping(record, group.weeklySourceMappingTable))
    .filter(item => item.enabled && isMappingActive(item, period));

  return {
    mappings,
    rules: recordsByKey.rules
      .map(record => normalizeWeeklySectionRule(record, group.weeklySectionRuleTable))
      .filter(item => item.enabled),
    styleExamples: recordsByKey.styleExamples
      .map(record => normalizeWeeklyStyleExample(record, group.weeklyStyleExampleTable))
      .filter(item => item.enabled && item.reviewedAt && item.highQuality && item.finalText),
    metricOwners: recordsByKey.metricOwners
      .map(record => normalizeCoreMetricOwner(record, group.coreMetricOwnerTable))
      .filter(item => item.enabled),
    warnings: [...warnings, ...findMappingConflicts(mappings, period)],
  };
}
