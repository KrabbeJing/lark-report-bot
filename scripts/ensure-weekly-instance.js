import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { reportOperationalFailure } from '../src/error-reporter.js';
import { ensureWeeklyInstancesForAllGroups } from '../src/weekly-instance-service.js';
import { buildLarkClientOptions } from '../src/lark-client.js';
import { LarkMessenger } from '../src/lark-messenger.js';
import { WeeklySheetWriter } from '../src/weekly-sheet-writer.js';
import { hasWeeklyEnsureFailures, summarizeWeeklyEnsureResult } from '../src/weekly-instance-cli-summary.js';

const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');

const config = loadGroupConfig();
const client = new lark.Client(buildLarkClientOptions({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
}));
const messenger = new LarkMessenger(client);
const results = await ensureWeeklyInstancesForAllGroups({
  config,
  bitable: new BitableService(client),
  sheetWriter: new WeeklySheetWriter(client),
  now: new Date(),
});

for (const result of results) {
  if (!result.error) continue;
  await reportOperationalFailure({
    task: '周报实例创建',
    scope: result.group,
    stage: result.error.weeklyInstanceStage || 'ensure_weekly_instance',
    errors: [result.error],
    messenger,
    config,
  });
}

console.log(JSON.stringify(results.map(summarizeWeeklyEnsureResult), null, 2));
if (hasWeeklyEnsureFailures(results)) process.exitCode = 1;
