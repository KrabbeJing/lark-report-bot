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
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const lark = await import('@larksuiteoapi/node-sdk');
  const { loadGroupConfig } = await import('../src/config.js');
  const { BitableService } = await import('../src/bitable-service.js');
  const { LarkMessenger } = await import('../src/lark-messenger.js');
  const { WeeklySheetWriter } = await import('../src/weekly-sheet-writer.js');
  const { WeeklyPosterService } = await import('../src/weekly-poster-service.js');
  const { buildLarkClientOptions } = await import('../src/lark-client.js');
  const { createAiProvider } = await import('../src/ai-providers.js');
  const { createWeeklyWorkflowServices } = await import('../src/weekly-workflow-services.js');
  const { runWeeklyWorkflowStage } = await import('../src/weekly-workflow.js');
  const config = loadGroupConfig();
  const options = parseWeeklyWorkflowArgs(process.argv.slice(2));
  const now = new Date(`${options.date}T12:00:00+08:00`);
  const { APP_ID, APP_SECRET } = process.env;
  if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');
  const client = new lark.Client(buildLarkClientOptions({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: lark.Domain.Feishu,
  }));
  const messenger = new LarkMessenger(client);
  const bitable = new BitableService(client);
  const sheetWriter = new WeeklySheetWriter(client);
  const outDir = path.default.resolve(path.default.dirname(fileURLToPath(import.meta.url)), '..', 'out');
  const poster = new WeeklyPosterService({
    sheetWriter,
    messenger,
    outDir,
  });
  const services = createWeeklyWorkflowServices({
    config,
    bitable,
    sheetWriter,
    aiProvider: createAiProvider(),
    messenger,
    poster,
  });
  for (const group of config.groups) {
    const result = await runWeeklyWorkflowStage({ stage: options.stage, group, now, dryRun: options.dryRun, services });
    console.log(JSON.stringify({ group: group.project, stage: options.stage, dryRun: options.dryRun, result }, null, 2));
  }
}
