import { getWeeklyReportRange } from './date-utils.js';

const STAGES = new Set(['draft', 'notify', 'refresh', 'publish']);

export async function runWeeklyWorkflowStage({ stage, group, services = {}, now = new Date(), dryRun = false }) {
  if (!STAGES.has(stage)) throw new Error(`Unsupported weekly workflow stage: ${stage}`);
  const timezone = services.timezone || group.timezone || 'Asia/Shanghai';
  const period = getWeeklyReportRange(now, timezone);
  const context = { stage, group, services, now, period, timezone, dryRun };

  if (stage === 'draft') return runDraft(context);
  if (stage === 'notify') return runNotify(context);
  if (stage === 'refresh') return runRefresh(context);
  return runPublish(context);
}

async function runDraft(context) {
  const { services, group, period, now, dryRun } = context;
  const instance = await call(services.instanceService, 'ensure', context);
  await syncFacts(context);
  const configuration = await loadConfiguration(context);
  const routing = await routeFacts(context, configuration);
  const preview = await generate(context, configuration, routing);
  const draft = dryRun ? { skipped: true, preview } : await call(services.draftService, 'writeInitial', {
    ...context, instance, configuration, routing, preview,
  });
  await persist(context, instance, { stage: 'draft', aiGenerationStatus: dryRun ? '预览' : '已生成' });
  return { stage: 'draft', period, instance, configuration, routing, preview, draft };
}

async function runNotify(context) {
  const { services, now, dryRun } = context;
  const instance = await loadInstance(context);
  const configuration = await loadConfiguration(context);
  const draft = await readDraft(context, instance);
  const notifications = dryRun ? { skipped: true } : await call(services.ownerNotifier, 'owners', {
    ...context, instance, draft, rules: configuration.rules,
  });
  const metrics = dryRun ? { skipped: true } : await call(services.ownerNotifier, 'metrics', {
    ...context, instance, metricOwners: configuration.metricOwners, metricCells: instance.metricCells || {},
  });
  await persist(context, instance, { stage: 'notify', ownerNotificationStatus: dryRun ? '预览' : notifications?.status });
  return { stage: 'notify', instance, draft, notifications, metrics };
}

async function runRefresh(context) {
  const { services, period, now, dryRun } = context;
  const instance = await loadInstance(context);
  await syncFacts(context);
  const configuration = await loadConfiguration(context);
  const routing = await routeFacts(context, configuration);
  const preview = await generate(context, configuration, routing);
  const refresh = dryRun ? { skipped: true, preview } : await call(services.draftService, 'refresh', {
    ...context, instance, configuration, routing, preview,
  });
  await persist(context, instance, { stage: 'refresh', aiGenerationStatus: dryRun ? '预览' : '已刷新' });
  return { stage: 'refresh', period, instance, configuration, routing, preview, refresh };
}

async function runPublish(context) {
  const { services, group, dryRun } = context;
  const instance = await loadInstance(context);
  const currentSheet = await call(services.poster, 'readSheet', { ...context, instance });
  const poster = await call(services.poster, 'render', {
    ...context, sheet: currentSheet, instance,
  });
  await call(services.poster, 'validate', { ...context, poster, instance });
  if (!dryRun) {
    await call(services.poster, 'sendDepartment', { ...context, poster, instance, chatId: group.weeklyDelivery?.departmentChatId });
    const sections = currentSheet?.sections || {};
    for (const target of (group.weeklyDelivery?.smallTeams || []).filter(item => item.enabled === true)) {
      const content = Object.fromEntries((target.sectionTargets || [])
        .filter(section => Object.prototype.hasOwnProperty.call(sections, section))
        .map(section => [section, sections[section]]));
      await services.poster.sendTeam(
        target,
        content,
        `weekly-${context.period.reportDate}-publish-${target.key}`,
      );
    }
  }
  await persist(context, instance, { stage: 'publish', posterStatus: dryRun ? '预览' : '已发送' });
  return { stage: 'publish', poster, currentSheet };
}

async function syncFacts(context) {
  const service = context.services.factSync;
  if (!service) return null;
  return call(service, 'sync', context);
}

async function loadConfiguration(context) {
  const service = context.services.configRepository;
  return service ? call(service, 'load', context) : { mappings: [], rules: [], styleExamples: [], metricOwners: [] };
}

async function routeFacts(context, configuration) {
  const service = context.services.sourceRouter;
  return service ? call(service, 'route', { ...context, configuration }) : { buckets: [], diagnostics: [] };
}

async function generate(context, configuration, routing) {
  const service = context.services.ai;
  return service ? call(service, 'generate', { ...context, configuration, routing }) : { cells: {}, evidence: {} };
}

async function readDraft(context, instance) {
  if (context.services.draftService?.read) return call(context.services.draftService, 'read', { ...context, instance });
  if (context.services.sheetWriter?.readCells && instance?.targets) {
    const cells = Object.values(instance.targets).flatMap(value => Array.isArray(value) ? value : [value]).filter(Boolean);
    return context.services.sheetWriter.readCells(instance.sheetConfig, instance.sheetId, cells);
  }
  return instance?.aiDraftSnapshot || {};
}

async function loadInstance(context) {
  if (context.services.instanceService?.load) return call(context.services.instanceService, 'load', context);
  return {};
}

async function persist(context, instance, patch) {
  if (context.dryRun || !context.services.bitable?.updateWeeklyInstance) return null;
  return context.services.bitable.updateWeeklyInstance(instance, patch, { now: context.now });
}

async function call(service, method, args) {
  if (!service || typeof service[method] !== 'function') {
    throw new Error(`weekly workflow service missing: ${method}`);
  }
  return service[method](args);
}
