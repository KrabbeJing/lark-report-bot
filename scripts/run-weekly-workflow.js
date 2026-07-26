import 'dotenv/config';

export function parseWeeklyWorkflowArgs(argv = []) {
  const result = { stage: '', date: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--dry-run') { result.dryRun = true; continue; }
    if (!['--stage', '--date'].includes(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    if (option === '--stage') result.stage = value;
    if (option === '--date') result.date = value;
  }
  if (!['draft', 'notify', 'refresh', 'publish'].includes(result.stage)) throw new Error('--stage must be draft, notify, refresh, or publish');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.date)) throw new Error('--date must be YYYY-MM-DD');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadGroupConfig } = await import('../src/config.js');
  const { runWeeklyWorkflowStage } = await import('../src/weekly-workflow.js');
  const config = loadGroupConfig();
  const options = parseWeeklyWorkflowArgs(process.argv.slice(2));
  const now = new Date(`${options.date}T12:00:00+08:00`);
  for (const group of config.groups) {
    const result = await runWeeklyWorkflowStage({ stage: options.stage, group, now, dryRun: options.dryRun, services: {} });
    console.log(JSON.stringify({ group: group.project, stage: options.stage, dryRun: options.dryRun, result }, null, 2));
  }
}
