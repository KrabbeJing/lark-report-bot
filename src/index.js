import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lark from '@larksuiteoapi/node-sdk';
import { createAiProvider } from './ai-providers.js';
import { BitableService } from './bitable-service.js';
import { syncDailyFactsForAllGroups } from './daily-fact-sync.js';
import { pushDailyReportsToSupervisors } from './daily-supervisor-push.js';
import { reportHandlerError, reportOperationalFailure } from './error-reporter.js';
import { formatOperationalError } from './operational-log.js';
import { getReportingUnits, loadGroupConfig } from './config.js';
import { buildLarkClientOptions } from './lark-client.js';
import { LarkMessenger } from './lark-messenger.js';
import { handleMessageEvent } from './message-router.js';
import { handleRecalledMessageEvent } from './chat-message-events.js';
import { replayRecentChatDailyReports } from './chat-daily-replay.js';
import { createMessageDeduper } from './message-deduper.js';
import { getMessageFingerprint } from './message-utils.js';
import {
  startDailyFactSyncScheduler,
  startChatDailyReplayScheduler,
  startDailySupervisorScheduler,
  startWeeklyStageScheduler,
} from './scheduler.js';
import { runGroupedWorkflow } from './scheduled-workflows.js';
import { SerialTaskQueue } from './serial-task-queue.js';
import { WeeklySheetWriter } from './weekly-sheet-writer.js';
import { WeeklyPosterService } from './weekly-poster-service.js';
import { runWeeklyWorkflowStage } from './weekly-workflow.js';
import { createWeeklyWorkflowServices } from './weekly-workflow-services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'out');

const { APP_ID, APP_SECRET } = process.env;

if (!APP_ID || !APP_SECRET) {
  console.error('[fatal] 请先在 .env 里配置 APP_ID 和 APP_SECRET');
  process.exit(1);
}

const config = loadGroupConfig();
const reportingUnits = getReportingUnits(config);
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
const poster = new WeeklyPosterService({ sheetWriter, messenger, outDir: OUT_DIR });
const messageDeduper = createMessageDeduper();
const messageQueue = new SerialTaskQueue();
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
    const fingerprint = getMessageFingerprint(message);

    if (!messageDeduper.begin(messageId, fingerprint)) {
      console.log('[dedupe] already processing/processed');
      return;
    }

    console.log('[event] message received', {
      chat_type: message.chat_type,
      message_type: message.message_type,
    });

    return messageQueue.enqueue(async () => {
      try {
        await handleMessageEvent({
          data,
          client,
          messenger,
          bitable,
          config,
          aiProvider,
          sheetWriter,
          outDir: OUT_DIR,
        });
        messageDeduper.complete(messageId, fingerprint);
      } catch (err) {
        console.error(`[handler] failed ${formatOperationalError(err, { stage: 'handler' })}`);
        await reportHandlerError({ err, message, messenger, config });
      } finally {
        messageDeduper.fail(messageId);
      }
    });
  },
  'im.message.recalled_v1': (data) => handleRecalledMessageEvent({ data, bitable, config }),
});

const workflowServices = createWeeklyWorkflowServices({
  config,
  bitable,
  sheetWriter,
  aiProvider,
  messenger,
  poster,
});

for (const [scheduleKey, stage] of [
  ['weeklyDraft', 'draft'],
  ['weeklyOwnerReminder', 'notify'],
  ['weeklyRefresh', 'refresh'],
  ['weeklyPush', 'publish'],
]) {
  startWeeklyStageScheduler({
    config,
    scheduleKey,
    stage,
    onRun: now => runGroupedWorkflow({
      task: `周报${stage}`,
      stage: `weekly_${stage}`,
      groups: reportingUnits,
      operation: group => runWeeklyWorkflowStage({ stage, group, services: workflowServices, now }),
      notifyFailure,
    }),
  });
}

startDailySupervisorScheduler({
  config,
  onRun: now => runGroupedWorkflow({
    task: '直属上级日报推送',
    stage: 'deliver_supervisor_digest',
    groups: reportingUnits,
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

startChatDailyReplayScheduler({
  config,
  onRun: now => replayRecentChatDailyReports({
    client,
    bitable,
    config,
    now,
  }),
});

wsClient.start({ eventDispatcher });
console.log(`[bot] WSClient started, waiting for events... groups=${config.groups.length}, ai=${aiProvider.name}`);
