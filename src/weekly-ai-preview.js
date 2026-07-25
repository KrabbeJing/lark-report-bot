import { tableIsConfigured } from './config.js';
import { loadWeeklyConfiguration } from './weekly-config-repository.js';
import { routeWeeklyFacts } from './weekly-source-router.js';

const VALID_FACT_STATUS = '有效';
const MODULE_TWO = 'module2';
const MODULE_THREE = 'module3';
const MIN_STYLE_EXAMPLES = 3;
const MAX_STYLE_EXAMPLES = 5;
const STATUS_TERMS = [
  '尚未完成',
  '未完成',
  '已完成',
  '已上线',
  '已解决',
  '待确认',
  '计划中',
  '推进中',
  '进行中',
  '延期',
  '延迟',
  '完成',
  '上线',
  '解决',
  '通过',
  '失败',
  '成功',
];

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
  let provider = aiProvider?.name || '';
  let model = aiProvider?.model || '';
  for (const group of groups) {
    const listedFacts = await bitable.listAllDailyReportsForRange(
      group,
      normalizedOptions.startDate,
      normalizedOptions.endDate,
    );
    const facts = selectPreviewFacts(listedFacts, normalizedOptions);
    const weeklyConfiguration = await loadWeeklyConfiguration({
      group,
      bitable,
      period: {
        start: normalizedOptions.startDate,
        end: normalizedOptions.endDate,
      },
    });
    const cellMap = await sheetWriter.discoverTemplateTargets(
      group.weeklySheet,
      group.weeklySheet?.templateSheetId,
      { aliasMap: group.weeklySheet?.entityAliases },
    );
    const routing = routeWeeklyFacts({
      facts,
      mappings: weeklyConfiguration.mappings,
      rules: weeklyConfiguration.rules,
      cellMap,
      period: {
        start: normalizedOptions.startDate,
        end: normalizedOptions.endDate,
      },
    });
    const result = await previewGroup({
      group,
      cellMap,
      facts,
      routing,
      weeklyConfiguration,
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
    diagnostics: singleGroup?.diagnostics || [],
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

async function previewGroup({
  group,
  cellMap,
  facts,
  routing,
  weeklyConfiguration,
  aiProvider,
  options,
}) {
  const cells = buildEmptyCurrentCells(cellMap, options);
  const evidence = {};
  const warnings = [...weeklyConfiguration.warnings];
  const diagnostics = [...routing.diagnostics];
  let provider = aiProvider?.name || '';
  let model = aiProvider?.model || '';

  for (const bucket of routing.buckets) {
    const targetContext = buildTargetContext({
      bucket,
      cellMap,
      rules: weeklyConfiguration.rules,
      styleExamples: weeklyConfiguration.styleExamples,
    });
    if (targetContext.diagnostic) {
      diagnostics.push(targetContext.diagnostic);
      continue;
    }

    const targetEvidence = (bucket.sources?.current || []).map(source => ({
      evidenceId: source.evidenceId,
      date: source.date,
      text: source.text,
    }));
    if (!targetEvidence.length) continue;

    let modelResult;
    try {
      modelResult = await aiProvider.generateWeeklySheetPreview({
        group: { name: group.name || '', project: group.project || '' },
        target: targetContext.target,
        evidence: targetEvidence,
        styleExamples: targetContext.styleExamples,
        weekStart: options.startDate,
        weekEnd: options.endDate,
      });
    } catch (error) {
      diagnostics.push({
        module: bucket.module,
        target: bucket.target,
        code: 'provider_error',
        detail: safeProviderError(error),
      });
      continue;
    }

    provider = modelResult?.provider || provider;
    model = modelResult?.model || model;
    const validated = validateTargetResult({
      bucket,
      target: targetContext.target,
      modelCells: modelResult?.cells,
    });
    diagnostics.push(...validated.diagnostics);
    Object.assign(cells, validated.cells);
    Object.assign(evidence, validated.evidence);
  }

  const groupResult = {
    name: group.name || group.project || '',
    project: group.project || '',
    reportCount: facts.length,
    bucketCount: routing.buckets.length,
    cells,
    evidence,
    warnings,
    diagnostics,
  };
  return {
    provider,
    model,
    group: groupResult,
  };
}

function buildEmptyCurrentCells(cellMap, { startDate, endDate }) {
  const cells = {};
  if (cellMap?.reportPeriod) cells[cellMap.reportPeriod] = formatWeekPeriod(startDate, endDate);
  for (const spec of Object.values(cellMap?.agileProjects || {})) {
    for (const cell of toCellArray(spec?.current)) cells[cell] = [];
  }
  for (const spec of Object.values(cellMap?.management || {})) {
    for (const cell of toCellArray(spec?.current)) cells[cell] = [];
  }
  return cells;
}

function buildTargetContext({ bucket, cellMap, rules, styleExamples }) {
  const matchingRules = rules
    .filter(rule => moduleKey(rule.module) === bucket.module)
    .filter(rule => normalized(rule.target) === normalized(bucket.target))
    .sort((left, right) => (
      Number(left.order || 0) - Number(right.order || 0)
      || normalized(left.recordId).localeCompare(normalized(right.recordId))
    ));
  const contentTypes = [...new Set(matchingRules.map(rule => normalized(rule.contentType)).filter(Boolean))];
  if (contentTypes.length !== 1) {
    return {
      diagnostic: {
        module: bucket.module,
        target: bucket.target,
        code: contentTypes.length ? 'ambiguous_content_type' : 'missing_content_type',
      },
    };
  }

  const contentType = contentTypes[0];
  const exactStyles = styleExamples
    .filter(example => moduleKey(example.module) === bucket.module)
    .filter(example => normalized(example.target) === normalized(bucket.target))
    .filter(example => normalized(example.contentType) === contentType)
    .sort(compareStyleExamples)
    .slice(0, MAX_STYLE_EXAMPLES)
    .map(example => ({
      module: bucket.module,
      target: bucket.target,
      contentType,
      weekKey: example.weekKey,
      finalText: example.finalText,
    }));
  if (exactStyles.length < MIN_STYLE_EXAMPLES) {
    return {
      diagnostic: {
        module: bucket.module,
        target: bucket.target,
        contentType,
        code: 'insufficient_style_examples',
        count: exactStyles.length,
      },
    };
  }

  return {
    target: {
      module: bucket.module,
      target: bucket.target,
      contentType,
      cells: targetCurrentCells(bucket, cellMap),
    },
    styleExamples: exactStyles,
  };
}

function compareStyleExamples(left, right) {
  return normalized(right.weekKey).localeCompare(normalized(left.weekKey))
    || normalized(right.reviewedAt).localeCompare(normalized(left.reviewedAt))
    || normalized(right.recordId).localeCompare(normalized(left.recordId));
}

function targetCurrentCells(bucket, cellMap) {
  const entries = bucket.module === MODULE_TWO
    ? cellMap?.agileProjects
    : bucket.module === MODULE_THREE
      ? cellMap?.management
      : {};
  const spec = Object.entries(entries || {})
    .find(([target]) => normalized(target) === normalized(bucket.target))?.[1];
  return toCellArray(spec?.current);
}

function validateTargetResult({ bucket, target, modelCells }) {
  const cells = {};
  const evidence = {};
  const diagnostics = [];
  const base = { module: bucket.module, target: bucket.target };
  const allowedCells = new Set(target.cells);
  const evidenceMap = new Map(
    (bucket.sources?.current || []).map(source => [source.evidenceId, source]),
  );

  if (!modelCells || typeof modelCells !== 'object' || Array.isArray(modelCells)) {
    diagnostics.push({ ...base, code: 'invalid_model_cells' });
    return { cells, evidence, diagnostics };
  }
  const outputCells = Object.keys(modelCells);
  const invalidCell = outputCells.find(cell => !allowedCells.has(cell));
  if (invalidCell) {
    diagnostics.push({ ...base, code: 'invalid_cell', cell: invalidCell });
    return { cells, evidence, diagnostics };
  }
  const nonEmptyCells = outputCells.filter(cell => (
    Array.isArray(modelCells[cell])
    && modelCells[cell].some(entry => normalized(entry?.text))
  ));
  if (bucket.module === MODULE_THREE && nonEmptyCells.length > 3) {
    diagnostics.push({ ...base, code: 'module3_cell_limit' });
    return { cells, evidence, diagnostics };
  }

  for (const [cell, entries] of Object.entries(modelCells)) {
    if (!Array.isArray(entries)) {
      diagnostics.push({ ...base, cell, code: 'invalid_entries' });
      continue;
    }
    if (bucket.module === MODULE_THREE && entries.filter(entry => normalized(entry?.text)).length > 1) {
      diagnostics.push({ ...base, cell, code: 'module3_entry_limit' });
      continue;
    }
    const accepted = [];
    for (const entry of entries) {
      if (isExplicitEmptyEntry(entry)) continue;
      const validated = validateEntry(entry, evidenceMap);
      if (validated.code) {
        diagnostics.push({ ...base, cell, code: validated.code });
        continue;
      }
      accepted.push(validated.entry);
    }
    if (!accepted.length) continue;
    cells[cell] = accepted;
    evidence[cell] = uniqueEvidence(accepted, evidenceMap);
  }
  return { cells, evidence, diagnostics };
}

function validateEntry(entry, evidenceMap) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.text !== 'string'
    || !Array.isArray(entry.evidenceIds)
    || entry.evidenceIds.some(id => typeof id !== 'string')) {
    return { code: 'invalid_entry' };
  }
  const text = entry.text.trim();
  const evidenceIds = [...new Set(entry.evidenceIds)];
  if (!text || !evidenceIds.length) return { code: 'invalid_entry' };
  if (evidenceIds.some(id => !evidenceMap.has(id))) return { code: 'invalid_evidence' };

  const sources = evidenceIds.map(id => evidenceMap.get(id));
  const memberNames = [...new Set(sources.map(source => normalized(source.member)).filter(Boolean))];
  if (memberNames.some(name => text.includes(name))) return { code: 'visible_member_name' };
  if (/下周|明日|明天/.test(text)) return { code: 'next_plan_content' };
  if (/风险|阻塞|覆盖率|缺报/.test(text)) return { code: 'forbidden_content' };
  if (!protectedFactsUnchanged(text, sources)) return { code: 'changed_protected_fact' };

  return { entry: { text, evidenceIds } };
}

function protectedFactsUnchanged(text, sources) {
  const sourceText = sources
    .flatMap(source => [source.date, source.text])
    .filter(Boolean)
    .join('\n');
  return tokensAreSourced(extractDateTokens(text), extractDateTokens(sourceText))
    && tokensAreSourced(extractNumberTokens(text), extractNumberTokens(sourceText))
    && tokensAreSourced(extractStatusTokens(text), extractStatusTokens(sourceText))
    && tokensAreSourced(
      extractResponsibilityTokens(text),
      extractResponsibilityTokens(sourceText),
    );
}

function tokensAreSourced(outputTokens, sourceTokens) {
  const allowed = new Set(sourceTokens);
  return outputTokens.every(token => allowed.has(token));
}

function extractDateTokens(text) {
  return String(text || '').match(
    /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}日/g,
  ) || [];
}

function extractNumberTokens(text) {
  return String(text || '').match(/\d+(?:[.,]\d+)*%?/g) || [];
}

function extractStatusTokens(text) {
  return STATUS_TERMS.filter(term => String(text || '').includes(term));
}

function extractResponsibilityTokens(text) {
  return String(text || '').match(/(?:责任人|负责人|由)[^，。；;\s]{1,12}/g) || [];
}

function isExplicitEmptyEntry(entry) {
  return entry?.text === ''
    && Array.isArray(entry?.evidenceIds)
    && entry.evidenceIds.length === 0;
}

function uniqueEvidence(entries, evidenceMap) {
  return [...new Set(entries.flatMap(entry => entry.evidenceIds))].map(evidenceId => {
    const source = evidenceMap.get(evidenceId);
    return {
      evidenceId,
      factRecordId: source.factRecordId,
      date: source.date,
      member: source.member,
    };
  });
}

function safeProviderError(error) {
  const message = String(error?.message || '');
  if (message === 'AI preview request timed out') return 'timeout';
  if (message === 'AI preview returned invalid JSON') return 'invalid_json';
  const statusMatch = /^AI preview request failed: status=(\d{3})/.exec(message);
  if (statusMatch) return `status=${statusMatch[1]}`;
  return 'request_failed';
}

function formatWeekPeriod(startDate, endDate) {
  return `${startDate.replace(/-/g, '.')}-${endDate.replace(/-/g, '.')}`;
}

function moduleKey(value) {
  const key = normalized(value).toLowerCase();
  if (['模块二', 'module2', 'module 2', '2'].includes(key)) return MODULE_TWO;
  if (['模块三', 'module3', 'module 3', '3'].includes(key)) return MODULE_THREE;
  return key;
}

function normalized(value) {
  return String(value || '').trim();
}

function toCellArray(cells) {
  if (!cells) return [];
  return (Array.isArray(cells) ? cells : [cells]).map(normalized).filter(Boolean);
}
