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
        await notifyFailure({
          task: '日报事实同步',
          scope,
          stage: 'write_daily_fact',
          errors: result.errors,
        });
      }
    } catch (err) {
      const failure = {
        group: scope,
        failed: true,
        error: err,
      };
      results.push(failure);
      logger.error('[daily-fact-sync] group failed', failure);
      await notifyFailure({
        task: '日报事实同步',
        scope,
        stage: 'sync_group',
        errors: [err],
      });
    }
  }
  return results;
}
