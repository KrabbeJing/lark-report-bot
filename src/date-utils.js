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
  const parsed = parseYmd(today);
  const dow = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const start = addDaysToYmd(today, mondayOffset);
  return {
    start,
    end: addDaysToYmd(start, 4),
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
