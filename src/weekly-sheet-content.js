const FOLLOW_UP_RE = /(下周|明日|计划|待|协调|跟进|推进|确认|联调|评审|上线|发布|优化)/;
const DEFAULT_EMPTY_VALUE = '';
const EMPTY_WEEKLY_SHEET_CELL_MAP = {
  reportPeriod: '',
  agileProjects: {},
  management: {},
};

export function buildWeeklySheetValues({
  group = {},
  reports = [],
  summary = null,
  weekStart = '',
  weekEnd = '',
  cellMap = EMPTY_WEEKLY_SHEET_CELL_MAP,
} = {}) {
  const values = {};
  const buckets = {
    agileProjects: {},
    management: {},
  };

  setCell(values, cellMap.reportPeriod, formatWeekPeriod(weekStart, weekEnd));

  for (const [bucketName, spec] of Object.entries(cellMap.agileProjects || {})) {
    const bucketReports = filterReportsForAgileBucket(reports, spec, bucketName);
    const currentItems = collectReportItems(bucketReports, ['workItems']);
    const nextItems = collectReportItems(bucketReports, ['tomorrowPlanItems']);
    const fallbackNextItems = nextItems.length
      ? nextItems
      : collectFollowUpItems(bucketReports, ['workItems', 'riskItems']);

    setCell(values, spec.current, formatItemList(currentItems, { maxItems: 4 }));
    setCell(values, spec.next, formatItemList(fallbackNextItems, { maxItems: 3 }));
    buckets.agileProjects[bucketName] = buildBucketMeta(bucketReports, currentItems, fallbackNextItems);
  }

  for (const [bucketName, spec] of Object.entries(cellMap.management || {})) {
    const currentItems = collectMatchingItems(reports, spec, bucketName, ['workItems', 'riskItems'], group);
    const nextItems = collectMatchingItems(reports, spec, bucketName, ['tomorrowPlanItems'], group);
    const fallbackNextItems = nextItems.length
      ? nextItems
      : collectFollowUpItems(filterReportsForBucket(reports, spec, bucketName, group), ['workItems', 'riskItems']);

    setCells(values, spec.current, currentItems, { maxItems: spec.current?.length || 3 });
    setCells(values, spec.next, fallbackNextItems, { maxItems: spec.next?.length || 3 });
    buckets.management[bucketName] = buildBucketMeta(
      filterReportsForBucket(reports, spec, bucketName, group),
      currentItems,
      fallbackNextItems,
    );
  }

  return {
    values,
    buckets,
    summary,
    reportCount: reports.length,
    weekStart,
    weekEnd,
  };
}

export function getWeeklySheetExpectedCells(cellMap = EMPTY_WEEKLY_SHEET_CELL_MAP) {
  const cells = [];
  if (cellMap.reportPeriod) cells.push(cellMap.reportPeriod);
  for (const spec of Object.values(cellMap.agileProjects || {})) {
    cells.push(spec.current, spec.next);
  }
  for (const spec of Object.values(cellMap.management || {})) {
    cells.push(...toCellArray(spec.current), ...toCellArray(spec.next));
  }
  return [...new Set(cells.filter(Boolean))];
}

export function buildWeeklyPreviewBuckets({ reports = [], cellMap = {}, group = {} } = {}) {
  return [
    ...buildAgilePreviewBuckets(reports, cellMap.agileProjects || {}),
    ...buildManagementPreviewBuckets(reports, cellMap.management || {}, group),
  ];
}

function buildAgilePreviewBuckets(reports, specs) {
  return Object.entries(specs).map(([name, spec]) => {
    const bucketReports = filterReportsForAgileBucket(reports, spec, name);
    const current = collectPreviewReportItems(bucketReports, ['workItems'], 'current');
    const nextDirect = collectPreviewReportItems(bucketReports, ['tomorrowPlanItems'], 'next');
    const next = nextDirect.length
      ? nextDirect
      : collectPreviewFollowUpItems(bucketReports, ['workItems', 'riskItems'], 'next');
    return buildPreviewBucket('agileProjects', name, spec, current, next);
  });
}

function buildManagementPreviewBuckets(reports, specs, group) {
  return Object.entries(specs).map(([name, spec]) => {
    const bucketReports = filterReportsForBucket(reports, spec, name, group);
    const current = collectMatchingPreviewItems(
      reports, spec, name, ['workItems', 'riskItems'], group, 'current',
    );
    const nextDirect = collectMatchingPreviewItems(
      reports, spec, name, ['tomorrowPlanItems'], group, 'next',
    );
    const next = nextDirect.length
      ? nextDirect
      : collectPreviewFollowUpItems(bucketReports, ['workItems', 'riskItems'], 'next');
    return buildPreviewBucket('management', name, spec, current, next);
  });
}

function buildPreviewBucket(module, name, spec, current, next) {
  const maxTargets = module === 'management' ? 3 : Infinity;
  return {
    module,
    name,
    targets: {
      current: toCellArray(spec.current).slice(0, maxTargets),
      next: toCellArray(spec.next).slice(0, maxTargets),
    },
    sources: { current, next },
  };
}

function collectPreviewReportItems(reports, keys, category) {
  const items = [];
  for (const report of reports) {
    for (const key of keys) {
      for (const [itemIndex, text] of toTextArray(report[key]).entries()) {
        items.push(toPreviewItem(report, text, category, key, itemIndex));
      }
    }
  }
  return dedupePreviewItems(items);
}

function collectMatchingPreviewItems(reports, spec, bucketName, keys, group, category) {
  const aliases = buildAliases(spec, bucketName, group);
  const items = [];
  for (const report of reports) {
    const reportScoped = reportMatchesBucket(report, spec, bucketName, group, { ignoreItemText: true });
    for (const key of keys) {
      for (const [itemIndex, text] of toTextArray(report[key]).entries()) {
        if (reportScoped || aliases.some(alias => includesNormalized(text, alias))) {
          items.push(toPreviewItem(report, text, category, key, itemIndex));
        }
      }
    }
  }
  return dedupePreviewItems(items);
}

function collectPreviewFollowUpItems(reports, keys, category) {
  const items = [];
  for (const report of reports) {
    for (const key of keys) {
      for (const [itemIndex, text] of toTextArray(report[key]).entries()) {
        if (FOLLOW_UP_RE.test(text)) {
          items.push(toPreviewItem(report, text, category, key, itemIndex));
        }
      }
    }
  }
  return dedupePreviewItems(items);
}

function toPreviewItem(report, text, category, sourceField, itemIndex) {
  const factRecordId = String(report.recordId || '');
  return {
    evidenceId: [factRecordId, category, sourceField, itemIndex].join(':'),
    factRecordId,
    category,
    sourceField,
    itemIndex,
    date: String(report.reportDate || ''),
    member: report.reporterName || report.senderOpenId || '',
    text: cleanItemText(text),
  };
}

function dedupePreviewItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.evidenceId;
    if (!item.factRecordId || !item.text || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterReportsForBucket(reports, spec, bucketName, group) {
  return reports.filter(report => reportMatchesBucket(report, spec, bucketName, group));
}

function filterReportsForAgileBucket(reports, spec, bucketName) {
  const aliases = buildAliases(spec, bucketName);
  return reports.filter(report => (
    aliases.some(alias => includesNormalized(report.agileGroup || '', alias))
  ));
}

function collectMatchingItems(reports, spec, bucketName, keys, group) {
  const aliases = buildAliases(spec, bucketName, group);
  const items = [];

  for (const report of reports) {
    const reportScoped = reportMatchesBucket(report, spec, bucketName, group, { ignoreItemText: true });
    for (const key of keys) {
      for (const text of toTextArray(report[key])) {
        if (reportScoped || aliases.some(alias => includesNormalized(text, alias))) {
          items.push(toItem(report, text));
        }
      }
    }
  }

  return dedupeItems(items);
}

function collectReportItems(reports, keys) {
  const items = [];
  for (const report of reports) {
    for (const key of keys) {
      for (const text of toTextArray(report[key])) {
        items.push(toItem(report, text));
      }
    }
  }
  return dedupeItems(items);
}

function collectFollowUpItems(reports, keys) {
  const items = [];
  for (const report of reports) {
    for (const key of keys) {
      for (const text of toTextArray(report[key])) {
        if (FOLLOW_UP_RE.test(text)) {
          items.push(toItem(report, text));
        }
      }
    }
  }
  return dedupeItems(items);
}

function reportMatchesBucket(report, spec, bucketName, group, options = {}) {
  const aliases = buildAliases(spec, bucketName, group);
  const scopedText = [
    report.project,
    report.agileGroup,
    report.teamName,
    report.sourceGroup,
  ].filter(Boolean).join('\n');
  if (aliases.some(alias => includesNormalized(scopedText, alias))) return true;

  if (bucketMatchesGroup(group, aliases)) return true;
  if (options.ignoreItemText) return false;

  const itemText = [
    report.rawText,
    ...toTextArray(report.workItems),
    ...toTextArray(report.tomorrowPlanItems),
    ...toTextArray(report.riskItems),
  ].filter(Boolean).join('\n');
  return aliases.some(alias => includesNormalized(itemText, alias));
}

function bucketMatchesGroup(group, aliases) {
  const groupText = [group.project, group.name].filter(Boolean).join('\n');
  return Boolean(groupText) && aliases.some(alias => includesNormalized(groupText, alias));
}

function buildAliases(spec, bucketName) {
  return [bucketName, ...(spec.aliases || [])]
    .map(alias => String(alias || '').trim())
    .filter(Boolean);
}

function setCell(values, cell, value) {
  if (!cell) return;
  values[cell] = value || DEFAULT_EMPTY_VALUE;
}

function setCells(values, cells, items, options) {
  const cellList = toCellArray(cells);
  const formattedItems = items.slice(0, options.maxItems).map(item => formatSingleItem(item));
  for (let index = 0; index < cellList.length; index += 1) {
    setCell(values, cellList[index], formattedItems[index] || DEFAULT_EMPTY_VALUE);
  }
}

function toCellArray(cells) {
  if (!cells) return [];
  return Array.isArray(cells) ? cells : [cells];
}

function formatItemList(items, { maxItems }) {
  const selected = items.slice(0, maxItems);
  if (!selected.length) return DEFAULT_EMPTY_VALUE;
  return selected.map((item, index) => `${index + 1}. ${formatSingleItem(item)}`).join('\n');
}

function formatSingleItem(item) {
  const text = cleanItemText(item.text);
  return item.member ? `${item.member}：${text}` : text;
}

function cleanItemText(text) {
  return String(text || '')
    .replace(/^[\s【\[]*\d+[\]】)、.．\s]*/, '')
    .replace(/[；;。.\s]+$/, '')
    .trim();
}

function toItem(report, text) {
  return {
    member: report.reporterName || report.senderOpenId || '',
    text: cleanItemText(text),
  };
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.member}|${item.text}`;
    if (!item.text || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildBucketMeta(reports, currentItems, nextItems) {
  const members = new Set(reports.map(report => report.reporterName).filter(Boolean));
  return {
    reportCount: reports.length,
    memberCount: members.size,
    currentItemCount: currentItems.length,
    nextItemCount: nextItems.length,
  };
}

function toTextArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (value == null || value === '') return [];
  return String(value)
    .split(/\n+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function includesNormalized(text, keyword) {
  const normalizedText = normalizeForMatch(text);
  const normalizedKeyword = normalizeForMatch(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  return normalizedText.includes(normalizedKeyword);
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/项目组/g, '')
    .replace(/[，。；;、:：【】\[\]（）()]/g, '');
}

function formatWeekPeriod(weekStart, weekEnd) {
  if (!weekStart && !weekEnd) return DEFAULT_EMPTY_VALUE;
  if (!weekEnd) return compactDate(weekStart);
  if (!weekStart) return compactDate(weekEnd);
  return `${compactDate(weekStart)}-${compactDate(weekEnd)}`;
}

function compactDate(ymd) {
  return String(ymd || '').replace(/-/g, '.');
}
