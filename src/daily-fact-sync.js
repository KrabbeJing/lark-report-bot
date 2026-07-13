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
        group: scope,
        ...result,
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
      logger.error('[daily-fact-sync] group failed', failure);
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
