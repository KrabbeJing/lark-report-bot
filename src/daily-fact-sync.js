export async function syncDailyFactsForAllGroups({
  config,
  bitable,
  now = new Date(),
  logger = console,
  startDate,
  endDate,
  repairOrganization,
}) {
  const results = [];
  for (const group of config.groups) {
    try {
      const result = await bitable.syncDailyFactRecordsForGroup(group, {
        now,
        timezone: config.dailyFactSync?.timezone || config.timezone,
        lookbackDays: config.dailyFactSync?.lookbackDays,
        startDate,
        endDate,
        repairOrganization,
      });
      results.push({ group: group.project || group.chatId, ...result });
      logger.log('[daily-fact-sync] group result', {
        group: group.project || group.chatId,
        ...result,
      });
    } catch (err) {
      const failure = {
        group: group.project || group.chatId,
        failed: true,
        message: err?.response?.data?.msg || err?.message || String(err),
      };
      results.push(failure);
      logger.error('[daily-fact-sync] group failed', failure);
    }
  }
  return results;
}
