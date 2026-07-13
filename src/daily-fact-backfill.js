const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDailyFactBackfillArgs(argv = []) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--repair-organization') {
      values.set(key, true);
    } else if (key === '--start' || key === '--end') {
      values.set(key, argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }

  const startDate = values.get('--start') || '';
  const endDate = values.get('--end') || '';
  if (!YMD_RE.test(startDate) || !YMD_RE.test(endDate)) {
    throw new Error('--start 和 --end 必须使用 YYYY-MM-DD');
  }
  if (startDate > endDate) throw new Error('start 不能晚于 end');

  return {
    startDate,
    endDate,
    repairOrganization: values.get('--repair-organization') === true,
  };
}

export async function runDailyFactBackfill({ config, bitable, options }) {
  const results = [];
  for (const group of config.groups) {
    try {
      const result = await bitable.syncDailyFactRecordsForGroup(group, {
        startDate: options.startDate,
        endDate: options.endDate,
        repairOrganization: options.repairOrganization,
        timezone: config.dailyFactSync?.timezone || config.timezone,
      });
      results.push({ group: group.project || group.chatId, ...result });
    } catch (error) {
      results.push({ group: group.project || group.chatId, failed: true, error });
    }
  }
  return results;
}
