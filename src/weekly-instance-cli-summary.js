import { sanitizeOperationalLabel, summarizeOperationalError } from './operational-log.js';

export function summarizeWeeklyEnsureResult(result) {
  return {
    group: sanitizeOperationalLabel(result.group),
    skipped: result.skipped,
    reason: result.reason,
    reused: result.reused,
    instanceKey: result.instanceKey,
    ...(result.error ? {
      error: summarizeOperationalError(result.error),
    } : {}),
  };
}

export function hasWeeklyEnsureFailures(results) {
  return results.some(result => Boolean(result.error));
}
