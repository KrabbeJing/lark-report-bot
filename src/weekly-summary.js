const RISK_RE = /(风险|阻塞|困难|问题|依赖|待协调|延期|延迟|卡点|无法|未完成|需关注|异常)/;
const FOLLOW_UP_RE = /(下周|计划|待|协调|跟进|推进|确认|联调|评审|上线|发布)/;

export function buildWeeklySummary({ group, reports, weekStart, weekEnd, generatedAt = new Date() }) {
  const memberMap = new Map();
  const allItems = [];
  const risks = [];
  const followUps = [];

  for (const report of reports) {
    const name = report.reporterName || report.senderOpenId || '未识别成员';
    if (!memberMap.has(name)) {
      memberMap.set(name, { name, reportCount: 0, itemCount: 0, dates: new Set() });
    }
    const member = memberMap.get(name);
    member.reportCount += 1;
    if (report.reportDate) member.dates.add(report.reportDate);

    const items = report.workItems || [];
    const tomorrowItems = report.tomorrowPlanItems || [];
    member.itemCount += items.length;
    for (const item of items) {
      allItems.push({ member: name, text: item });
      if (RISK_RE.test(item)) risks.push({ member: name, text: item });
      if (FOLLOW_UP_RE.test(item)) followUps.push({ member: name, text: item });
    }
    for (const item of tomorrowItems) {
      followUps.push({ member: name, text: item });
      if (RISK_RE.test(item)) risks.push({ member: name, text: item });
    }
    for (const risk of report.riskItems || []) {
      if (!risks.some(item => item.text === risk && item.member === name)) {
        risks.push({ member: name, text: risk });
      }
    }
  }

  const members = [...memberMap.values()]
    .map(member => ({
      ...member,
      dates: [...member.dates].sort(),
    }))
    .sort((a, b) => b.reportCount - a.reportCount || a.name.localeCompare(b.name, 'zh-CN'));

  const highlights = dedupeItems(allItems).slice(0, 8);
  const riskItems = dedupeItems(risks).slice(0, 6);
  const followUpItems = dedupeItems(followUps).slice(0, 6);

  const summaryText = buildSummaryText({
    project: group.project,
    reports,
    members,
    highlights,
    riskItems,
    followUpItems,
  });

  return {
    project: group.project,
    agileGroup: group.agileGroup,
    chatId: group.chatId,
    weekStart,
    weekEnd,
    generatedAt,
    reportCount: reports.length,
    memberCount: members.length,
    itemCount: allItems.length,
    members,
    highlights,
    riskItems,
    followUpItems,
    summaryText,
  };
}

export function buildSummaryText({ project, reports, members, highlights, riskItems, followUpItems }) {
  const lines = [
    `${project || '项目组'}本周共收集 ${reports.length} 份日报，覆盖 ${members.length} 名成员，沉淀 ${highlights.length} 项重点事项。`,
    '',
    '重点事项：',
    ...formatTextItems(highlights, '暂无可汇总事项'),
    '',
    '风险阻塞：',
    ...formatTextItems(riskItems, '暂无明确风险阻塞'),
    '',
    '待跟进：',
    ...formatTextItems(followUpItems, '暂无明确待跟进事项'),
  ];
  return lines.join('\n');
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.member}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function formatTextItems(items, emptyText) {
  if (!items.length) return [`- ${emptyText}`];
  return items.map((item, index) => `${index + 1}. ${item.member}：${item.text}`);
}
