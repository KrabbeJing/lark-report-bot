const MODULES = {
  metrics: '一、核心指标完成情况',
  agileProjects: '二、敏捷项目组工作进展',
  management: '三、部门管理工作',
};

const CONTENT_LABELS = {
  agileProjects: {
    本周重点事项说明: 'current',
    下周工作计划: 'next',
  },
  management: {
    本周工作进展: 'current',
    下周工作计划: 'next',
  },
};

export function normalizeSheetCellText(value) {
  return flattenSheetCellText(value).replace(/\r\n/g, '\n').trim();
}

export function locateWeeklyTemplateTargets(values, options = {}) {
  const rows = Array.isArray(values) ? values : [];
  const managementCellLimit = Number(options.managementCellLimit ?? 3);
  if (managementCellLimit !== 3) throw new Error('部门管理目标单元格数量必须为3');

  const result = {
    reportPeriod: '',
    metrics: {},
    agileProjects: {},
    management: {},
  };
  const moduleRows = findModuleRows(rows);
  result.reportPeriod = findReportPeriodCell(rows);
  scanMetrics(rows, moduleRows, result);
  scanRepeatedSections(rows, moduleRows, result, options.aliasMap || {});
  validateCompleteResult(result);
  return result;
}

function flattenSheetCellText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(flattenSheetCellText).join('');
  if (typeof value === 'object') {
    if (value.text != null) return flattenSheetCellText(value.text);
    if (value.value != null) return flattenSheetCellText(value.value);
    return '';
  }
  return String(value);
}

function findModuleRows(rows) {
  const found = {};
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const text = normalizeSheetCellText(rows[rowIndex]?.[0]);
    for (const [key, title] of Object.entries(MODULES)) {
      if (!text.includes(title)) continue;
      if (found[key] != null) throw new Error(`重复模块标题：${title}`);
      found[key] = rowIndex;
    }
  }
  for (const [key, title] of Object.entries(MODULES)) {
    if (found[key] == null) throw new Error(`缺少模块：${title}`);
  }
  if (!(found.metrics < found.agileProjects && found.agileProjects < found.management)) {
    throw new Error('周报模块顺序错误');
  }
  return found;
}

function findReportPeriodCell(rows) {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (normalizeSheetCellText(rows[rowIndex]?.[0]) === '报告周期') {
      return toA1(1, rowIndex);
    }
  }
  throw new Error('缺少报告周期目标单元格');
}

function scanMetrics(rows, moduleRows, result) {
  for (let row = moduleRows.metrics + 1; row < moduleRows.agileProjects; row += 1) {
    const name = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    if (!name || name === '指标名称' || name.includes('填写说明')) continue;
    addUnique(result.metrics, name, toA1(2, row), `${MODULES.metrics}/${name}`);
  }
}

function scanRepeatedSections(rows, moduleRows, result, aliasMap) {
  scanSection(rows, {
    start: moduleRows.agileProjects + 1,
    end: moduleRows.management,
    moduleKey: 'agileProjects',
    result: result.agileProjects,
    aliases: aliasMap.agileProjects || {},
  });
  scanSection(rows, {
    start: moduleRows.management + 1,
    end: rows.length,
    moduleKey: 'management',
    result: result.management,
    aliases: aliasMap.management || {},
  });
}

function scanSection(rows, { start, end, moduleKey, result, aliases }) {
  let entity = '';
  const labels = CONTENT_LABELS[moduleKey];
  for (let row = start; row < end; row += 1) {
    const columnA = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    const columnB = normalizeSheetCellText(rows[row]?.[1]);
    if (columnA && !columnA.includes('填写说明')) entity = columnA;
    const contentKey = labels[columnB];
    if (!contentKey) continue;
    if (!entity) throw new Error(`${MODULES[moduleKey]}/${columnB} 缺少项目或部门上下文`);

    const entry = result[entity] || {
      current: moduleKey === 'management' ? [] : '',
      next: moduleKey === 'management' ? [] : '',
      aliases: resolveAliases(aliases, entity),
    };
    const existingTarget = entry[contentKey];
    const hasExistingTarget = Array.isArray(existingTarget)
      ? existingTarget.length > 0
      : Boolean(existingTarget);
    if (hasExistingTarget) {
      throw new Error(`重复定位：${MODULES[moduleKey]}/${entity}/${columnB}`);
    }
    entry[contentKey] = moduleKey === 'management'
      ? buildManagementRange(rows, row, end, entity, columnB)
      : toA1(2, row);
    result[entity] = entry;
  }
}

function buildManagementRange(rows, startRow, endRow, entity, contentLabel) {
  for (let row = startRow + 1; row <= startRow + 2; row += 1) {
    if (row >= endRow) throw new Error(`${entity}/${contentLabel} 目标区域不足3行`);
    const boundaryA = cleanEntityName(normalizeSheetCellText(rows[row]?.[0]));
    const boundaryB = normalizeSheetCellText(rows[row]?.[1]);
    if (boundaryA || CONTENT_LABELS.management[boundaryB]) {
      throw new Error(`${entity}/${contentLabel} 目标区域不足3行`);
    }
  }
  return [0, 1, 2].map(offset => toA1(2, startRow + offset));
}

function cleanEntityName(text) {
  return String(text || '')
    .split('\n')[0]
    .replace(/^\s*\d+[.、]\s*/, '')
    .trim();
}

function resolveAliases(aliasConfig, entity) {
  if (Array.isArray(aliasConfig[entity])) return aliasConfig[entity];
  const match = Object.entries(aliasConfig).find(([name, aliases]) => {
    if (name === entity) return true;
    return Array.isArray(aliases)
      && aliases.some(alias => entity.includes(alias) || alias.includes(entity));
  });
  return match && Array.isArray(match[1]) ? match[1] : [];
}

function addUnique(target, key, value, path) {
  if (target[key]) throw new Error(`重复定位：${path}`);
  target[key] = value;
}

function validateCompleteResult(result) {
  if (!result.reportPeriod) throw new Error('报告周期目标单元格未定位');
  if (!Object.keys(result.metrics).length) throw new Error('核心指标目标单元格未定位');
  for (const [section, title] of [
    ['agileProjects', MODULES.agileProjects],
    ['management', MODULES.management],
  ]) {
    const entries = Object.entries(result[section]);
    if (!entries.length) throw new Error(`${title}未定位到任何业务板块`);
    for (const [entity, entry] of entries) {
      if (!entry.current || !entry.next || !entry.current.length || !entry.next.length) {
        throw new Error(`${title}/${entity} 缺少本周或下周目标`);
      }
    }
  }
}

function toA1(columnIndex, rowIndex) {
  let number = columnIndex + 1;
  let letters = '';
  while (number > 0) {
    number -= 1;
    letters = String.fromCharCode(65 + (number % 26)) + letters;
    number = Math.floor(number / 26);
  }
  return `${letters}${rowIndex + 1}`;
}
