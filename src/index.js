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
import { loadGroupConfig } from './config.js';
import { buildLarkClientOptions } from './lark-client.js';
import { LarkMessenger } from './lark-messenger.js';
import { handleMessageEvent } from './message-router.js';
import {
  startDailyFactSyncScheduler,
  startDailySupervisorScheduler,
  startWeeklyStageScheduler,
} from './scheduler.js';
import { runGroupedWorkflow } from './scheduled-workflows.js';
import { SerialTaskQueue } from './serial-task-queue.js';
import { ensureWeeklyInstanceForGroup } from './weekly-instance-service.js';
import { WeeklySheetWriter } from './weekly-sheet-writer.js';
import { runWeeklyWorkflowStage } from './weekly-workflow.js';
import { loadWeeklyConfiguration } from './weekly-config-repository.js';
import { routeWeeklyFacts } from './weekly-source-router.js';
import { writeInitialWeeklyDraft, refreshWeeklyDraft } from './weekly-draft-service.js';
import { notifyWeeklyOwners, notifyMissingCoreMetricOwners } from './weekly-owner-notifier.js';

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
const processingMessageIds = new Set();
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

    if (processedMessageIds.has(messageId) || processingMessageIds.has(messageId)) {
      console.log('[dedupe] already processing/processed');
      return;
    }
    processingMessageIds.add(messageId);

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
        rememberMessageId(messageId);
      } catch (err) {
        console.error(`[handler] failed ${formatOperationalError(err, { stage: 'handler' })}`);
        await reportHandlerError({ err, message, messenger, config });
      } finally {
        processingMessageIds.delete(messageId);
      }
    });
  },
});

const workflowServices = {
  timezone: config.timezone,
  instanceService: {
    ensure: args => ensureWeeklyInstanceForGroup({ ...args, bitable, sheetWriter, timezone: config.timezone }),
    load: args => ensureWeeklyInstanceForGroup({ ...args, bitable, sheetWriter, timezone: config.timezone }),
  },
  factSync: {
    sync: ({ group, period, now }) => bitable.syncDailyFactRecordsForGroup(group, {
      now, timezone: config.timezone, startDate: period.start, endDate: period.end,
    }),
  },
  configRepository: { load: ({ group, period }) => loadWeeklyConfiguration({ group, bitable, period }) },
  sourceRouter: {
    route: async ({ group, period, configuration }) => {
      const facts = await bitable.listAllDailyReportsForRange(group, period.start, period.end);
      const cellMap = await sheetWriter.discoverTemplateTargets(group.weeklySheet, group.weeklySheet?.templateSheetId, { aliasMap: group.weeklySheet?.entityAliases });
      return routeWeeklyFacts({ facts, mappings: configuration.mappings, rules: configuration.rules, cellMap, period });
    },
  },
  ai: {
    generate: ({ group, period }) => aiProvider.generateWeeklySheetPreview({ group, target: {}, evidence: [], styleExamples: [], weekStart: period.start, weekEnd: period.end }),
  },
  draftService: {
    writeInitial: args => writeInitialWeeklyDraft({ ...args, writer: sheetWriter, bitable }),
    refresh: args => refreshWeeklyDraft({ ...args, writer: sheetWriter, bitable }),
  },
  bitable,
  ownerNotifier: {
    owners: args => notifyWeeklyOwners({ ...args, messenger, bitable }),
    metrics: args => notifyMissingCoreMetricOwners({ ...args, writer: sheetWriter, messenger, bitable }),
  },
};

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
      groups: config.groups,
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
