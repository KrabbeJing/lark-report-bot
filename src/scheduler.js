import { formatYmd, getIsoWeekInfo, getWeeklyReportRange } from './date-utils.js';
import { formatOperationalError } from './operational-log.js';

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
      logger.error(formatSchedulerFailure('weekly push', err));
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

export function startWeeklyStageScheduler({ config, scheduleKey, stage, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config[scheduleKey];
  if (!schedule?.enabled) {
    logger.log(`[scheduler] weekly ${stage} disabled`);
    return { stop() {} };
  }
  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunWeeklyStage(now, schedule)) return;
    const reportDate = getWeeklyReportRange(now, schedule.timezone || 'Asia/Shanghai').reportDate;
    const instanceKey = getIsoWeekInfo(reportDate).key;
    const runKey = `${stage}-${instanceKey}-${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);
    logger.log(`[scheduler] weekly ${stage} triggered: ${runKey}`);
    try { await onRun(now, runKey); } catch (err) { logger.error(formatSchedulerFailure(`weekly ${stage}`, err)); }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop() { clearInterval(timer); } };
}

export function startWeeklyInstanceScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.weeklyInstanceCreation;
  if (!schedule?.enabled) {
    logger.log('[scheduler] weekly instance creation disabled');
    return { stop() {} };
  }

  const runKeys = new Set();
  const tick = async () => {
    const now = new Date();
    if (!shouldRunWeeklyInstanceCreation(now, schedule)) return;

    const runKey = `${formatYmd(now, schedule.timezone)}-${schedule.time}`;
    if (runKeys.has(runKey)) return;
    runKeys.add(runKey);

    logger.log(`[scheduler] weekly instance creation triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error(formatSchedulerFailure('weekly instance creation', err));
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
      logger.error(formatSchedulerFailure('daily supervisor push', err));
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
      logger.error(formatSchedulerFailure('daily fact sync', err));
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

export function startChatDailyReplayScheduler({ config, onRun, logger = console, intervalMs = 60_000 }) {
  const schedule = config.chatDailyReplay;
  if (!schedule?.enabled) {
    logger.log('[scheduler] chat daily replay disabled');
    return { stop() {} };
  }

  let lastRunKey = '';
  const tick = async () => {
    const now = new Date();
    if (!shouldRunChatDailyReplay(now, schedule)) return;
    const runKey = Math.floor(now.getTime() / 60_000).toString();
    if (runKey === lastRunKey) return;
    lastRunKey = runKey;
    logger.log(`[scheduler] chat daily replay triggered: ${runKey}`);
    try {
      await onRun(now);
    } catch (err) {
      logger.error(formatSchedulerFailure('chat daily replay', err));
    }
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop() { clearInterval(timer); } };
}

export function formatSchedulerFailure(task, error) {
  return `[scheduler] ${task} failed ${formatOperationalError(error)}`;
}

export function shouldRunWeeklyPush(now, schedule) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || '10:00').split(':').map(Number);
  return parts.dayOfWeek === Number(schedule.dayOfWeek ?? 6)
    && parts.hour === hour
    && parts.minute === minute;
}

export function shouldRunWeeklyStage(now, schedule) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || '').split(':').map(Number);
  return parts.dayOfWeek === Number(schedule.dayOfWeek)
    && parts.hour === hour && parts.minute === minute;
}

export function shouldRunWeeklyInstanceCreation(now, schedule) {
  const parts = getLocalParts(now, schedule.timezone || 'Asia/Shanghai');
  const [hour, minute] = String(schedule.time || '09:00').split(':').map(Number);
  return parts.dayOfWeek === Number(schedule.dayOfWeek ?? 1)
    && parts.hour === hour
    && parts.minute === minute;
}

export function shouldRunDailySupervisorPush(now, schedule) {
  return shouldRunDailySchedule(now, schedule, '17:00');
}

export function shouldRunDailyFactSync(now, schedule) {
  return shouldRunDailySchedule(now, schedule, '18:10');
}

export function shouldRunChatDailyReplay(now, schedule) {
  const intervalMinutes = Math.max(1, Number(schedule?.intervalMinutes || 1440));
  return Math.floor(now.getTime() / 60_000) % intervalMinutes === 0;
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
