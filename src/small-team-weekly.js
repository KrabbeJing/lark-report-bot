const VALID_FACT_STATUS = '有效';

export function classifySmallTeamFacts({ target = {}, facts = [], routing = {}, period = {} } = {}) {
  const sections = normalizePosterSections(target);
  const supervisorIds = new Set(normalizeList(target.sourceSupervisors || target.supervisorOpenIds));
  const factById = new Map(facts.map(fact => [String(fact.recordId || ''), fact]));
  const sources = flattenRoutedSources(routing);
  const grouped = new Map(sections.map(section => [section.key, new Map()]));
  const diagnostics = [];

  for (const source of sources) {
    const fact = factById.get(String(source.factRecordId || ''));
    if (!fact || !isEligibleFact(fact, period)) continue;
    if (supervisorIds.size && !supervisorIds.has(String(fact.supervisorOpenId || '').trim())) continue;

    const matches = sections.filter(section => matchesSection(source, section));
    if (matches.length === 0) {
      diagnostics.push({ code: 'unmatched_module', factRecordId: source.factRecordId, text: source.text });
      continue;
    }
    if (matches.length > 1) {
      diagnostics.push({
        code: 'ambiguous_module',
        factRecordId: source.factRecordId,
        text: source.text,
        modules: matches.map(section => section.name),
      });
      continue;
    }

    const section = matches[0];
    const sectionFacts = grouped.get(section.key);
    const factKey = String(fact.recordId || '');
    const existing = sectionFacts.get(factKey);
    if (existing) {
      existing.workItems.push(String(source.text || '').trim());
    } else {
      sectionFacts.set(factKey, {
        ...fact,
        workItems: [String(source.text || '').trim()],
        tomorrowPlanItems: [],
        riskItems: [],
      });
    }
  }

  return {
    sections: sections
      .map(section => ({
        ...section,
        reports: [...(grouped.get(section.key)?.values() || [])],
      }))
      .filter(section => section.reports.length > 0),
    diagnostics,
  };
}

export async function generateSmallTeamSummaries({
  group = {},
  target = {},
  facts = [],
  routing = {},
  period = {},
  aiProvider,
} = {}) {
  const classified = classifySmallTeamFacts({ target, facts, routing, period });
  const sections = [];
  for (const section of classified.sections) {
    const input = {
      group: {
        project: `${group.project || group.name || '团队'}-${target.name || target.key || '小团队'}-${section.name}`,
      },
      reports: section.reports,
      weekStart: period.start,
      weekEnd: period.end,
    };
    const summary = aiProvider?.summarizeWeeklyReports
      ? await aiProvider.summarizeWeeklyReports(input)
      : { summaryText: buildFallbackSummary(section.reports) };
    const summaryText = String(summary?.summaryText || '').trim();
    if (!summaryText) continue;
    sections.push({
      key: section.key,
      name: section.name,
      summaryText,
      provider: summary?.provider || 'template',
      reports: section.reports,
    });
  }
  return {
    target: target.key || target.name || '',
    name: target.name || target.key || '',
    sections,
    diagnostics: classified.diagnostics,
  };
}

function normalizePosterSections(target) {
  const configured = Array.isArray(target.posterSections) ? target.posterSections : [];
  if (configured.length) {
    return configured.map((section, index) => normalizeSection(section, index));
  }
  return normalizeList(target.sectionTargets).map((name, index) => normalizeSection({
    key: `legacy-${index + 1}`,
    name,
    sourceTargets: [name],
  }, index));
}

function normalizeSection(section, index) {
  return {
    key: String(section?.key || `section-${index + 1}`).trim(),
    name: String(section?.name || section?.key || '').trim(),
    sourceTargets: normalizeList(section?.sourceTargets || section?.source_targets),
    includeTopics: normalizeList(section?.includeTopics || section?.include_topics),
    excludeTopics: normalizeList(section?.excludeTopics || section?.exclude_topics),
  };
}

function flattenRoutedSources(routing) {
  return (routing?.buckets || []).flatMap(bucket => (
    (bucket?.sources?.current || bucket?.sources || []).map(source => ({
      ...source,
      target: String(bucket.target || '').trim(),
    }))
  ));
}

function matchesSection(source, section) {
  if (section.sourceTargets.length && !section.sourceTargets.includes(source.target)) return false;
  const text = String(source.text || '').trim();
  if (!text) return false;
  if (section.includeTopics.length && !section.includeTopics.some(topic => text.includes(topic))) return false;
  return !section.excludeTopics.some(topic => text.includes(topic));
}

function isEligibleFact(fact, period) {
  const date = String(fact.reportDate || '').trim();
  return fact.factStatus === VALID_FACT_STATUS
    && Boolean(date)
    && date >= String(period.start || '')
    && date <= String(period.end || '');
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/[,\n]/).map(item => item.trim()).filter(Boolean);
}

function buildFallbackSummary(reports) {
  const items = [...new Set(reports.flatMap(report => report.workItems || []).map(item => String(item).trim()).filter(Boolean))];
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}
