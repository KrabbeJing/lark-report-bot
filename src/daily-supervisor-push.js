import { formatYmd } from './date-utils.js';

export async function pushDailyReportsToSupervisors({
  group,
  bitable,
  messenger,
  timezone = 'Asia/Shanghai',
  now = new Date(),
  logger = console,
}) {
  const reportDate = formatYmd(now, timezone);
  const reports = await bitable.listDailyReportsForDate(group, reportDate);
  const batches = groupReportsBySupervisor(reports);
  const results = [];

  for (const batch of batches) {
    if (!batch.supervisorOpenId) {
      logger.warn(`[daily-supervisor] skip supervisor without open_id: ${batch.supervisorName || 'unknown'}`);
      results.push({ skipped: true, reason: 'missing_supervisor_open_id', batch });
      continue;
    }

    const text = buildSupervisorDigestText({
      group,
      reportDate,
      supervisorName: batch.supervisorName,
      reports: batch.reports,
    });
    const uuid = `daily-supervisor-${group.chatId || group.project}-${reportDate}-${batch.supervisorOpenId}`;
    await messenger.sendTextToOpenId(batch.supervisorOpenId, text, uuid);
    results.push({ sent: true, supervisorOpenId: batch.supervisorOpenId, count: batch.reports.length });
  }

  return {
    reportDate,
    totalReports: reports.length,
    supervisors: batches.length,
    results,
  };
}

export function groupReportsBySupervisor(reports) {
  const map = new Map();
  for (const report of reports) {
    const key = report.supervisorOpenId || `name:${report.supervisor || '未配置直属上级'}`;
    if (!map.has(key)) {
      map.set(key, {
        supervisorOpenId: report.supervisorOpenId || '',
        supervisorName: report.supervisor || '未配置直属上级',
        reports: [],
      });
    }
    map.get(key).reports.push(report);
  }
  return [...map.values()].sort((a, b) => a.supervisorName.localeCompare(b.supervisorName, 'zh-CN'));
}

export function buildSupervisorDigestText({ group, reportDate, supervisorName, reports }) {
  const lines = [
    `【${group.project || group.name || '项目组'}】${reportDate} 下属日报汇总`,
    supervisorName ? `直属上级：${supervisorName}` : '',
    `今日共收到 ${reports.length} 份日报。`,
    '',
  ].filter(Boolean);

  for (const report of reports) {
    lines.push(`【${report.reporterName || '未识别成员'}】`);
    appendSection(lines, '今日工作总结', report.workItems);
    appendSection(lines, '明日工作计划', report.tomorrowPlanItems);
    appendSection(lines, '遇到的问题', report.riskItems);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function appendSection(lines, title, items) {
  if (!items?.length) return;
  lines.push(`${title}：`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}
