const DEFAULT_EMPTY_VALUE = '';
const EMPTY_WEEKLY_SHEET_CELL_MAP = {
  reportPeriod: '',
  agileProjects: {},
  management: {},
};

export function buildWeeklySheetValues({
  reports = [],
  summary = null,
  weekStart = '',
  weekEnd = '',
  cellMap = EMPTY_WEEKLY_SHEET_CELL_MAP,
  routing = null,
} = {}) {
  const values = {};
  const buckets = routing?.buckets || [];

  setCell(values, cellMap.reportPeriod, formatWeekPeriod(weekStart, weekEnd));
  initializeCurrentCells(values, cellMap);

  for (const bucket of buckets) {
    setBucketCurrentValues(values, bucket);
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
    cells.push(...toCellArray(spec.current));
  }
  for (const spec of Object.values(cellMap.management || {})) {
    cells.push(...toCellArray(spec.current));
  }
  return [...new Set(cells.filter(Boolean))];
}

export function buildWeeklyPreviewBuckets({ routing = null } = {}) {
  return routing?.buckets || [];
}

function initializeCurrentCells(values, cellMap) {
  for (const cell of getWeeklySheetExpectedCells(cellMap)) {
    if (cell !== cellMap.reportPeriod) setCell(values, cell, DEFAULT_EMPTY_VALUE);
  }
}

function setBucketCurrentValues(values, bucket) {
  const cells = toCellArray(bucket?.targets?.current);
  const items = bucket?.sources?.current || [];
  if (!cells.length) return;
  if (cells.length === 1) {
    setCell(values, cells[0], formatItemList(items, { maxItems: 4 }));
    return;
  }

  for (const [index, cell] of cells.entries()) {
    setCell(values, cell, items[index] ? formatSingleItem(items[index]) : DEFAULT_EMPTY_VALUE);
  }
}

function setCell(values, cell, value) {
  if (!cell) return;
  values[cell] = value || DEFAULT_EMPTY_VALUE;
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

function formatWeekPeriod(weekStart, weekEnd) {
  if (!weekStart && !weekEnd) return DEFAULT_EMPTY_VALUE;
  if (!weekEnd) return compactDate(weekStart);
  if (!weekStart) return compactDate(weekEnd);
  return `${compactDate(weekStart)}-${compactDate(weekEnd)}`;
}

function compactDate(ymd) {
  return String(ymd || '').replace(/-/g, '.');
}
