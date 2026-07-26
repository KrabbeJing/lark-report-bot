import { getWeeklyReportRange } from './date-utils.js';

const EMPTY_DRAFT_TEXT = '本期暂无可用 AI 草稿，请直接进入周报表填写';
const OWNER_STATUS_SUCCESS = '成功';
const OWNER_STATUS_FAILURE = '失败';

export async function notifyWeeklyOwners({
  rules = [],
  instance = {},
  draft = {},
  messenger,
  bitable,
  now = new Date(),
  timezone = 'Asia/Shanghai',
} = {}) {
  const groups = groupOwnerSections({
    rules,
    instance,
    draft,
  });
  const previous = normalizeDetails(instance.ownerNotificationDetails);
  const pending = [];
  let skipped = 0;

  for (const group of groups) {
    const idempotencyKey = ownerIdempotencyKey(instance, group.openId);
    if (hasSuccessfulDetail(previous, group.openId, idempotencyKey)) {
      skipped += 1;
      continue;
    }
    pending.push({ ...group, idempotencyKey });
  }

  if (!pending.length) {
    return {
      status: groups.length ? OWNER_STATUS_SUCCESS : '未发送',
      sent: 0,
      skipped,
      details: previous,
    };
  }

  const results = [];
  for (const group of pending) {
    const sentAt = now.getTime();
    if (!group.openId) {
      results.push(buildDetail({
        openId: '',
        sentAt,
        idempotencyKey: group.idempotencyKey,
        errorCode: 'missing_open_id',
      }));
      continue;
    }

    try {
      await messenger.sendTextToOpenId(
        group.openId,
        buildOwnerMessage(group, instance),
        group.idempotencyKey,
      );
      results.push(buildDetail({
        openId: group.openId,
        sentAt,
        idempotencyKey: group.idempotencyKey,
      }));
    } catch (error) {
      results.push(buildDetail({
        openId: group.openId,
        sentAt,
        idempotencyKey: group.idempotencyKey,
        errorCode: safeErrorCode(error),
      }));
    }
  }

  const details = mergeDetails(previous, results);
  await persistInstancePatch(bitable, instance, {
    ownerNotificationStatus: aggregateStatus(details),
    ownerNotificationDetails: details,
    ownerNotificationAt: now.getTime(),
  }, now);

  return {
    status: aggregateStatus(results),
    sent: results.filter(item => item.status === OWNER_STATUS_SUCCESS).length,
    failed: results.filter(item => item.status === OWNER_STATUS_FAILURE).length,
    skipped,
    details,
  };
}

export async function notifyMissingCoreMetricOwners({
  metricOwners = [],
  metricCells = {},
  instance = {},
  writer,
  messenger,
  bitable,
  now = new Date(),
  timezone = 'Asia/Shanghai',
} = {}) {
  const reportDate = getWeeklyReportRange(now, timezone).reportDate;
  if (reportDate !== formatDateInTimezone(now, timezone)) {
    return { skipped: 0, sent: 0, status: '未发送', reason: 'friday_only' };
  }

  const configuredMetrics = metricOwners
    .filter(owner => owner?.enabled !== false && owner?.remindersEnabled === true)
    .map(owner => ({
      ...owner,
      metricName: normalizeText(owner.metricName),
      owners: normalizeOwners(owner.owners),
    }))
    .filter(owner => owner.metricName);
  const cells = configuredMetrics
    .map(owner => metricCell(metricCells, owner.metricName))
    .map(item => item?.cell)
    .filter(Boolean);
  const values = cells.length && typeof writer?.readCells === 'function'
    ? await writer.readCells(instance.sheetConfig || instance.weeklySheet, instance.sheetId, [...new Set(cells)])
    : {};
  const groups = groupMissingMetrics(configuredMetrics, metricCells, values);
  const previous = normalizeDetails(instance.coreMetricReminderDetails);
  const pending = [];
  let skipped = 0;

  for (const group of groups) {
    const idempotencyKey = metricIdempotencyKey(instance, group.openId);
    if (hasSuccessfulDetail(previous, group.openId, idempotencyKey)) {
      skipped += 1;
      continue;
    }
    pending.push({ ...group, idempotencyKey });
  }

  if (!pending.length) {
    return {
      status: groups.length ? OWNER_STATUS_SUCCESS : '未发送',
      sent: 0,
      skipped,
      details: previous,
    };
  }

  const results = [];
  for (const group of pending) {
    const sentAt = now.getTime();
    if (!group.openId) {
      results.push(buildDetail({
        openId: '',
        sentAt,
        idempotencyKey: group.idempotencyKey,
        errorCode: 'missing_open_id',
      }));
      continue;
    }

    try {
      await messenger.sendTextToOpenId(
        group.openId,
        buildMetricMessage(group, instance),
        group.idempotencyKey,
      );
      results.push(buildDetail({
        openId: group.openId,
        sentAt,
        idempotencyKey: group.idempotencyKey,
      }));
    } catch (error) {
      results.push(buildDetail({
        openId: group.openId,
        sentAt,
        idempotencyKey: group.idempotencyKey,
        errorCode: safeErrorCode(error),
      }));
    }
  }

  const details = mergeDetails(previous, results);
  await persistInstancePatch(bitable, instance, {
    coreMetricReminderDetails: details,
  }, now);

  return {
    status: aggregateStatus(results),
    sent: results.filter(item => item.status === OWNER_STATUS_SUCCESS).length,
    failed: results.filter(item => item.status === OWNER_STATUS_FAILURE).length,
    skipped,
    details,
  };
}

function groupOwnerSections({ rules, instance, draft }) {
  const groups = new Map();
  const cells = draftCells(draft);
  const targets = instance.targets || instance.cellMap || draft.cellMap || {};
  const sortedRules = [...rules]
    .filter(rule => rule?.enabled !== false && rule?.remindOwners === true)
    .sort(compareRules);

  for (const rule of sortedRules) {
    const section = {
      module: normalizeText(rule.module),
      section: normalizeText(rule.target),
      draftText: readSectionDraft(rule, targets, cells),
    };
    for (const owner of normalizeOwners(rule.owners)) {
      const key = owner.openId || `missing:${owner.name || 'owner'}`;
      if (!groups.has(key)) {
        groups.set(key, {
          openId: owner.openId,
          ownerName: owner.name,
          sections: [],
        });
      }
      groups.get(key).sections.push(section);
    }
  }
  return [...groups.values()];
}

function groupMissingMetrics(metricOwners, metricCells, values) {
  const groups = new Map();
  for (const owner of metricOwners) {
    const target = metricCell(metricCells, owner.metricName);
    if (!target || !isBlank(target.value ?? values[target.cell])) continue;
    for (const metricOwner of owner.owners) {
      const key = metricOwner.openId || `missing:${metricOwner.name || 'owner'}`;
      if (!groups.has(key)) {
        groups.set(key, {
          openId: metricOwner.openId,
          ownerName: metricOwner.name,
          missingMetrics: [],
        });
      }
      const metrics = groups.get(key).missingMetrics;
      if (!metrics.includes(owner.metricName)) metrics.push(owner.metricName);
    }
  }
  return [...groups.values()];
}

function readSectionDraft(rule, targets, cells) {
  const spec = targetSpec(rule, targets);
  const currentCells = toCellArray(spec?.current);
  const values = currentCells.map(cell => normalizeDraftValue(cells[cell])).filter(Boolean);
  return values.join('\n');
}

function targetSpec(rule, targets) {
  const key = moduleKey(rule.module);
  const entries = key === 'module2' ? targets.agileProjects : targets.management;
  if (!entries) return null;
  const target = normalizeText(rule.target);
  const exact = entries[target];
  if (exact) return exact;
  const found = Object.entries(entries).find(([name, spec]) => (
    normalizeText(name) === target || (spec?.aliases || []).some(alias => normalizeText(alias) === target)
  ));
  return found?.[1] || null;
}

function buildOwnerMessage(group, instance) {
  const sections = group.sections.map(section => [
    `板块：${section.section}`,
    section.draftText || EMPTY_DRAFT_TEXT,
  ].join('\n')).join('\n\n');
  return [
    '本周周报负责人提醒',
    '',
    sections,
    '',
    '请审核、修改并完成填写。',
    '',
    `周报链接：${sheetUrl(instance)}`,
  ].join('\n');
}

function buildMetricMessage(group, instance) {
  return [
    '本周核心指标提醒',
    '',
    '以下指标目标单元格仍为空，请进入周报表填写：',
    ...group.missingMetrics.map(metric => `- ${metric}`),
    '',
    `周报链接：${sheetUrl(instance)}`,
  ].join('\n');
}

function draftCells(draft) {
  return draft?.cells || draft?.writtenCells || draft?.snapshot || {};
}

function normalizeDraftValue(value) {
  if (Array.isArray(value)) return normalizeDraftValue(value[0]);
  if (value && typeof value === 'object') return normalizeText(value.text ?? value.value);
  return normalizeText(value);
}

function metricCell(metricCells, metricName) {
  if (Array.isArray(metricCells)) {
    const match = metricCells.find(item => normalizeText(item?.metricName || item?.name) === metricName);
    return match ? normalizeMetricCell(match) : null;
  }
  const value = metricCells?.[metricName];
  return value == null ? null : normalizeMetricCell(value);
}

function normalizeMetricCell(value) {
  if (typeof value === 'string') return { cell: value, value: undefined };
  return {
    cell: normalizeText(value?.cell || value?.address || value?.target),
    value: value?.value,
  };
}

function normalizeOwners(owners) {
  const list = Array.isArray(owners) ? owners : owners ? [owners] : [];
  return list.map(owner => ({
    openId: normalizeText(owner?.openId || owner?.id),
    name: normalizeText(owner?.name || owner?.text),
  }));
}

function normalizeDetails(value) {
  if (typeof value === 'string') {
    try {
      return normalizeDetails(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') {
    if (Array.isArray(value.details)) return normalizeDetails(value.details);
    return Object.values(value).filter(item => item && typeof item === 'object');
  }
  return [];
}

function mergeDetails(previous, results) {
  const replaced = new Set(results.map(item => item.idempotencyKey));
  return [...previous.filter(item => !replaced.has(item.idempotencyKey)), ...results];
}

function hasSuccessfulDetail(details, openId, idempotencyKey) {
  return details.some(item => (
    item.openId === openId
      && item.status === OWNER_STATUS_SUCCESS
      && item.idempotencyKey === idempotencyKey
  ));
}

function buildDetail({ openId, sentAt, idempotencyKey, errorCode = '' }) {
  return {
    openId,
    status: errorCode ? OWNER_STATUS_FAILURE : OWNER_STATUS_SUCCESS,
    sentAt,
    idempotencyKey,
    errorCode,
  };
}

function aggregateStatus(details) {
  if (!details.length) return '未发送';
  const successes = details.filter(item => item.status === OWNER_STATUS_SUCCESS).length;
  if (successes === details.length) return OWNER_STATUS_SUCCESS;
  if (!successes) return OWNER_STATUS_FAILURE;
  return '部分成功';
}

function ownerIdempotencyKey(instance, openId) {
  return `weekly-owner:${normalizeText(instance.instanceKey)}:${openId || 'missing-open-id'}`;
}

function metricIdempotencyKey(instance, openId) {
  return `weekly-metric:${normalizeText(instance.instanceKey)}:${openId || 'missing-open-id'}`;
}

function compareRules(left, right) {
  return Number(left?.order || 0) - Number(right?.order || 0)
    || normalizeText(left?.module).localeCompare(normalizeText(right?.module))
    || normalizeText(left?.target).localeCompare(normalizeText(right?.target))
    || normalizeText(left?.recordId).localeCompare(normalizeText(right?.recordId));
}

function moduleKey(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'module2' || normalized === '模块二' || normalized === '2') return 'module2';
  if (normalized === 'module3' || normalized === '模块三' || normalized === '3') return 'module3';
  return normalized;
}

function toCellArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function sheetUrl(instance) {
  return normalizeText(instance.sheetUrl || instance.sheet?.url || instance.sheet?.link || instance.url);
}

function isBlank(value) {
  return normalizeText(value) === '';
}

function normalizeText(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return normalizeText(value.text ?? value.value ?? value.name ?? value.id);
  return String(value ?? '').trim();
}

function safeErrorCode(error) {
  const code = error?.response?.data?.code ?? error?.code;
  return code == null || code === '' ? 'send_failed' : String(code).slice(0, 64);
}

function formatDateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
