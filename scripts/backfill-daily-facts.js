import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { loadGroupConfig } from '../src/config.js';
import { reportOperationalFailure } from '../src/error-reporter.js';
import {
  parseDailyFactBackfillArgs,
  runDailyFactBackfill,
} from '../src/daily-fact-backfill.js';
import { buildLarkClientOptions } from '../src/lark-client.js';
import { LarkMessenger } from '../src/lark-messenger.js';

const options = parseDailyFactBackfillArgs(process.argv.slice(2));
const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');

const config = loadGroupConfig();
const client = new lark.Client(buildLarkClientOptions({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
}));
const messenger = new LarkMessenger(client);
const results = await runDailyFactBackfill({
  config,
  bitable: new BitableService(client),
  options,
});

for (const result of results) {
  const errors = result.errors?.length ? result.errors : (result.error ? [result.error] : []);
  if (!errors.length) continue;
  await reportOperationalFailure({
    task: '日报事实回填',
    scope: result.group,
    stage: result.errors?.length ? 'write_daily_fact' : 'backfill_group',
    errors,
    messenger,
    config,
  });
}

console.log(JSON.stringify(results.map(result => ({
  group: result.group,
  created: result.created || 0,
  updated: result.updated || 0,
  unchanged: result.unchanged || 0,
  filtered: result.filtered || 0,
  errorCount: result.errors?.length || (result.error ? 1 : 0),
})), null, 2));
if (results.some(result => result.failed || result.error || result.errors?.length)) {
  process.exitCode = 1;
}
