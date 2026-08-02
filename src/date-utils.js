export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function getDateParts(date, timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

export function formatYmd(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const { year, month, day } = getDateParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatDateTime(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function parseYmd(ymd) {
  const match = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function addDaysToYmd(ymd, days) {
  const parsed = parseYmd(ymd);
  if (!parsed) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day + days);
  const next = new Date(utc);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export function getWorkWeekRange(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const today = formatYmd(now, timeZone);
  return getWorkWeekRangeForYmd(today);
}

export function getWorkWeekRangeForYmd(ymd) {
  const parsed = parseYmd(ymd);
  if (!parsed) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  const dow = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const start = addDaysToYmd(ymd, mondayOffset);
  return {
    start,
    end: addDaysToYmd(start, 4),
  };
}

export function getWeeklyReportRange(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const today = formatYmd(now, timeZone);
  const parsed = parseYmd(today);
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const fridayOffset = day === 6 ? -1 : day <= 5 ? 5 - day : -2;
  const reportDate = addDaysToYmd(today, fridayOffset);
  return {
    reportDate,
    start: addDaysToYmd(reportDate, -7),
    end: reportDate,
  };
}

export function formatNaturalWeekPeriod(startDate, endDate) {
  if (!startDate && !endDate) return '';
  const start = parseYmd(startDate);
  const end = parseYmd(endDate);
  if (!start || !end) return '';
  const left = `${start.year}年${start.month}月${start.day}日`;
  const right = start.year === end.year
    ? `${end.month}月${end.day}日`
    : `${end.year}年${end.month}月${end.day}日`;
  return `${left}-${right}`;
}

export function getIsoWeekInfo(ymd) {
  const parsed = parseYmd(ymd);
  if (!parsed) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return {
    isoYear,
    isoWeek,
    key: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
  };
}

export function coerceLarkTimestamp(value) {
  if (value == null || value === '') return new Date();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
