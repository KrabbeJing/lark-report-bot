import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { ensureWeeklyInstancesForAllGroups } from '../src/weekly-instance-service.js';
import { WeeklySheetWriter } from '../src/weekly-sheet-writer.js';

const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');

const config = loadGroupConfig();
const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});
const results = await ensureWeeklyInstancesForAllGroups({
  config,
  bitable: new BitableService(client),
  sheetWriter: new WeeklySheetWriter(client),
  now: new Date(),
});

console.log(JSON.stringify(results.map(result => ({
  group: result.group,
  skipped: result.skipped,
  reason: result.reason,
  reused: result.reused,
  instanceKey: result.instanceKey,
  error: result.error?.message,
})), null, 2));
if (results.some(result => result.error)) process.exitCode = 1;
