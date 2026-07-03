import { formatYmd } from './date-utils.js';

export function startWeeklyScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.weeklyPush;
  if (!schedule?.enabled) {
    logger.log('[scheduler] weekly push disabled');
    return { stop() {} };
  }

  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunWeeklyPush(now, schedule)) return;

    const runKey = `${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);

    logger.log(`[scheduler] weekly push triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error('[scheduler] weekly push failed', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export function startDailySupervisorScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.dailySupervisorPush;
  if (!schedule?.enabled) {
    logger.log('[scheduler] daily supervisor push disabled');
    return { stop() {} };
  }

  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunDailySupervisorPush(now, schedule)) return;

    const runKey = `${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);

    logger.log(`[scheduler] daily supervisor push triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error('[scheduler] daily supervisor push failed', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export function startDailyFactSyncScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.dailyFactSync;
  if (!schedule?.enabled) {
    logger.log('[scheduler] daily fact sync disabled');
    return { stop() {} };
  }

  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunDailyFactSync(now, schedule)) return;

    const runKey = `${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);

    logger.log(`[scheduler] daily fact sync triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error('[scheduler] daily fact sync failed', err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export function shouldRunWeeklyPush(now, schedule) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || '10:00').split(':').map(Number);
  return parts.dayOfWeek === Number(schedule.dayOfWeek ?? 6)
    && parts.hour === hour
    && parts.minute === minute;
}

export function shouldRunDailySupervisorPush(now, schedule) {
  return shouldRunDailySchedule(now, schedule, '17:00');
}

export function shouldRunDailyFactSync(now, schedule) {
  return shouldRunDailySchedule(now, schedule, '18:10');
}

function shouldRunDailySchedule(now, schedule, defaultTime) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || defaultTime).split(':').map(Number);
  return parts.hour === hour && parts.minute === minute;
}

function getLocalParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    dayOfWeek: weekdayToNumber(parts.weekday),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function weekdayToNumber(weekday) {
  return {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }[weekday];
}
