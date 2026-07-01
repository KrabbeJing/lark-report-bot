function formatCell(cell) {
  if (cell == null) return '';
  if (Array.isArray(cell)) {
    return cell.map(seg => (typeof seg === 'object' ? (seg.text ?? '') : seg)).join('');
  }
  if (typeof cell === 'object') return cell.text ?? '';
  return String(cell);
}

function stripStageTag(text) {
  return String(text || '')
    .replace(/\s*【[^】]*\/[^】]*】\s*/g, '')
    .split('\n')[0]
    .trim();
}

function isNote(text) {
  return /^(填写要求|说明|备注)[：:]/.test(String(text || '').trim());
}

function tryComputePct(target, actual) {
  const tMatch = String(target || '').match(/^([\d.]+)\s*([万亿千百]?[一-龥%个元人次台件]*)/);
  const aMatch = String(actual || '').match(/^([\d.]+)\s*([万亿千百]?[一-龥%个元人次台件]*)/);
  if (!tMatch || !aMatch) return null;
  const t = parseFloat(tMatch[1]);
  const a = parseFloat(aMatch[1]);
  if (!isFinite(t) || !isFinite(a) || t === 0) return null;
  const tUnit = (tMatch[2] || '').replace(/[（(].*$/, '').trim();
  const aUnit = (aMatch[2] || '').replace(/[（(].*$/, '').trim();
  if (tUnit !== aUnit) return null;
  return Math.round((a / t) * 100 * 100) / 100;
}

function parseMetricText(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // 完成度 X%
  const pctMatch = t.match(/完成度\s*([\d.]+)\s*%/);
  const completionPct = pctMatch ? parseFloat(pctMatch[1]) : null;

  // 年度(目标|指标) X — first number+unit phrase
  const yMatch = t.match(/年度(?:目标|指标)\s*([\d.]+\s*[万亿千百]?[一-龥%个元人次台件]*)/);
  const yearTarget = yMatch ? yMatch[1].replace(/[（(].*$/, '').trim() : null;

  // 当前 / 累计 / 目前 / 本周完成 / 实际 — second number+unit phrase
  const aMatch = t.match(/(?:累计|当前|目前|本周完成|实际完成|完成|增加|输送|响应|活跃)[^\d]*([\d.]+\s*[万亿千百]?[一-龥%个元人次台件]*)/);
  let weekActual = aMatch ? aMatch[1].replace(/[（(].*$/, '').trim() : null;

  // Fallback: pick the second number in text
  if (!weekActual) {
    const nums = [...t.matchAll(/([\d.]+\s*[万亿千百]?[一-龥%个元人次台件]*)/g)].map(m => m[1].trim());
    if (nums.length >= 2) weekActual = nums[1].replace(/[（(].*$/, '').trim();
  }

  const finalPct = completionPct != null ? completionPct : tryComputePct(yearTarget, weekActual);

  return {
    yearTarget,
    weekActual,
    completionPct: finalPct,
    rawText: t,
  };
}

function findSectionStarts(rows) {
  const map = {};
  for (let i = 0; i < rows.length; i++) {
    const a = (rows[i][0] || '').trim();
    if (/^一[、\.]/.test(a)) map[1] = i;
    else if (/^二[、\.]/.test(a)) map[2] = i;
    else if (/^三[、\.]/.test(a)) map[3] = i;
  }
  return map;
}

function isColumnHeaderRow(row) {
  const a = (row[0] || '').trim();
  const b = (row[1] || '').trim();
  const c = (row[2] || '').trim();
  return a === '业务板块' || (b === '核心指标名称' && /完成情况/.test(c));
}

function parseSection1(rows, start, end) {
  const metrics = [];
  let currentCat = '';
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row || row.every(c => c.trim() === '')) continue;
    if (isColumnHeaderRow(row)) continue;
    const colA = row[0].trim();
    const colB = row[1].trim();
    const colC = row[2].trim();
    if (colA) currentCat = colA;
    if (!colB) continue;
    const parsed = parseMetricText(colC);
    if (!parsed) continue;
    metrics.push({
      category: currentCat,
      name: colB,
      ...parsed,
    });
  }
  return metrics;
}

function parseSection2(rows, start, end) {
  const projects = [];
  let current = null;
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row || row.every(c => c.trim() === '')) continue;
    const colA = row[0].trim();
    const colB = row[1].trim();
    const colC = row[2].trim();
    if (isNote(colA)) continue;
    if (colA) {
      const name = stripStageTag(colA);
      if (!current || current.name !== name) {
        if (current) projects.push(current);
        current = {
          name,
          weekHighlights: '',
          nextWeekPlan: '',
        };
      }
    }
    if (!current) continue;
    if (/^本周/.test(colB) && colC) {
      current.weekHighlights = colC;
    } else if (/^下周/.test(colB) && colC) {
      current.nextWeekPlan = colC;
    }
  }
  if (current) projects.push(current);
  return projects;
}

function parseSection3(rows, start, end) {
  const cats = [];
  let current = null;
  let block = null;
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (!row || row.every(c => c.trim() === '')) continue;
    const colA = row[0].trim();
    const colB = row[1].trim();
    const colC = row[2].trim();
    if (isNote(colA)) continue;
    if (colA && (!current || current.name !== colA)) {
      if (current) cats.push(current);
      current = {
        name: colA,
        weekProgress: [],
        nextWeekPlan: [],
      };
      block = null;
    }
    if (!current) continue;
    if (/^本周/.test(colB)) block = 'week';
    else if (/^下周/.test(colB)) block = 'next';
    if (colC) {
      if (block === 'week') current.weekProgress.push(colC);
      else if (block === 'next') current.nextWeekPlan.push(colC);
    }
  }
  if (current) cats.push(current);
  return cats;
}

function formatDate(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// 默认周期：以"最近一个周六（含今天）"所在那一周的周一到周五。
// 典型场景是周六生成海报 → 本周一~本周五。
function getReportPeriod(now = new Date()) {
  const dow = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysBackToSat = (dow + 1) % 7;
  const refSat = new Date(now);
  refSat.setDate(now.getDate() - daysBackToSat);
  const friday = new Date(refSat);
  friday.setDate(refSat.getDate() - 1);
  const monday = new Date(friday);
  monday.setDate(friday.getDate() - 4);
  return `${formatDate(monday)} - ${formatDate(friday)}`;
}

// 从表里抽「报告周期」右侧的值；占位符（____）当空处理
function parseReportPeriodFromSheet(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i] || [];
    const labelIdx = row.findIndex(c => /周期|日期|时间/.test((c || '').trim()));
    if (labelIdx === -1) continue;
    for (let k = labelIdx + 1; k < row.length; k++) {
      const v = (row[k] || '').trim();
      if (v && !/_{2,}/.test(v)) return v;
    }
  }
  return null;
}

function normalizeTitle(raw) {
  return String(raw || '').replace(/工作周报/, '周报').trim() || '周报';
}

export function parseSheetToReport(values) {
  const rows = values.map(r => r.map(formatCell));
  const sectionStarts = findSectionStarts(rows);

  const mainTitle = (rows[0] || []).find(c => c.trim() !== '') || '周报';

  const sec1Start = sectionStarts[1] != null ? sectionStarts[1] + 1 : 0;
  const sec2Start = sectionStarts[2] != null ? sectionStarts[2] + 1 : rows.length;
  const sec3Start = sectionStarts[3] != null ? sectionStarts[3] + 1 : rows.length;

  const sec1End = sectionStarts[2] != null ? sectionStarts[2] : (sectionStarts[3] != null ? sectionStarts[3] : rows.length);
  const sec2End = sectionStarts[3] != null ? sectionStarts[3] : rows.length;
  const sec3End = rows.length;

  const userPeriod = parseReportPeriodFromSheet(rows);

  return {
    title: normalizeTitle(mainTitle),
    period: userPeriod || getReportPeriod(),
    metrics: sectionStarts[1] != null ? parseSection1(rows, sec1Start, sec1End) : [],
    projects: sectionStarts[2] != null ? parseSection2(rows, sec2Start, sec2End) : [],
    managementCategories: sectionStarts[3] != null ? parseSection3(rows, sec3Start, sec3End) : [],
  };
}
