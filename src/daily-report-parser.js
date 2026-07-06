import { addDaysToYmd, coerceLarkTimestamp, formatYmd } from './date-utils.js';

const DATE_RANGE_PATTERNS = [
  /(?:(?<startYear>20\d{2})\s*[-/.年]\s*)?(?<startMonth>\d{1,2})\s*[-/.月]\s*(?<startDay>\d{1,2})\s*(?:日)?\s*[-~至到]\s*(?:(?<endYear>20\d{2})\s*[-/.年]\s*)?(?:(?<endMonth>\d{1,2})\s*[-/.月]\s*)?(?<endDay>\d{1,2})\s*日?/,
];

const DATE_RANGE_LIKE_RE = /(?:^|[^\d])(?:20\d{2}\s*[-/.年]\s*)?(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:0?[1-9]|[12]\d|3[01])\s*(?:日)?\s*[-~至到]\s*(?:(?:20\d{2})\s*[-/.年]\s*)?(?:(?:0?[1-9]|1[0-2])\s*[-/.月]\s*)?(?:0?[1-9]|[12]\d|3[01])\s*日?/;

const DATE_PATTERNS = [
  /(?<year>20\d{2})\s*[-/.年]\s*(?<month>\d{1,2})\s*[-/.月]\s*(?<day>\d{1,2})\s*日?/,
  /(?<shortYear>\d{2})\s*[-/.年]\s*(?<month>\d{1,2})\s*[-/.月]\s*(?<day>\d{1,2})\s*日?/,
  /(?<month>\d{1,2})\s*[-/.月]\s*(?<day>\d{1,2})\s*日?/,
];

const ITEM_RE = /^\s*(?:[【\[]\s*)?(?:\d+|[一二三四五六七八九十]+)(?:\s*[】\]]|[.、)\）])\s*(.+)$/;
const BULLET_RE = /^\s*[-*•]\s*(.+)$/;
const SECTION_RE = /^(今日工作总结|今日工作|今天工作|本日工作|工作总结|明日工作计划|明日计划|明天计划|明天工作|遇到的问题或需求的协助|遇到的问题|问题|风险|阻塞|需求协助)\s*[：:]\s*(.*)$/;

export function parseDailyReportText(text, options = {}) {
  const fallbackDate = coerceLarkTimestamp(options.fallbackDate || options.messageTime);
  const timezone = options.timezone || 'Asia/Shanghai';
  const normalized = normalizeText(text);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const title = lines[0];
  const hasReportKeyword = /(?:工作)?日报/.test(title) || /(?:工作)?日报/.test(normalized.slice(0, 80));
  if (!hasReportKeyword) return null;

  const dateInfo = extractDateInfo(title, fallbackDate, timezone);
  const reporterName = extractReporterName(title, dateInfo?.raw);
  const sections = splitSections(lines.slice(1));
  const workItems = sections.hasSections
    ? extractWorkItems(sections.work.length ? sections.work : sections.unsectioned)
    : extractWorkItems(lines.slice(1));
  const workSummaryText = buildWorkSummaryText(lines.slice(1), sections);
  const tomorrowPlanItems = extractWorkItems(sections.plan);
  const explicitRiskItems = extractWorkItems(sections.risk);
  const riskItems = explicitRiskItems;

  let confidence = 0;
  if (hasReportKeyword) confidence += 0.45;
  if (reporterName) confidence += 0.2;
  if (dateInfo?.raw) confidence += 0.15;
  if (workItems.length > 0) confidence += 0.25;

  const highConfidence = !dateInfo.invalidRange && confidence >= 0.75;
  if (!highConfidence) {
    return {
      highConfidence,
      confidence,
      reason: '日报格式不完整',
      rawText: normalized,
    };
  }

  return {
    highConfidence,
    confidence,
    reporterName,
    reportDate: dateInfo.ymd,
    reportDates: dateInfo.dates,
    dateRange: dateInfo.rangeText,
    reportType: dateInfo.reportType,
    rawText: normalized,
    workSummaryText,
    workItems,
    tomorrowPlanItems,
    riskItems,
    title,
  };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function extractDateInfo(title, fallbackDate, timezone) {
  const range = extractDateRange(title, fallbackDate, timezone);
  if (range) return range;

  if (looksLikeDateRange(title)) {
    return {
      raw: '',
      ymd: formatYmd(fallbackDate, timezone),
      dates: [],
      rangeText: '',
      reportType: '日期范围无效',
      invalidRange: true,
    };
  }

  const single = extractDate(title, fallbackDate, timezone);
  return {
    ...single,
    dates: [single.ymd],
    rangeText: single.ymd,
    reportType: '单日',
  };
}

function extractDateRange(title, fallbackDate, timezone) {
  for (const pattern of DATE_RANGE_PATTERNS) {
    const match = String(title || '').match(pattern);
    if (!match?.groups) continue;

    const fallbackYear = Number(formatYmd(fallbackDate, timezone).slice(0, 4));
    const startYear = match.groups.startYear ? Number(match.groups.startYear) : fallbackYear;
    const endYear = match.groups.endYear ? Number(match.groups.endYear) : startYear;
    const startMonth = Number(match.groups.startMonth);
    const startDay = Number(match.groups.startDay);
    const endMonth = Number(match.groups.endMonth || match.groups.startMonth);
    const endDay = Number(match.groups.endDay);

    if (!isValidMonthDay(startMonth, startDay) || !isValidMonthDay(endMonth, endDay)) continue;

    const start = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    const dates = expandDateRange(start, end);
    if (dates.length < 2) continue;

    return {
      raw: match[0],
      ymd: dates[0],
      dates,
      rangeText: `${dates[0]}~${dates[dates.length - 1]}`,
      reportType: '多日合并',
    };
  }
  return null;
}

function looksLikeDateRange(title) {
  return DATE_RANGE_LIKE_RE.test(String(title || ''));
}

function expandDateRange(start, end) {
  const dates = [];
  let current = start;
  for (let i = 0; i < 31; i += 1) {
    dates.push(current);
    if (current === end) return dates;
    current = addDaysToYmd(current, 1);
  }
  return [];
}

function extractDate(title, fallbackDate, timezone) {
  for (const pattern of DATE_PATTERNS) {
    const match = String(title || '').match(pattern);
    if (!match?.groups) continue;

    const fallbackYear = Number(formatYmd(fallbackDate, timezone).slice(0, 4));
    const year = normalizeYear(match.groups.year, match.groups.shortYear, fallbackYear);
    const month = Number(match.groups.month);
    const day = Number(match.groups.day);
    if (!isValidMonthDay(month, day)) continue;

    return {
      raw: match[0],
      ymd: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  }
  return {
    raw: '',
    ymd: formatYmd(fallbackDate, timezone),
  };
}

function normalizeYear(year, shortYear, fallbackYear) {
  if (year) return Number(year);
  if (shortYear) return 2000 + Number(shortYear);
  return fallbackYear;
}

function isValidMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function extractReporterName(title, dateRaw = '') {
  let name = String(title || '');
  if (dateRaw) name = name.replace(dateRaw, '');
  name = name
    .replace(/(?:工作)?日报/g, '')
    .replace(/[：:，,\s_-]+$/g, '')
    .replace(/^[：:，,\s_-]+/g, '')
    .trim();
  return name.length <= 12 ? name : '';
}

function extractWorkItems(bodyLines) {
  const items = [];
  let current = '';

  for (const line of bodyLines) {
    const numbered = line.match(ITEM_RE);
    const bullet = line.match(BULLET_RE);
    const itemText = numbered?.[1] || bullet?.[1] || '';

    if (itemText) {
      if (current) items.push(current.trim());
      current = itemText.trim();
      continue;
    }

    if (!line) continue;
    if (current) {
      current = `${current}\n${line}`;
    } else {
      current = line;
    }
  }

  if (current) items.push(current.trim());
  return items.filter(Boolean);
}

function buildWorkSummaryText(bodyLines, sections) {
  const sourceLines = sections.hasSections
    ? (sections.work.length ? sections.work : sections.unsectioned)
    : bodyLines;
  return sourceLines
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .join('\n');
}

function splitSections(bodyLines) {
  const sections = {
    work: [],
    plan: [],
    risk: [],
    unsectioned: [],
    hasSections: false,
  };
  let current = '';

  for (const line of bodyLines) {
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      sections.hasSections = true;
      current = detectSectionKind(sectionMatch[1]);
      if (sectionMatch[2]) sections[current].push(sectionMatch[2]);
      continue;
    }

    if (current) sections[current].push(line);
    else sections.unsectioned.push(line);
  }

  return sections;
}

function detectSectionKind(label) {
  if (/明日|明天/.test(label)) return 'plan';
  if (/问题|风险|阻塞|协助/.test(label)) return 'risk';
  return 'work';
}
