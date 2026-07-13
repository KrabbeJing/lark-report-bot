const ALLOWED_STAGES = new Set([
  'handler',
  'find_existing_instance',
  'copy_sheet',
  'move_sheet',
  'locate_template',
  'write_period',
  'write_instance_base',
  'resolve_workbook',
  'validate_reused_instance',
  'validate_reused_sheet',
]);

export function summarizeOperationalError(error, { stage } = {}) {
  const code = normalizeErrorCode(error?.response?.data?.code ?? error?.code);
  const resolvedStage = normalizeStage(stage ?? error?.weeklyInstanceStage);
  return {
    code,
    ...(resolvedStage ? { stage: resolvedStage } : {}),
  };
}

export function formatOperationalError(error, options) {
  const summary = summarizeOperationalError(error, options);
  return [`code=${summary.code}`, ...(summary.stage ? [`stage=${summary.stage}`] : [])].join(' ');
}

export function sanitizeOperationalLabel(value) {
  return String(value ?? '').replace(/\b(?:ou|oc|om)_[A-Za-z0-9_-]+\b/g, '[masked-id]');
}

function normalizeErrorCode(value) {
  const code = String(value ?? '').trim();
  if (/^\d{1,12}$/.test(code)) return code;
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  return 'unknown';
}

function normalizeStage(value) {
  const stage = String(value ?? '').trim();
  if (!stage) return '';
  return ALLOWED_STAGES.has(stage) ? stage : 'unknown';
}
