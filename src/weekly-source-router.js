const VALID_FACT_STATUS = '有效';
const MODULE_TWO = 'module2';
const MODULE_THREE = 'module3';
const EXPLICIT_MEETING_WORDS = /会议|例会|项目会|评审会|周会|协调会|座谈会|碰头会|沟通会|讨论会|汇报会/;
const BARE_PROCESS_MEETINGS = /沟通|讨论|汇报/;
const MEETING_ACTIONS = /参加|召开|组织|出席|列席|主持/;
const MEETING_CANDIDATE = /会议|会/;
const ACTION_MEETING_MAX_LENGTH = 20;
const ACTION_MEETING_DELIMITERS = ['，', '。', '；', ';', '：', ':', '、', '\n'];
const NON_MEETING_WORDS = ['社会', '工会', '协会', '学会', '机会', '体会', '优惠', '不会', '将会', '都会', '可能会', '委员会', '会计', '会员', '会籍', '会费', '会务', '会刊', '会展'];
const NON_MEETING_PROCESS_BOUNDARIES = /后|并|[，。；;：:、\n]/;
const COMPLETION_MARKERS = ['已', '已经', '成功', '最终', '会后'];
const STRONG_INTENT_OR_NEGATION = /尚未|未能|没有|未|议题|计划|拟|准备|是否|待|需要|需|针对|关于|重点|就/;
const PROCESS_MARKERS = /讨论|沟通|协调|研究|交流|汇报|围绕|开展|评审|审议|测试|审核|审查|论证|研讨|验证|演示|演练|培训|学习|调研|分析|梳理|排查/;
const OUTCOME_CONNECTORS = ['并', '后', '最终', '已', '已经', '成功', '会后'];
const CLAUSE_DELIMITERS = ['。', '；', ';', '\n'];
const MEETING_OUTCOME_PATTERNS = [
  /形成(?:结论|方案|报告|成果|共识)/,
  /输出(?:成果|报告|方案)/,
  /解决问题/,
  /(?:确认|明确|确定)[^，。；;]*?(?:方案|结论)/,
  /签署协议/,
  /提交(?:成果|报告|材料)/,
  /制定(?:方案|计划)/,
  /达成(?:一致|共识)/,
  /评审通过/,
  /(?:已|已经|成功|最终|会后)(?:上线|发布|落地|交付)/,
  /(?:上线|发布|落地|交付)(?:完成|成功)/,
];

export function buildWeeklyClassificationCandidates({
  facts = [],
  mappings = [],
  rules = [],
  cellMap = {},
  period = {},
} = {}) {
  const targetSpecs = buildTargetSpecs(cellMap);
  const ruleIndex = buildSemanticRuleIndex(rules);
  const periodComponents = buildMappingIdentityComponents(
    mappings.filter(mapping => isMappingRelevantToPeriod(mapping, period)),
  );
  const resolvedFacts = facts
    .filter(fact => isEligibleFact(fact, period))
    .sort(compareFacts)
    .map(fact => {
      const activeComponents = activeComponentViews(periodComponents, fact.reportDate);
      const memberResolution = findMemberMappings(fact, activeComponents);
      return {
        fact,
        memberResolution,
        memberKeys: memberResolution.aliasKeys,
      };
    });
  const blockedMemberKeys = new Set(resolvedFacts
    .filter(({ memberResolution, memberKeys }) => memberKeys.length && memberResolution.mappings.length > 1)
    .flatMap(({ memberKeys }) => memberKeys));
  const candidates = [];
  const diagnostics = [];

  for (const { fact, memberResolution, memberKeys } of resolvedFacts) {
    for (const [itemIndex, rawText] of toTextArray(fact.workItems).entries()) {
      const source = toSource(fact, rawText, itemIndex);
      if (!source.text) continue;

      const diagnosticCode = classificationMemberDiagnostic({
        memberResolution,
        memberKeys,
        blockedMemberKeys,
      });
      if (diagnosticCode) {
        diagnostics.push(diagnostic(source, diagnosticCode));
        continue;
      }

      const allowedTargets = buildAllowedClassificationTargets({
        mappings: memberResolution.mappings,
        ruleIndex,
        targetSpecs,
      });
      if (allowedTargets.diagnostic) {
        diagnostics.push(diagnostic(source, allowedTargets.diagnostic.code, allowedTargets.diagnostic.details));
        continue;
      }
      if (!allowedTargets.targets.length) {
        diagnostics.push(diagnostic(source, 'no_allowed_target'));
        continue;
      }

      candidates.push({ ...source, allowedTargets: allowedTargets.targets });
    }
  }

  return {
    candidates: candidates.sort(compareClassificationCandidates),
    diagnostics,
  };
}

// Legacy small-team routing: department previews must use bounded semantic candidates above.
export function routeWeeklyFacts({
  facts = [],
  mappings = [],
  rules = [],
  cellMap = {},
  period = {},
  includeRoutineMeetingEvidence = false,
} = {}) {
  const targetSpecs = buildTargetSpecs(cellMap);
  const bucketsByKey = new Map();
  const evidence = {};
  const diagnostics = [];
  const periodComponents = buildMappingIdentityComponents(
    mappings.filter(mapping => isMappingRelevantToPeriod(mapping, period)),
  );
  const resolvedFacts = facts
    .filter(fact => isEligibleFact(fact, period))
    .sort(compareFacts)
    .map(fact => {
      const activeComponents = activeComponentViews(periodComponents, fact.reportDate);
      const memberResolution = findMemberMappings(fact, activeComponents);
      return {
        fact,
        memberResolution,
        memberKeys: memberResolution.aliasKeys,
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
        includeRoutineMeetingEvidence,
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

function routeItem({
  source,
  memberResolution,
  rules,
  targetSpecs,
  bucketsByKey,
  evidence,
  blocked,
  includeRoutineMeetingEvidence,
}) {
  if (blocked) return diagnostic(source, 'duplicate_active_mapping');
  if (memberResolution.diagnosticCode) return diagnostic(source, memberResolution.diagnosticCode);
  const { mappings: memberMappings } = memberResolution;
  if (!memberMappings.length) return diagnostic(source, 'unmapped_member');
  if (memberMappings.length > 1) return diagnostic(source, 'duplicate_active_mapping');
  if (!includeRoutineMeetingEvidence && isRoutineMeetingWithoutOutcome(source.text)) {
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
    [MODULE_TWO]: collectTargetSpecs(cellMap?.agileProjects),
    [MODULE_THREE]: collectTargetSpecs(cellMap?.management),
  };
}

function buildSemanticRuleIndex(rules) {
  const enabledRules = rules.filter(rule => rule?.enabled !== false);
  const rulesByTargetId = new Map();
  const rulesByNaturalKey = new Map();
  for (const rule of enabledRules) {
    const targetId = normalized(rule.targetId);
    const module = moduleKey(rule.module);
    const target = normalized(rule.target);
    const contentType = normalized(rule.contentType);
    const naturalKey = `${module}:${target}:${contentType}`;
    addIndexedRule(rulesByTargetId, targetId, rule);
    addIndexedRule(rulesByNaturalKey, naturalKey, rule);
  }

  return {
    rulesByTargetId,
    rulesByNaturalKey,
    duplicateTargetIds: duplicateIndexKeys(rulesByTargetId),
    duplicateNaturalKeys: duplicateIndexKeys(rulesByNaturalKey),
  };
}

function addIndexedRule(index, key, rule) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(rule);
}

function duplicateIndexKeys(index) {
  return new Set([...index.entries()]
    .filter(([, rules]) => rules.length > 1)
    .map(([key]) => key));
}

function classificationMemberDiagnostic({ memberResolution, memberKeys, blockedMemberKeys }) {
  if (memberKeys.some(memberKey => blockedMemberKeys.has(memberKey))) return 'duplicate_active_mapping';
  if (memberResolution.diagnosticCode) return memberResolution.diagnosticCode;
  if (!memberResolution.mappings.length) return 'unmapped_member';
  if (memberResolution.mappings.length > 1) return 'duplicate_active_mapping';
  return '';
}

function buildAllowedClassificationTargets({ mappings, ruleIndex, targetSpecs }) {
  const allowedPairs = new Map();
  for (const mapping of mappings) {
    for (const target of toTextArray(mapping.module2Targets)) {
      allowedPairs.set(`${MODULE_TWO}:${target}`, { module: MODULE_TWO, target });
    }
    const module3Target = normalized(mapping.module3Target);
    if (module3Target) {
      allowedPairs.set(`${MODULE_THREE}:${module3Target}`, {
        module: MODULE_THREE,
        target: module3Target,
      });
    }
  }

  const targets = [];
  for (const pair of allowedPairs.values()) {
    const ruleResult = resolveSemanticRule(pair, ruleIndex);
    if (ruleResult.diagnostic) return ruleResult;
    const spec = targetSpecs[pair.module]?.get(normalized(pair.target));
    if (!spec) {
      return {
        diagnostic: {
          code: 'target_not_in_cell_map',
          details: { module: pair.module, target: pair.target },
        },
      };
    }
    const rule = ruleResult.rule;
    targets.push({
      targetId: normalized(rule.targetId),
      module: pair.module,
      target: normalized(rule.target),
      contentType: normalized(rule.contentType),
      cells: [...spec.current],
      businessScope: normalized(rule.businessScope),
      includeTopics: toTopicArray(rule.includeTopics),
      excludeTopics: toTopicArray(rule.excludeTopics),
      positiveExamples: toTopicArray(rule.positiveExamples),
      negativeExamples: toTopicArray(rule.negativeExamples),
      order: numericOrder(rule.order),
    });
  }

  targets.sort((left, right) => (
    left.order - right.order
    || left.targetId.localeCompare(right.targetId, 'zh-Hans-CN')
  ));
  return { targets: targets.map(({ order, ...target }) => target) };
}

function resolveSemanticRule({ module, target }, ruleIndex) {
  const naturalKey = `${module}:${normalized(target)}:`;
  const matchingRules = [...ruleIndex.rulesByNaturalKey.entries()]
    .filter(([key]) => key.startsWith(naturalKey))
    .flatMap(([, rules]) => rules);
  if (!matchingRules.length) {
    return {
      diagnostic: {
        code: 'missing_target_rule',
        details: { module, target },
      },
    };
  }
  if (matchingRules.length !== 1) {
    return {
      diagnostic: {
        code: 'duplicate_target_rule',
        details: { module, target },
      },
    };
  }

  const rule = matchingRules[0];
  const targetId = normalized(rule.targetId);
  const exactNaturalKey = `${module}:${normalized(rule.target)}:${normalized(rule.contentType)}`;
  if (!targetId
    || ruleIndex.duplicateTargetIds.has(targetId)
    || ruleIndex.duplicateNaturalKeys.has(exactNaturalKey)
    || ruleIndex.rulesByTargetId.get(targetId)?.length !== 1) {
    return {
      diagnostic: {
        code: 'duplicate_target_rule',
        details: { module, target },
      },
    };
  }
  return { rule };
}

function numericOrder(value) {
  const order = Number(value);
  return Number.isFinite(order) ? order : 0;
}

function compareClassificationCandidates(left, right) {
  return normalized(left.date).localeCompare(normalized(right.date))
    || normalized(left.evidenceId).localeCompare(normalized(right.evidenceId));
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

function isMappingRelevantToPeriod(mapping, period) {
  const periodStart = normalized(period.start);
  const periodEnd = normalized(period.end);
  const effectiveFrom = normalized(mapping.effectiveFrom);
  const effectiveTo = normalized(mapping.effectiveTo);
  return Boolean(periodStart && periodEnd)
    && (!effectiveTo || effectiveTo >= periodStart)
    && (!effectiveFrom || effectiveFrom <= periodEnd);
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

function findMemberMappings(fact, components) {
  const memberOpenId = normalized(fact.memberOpenId);
  if (memberOpenId) {
    const matchingComponents = components.filter(component => component.activeOpenIds.includes(memberOpenId));
    if (matchingComponents.length > 1) {
      const memberName = normalized(fact.memberName) || normalized(fact.reporterName);
      const nameMatches = matchingComponents.filter(component => (
        memberName && component.mappings.some(mapping => normalized(mapping.memberName) === memberName)
      ));
      if (nameMatches.length === 1) return nameMatches[0];
      return emptyResolution('ambiguous_member_open_id');
    }
    return matchingComponents[0] || emptyResolution();
  }

  const memberName = normalized(fact.memberName) || normalized(fact.reporterName);
  if (!memberName) return emptyResolution();
  const matchingComponents = components.filter(component => (
    component.mappings.some(mapping => normalized(mapping.memberName) === memberName)
  ));
  if (matchingComponents.length > 1) return emptyResolution('ambiguous_member_name');
  return matchingComponents[0] || emptyResolution();
}

function activeComponentViews(components, reportDate) {
  return components
    .map(component => {
      const mappings = component.mappings.filter(mapping => isMappingActiveOn(mapping, reportDate));
      return {
        ...component,
        mappings,
        activeOpenIds: [...new Set(mappings
          .map(mapping => normalized(mapping.memberOpenId))
          .filter(Boolean))]
          .sort(),
      };
    })
    .filter(component => component.mappings.length);
}

function emptyResolution(diagnosticCode = '') {
  return { mappings: [], aliasKeys: [], ...(diagnosticCode ? { diagnosticCode } : {}) };
}

function buildMappingIdentityComponents(mappings) {
  const nodes = mappings.map((mapping, index) => ({
    mapping,
    index,
    contactRecordIds: [...new Set(toTextArray(mapping.contactRecordIds))],
    memberOpenId: normalized(mapping.memberOpenId),
    memberName: normalized(mapping.memberName),
  }));
  const parents = nodes.map((_, index) => index);
  const find = index => {
    if (parents[index] !== index) parents[index] = find(parents[index]);
    return parents[index];
  };
  const connect = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  connectMatchingNodes(nodes, node => node.contactRecordIds, connect);
  const scopedOpenIds = connectOpenIdNodes(nodes, find, connect);

  const components = new Map();
  for (const node of nodes) {
    const root = find(node.index);
    if (!components.has(root)) components.set(root, { nodes: [] });
    const component = components.get(root);
    component.nodes.push(node);
  }
  return [...components.values()].map(component => ({
    mappings: component.nodes.map(node => node.mapping),
    openIds: [...new Set(component.nodes.map(node => node.memberOpenId).filter(Boolean))].sort(),
    aliasKeys: componentAliasKeys(component.nodes, scopedOpenIds),
  }));
}

function connectMatchingNodes(nodes, aliasesFor, connect, shouldConnect = () => true) {
  const indexesByAlias = new Map();
  for (const node of nodes) {
    for (const alias of aliasesFor(node)) {
      if (!indexesByAlias.has(alias)) indexesByAlias.set(alias, []);
      indexesByAlias.get(alias).push(node.index);
    }
  }
  for (const indexes of indexesByAlias.values()) {
    if (indexes.length < 2 || !shouldConnect(indexes)) continue;
    for (const index of indexes.slice(1)) connect(indexes[0], index);
  }
}

function connectOpenIdNodes(nodes, find, connect) {
  const indexesByOpenId = new Map();
  for (const node of nodes) {
    if (!node.memberOpenId) continue;
    if (!indexesByOpenId.has(node.memberOpenId)) indexesByOpenId.set(node.memberOpenId, []);
    indexesByOpenId.get(node.memberOpenId).push(node.index);
  }

  const scopedOpenIds = new Set();
  for (const [memberOpenId, indexes] of indexesByOpenId) {
    const explicitRoots = new Map();
    for (const index of indexes) {
      if (!nodes[index].contactRecordIds.length) continue;
      const root = find(index);
      if (!explicitRoots.has(root)) explicitRoots.set(root, index);
    }
    const contactlessIndexes = indexes.filter(index => !nodes[index].contactRecordIds.length);
    if (explicitRoots.size <= 1) {
      for (const index of indexes.slice(1)) connect(indexes[0], index);
      continue;
    }

    scopedOpenIds.add(memberOpenId);
    for (const index of contactlessIndexes) {
      const memberName = nodes[index].memberName;
      if (!memberName) continue;
      const matchingRoots = [...explicitRoots.entries()].filter(([root]) => (
        nodes.some(node => (
          node.contactRecordIds.length > 0
          && find(node.index) === root
          && node.memberName === memberName
        ))
      ));
      if (matchingRoots.length === 1) connect(index, matchingRoots[0][1]);
    }
  }
  return scopedOpenIds;
}

function componentAliasKeys(nodes, scopedOpenIds) {
  const contactAliases = [...new Set(nodes.flatMap(node => (
    node.contactRecordIds.map(contactRecordId => `contact:${contactRecordId}`)
  )))].sort();
  const aliases = new Set(contactAliases);
  const contactScope = contactAliases.join('|');
  for (const node of nodes) {
    if (node.memberOpenId) {
      const openIdAlias = scopedOpenIds.has(node.memberOpenId)
        ? `openId:${node.memberOpenId}|${contactScope || `mapping:${node.mapping.recordId || node.index}`}`
        : `openId:${node.memberOpenId}`;
      aliases.add(openIdAlias);
    } else if (!node.contactRecordIds.length && node.memberName) {
      aliases.add(`name:${node.memberName}`);
    }
  }
  return [...aliases].sort();
}

function isRoutineMeetingWithoutOutcome(text) {
  const meeting = findMeeting(text);
  return Boolean(meeting) && !hasMeetingOutcome(text, meeting);
}

function findMeeting(text) {
  const actionMeeting = findActionMeeting(text);
  const meetings = [
    ...findMatches(text, EXPLICIT_MEETING_WORDS)
      .filter(match => !isNonMeetingCandidate(text, match))
      .map(match => ({ ...match, isProcess: false })),
    ...findMatches(text, BARE_PROCESS_MEETINGS)
      .filter(match => !isProcessAfterNonMeetingWord(text, match))
      .map(match => ({ ...match, isProcess: true })),
    ...(actionMeeting ? [actionMeeting] : []),
  ];
  return meetings.sort((left, right) => (
    left.index - right.index || right.length - left.length
  ))[0] || null;
}

function findActionMeeting(text) {
  for (const action of findMatches(text, MEETING_ACTIONS)) {
    const actionEnd = action.index + action.length;
    const searchEnd = actionMeetingSearchEnd(text, actionEnd);
    const candidates = findMatches(text.slice(actionEnd, searchEnd), MEETING_CANDIDATE);
    for (const candidate of candidates) {
      const meeting = { index: actionEnd + candidate.index, length: candidate.length, isProcess: false };
      if (!isNonMeetingCandidate(text, meeting)) return meeting;
    }
  }
  return null;
}

function actionMeetingSearchEnd(text, actionEnd) {
  const delimiterIndexes = ACTION_MEETING_DELIMITERS
    .map(delimiter => text.indexOf(delimiter, actionEnd))
    .filter(index => index >= 0);
  const clauseEnd = delimiterIndexes.length ? Math.min(...delimiterIndexes) : text.length;
  return Math.min(clauseEnd, actionEnd + ACTION_MEETING_MAX_LENGTH);
}

function isNonMeetingCandidate(text, meeting) {
  return NON_MEETING_WORDS.some(word => {
    const wordIndex = text.lastIndexOf(word, meeting.index);
    return wordIndex >= 0
      && meeting.index < wordIndex + word.length
      && !(word === '会计' && text.startsWith('会计划', wordIndex));
  });
}

function isProcessAfterNonMeetingWord(text, process) {
  return findMatches(text, MEETING_ACTIONS).some(action => {
    const actionEnd = action.index + action.length;
    if (process.index < actionEnd || process.index >= actionMeetingSearchEnd(text, actionEnd)) return false;
    return NON_MEETING_WORDS.some(word => {
      const wordIndex = text.lastIndexOf(word, process.index);
      if (wordIndex < actionEnd || wordIndex + word.length > process.index) return false;
      const between = text.slice(wordIndex + word.length, process.index);
      return !NON_MEETING_PROCESS_BOUNDARIES.test(between);
    });
  });
}

function hasMeetingOutcome(text, meeting) {
  return MEETING_OUTCOME_PATTERNS
    .flatMap(pattern => findMatches(text, pattern))
    .some(outcome => isSupportedMeetingOutcome(text, meeting, outcome));
}

function isSupportedMeetingOutcome(text, meeting, outcome) {
  const clause = meetingClause(text, meeting, outcome);
  if (STRONG_INTENT_OR_NEGATION.test(clause)) return false;
  const meetingEnd = meeting.index + meeting.length;
  if (outcome.index < meetingEnd) return hasAdjacentCompletionMarker(text, outcome);

  const processContext = text.slice(meeting.isProcess ? meeting.index : meetingEnd, outcome.index);
  if (PROCESS_MARKERS.test(processContext) && !hasOutcomeConnector(processContext)) return false;
  const trailingContext = text.slice(outcome.index + outcome.length, findClauseEnd(text, outcome.index + outcome.length));
  if (PROCESS_MARKERS.test(trailingContext)) return false;
  return true;
}

function meetingClause(text, meeting, outcome) {
  const startIndex = Math.min(meeting.index, outcome.index);
  const endIndex = Math.max(meeting.index + meeting.length, outcome.index + outcome.length);
  const start = findClauseStart(text, startIndex);
  const end = findClauseEnd(text, endIndex);
  return text.slice(start, end);
}

function findClauseStart(text, index) {
  return Math.max(...CLAUSE_DELIMITERS.map(delimiter => text.lastIndexOf(delimiter, index - 1))) + 1;
}

function findClauseEnd(text, index) {
  const endings = CLAUSE_DELIMITERS
    .map(delimiter => text.indexOf(delimiter, index))
    .filter(end => end >= 0);
  return endings.length ? Math.min(...endings) : text.length;
}

function hasOutcomeConnector(context) {
  return OUTCOME_CONNECTORS.some(connector => context.endsWith(connector));
}

function findMatches(text, pattern) {
  const matches = [];
  let startIndex = 0;
  while (startIndex < text.length) {
    const match = text.slice(startIndex).match(pattern);
    if (!match) break;
    const index = startIndex + match.index;
    const length = match[0].length;
    matches.push({ index, length });
    startIndex = index + Math.max(length, 1);
  }
  return matches;
}

function hasCompletionMarkerBefore(text, outcome) {
  const beforeOutcome = text.slice(0, outcome.index);
  return COMPLETION_MARKERS.some(marker => beforeOutcome.endsWith(marker));
}

function hasAdjacentCompletionMarker(text, outcome) {
  return hasCompletionMarkerBefore(text, outcome)
    || COMPLETION_MARKERS.some(marker => text.startsWith(marker, outcome.index));
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
