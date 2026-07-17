import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { BitableService } from '../src/bitable-service.js';
import { parseChatDailyReplayArgs, replayChatDailyReports } from '../src/chat-daily-replay.js';
import { loadGroupConfig } from '../src/config.js';
import { buildLarkClientOptions } from '../src/lark-client.js';

const options = parseChatDailyReplayArgs(process.argv.slice(2));
const { APP_ID, APP_SECRET } = process.env;
if (!APP_ID || !APP_SECRET) throw new Error('APP_ID/APP_SECRET 未配置');

const config = loadGroupConfig();
const client = new lark.Client(buildLarkClientOptions({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
}));
const result = await replayChatDailyReports({
  client,
  bitable: new BitableService(client),
  config,
  options,
});

console.log(JSON.stringify({
  group: result.group,
  messagesRead: result.messagesRead,
  replayed: result.replayed,
  skippedExisting: result.skippedExisting,
  ignored: result.ignored,
  facts: {
    created: result.syncResult.created || 0,
    updated: result.syncResult.updated || 0,
    unchanged: result.syncResult.unchanged || 0,
    conflicts: result.syncResult.conflicts || 0,
    filtered: result.syncResult.filtered || 0,
    errors: result.syncResult.errors?.length || 0,
  },
}, null, 2));
if (result.syncResult.errors?.length) process.exitCode = 1;
