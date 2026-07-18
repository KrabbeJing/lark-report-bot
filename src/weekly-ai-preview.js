import { buildWeeklyPreviewBuckets } from './weekly-sheet-content.js';
import { tableIsConfigured } from './config.js';

const VALID_FACT_STATUS = '有效';

export function parseWeeklyAiPreviewArgs(argv = []) {
  const values = { startDate: '', endDate: '', outputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--start', '--end', '--output'].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || String(value).startsWith('--')) throw new Error(`Missing value for ${option}`);
    if (option === '--start') values.startDate = value;
    if (option === '--end') values.endDate = value;
    if (option === '--output') values.outputPath = value;
    index += 1;
  }
  if (!isYmd(values.startDate) || !isYmd(values.endDate)) {
    throw new Error('--start and --end must be valid YYYY-MM-DD dates');
  }
  if (values.startDate > values.endDate) throw new Error('start must not be after end');
  return values;
}

export async function runWeeklyAiPreview({
  config,
  bitable,
  sheetWriter,
  aiProvider,
  options = {},
} = {}) {
  const normalizedOptions = validateOptions(options);
  const groups = config?.groups || [];
  for (const group of groups) {
    if (!tableIsConfigured(group.dailyFactTable)) {
      throw new Error(`dailyFactTable must be configured for group ${group.name || group.project || 'group'}`);
    }
  }
  const groupResults = [];
  const preparedGroups = [];
  let provider = aiProvider?.name || '';
  let model = aiProvider?.model || '';

  for (const group of groups) {
    const cellMap = await sheetWriter.discoverTemplateTargets(
      group.weeklySheet,
      group.weeklySheet?.templateSheetId,
      { aliasMap: group.weeklySheet?.entityAliases },
    );
    const listed = await bitable.listAllDailyReportsForRange(
      group,
      normalizedOptions.startDate,
      normalizedOptions.endDate,
    );
    const reports = selectPreviewFacts(listed, normalizedOptions);
    const buckets = buildWeeklyPreviewBuckets({ reports, cellMap, group });
    preparedGroups.push({ group, cellMap, buckets, reportCount: reports.length });
  }

  for (const { group, cellMap, buckets, reportCount } of preparedGroups) {
    const result = await previewGroup({
      group,
      cellMap,
      buckets,
      reportCount,
      aiProvider,
      options: normalizedOptions,
    });
    groupResults.push(result.group);
    provider = result.provider || provider;
    model = result.model || model;
  }

  const singleGroup = groupResults.length === 1 ? groupResults[0] : null;
  const multipleGroups = groupResults.length > 1;

  return {
    mode: 'read_only_preview',
    weekStart: normalizedOptions.startDate,
    weekEnd: normalizedOptions.endDate,
    provider,
    model,
    groups: groupResults,
    cells: singleGroup?.cells || {},
    evidence: singleGroup?.evidence || {},
    warnings: singleGroup?.warnings || (multipleGroups
      ? ['Multiple groups were previewed; use groups[].cells/evidence/warnings because top-level cells and evidence are empty.']
      : []),
  };
}

function validateOptions(options) {
  const startDate = String(options.startDate || '');
  const endDate = String(options.endDate || '');
  if (!isYmd(startDate) || !isYmd(endDate)) throw new Error('start and end must be valid dates');
  if (startDate > endDate) throw new Error('start must not be after end');
  return { startDate, endDate, outputPath: String(options.outputPath || '') };
}

function isYmd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function selectPreviewFacts(reports, { startDate, endDate }) {
  const selected = new Map();
  for (const report of reports || []) {
    if (report?.factStatus !== VALID_FACT_STATUS) continue;
    if (report.reportDate < startDate || report.reportDate > endDate) continue;
    const identity = [
      report.memberOpenId || report.reporterName || report.senderOpenId || '',
      report.reportDate || '',
      report.effectiveSource || report.source || '',
    ].join('|');
    const existing = selected.get(identity);
    if (!existing || compareFacts(report, existing) > 0) selected.set(identity, report);
  }
  return [...selected.values()];
}

function compareFacts(left, right) {
  const leftTime = sourceTimestamp(left.sourceTime);
  const rightTime = sourceTimestamp(right.sourceTime);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left.recordId || '').localeCompare(String(right.recordId || ''));
}

function sourceTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function previewGroup({ group, cellMap, buckets, reportCount, aiProvider, options }) {
  const cells = buildEmptyCells(cellMap, buckets, options);
  const evidence = {};
  const warnings = [];
  let provider = aiProvider?.name || '';
  let model = aiProvider?.model || '';

  for (const bucket of buckets) {
    if (!bucket.sources.current.length && !bucket.sources.next.length) {
      warnings.push(`${group.project || group.name || 'group'}/${bucket.name}: 空事实分桶`);
      continue;
    }
    const modelResult = await aiProvider.generateWeeklySheetPreview({
      group: { name: group.name || '', project: group.project || '' },
      reports: buildBucketInput(bucket),
      weekStart: options.startDate,
      weekEnd: options.endDate,
      cellMap: buildBucketCellMap(bucket),
    });
    provider = modelResult?.provider || provider;
    model = modelResult?.model || model;
    const validated = validateBucketResult(bucket, modelResult?.cells);
    Object.assign(cells, validated.cells);
    Object.assign(evidence, validated.evidence);
    warnings.push(...validated.warnings.map(warning => `${bucket.name}: ${warning}`));
  }

  return {
    provider,
    model,
    cells,
    evidence,
    warnings,
    group: {
      name: group.name || group.project || '',
      project: group.project || '',
      reportCount,
      bucketCount: buckets.length,
      cells,
      evidence,
      warnings,
    },
  };
}

function buildEmptyCells(cellMap, buckets, { startDate, endDate }) {
  const cells = {};
  if (cellMap?.reportPeriod) cells[cellMap.reportPeriod] = formatWeekPeriod(startDate, endDate);
  for (const cell of getCoreMetricCells(cellMap)) cells[cell] = '';
  for (const bucket of buckets) {
    for (const cell of [...bucket.targets.current, ...bucket.targets.next]) cells[cell] = '';
  }
  return cells;
}

function getCoreMetricCells(cellMap = {}) {
  return ['coreMetrics', 'metrics', 'coreMetric']
    .flatMap(key => collectCells(cellMap[key]))
    .filter(Boolean);
}

function collectCells(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectCells);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectCells);
}

function formatWeekPeriod(startDate, endDate) {
  return `${startDate.replace(/-/g, '.')}-${endDate.replace(/-/g, '.')}`;
}

function buildBucketInput(bucket) {
  return Object.values(bucket.sources).flatMap(sources => sources.map(source => {
    const report = {
      evidenceId: source.evidenceId,
      factRecordId: source.factRecordId,
      category: source.category,
      sourceField: source.sourceField,
      itemIndex: source.itemIndex,
      reportDate: source.date,
      reporterName: source.member,
      workItems: [],
      tomorrowPlanItems: [],
      riskItems: [],
    };
    if (Object.hasOwn(report, source.sourceField)) report[source.sourceField].push(source.text);
    return report;
  }));
}

function buildBucketCellMap(bucket) {
  const spec = {
    current: bucket.targets.current.length === 1 ? bucket.targets.current[0] : bucket.targets.current,
    next: bucket.targets.next.length === 1 ? bucket.targets.next[0] : bucket.targets.next,
  };
  return bucket.module === 'agileProjects'
    ? { agileProjects: { [bucket.name]: spec } }
    : { management: { [bucket.name]: spec } };
}

function validateBucketResult(bucket, modelCells) {
  const cells = {};
  const evidence = {};
  const warnings = [];
  const allowedCells = new Set([...bucket.targets.current, ...bucket.targets.next]);
  const allEvidence = new Map(
    [...bucket.sources.current, ...bucket.sources.next].map(item => [item.evidenceId, item]),
  );
  const evidenceByCell = new Map([
    ...bucket.targets.current.map(cell => [cell, new Map(bucket.sources.current.map(item => [item.evidenceId, item]))]),
    ...bucket.targets.next.map(cell => [cell, new Map(bucket.sources.next.map(item => [item.evidenceId, item]))]),
  ]);
  if (!modelCells || typeof modelCells !== 'object' || Array.isArray(modelCells)) {
    warnings.push('模型输出为空');
    return { cells, evidence, warnings };
  }

  for (const [cell, entries] of Object.entries(modelCells)) {
    if (!allowedCells.has(cell)) {
      warnings.push(`白名单外单元格 ${cell} 已丢弃`);
      continue;
    }
    if (!Array.isArray(entries)) {
      warnings.push(`${cell} 不是事项数组，已丢弃`);
      continue;
    }
    const maxEntries = bucket.module === 'management' ? 1 : Infinity;
    const allowedEvidence = evidenceByCell.get(cell);
    const accepted = [];
    for (const entry of entries) {
      if (accepted.length >= maxEntries) break;
      if (entry?.text === '' && Array.isArray(entry?.evidenceIds) && entry.evidenceIds.length === 0) continue;
      const text = String(entry?.text || '').trim();
      const evidenceIds = Array.isArray(entry?.evidenceIds) ? entry.evidenceIds : [];
      const knownIds = [...new Set(evidenceIds.filter(id => allowedEvidence.has(id)))];
      if (evidenceIds.some(id => !allEvidence.has(id))) warnings.push(`${cell} 包含未知 evidenceId，已丢弃未知引用`);
      if (evidenceIds.some(id => allEvidence.has(id) && !allowedEvidence.has(id))) {
        warnings.push(`${cell} evidenceId 不属于对应单元格来源，已丢弃`);
      }
      if (!text || !knownIds.length) {
        warnings.push(`${cell} 缺少有效证据或文本，已丢弃`);
        continue;
      }
      accepted.push({ text, evidenceIds: knownIds });
    }
    if (!accepted.length) continue;
    cells[cell] = bucket.module === 'agileProjects'
      ? accepted.map((item, index) => `${index + 1}. ${formatPreviewItem(item, allowedEvidence)}`).join('\n')
      : formatPreviewItem(accepted[0], allowedEvidence);
    evidence[cell] = uniqueEvidence(accepted, allowedEvidence);
  }
  return { cells, evidence, warnings };
}

function formatPreviewItem(item, allowedEvidence) {
  const source = allowedEvidence.get(item.evidenceIds[0]);
  return source?.member ? `${source.member}：${item.text}` : item.text;
}

function uniqueEvidence(entries, allowedEvidence) {
  const ids = [...new Set(entries.flatMap(entry => entry.evidenceIds))];
  return ids.map(id => {
    const source = allowedEvidence.get(id);
    return {
      evidenceId: id,
      factRecordId: source.factRecordId,
      date: source.date,
      member: source.member,
    };
  });
}
