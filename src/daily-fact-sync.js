import { sanitizeOperationalText } from './error-reporter.js';

export async function syncDailyFactsForAllGroups({
  config,
  bitable,
  now = new Date(),
  logger = console,
  notifyFailure = async () => {},
  startDate,
  endDate,
  repairOrganization,
}) {
  const results = [];
  for (const group of config.groups) {
    const scope = group.project || group.chatId;
    let alert;
    try {
      const result = await bitable.syncDailyFactRecordsForGroup(group, {
        now,
        timezone: config.dailyFactSync?.timezone || config.timezone,
        lookbackDays: config.dailyFactSync?.lookbackDays,
        startDate,
        endDate,
        repairOrganization,
      });
      results.push({ group: scope, ...result });
      logger.log('[daily-fact-sync] group result', {
        task: sanitizeOperationalText('日报事实同步'),
        scope: sanitizeDailyFactScope(scope),
        stage: result.errors?.length ? 'write_daily_fact' : 'sync_group',
        created: safeCount(result.created),
        updated: safeCount(result.updated),
        unchanged: safeCount(result.unchanged),
        failureCount: safeCount(result.errors?.length),
        message: sanitizeOperationalText(result.errors?.length ? '日报事实写入存在记录错误' : '日报事实同步完成'),
      });
      if (result.errors?.length) {
        alert = {
          task: '日报事实同步',
          scope,
          stage: 'write_daily_fact',
          errors: result.errors,
        };
      }
    } catch (err) {
      const failure = {
        group: scope,
        failed: true,
        message: err?.response?.data?.msg || err?.message || String(err),
        error: err,
      };
      results.push(failure);
      logger.error('[daily-fact-sync] group failed', {
        task: sanitizeOperationalText('日报事实同步'),
        scope: sanitizeDailyFactScope(scope),
        stage: 'sync_group',
        failureCount: 1,
        message: sanitizeOperationalText('日报事实同步失败'),
      });
      alert = {
        task: '日报事实同步',
        scope,
        stage: 'sync_group',
        errors: [err],
      };
    }

    if (alert) {
      try {
        await notifyFailure(alert);
      } catch {
        try {
          logger.warn('[daily-fact-sync] failure notification failed');
        } catch {}
      }
    }
  }
  return results;
}

function safeCount(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeDailyFactScope(value) {
  return sanitizeOperationalText(value)
    .replace(/\b(?:base|sheet|wiki)[_-][A-Za-z0-9_-]+\b/gi, '[masked-id]')
    .replace(/\bwiki(?:node)?[A-Za-z0-9_-]{6,}\b/gi, '[masked-id]');
}
