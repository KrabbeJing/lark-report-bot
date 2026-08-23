import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { getReportingUnits } from './config.js';
import { buildWeeklyClassificationCandidates } from './weekly-source-router.js';

const CONFIRMED_STATUS = '已确认';
const VALID_FACT_STATUS = '有效';
const REQUIRED_HEADERS = [
  '样本编号',
  '日报日期',
  '日报事项原文',
  '日报提交人',
  '人工正确板块',
  '复核状态',
];

export function prepareWeeklyClassificationLabels({ csv, mappings = [], rules = [] } = {}) {
  const labels = parseConfirmedLabels(csv);
  if (!labels.length) throw new Error('no_confirmed_labels');

  const period = {
    start: labels.map(item => item.date).sort()[0],
    end: labels.map(item => item.date).sort().at(-1),
  };
  const recordIds = new Map();
  const facts = labels.map((label, index) => {
    const recordId = `classification-label-${index + 1}`;
    recordIds.set(recordId, label);
    return {
      recordId,
      reportDate: label.date,
      reporterName: label.memberName,
      factStatus: VALID_FACT_STATUS,
      workItems: [label.text],
    };
  });
  const candidateResult = buildWeeklyClassificationCandidates({
    facts,
    mappings,
    rules,
    cellMap: evaluationCellMap(rules),
    period,
  });
  const candidatesByRecordId = new Map(candidateResult.candidates.map(candidate => (
    [candidate.factRecordId, candidate]
  )));
  const diagnosticsByRecordId = new Map(candidateResult.diagnostics.map(diagnostic => (
    [diagnostic.factRecordId, diagnostic]
  )));

  const items = facts.map(fact => {
    const label = recordIds.get(fact.recordId);
    const candidate = candidatesByRecordId.get(fact.recordId);
    if (!candidate) {
      const code = diagnosticsByRecordId.get(fact.recordId)?.code || 'candidate_not_created';
      throw new Error(`${label.evidenceId}:${code}`);
    }
    const expectedTargets = candidate.allowedTargets.filter(target => (
      target.target === label.expectedTarget
    ));
    if (!expectedTargets.length) {
      throw new Error(`${label.evidenceId}:expected_target_not_allowed`);
    }
    if (expectedTargets.length > 1) {
      throw new Error(`${label.evidenceId}:expected_target_ambiguous`);
    }
    return {
      evidenceId: label.evidenceId,
      date: label.date,
      text: label.text,
      allowedTargets: candidate.allowedTargets.map(({ cells: _cells, ...target }) => target),
      expectedTargetId: expectedTargets[0].targetId,
    };
  });

  return { items };
}

export async function runWeeklyClassificationLabelPreparationCli({
  argv = process.argv.slice(2),
  loadConfig,
  createClient,
  createBitable,
  loadWeeklyConfiguration,
  readFile,
  mkdir,
  realpath,
  lstat,
  writeFile,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
  processRef = process,
} = {}) {
  try {
    const options = parsePreparationArgs(argv);
    const cwd = processRef.cwd?.() || process.cwd();
    validateRelativePath(options.inputPath, cwd);
    validateRelativePath(options.outputPath, cwd);
    const inputPath = await resolveSafeInputPath({ cwd, inputPath: options.inputPath, realpath, lstat });
    await mkdir(path.dirname(path.resolve(cwd, options.outputPath)), { recursive: true });
    const outputPath = await resolveSafeOutputPath({ cwd, outputPath: options.outputPath, realpath, lstat });
    const csv = await readFile(inputPath, 'utf8');
    const labels = parseConfirmedLabels(csv);
    if (!labels.length) throw new Error('no_confirmed_labels');
    const period = labelPeriod(labels);
    const group = getReportingUnits(loadConfig())[0];
    if (!group) throw new Error('reporting_unit_not_configured');
    const configuration = await loadWeeklyConfiguration({
      group,
      bitable: createBitable(createClient()),
      period,
    });
    const result = prepareWeeklyClassificationLabels({
      csv,
      mappings: configuration.mappings,
      rules: configuration.rules,
    });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    stdout(`${JSON.stringify({
      mode: 'local_classification_label_preparation',
      confirmed: result.items.length,
      output: options.outputPath,
    }, null, 2)}\n`);
    return result;
  } catch (error) {
    stderr(`[weekly:classification-labels] ${safePreparationError(error)}\n`);
    processRef.exitCode = 1;
    return null;
  }
}

function parsePreparationArgs(argv) {
  const options = { inputPath: '', outputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--input', '--output'].includes(option)) throw new Error('invalid_arguments');
    const value = argv[index + 1];
    if (!value || String(value).startsWith('--')) throw new Error('invalid_arguments');
    if (option === '--input') options.inputPath = value;
    if (option === '--output') options.outputPath = value;
    index += 1;
  }
  if (!options.inputPath || !options.outputPath) throw new Error('invalid_arguments');
  return options;
}

function parseConfirmedLabels(csv) {
  let records;
  try {
    records = parse(String(csv || ''), {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    throw new Error('invalid_label_csv');
  }
  const headers = records.length ? Object.keys(records[0]) : csvHeaders(csv);
  if (REQUIRED_HEADERS.some(header => !headers.includes(header))) {
    throw new Error('invalid_label_csv_headers');
  }

  const confirmed = records.filter(record => normalized(record['复核状态']) === CONFIRMED_STATUS);
  const evidenceIds = new Set();
  return confirmed.map(record => {
    const evidenceId = normalized(record['样本编号']);
    if (!evidenceId || evidenceIds.has(evidenceId)) {
      throw new Error(`duplicate_evidence_id:${evidenceId || '(blank)'}`);
    }
    evidenceIds.add(evidenceId);
    const date = normalizeYmd(record['日报日期']);
    const text = normalized(record['日报事项原文']);
    const memberName = normalized(record['日报提交人']);
    const expectedTarget = normalized(record['人工正确板块']);
    if (!date || !text || !memberName || !expectedTarget) {
      throw new Error(`${evidenceId}:invalid_confirmed_label`);
    }
    return { evidenceId, date, text, memberName, expectedTarget };
  });
}

function labelPeriod(labels) {
  const dates = labels.map(item => item.date).sort();
  return { start: dates[0], end: dates.at(-1) };
}

function csvHeaders(csv) {
  try {
    return parse(String(csv || ''), { bom: true, to_line: 1, trim: true })[0] || [];
  } catch {
    return [];
  }
}

function evaluationCellMap(rules) {
  const cellMap = { agileProjects: {}, management: {} };
  for (const rule of rules.filter(item => item?.enabled !== false)) {
    const module = moduleKey(rule.module);
    const target = normalized(rule.target);
    if (!module || !target) continue;
    const key = module === 'module2' ? 'agileProjects' : 'management';
    cellMap[key][target] = { current: [`evaluation:${normalized(rule.targetId) || target}`] };
  }
  return cellMap;
}

function normalizeYmd(value) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(normalized(value));
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function moduleKey(value) {
  const module = normalized(value).toLowerCase();
  if (module === '模块二' || module === 'module2') return 'module2';
  if (module === '模块三' || module === 'module3') return 'module3';
  return '';
}

function normalized(value) {
  return String(value || '').trim();
}

async function resolveSafeInputPath({ cwd, inputPath, realpath, lstat }) {
  const [realCwd, realInput] = await Promise.all([
    realpath(cwd),
    realpath(path.resolve(cwd, inputPath)),
  ]);
  if (!isWithin(realCwd, realInput)) throw new Error('invalid_input_path');
  const stats = await lstat(realInput);
  if (!stats.isFile()) throw new Error('invalid_input_path');
  return realInput;
}

async function resolveSafeOutputPath({ cwd, outputPath, realpath, lstat }) {
  const target = path.resolve(cwd, outputPath);
  const [realCwd, realParent] = await Promise.all([
    realpath(cwd),
    realpath(path.dirname(target)),
  ]);
  if (!isWithin(realCwd, realParent)) throw new Error('invalid_output_path');
  try {
    await lstat(target);
    throw new Error('invalid_output_path');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

function validateRelativePath(value, cwd) {
  const candidate = normalized(value);
  if (!candidate || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
    || candidate.split(/[\\/]+/).includes('..')) {
    throw new Error('invalid_path');
  }
  const relative = path.relative(cwd, path.resolve(cwd, candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid_path');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safePreparationError(error) {
  const message = normalized(error?.message);
  if (/^[A-Za-z0-9_-]+:[a-z_]+$/.test(message)) return message;
  return 'weekly:classification-labels failed';
}
