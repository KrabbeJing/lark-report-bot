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
  const instance = normalizeInstanceResult(await call(
    services.instanceService,
    dryRun ? 'load' : 'ensure',
    context,
  ));
  if (!dryRun) await syncFacts(context);
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
  const instance = normalizeInstanceResult(await loadInstance(context));
  const configuration = await loadConfiguration(context);
  const draft = await readDraft(context, instance);
  const notifications = dryRun ? { skipped: true } : await call(services.ownerNotifier, 'owners', {
    ...context, instance, draft, rules: configuration.rules,
  });
  const metrics = dryRun ? { skipped: true } : await call(services.ownerNotifier, 'metrics', {
    ...context,
    instance,
    metricOwners: configuration.metricOwners,
    metricCells: instance.targets?.metrics || instance.metricCells || {},
  });
  await persist(context, instance, { stage: 'notify', ownerNotificationStatus: dryRun ? '预览' : notifications?.status });
  return { stage: 'notify', instance, draft, notifications, metrics };
}

async function runRefresh(context) {
  const { services, period, now, dryRun } = context;
  const instance = normalizeInstanceResult(await loadInstance(context));
  if (!dryRun) await syncFacts(context);
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
  const instance = normalizeInstanceResult(await loadInstance(context));
  const currentSheet = await call(services.poster, 'readSheet', { ...context, instance });
  const poster = await call(services.poster, 'render', {
    ...context, sheet: currentSheet, instance,
  });
  await call(services.poster, 'validate', { ...context, poster, instance });
  const publishDetails = normalizeDetails(instance.smallTeamPushDetails);
  const publishErrors = [];
  const departmentKey = `weekly-${context.period.reportDate}-publish-department`;
  if (!dryRun && !isPosterSent(instance)) {
    await call(services.poster, 'sendDepartment', {
      ...context,
      poster,
      instance,
      chatId: group.weeklyDelivery?.departmentChatId,
      idempotencyKey: departmentKey,
    });
    await persist(context, instance, {
      posterStatus: '已发送',
      posterSentAt: context.now.getTime(),
    });
  }
  if (!dryRun) {
    const sections = currentSheet?.sections || {};
    for (const target of (group.weeklyDelivery?.smallTeams || []).filter(item => item.enabled === true)) {
      const idempotencyKey = `weekly-${context.period.reportDate}-publish-${target.key}`;
      if (hasSuccessfulDetail(publishDetails, idempotencyKey)) continue;
      const content = Object.fromEntries((target.sectionTargets || [])
        .filter(section => Object.prototype.hasOwnProperty.call(sections, section))
        .map(section => [section, sections[section]]));
      try {
        await services.poster.sendTeam(target, content, idempotencyKey);
        publishDetails.push({
          key: target.key,
          status: '成功',
          sentAt: context.now.getTime(),
          idempotencyKey,
          errorCode: '',
        });
      } catch (error) {
        publishErrors.push(error);
        publishDetails.push({
          key: target.key,
          status: '失败',
          sentAt: context.now.getTime(),
          idempotencyKey,
          errorCode: safeErrorCode(error),
        });
      }
      await persist(context, instance, { smallTeamPushDetails: publishDetails });
    }
  }
  const enabledTeams = (group.weeklyDelivery?.smallTeams || []).filter(item => item.enabled === true);
  const failedTeams = publishDetails.filter(item => item.status === '失败').length;
  const successfulTeams = publishDetails.filter(item => item.status === '成功').length;
  const smallTeamPushStatus = dryRun
    ? '预览'
    : enabledTeams.length === 0
      ? '停用'
      : failedTeams === 0 && successfulTeams === enabledTeams.length
        ? '成功'
        : successfulTeams === 0
          ? '失败'
          : '部分成功';
  await persist(context, instance, {
    stage: 'publish',
    posterStatus: dryRun ? '预览' : '已发送',
    smallTeamPushStatus,
    ...(dryRun ? {} : { smallTeamPushDetails: publishDetails }),
  });
  return { stage: 'publish', poster, currentSheet, errors: publishErrors };
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

function normalizeInstanceResult(result) {
  if (result?.instance && typeof result.instance === 'object') {
    return { ...result.instance, targets: result.targets || result.instance.targets };
  }
  return result || {};
}

function isPosterSent(instance) {
  return instance?.posterStatus === '已发送' || Boolean(instance?.posterSentAt);
}

function hasSuccessfulDetail(details, idempotencyKey) {
  return details.some(item => item?.idempotencyKey === idempotencyKey && item?.status === '成功');
}

function normalizeDetails(value) {
  if (typeof value === 'string') {
    try { return normalizeDetails(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object') {
    if (Array.isArray(value.details)) return normalizeDetails(value.details);
    return Object.values(value).filter(item => item && typeof item === 'object');
  }
  return [];
}

function safeErrorCode(error) {
  const value = error?.response?.data?.code ?? error?.code;
  return value == null || value === '' ? 'send_failed' : String(value).slice(0, 64);
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
