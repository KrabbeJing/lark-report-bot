export function buildWeeklyAiInputs(reports) {
  const groups = new Map();
  for (const report of reports || []) {
    const key = buildSourceKey(report);
    if (!groups.has(key)) {
      groups.set(key, { ...report, reportDates: [], factRecordIds: [] });
    }
    const grouped = groups.get(key);
    if (report.reportDate && !grouped.reportDates.includes(report.reportDate)) {
      grouped.reportDates.push(report.reportDate);
    }
    if (report.recordId && !grouped.factRecordIds.includes(report.recordId)) {
      grouped.factRecordIds.push(report.recordId);
    }
  }

  return [...groups.values()].map(report => {
    report.reportDates.sort();
    report.factRecordIds.sort();
    const first = report.reportDates[0] || report.reportDate || '';
    const last = report.reportDates.at(-1) || first;
    return {
      ...report,
      reportDate: first,
      dateRange: first && last && first !== last ? `${first}~${last}` : first,
    };
  });
}

function buildSourceKey(report) {
  if (report.effectiveSource === 'form') {
    return report.sourceRecordId ? `form:${report.sourceRecordId}` : buildFactKey(report);
  }
  if (report.effectiveSource === 'chat') {
    return report.messageId ? `chat:${report.messageId}` : buildFactKey(report);
  }
  if (report.sourceRecordId) return `form:${report.sourceRecordId}`;
  if (report.messageId) return `chat:${report.messageId}`;
  return buildFactKey(report);
}

function buildFactKey(report) {
  return `fact:${report.recordId || report.reporterName || 'unknown'}:${report.reportDate || ''}`;
}
