const VALID_FACT_STATUS = '有效';
const MODULE_TWO = 'module2';
const MODULE_THREE = 'module3';

export function routeWeeklyFacts({
  facts = [],
  mappings = [],
  rules = [],
  cellMap = {},
  period = {},
} = {}) {
  const targetSpecs = buildTargetSpecs(cellMap);
  const bucketsByKey = new Map();
  const evidence = {};
  const diagnostics = [];
  const resolvedFacts = facts
    .filter(fact => isEligibleFact(fact, period))
    .sort(compareFacts)
    .map(fact => {
      const activeMappings = mappings.filter(mapping => isMappingActiveOn(mapping, fact.reportDate));
      const memberResolution = findMemberMappings(fact, activeMappings);
      return {
        fact,
        memberResolution,
        memberKeys: canonicalMemberKeys(fact, memberResolution),
      };
    });
  const blockedMemberKeys = new Set(resolvedFacts
    .filter(({ memberResolution, memberKeys }) => memberKeys.length && memberResolution.mappings.length > 1)
    .flatMap(({ memberKeys }) => memberKeys));

  for (const { fact, memberResolution, memberKeys } of resolvedFacts) {
    for (const [itemIndex, rawText] of toTextArray(fact.workItems).entries()) {
      const source = toSource(fact, rawText, itemIndex);
      if (!source.text) continue;
      const diagnostic = routeItem({
        source,
        memberResolution,
        rules,
        targetSpecs,
        bucketsByKey,
        evidence,
        blocked: memberKeys.some(memberKey => blockedMemberKeys.has(memberKey)),
      });
      if (diagnostic) diagnostics.push(diagnostic);
    }
  }

  return {
    buckets: [...bucketsByKey.values()].sort(compareBuckets),
    evidence,
    diagnostics,
  };
}

function routeItem({ source, memberResolution, rules, targetSpecs, bucketsByKey, evidence, blocked }) {
  if (blocked) return diagnostic(source, 'duplicate_active_mapping');
  if (memberResolution.diagnosticCode) return diagnostic(source, memberResolution.diagnosticCode);
  const { mappings: memberMappings } = memberResolution;
  if (!memberMappings.length) return diagnostic(source, 'unmapped_member');
  if (memberMappings.length > 1) return diagnostic(source, 'duplicate_active_mapping');
  if (isRoutineMeetingWithoutOutcome(source.text)) {
    return diagnostic(source, 'routine_meeting_without_result');
  }

  const allowedModule2Targets = new Set(memberMappings.flatMap(mapping => toTextArray(mapping.module2Targets)));
  const allowedModule3Targets = new Set(memberMappings.map(mapping => normalized(mapping.module3Target)).filter(Boolean));
  const module2 = matchingTargets({
    rules,
    module: MODULE_TWO,
    allowedTargets: allowedModule2Targets,
    text: source.text,
  });

  if (module2.length > 1) return diagnostic(source, 'ambiguous_module2_target', { targets: module2 });
  if (module2.length === 1) {
    return addRoute({ source, module: MODULE_TWO, target: module2[0], targetSpecs, bucketsByKey, evidence });
  }

  const module3 = matchingTargets({
    rules,
    module: MODULE_THREE,
    allowedTargets: allowedModule3Targets,
    text: source.text,
  });
  if (module3.length > 1) return diagnostic(source, 'ambiguous_module3_target', { targets: module3 });
  if (module3.length === 1) {
    return addRoute({ source, module: MODULE_THREE, target: module3[0], targetSpecs, bucketsByKey, evidence });
  }

  return diagnostic(source, 'no_topic_match');
}

function matchingTargets({ rules, module, allowedTargets, text }) {
  return [...new Set(rules
    .filter(rule => moduleKey(rule.module) === module)
    .filter(rule => allowedTargets.has(normalized(rule.target)))
    .filter(rule => matchesTopics(text, rule))
    .map(rule => normalized(rule.target)))]
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
}

function addRoute({ source, module, target, targetSpecs, bucketsByKey, evidence }) {
  const spec = targetSpecs[module].get(target);
  if (!spec) return diagnostic(source, 'target_not_in_cell_map', { module, target });

  const routedSource = { ...source };
  const key = `${module}:${target}`;
  if (!bucketsByKey.has(key)) {
    bucketsByKey.set(key, {
      module,
      target,
      targets: { current: spec.current },
      sources: { current: [] },
    });
  }
  bucketsByKey.get(key).sources.current.push(routedSource);
  evidence[source.evidenceId] = { ...routedSource, module, target };
  return null;
}

function buildTargetSpecs(cellMap) {
  return {
    [MODULE_TWO]: collectTargetSpecs(cellMap.agileProjects),
    [MODULE_THREE]: collectTargetSpecs(cellMap.management),
  };
}

function collectTargetSpecs(entries = {}) {
  const specs = new Map();
  for (const [target, spec] of Object.entries(entries || {})) {
    const current = toCellArray(spec?.current);
    if (current.length) specs.set(normalized(target), { current });
  }
  return specs;
}

function isEligibleFact(fact, period) {
  const reportDate = normalized(fact?.reportDate);
  return fact?.factStatus === VALID_FACT_STATUS
    && Boolean(reportDate)
    && reportDate >= normalized(period.start)
    && reportDate <= normalized(period.end);
}

function isMappingActiveOn(mapping, reportDate) {
  const date = normalized(reportDate);
  const effectiveFrom = normalized(mapping.effectiveFrom);
  const effectiveTo = normalized(mapping.effectiveTo);
  return Boolean(date)
    && (!effectiveFrom || effectiveFrom <= date)
    && (!effectiveTo || effectiveTo >= date);
}

function toSource(fact, text, itemIndex) {
  const factRecordId = normalized(fact.recordId);
  return {
    evidenceId: `${factRecordId}:current:workItems:${itemIndex}`,
    factRecordId,
    category: 'current',
    sourceField: 'workItems',
    itemIndex,
    date: normalized(fact.reportDate),
    member: normalized(fact.reporterName) || normalized(fact.memberOpenId) || normalized(fact.senderOpenId),
    text: cleanItemText(text),
  };
}

function diagnostic(source, code, extra = {}) {
  return { evidenceId: source.evidenceId, factRecordId: source.factRecordId, text: source.text, code, ...extra };
}

function matchesTopics(text, rule) {
  const excluded = toTopicArray(rule.excludeTopics);
  if (excluded.some(topic => includesNormalized(text, topic))) return false;
  return toTopicArray(rule.includeTopics).some(topic => includesNormalized(text, topic));
}

function findMemberMappings(fact, mappings) {
  const memberOpenId = normalized(fact.memberOpenId);
  if (memberOpenId) {
    const openIdMappings = mappings.filter(mapping => normalized(mapping.memberOpenId) === memberOpenId);
    const contactRecordIds = new Set(openIdMappings.flatMap(mapping => toTextArray(mapping.contactRecordIds)));
    const openIdMappingSet = new Set(openIdMappings);
    const expandedMappings = contactRecordIds.size
      ? mappings.filter(mapping => (
        openIdMappingSet.has(mapping) || hasSharedContact(mapping, contactRecordIds)
      ))
      : openIdMappings;
    return { mappings: expandedMappings };
  }

  const memberName = normalized(fact.memberName) || normalized(fact.reporterName);
  if (!memberName) return { mappings: [] };
  const nameMappings = mappings.filter(mapping => normalized(mapping.memberName) === memberName);
  const canonicalMembers = new Set(nameMappings.map(canonicalMemberIdentity));
  if (canonicalMembers.size > 1) return { mappings: [], diagnosticCode: 'ambiguous_member_name' };
  return { mappings: nameMappings };
}

function hasSharedContact(mapping, contactRecordIds) {
  return toTextArray(mapping.contactRecordIds).some(contactRecordId => contactRecordIds.has(contactRecordId));
}

function canonicalMemberIdentity(mapping) {
  const contactRecordIds = [...new Set(toTextArray(mapping.contactRecordIds))].sort();
  if (contactRecordIds.length) return `contact:${contactRecordIds.join('|')}`;
  const memberOpenId = normalized(mapping.memberOpenId);
  if (memberOpenId) return `openId:${memberOpenId}`;
  return `name:${normalized(mapping.memberName)}`;
}

function canonicalMemberKeys(fact, memberResolution) {
  const keys = new Set();
  const memberOpenId = normalized(fact.memberOpenId);
  if (memberOpenId) keys.add(`openId:${memberOpenId}`);
  for (const mapping of memberResolution.mappings) keys.add(canonicalMemberIdentity(mapping));
  return [...keys].sort();
}

function isRoutineMeetingWithoutOutcome(text) {
  const meeting = /(会议|例会|沟通|讨论|汇报)/.test(text);
  const outcome = /(形成结论|形成方案|确认方案|输出成果|输出报告|评审通过|解决问题|上线|发布|落地|交付|提交|签署|制定|达成)/.test(text);
  return meeting && !outcome;
}

function moduleKey(value) {
  const module = normalized(value).toLowerCase();
  if (module === '模块二' || module === 'module2') return MODULE_TWO;
  if (module === '模块三' || module === 'module3') return MODULE_THREE;
  return '';
}

function compareBuckets(left, right) {
  return left.module.localeCompare(right.module) || left.target.localeCompare(right.target, 'zh-Hans-CN');
}

function compareFacts(left, right) {
  return normalized(left.reportDate).localeCompare(normalized(right.reportDate))
    || normalized(left.recordId).localeCompare(normalized(right.recordId))
    || normalized(left.memberOpenId).localeCompare(normalized(right.memberOpenId))
    || normalized(left.memberName || left.reporterName).localeCompare(normalized(right.memberName || right.reporterName));
}

function toTextArray(value) {
  if (Array.isArray(value)) return value.map(normalized).filter(Boolean);
  return normalized(value) ? [normalized(value)] : [];
}

function toTopicArray(value) {
  return toTextArray(value)
    .flatMap(topic => topic.split(/\r?\n/))
    .map(normalized)
    .filter(Boolean);
}

function toCellArray(value) {
  if (Array.isArray(value)) return value.map(normalized).filter(Boolean);
  return normalized(value) ? [normalized(value)] : [];
}

function includesNormalized(text, topic) {
  const normalizedText = normalizeForMatch(text);
  const normalizedTopic = normalizeForMatch(topic);
  return Boolean(normalizedText && normalizedTopic && normalizedText.includes(normalizedTopic));
}

function normalizeForMatch(value) {
  return normalized(value).toLowerCase().replace(/[\s，。；;、:：【】\[\]（）()]/g, '');
}

function cleanItemText(value) {
  return normalized(value)
    .replace(/^[\s【\[]*\d+[\]】)、.．\s]*/, '')
    .replace(/[；;。.\s]+$/, '')
    .trim();
}

function normalized(value) {
  return String(value || '').trim();
}
