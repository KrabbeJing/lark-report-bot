import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import { createAiProvider } from './ai-providers.js';
import { BitableService } from './bitable-service.js';
import { syncDailyFactsForAllGroups } from './daily-fact-sync.js';
import { pushDailyReportsToSupervisors } from './daily-supervisor-push.js';
import { reportHandlerError, reportOperationalFailure } from './error-reporter.js';
import { loadGroupConfig } from './config.js';
import { buildLarkClientOptions } from './lark-client.js';
import { LarkMessenger } from './lark-messenger.js';
import { handleMessageEvent } from './message-router.js';
import {
  startDailyFactSyncScheduler,
  startDailySupervisorScheduler,
  startWeeklyInstanceScheduler,
  startWeeklyScheduler,
} from './scheduler.js';
import { runGroupedWorkflow } from './scheduled-workflows.js';
import { ensureWeeklyInstanceForGroup } from './weekly-instance-service.js';
import { generateWeeklyReportForGroup } from './weekly-reporter.js';
import { WeeklySheetWriter } from './weekly-sheet-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'out');

const { APP_ID, APP_SECRET } = process.env;

if (!APP_ID || !APP_SECRET) {
  console.error('[fatal] 请先在 .env 里配置 APP_ID 和 APP_SECRET');
  process.exit(1);
}

const config = loadGroupConfig();
const larkClientOptions = buildLarkClientOptions({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: lark.Domain.Feishu,
});
const client = new lark.Client(larkClientOptions);

const wsClient = new lark.WSClient(larkClientOptions);

const messenger = new LarkMessenger(client);
const bitable = new BitableService(client);
const aiProvider = createAiProvider();
const sheetWriter = new WeeklySheetWriter(client);
const processedMessageIds = new Set();
const notifyFailure = async ({ task, scope, stage, errors }) => reportOperationalFailure({
  task,
  scope,
  stage,
  errors,
  messenger,
  config,
});

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': (data) => {
    const { message } = data;
    const messageId = message.message_id;

    if (processedMessageIds.has(messageId)) {
      console.log('[dedupe] already processing/processed', messageId);
      return;
    }
    rememberMessageId(messageId);

    console.log('[event] message received', {
      chat_id: message.chat_id,
      chat_type: message.chat_type,
      message_type: message.message_type,
      message_id: message.message_id,
    });

    handleMessageEvent({
      data,
      client,
      messenger,
      bitable,
      config,
      aiProvider,
      sheetWriter,
      outDir: OUT_DIR,
    }).catch(async (err) => {
      console.error('[handler] failed', err?.response?.data || err);
      await reportHandlerError({ err, message, messenger, config });
    });
  },
});

startWeeklyInstanceScheduler({
  config,
  onRun: now => runGroupedWorkflow({
    task: '周报实例创建',
    stage: 'ensure_weekly_instance',
    groups: config.groups,
    operation: group => ensureWeeklyInstanceForGroup({
      group,
      bitable,
      sheetWriter,
      now,
      timezone: config.weeklyInstanceCreation?.timezone || config.timezone,
    }),
    notifyFailure,
  }),
});

startWeeklyScheduler({
  config,
  onRun: now => runGroupedWorkflow({
    task: 'AI周报生成',
    stage: 'generate_weekly',
    groups: config.groups,
    operation: group => generateWeeklyReportForGroup({
      group,
      bitable,
      aiProvider,
      messenger,
      outDir: OUT_DIR,
      timezone: config.timezone,
      now,
      delivery: 'send',
      sheetWriter,
    }),
    notifyFailure,
  }),
});

startDailySupervisorScheduler({
  config,
  onRun: now => runGroupedWorkflow({
    task: '直属上级日报推送',
    stage: 'deliver_supervisor_digest',
    groups: config.groups,
    operation: group => pushDailyReportsToSupervisors({
      group,
      bitable,
      messenger,
      timezone: config.timezone,
      now,
    }),
    notifyFailure,
  }),
});

startDailyFactSyncScheduler({
  config,
  onRun: now => syncDailyFactsForAllGroups({
    config,
    bitable,
    now,
    notifyFailure,
  }),
});

wsClient.start({ eventDispatcher });
console.log(`[bot] WSClient started, waiting for events... groups=${config.groups.length}, ai=${aiProvider.name}`);

function rememberMessageId(messageId) {
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
}
