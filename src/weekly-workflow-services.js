import { ensureWeeklyInstanceForGroup, loadWeeklyInstanceForGroup } from './weekly-instance-service.js';
import { loadWeeklyConfiguration } from './weekly-config-repository.js';
import { routeWeeklyFacts } from './weekly-source-router.js';
import { runWeeklyAiPreview } from './weekly-ai-preview.js';
import { writeInitialWeeklyDraft, refreshWeeklyDraft } from './weekly-draft-service.js';
import { notifyWeeklyOwners, notifyMissingCoreMetricOwners } from './weekly-owner-notifier.js';

export function createWeeklyWorkflowServices({ config, bitable, sheetWriter, aiProvider, messenger, poster }) {
  return {
    timezone: config.timezone,
    instanceService: {
      ensure: args => ensureWeeklyInstanceForGroup({ ...args, bitable, sheetWriter, timezone: config.timezone }),
      load: args => loadWeeklyInstanceForGroup({ ...args, bitable, sheetWriter, timezone: config.timezone }),
    },
    factSync: {
      sync: ({ group, period, now }) => bitable.syncDailyFactRecordsForGroup(group, {
        now,
        timezone: config.timezone,
        startDate: period.start,
        endDate: period.end,
      }),
    },
    configRepository: {
      load: ({ group, period }) => loadWeeklyConfiguration({ group, bitable, period }),
    },
    sourceRouter: {
      route: async ({ group, period, configuration }) => {
        const facts = await bitable.listAllDailyReportsForRange(group, period.start, period.end);
        const cellMap = await sheetWriter.discoverTemplateTargets(
          group.weeklySheet,
          group.weeklySheet?.templateSheetId,
          { aliasMap: group.weeklySheet?.entityAliases },
        );
        return routeWeeklyFacts({
          facts,
          mappings: configuration.mappings,
          rules: configuration.rules,
          cellMap,
          period,
        });
      },
    },
    ai: {
      generate: ({ group, period }) => runWeeklyAiPreview({
        config: { groups: [group] },
        bitable,
        sheetWriter,
        aiProvider,
        options: { startDate: period.start, endDate: period.end },
      }),
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
    poster,
  };
}
