import { getReportingUnits, tableIsConfigured } from './config.js';
import { formatNaturalWeekPeriod } from './date-utils.js';
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
const STATUS_TERMS_LONGEST_FIRST = [...STATUS_TERMS]
  .sort((left, right) => right.length - left.length || left.localeCompare(right));

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
  const groups = getReportingUnits(config);
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
      includeRoutineMeetingEvidence: true,
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
  const multiGroupDiagnostics = multipleGroups
    ? groupResults.flatMap(group => group.diagnostics.map(diagnostic => ({
      ...diagnostic,
      group: { name: group.name, project: group.project },
    })))
    : [];
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
      ? ['Multiple groups were previewed; use groups[].cells/evidence/warnings/diagnostics/provider/model because top-level cells and evidence are empty.']
      : []),
    diagnostics: singleGroup?.diagnostics || multiGroupDiagnostics,
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
  const knownNames = collectKnownNames(facts, routing);

  for (const bucket of routing.buckets) {
    const targetContext = buildTargetContext({
      bucket,
      cellMap,
      rules: weeklyConfiguration.rules,
      styleExamples: weeklyConfiguration.styleExamples,
      knownNames,
    });
    if (targetContext.diagnostic) {
      diagnostics.push(targetContext.diagnostic);
      continue;
    }

    const targetEvidence = (bucket.sources?.current || [])
      .map(source => ({
        evidenceId: source.evidenceId,
        date: source.date,
        text: redactKnownNames(source.text, knownNames),
      }))
      .filter(source => normalized(source.text));
    if (!targetEvidence.length) {
      diagnostics.push({
        module: bucket.module,
        target: bucket.target,
        code: 'empty_evidence_after_redaction',
      });
      continue;
    }

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
      knownNames,
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
    provider,
    model,
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

function buildTargetContext({ bucket, cellMap, rules, styleExamples, knownNames }) {
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
    .map(example => ({
      module: bucket.module,
      target: bucket.target,
      contentType,
      weekKey: example.weekKey,
      finalText: redactKnownNames(example.finalText, knownNames),
    }))
    .filter(example => normalized(example.finalText))
    .slice(0, MAX_STYLE_EXAMPLES);
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

function validateTargetResult({ bucket, target, modelCells, knownNames = [] }) {
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
      const validated = validateEntry(entry, evidenceMap, knownNames);
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

function validateEntry(entry, evidenceMap, knownNames = []) {
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
  const memberNames = [...new Set([
    ...knownNames,
    ...sources.map(source => normalized(source.member)),
  ].filter(Boolean))];
  if (memberNames.some(name => text.includes(name))) return { code: 'visible_member_name' };
  if (hasLeadingListMarker(text)) return { code: 'leading_list_marker' };
  if (/下周|明日|明天/.test(text)) return { code: 'next_plan_content' };
  if (/风险|阻塞|覆盖率|缺报/.test(text)) return { code: 'forbidden_content' };
  if (!protectedFactsUnchanged(text, sources)) return { code: 'changed_protected_fact' };

  return { entry: { text, evidenceIds } };
}

function protectedFactsUnchanged(text, sources) {
  return splitSentences(text).every(outputSentence => {
    const outputProfile = protectedProfile(outputSentence);
    if (!hasProtectedValues(outputProfile)) return true;
    return sources.some(source => sourceSupportsSentence(outputSentence, outputProfile, source));
  });
}

function sourceSupportsSentence(outputSentence, outputProfile, source) {
  const metadataDates = extractDateTokens(source.date);
  return splitSentences(source.text).some(sourceSentence => {
    const sourceProfile = protectedProfile(sourceSentence);
    sourceProfile.dates.push(...metadataDates);
    if (!profileTokensAreSourced(outputProfile, sourceProfile)) return false;

    const sourceClauses = splitClauses(sourceSentence);
    return splitClauses(outputSentence).every(outputClause => {
      const clauseProfile = protectedProfile(outputClause);
      if (!hasProtectedValues(clauseProfile)) return true;
      return sourceClauses.some(sourceClause => (
        clauseSupportsProtectedValues(outputClause, clauseProfile, sourceClause, metadataDates)
      ));
    });
  });
}

function clauseSupportsProtectedValues(outputClause, outputProfile, sourceClause, metadataDates) {
  const sourceProfile = protectedProfile(sourceClause);
  sourceProfile.dates.push(...metadataDates);
  if (!profileTokensAreSourced(outputProfile, sourceProfile)) return false;
  if (outputProfile.responsibilities.some(token => !sourceClause.includes(token))) return false;

  const outputContext = protectedContext(outputClause, outputProfile);
  if (!outputContext) return true;
  const sourceContext = protectedContext(sourceClause, sourceProfile);
  return Boolean(sourceContext)
    && (sourceContext.includes(outputContext) || outputContext.includes(sourceContext));
}

function protectedProfile(text) {
  return {
    dates: extractDateTokens(text),
    numbers: extractNumberTokens(text),
    statuses: extractStatusTokens(text),
    responsibilities: extractResponsibilityTokens(text),
  };
}

function hasProtectedValues(profile) {
  return Object.values(profile).some(tokens => tokens.length);
}

function profileTokensAreSourced(output, source) {
  return tokensAreSourced(output.dates, source.dates)
    && tokensAreSourced(output.numbers, source.numbers)
    && tokensAreSourced(output.statuses, source.statuses);
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
  const value = String(text || '');
  const tokens = [];
  for (let index = 0; index < value.length;) {
    const match = STATUS_TERMS_LONGEST_FIRST.find(term => value.startsWith(term, index));
    if (!match) {
      index += 1;
      continue;
    }
    tokens.push(match);
    index += match.length;
  }
  return tokens;
}

function extractResponsibilityTokens(text) {
  const value = String(text || '');
  const tokens = [
    ...(value.match(/(?:责任人|负责人)[:：]?[^，,。；;\s]{1,20}/gu) || []),
    ...(value.match(/由(?!于)[^，,。；;\s]{1,20}/gu) || []),
    ...(value.match(/[^，,。；;\s]{1,12}(?:负责|牵头)/gu) || []),
  ];
  return [...new Set(tokens)];
}

function protectedContext(text, profile) {
  const tokens = Object.values(profile)
    .flat()
    .sort((left, right) => right.length - left.length);
  let context = String(text || '');
  for (const token of tokens) context = context.split(token).join('');
  return context.replace(/[\s，,。；;：:、！？!?（）()\[\]【】]/gu, '');
}

function splitSentences(text) {
  return String(text || '')
    .split(/[。；;！？!?\n]+/u)
    .map(normalized)
    .filter(Boolean);
}

function splitClauses(text) {
  return String(text || '')
    .split(/[，,]+/u)
    .map(normalized)
    .filter(Boolean);
}

function hasLeadingListMarker(text) {
  return /^\s*(?:[0-9０-９]+[.．。、)）]|[(（][0-9０-９]+[)）])\s*/u.test(String(text || ''));
}

function collectKnownNames(facts, routing) {
  return [...new Set([
    ...(facts || []).flatMap(fact => [fact?.reporterName, fact?.memberName]),
    ...(routing?.buckets || []).flatMap(bucket => (
      (bucket.sources?.current || []).map(source => source.member)
    )),
  ].map(normalized).filter(Boolean))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactKnownNames(text, knownNames) {
  let redacted = String(text || '');
  for (const name of knownNames || []) redacted = redacted.split(name).join('');
  return redacted.trim();
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
  return formatNaturalWeekPeriod(startDate, endDate);
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
