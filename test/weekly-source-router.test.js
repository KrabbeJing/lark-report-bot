import test from 'node:test';
import assert from 'node:assert/strict';
import { routeWeeklyFacts } from '../src/weekly-source-router.js';

const period = { start: '2026-07-17', end: '2026-07-23' };
const cellMap = {
  reportPeriod: 'B2',
  agileProjects: {
    收单项目组: { current: 'C26', next: 'C27' },
    融羲项目组: { current: 'C28', next: 'C29' },
  },
  management: {
    对公客群经营及场景建设: { current: ['C45', 'C46', 'C47'], next: ['C48', 'C49', 'C50'] },
  },
};

function fact(overrides = {}) {
  return {
    recordId: 'rec_fact_1',
    reportDate: '2026-07-20',
    reporterName: '张三',
    memberOpenId: 'ou_a',
    factStatus: '有效',
    workItems: ['完成收单接口联调'],
    ...overrides,
  };
}

function mapping(overrides = {}) {
  return {
    recordId: 'rec_mapping_1',
    memberOpenId: 'ou_a',
    module2Targets: ['收单项目组'],
    module3Target: '对公客群经营及场景建设',
    ...overrides,
  };
}

function rule(module, target, includeTopics, overrides = {}) {
  return {
    recordId: `rec_rule_${module}_${target}`,
    module,
    target,
    includeTopics,
    excludeTopics: [],
    ...overrides,
  };
}

function texts(result, target) {
  return result.buckets
    .find(bucket => bucket.target === target)
    ?.sources.current.map(item => item.text) || [];
}

function diagnosticCodes(result) {
  return result.diagnostics.map(item => item.code);
}

test('routes receipt work to module II and cloud payment work to module III', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单接口联调', '完成云缴费对账方案评审'] })],
    mappings: [mapping()],
    rules: [
      rule('模块二', '收单项目组', ['收单']),
      rule('模块三', '对公客群经营及场景建设', ['云缴费']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
  assert.deepEqual(texts(result, '对公客群经营及场景建设'), ['完成云缴费对账方案评审']);
  assert.equal(result.evidence['rec_fact_1:current:workItems:0'].target, '收单项目组');
  assert.equal(result.evidence['rec_fact_1:current:workItems:1'].target, '对公客群经营及场景建设');
});

test('routes each work item to one module and lets a module II match win', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单云缴费联调'] })],
    mappings: [mapping()],
    rules: [
      rule('模块二', '收单项目组', ['收单']),
      rule('模块三', '对公客群经营及场景建设', ['云缴费']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单云缴费联调']);
  assert.deepEqual(texts(result, '对公客群经营及场景建设'), []);
  assert.deepEqual(Object.keys(result.evidence), ['rec_fact_1:current:workItems:0']);
});

test('does not route a member to a target absent from their source mapping', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成融羲需求评审'] })],
    mappings: [mapping({ module2Targets: ['收单项目组'], module3Target: '' })],
    rules: [rule('模块二', '融羲项目组', ['融羲'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['no_topic_match']);
});

test('pauses every work item when one member has multiple active mappings', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单接口联调', '完成云缴费对账'] })],
    mappings: [
      mapping({ recordId: 'rec_mapping_a', module2Targets: ['收单项目组'], module3Target: '' }),
      mapping({ recordId: 'rec_mapping_b', module2Targets: [], module3Target: '对公客群经营及场景建设' }),
    ],
    rules: [
      rule('模块二', '收单项目组', ['收单']),
      rule('模块三', '对公客群经营及场景建设', ['云缴费']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['duplicate_active_mapping', 'duplicate_active_mapping']);
  assert.deepEqual(result.diagnostics.map(item => item.evidenceId), [
    'rec_fact_1:current:workItems:0',
    'rec_fact_1:current:workItems:1',
  ]);
});

test('uses only mappings active on the fact date when ownership changed during the period', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ reportDate: '2026-07-20' })],
    mappings: [
      mapping({ recordId: 'rec_mapping_old', effectiveFrom: '2026-07-17', effectiveTo: '2026-07-19', module3Target: '' }),
      mapping({ recordId: 'rec_mapping_current', effectiveFrom: '2026-07-20', effectiveTo: '2026-07-23', module3Target: '' }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
  assert.deepEqual(result.diagnostics, []);
});

test('pauses a canonical member for the whole period after one fact date has duplicate mappings', () => {
  const facts = [
    fact({
      recordId: 'rec_monday',
      reportDate: '2026-07-20',
      workItems: ['周一完成收单接口联调'],
    }),
    fact({
      recordId: 'rec_tuesday',
      reportDate: '2026-07-21',
      workItems: ['周二完成收单接口联调'],
    }),
  ];
  const input = {
    mappings: [
      mapping({ recordId: 'rec_mapping_monday', effectiveFrom: '2026-07-20', effectiveTo: '2026-07-20', module3Target: '' }),
      mapping({ recordId: 'rec_mapping_current', effectiveFrom: '2026-07-20', effectiveTo: '2026-07-23', module3Target: '' }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  };

  const forward = routeWeeklyFacts({ ...input, facts });
  const reversed = routeWeeklyFacts({ ...input, facts: [...facts].reverse() });

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.buckets, []);
  assert.deepEqual(forward.evidence, {});
  assert.deepEqual(diagnosticCodes(forward), ['duplicate_active_mapping', 'duplicate_active_mapping']);
  assert.deepEqual(forward.diagnostics.map(item => item.evidenceId), [
    'rec_monday:current:workItems:0',
    'rec_tuesday:current:workItems:0',
  ]);
});

test('propagates a period mapping pause from an OpenID fact to a same-contact name-resolved fact', () => {
  const facts = [
    fact({
      recordId: 'rec_monday_open_id',
      reportDate: '2026-07-20',
      memberOpenId: 'ou_a',
      memberName: '张三',
      workItems: ['周一完成收单接口联调'],
    }),
    fact({
      recordId: 'rec_tuesday_name',
      reportDate: '2026-07-21',
      memberOpenId: '',
      memberName: '张三',
      workItems: ['周二完成收单接口联调'],
    }),
  ];
  const input = {
    mappings: [
      mapping({
        recordId: 'rec_mapping_monday_a',
        contactRecordIds: ['rec_contact_a'],
        memberName: '张三',
        effectiveFrom: '2026-07-20',
        effectiveTo: '2026-07-20',
        module3Target: '',
      }),
      mapping({
        recordId: 'rec_mapping_monday_b',
        contactRecordIds: ['rec_contact_a'],
        memberOpenId: '',
        memberName: '张三',
        effectiveFrom: '2026-07-20',
        effectiveTo: '2026-07-20',
        module3Target: '',
      }),
      mapping({
        recordId: 'rec_mapping_tuesday',
        contactRecordIds: ['rec_contact_a'],
        memberOpenId: 'ou_a',
        memberName: '张三',
        effectiveFrom: '2026-07-21',
        effectiveTo: '2026-07-23',
        module3Target: '',
      }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  };

  const forward = routeWeeklyFacts({ ...input, facts });
  const reversed = routeWeeklyFacts({ ...input, facts: [...facts].reverse() });

  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.buckets, []);
  assert.deepEqual(forward.evidence, {});
  assert.deepEqual(diagnosticCodes(forward), ['duplicate_active_mapping', 'duplicate_active_mapping']);
  assert.deepEqual(forward.diagnostics.map(item => item.evidenceId), [
    'rec_monday_open_id:current:workItems:0',
    'rec_tuesday_name:current:workItems:0',
  ]);
});

test('pauses an OpenID fact when an active mapping with the same contact has an empty lookup OpenID', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单接口联调', '完成云缴费对账'] })],
    mappings: [
      mapping({
        recordId: 'rec_mapping_open_id',
        contactRecordIds: ['rec_contact_a'],
        module2Targets: ['收单项目组'],
        module3Target: '',
      }),
      mapping({
        recordId: 'rec_mapping_lookup_empty',
        memberOpenId: '',
        contactRecordIds: ['rec_contact_a'],
        module2Targets: [],
        module3Target: '对公客群经营及场景建设',
      }),
    ],
    rules: [
      rule('模块二', '收单项目组', ['收单']),
      rule('模块三', '对公客群经营及场景建设', ['云缴费']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['duplicate_active_mapping', 'duplicate_active_mapping']);
});

test('keeps same-OpenID mappings that lack contacts when expanding shared-contact mappings', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单接口联调'] })],
    mappings: [
      mapping({
        recordId: 'rec_mapping_contact',
        contactRecordIds: ['rec_contact_a'],
        module3Target: '',
      }),
      mapping({
        recordId: 'rec_mapping_contact_empty',
        contactRecordIds: [],
        module3Target: '',
      }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['duplicate_active_mapping']);
});

test('skips one item when multiple authorized module II targets match', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成公共接口联调'] })],
    mappings: [mapping({ module2Targets: ['收单项目组', '融羲项目组'], module3Target: '' })],
    rules: [
      rule('模块二', '收单项目组', ['接口']),
      rule('模块二', '融羲项目组', ['接口']),
    ],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['ambiguous_module2_target']);
});

test('does not route an otherwise matching item when a rule exclusion topic matches', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单测试环境联调'] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'], { excludeTopics: ['测试环境'] })],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['no_topic_match']);
});

test('matches each inclusion topic from a multiline string independently', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单接口联调'] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', '云缴费\n收单')],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
});

test('applies each exclusion topic from a multiline string independently', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单演练联调'] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', '收单', { excludeTopics: '测试环境\n演练' })],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['no_topic_match']);
});

test('matches a unique name only when both fact and mapping lack an OpenID', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: '', memberName: '李四', reporterName: '李四' })],
    mappings: [mapping({ memberOpenId: '', memberName: '李四', module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
});

test('matches a missing fact OpenID to one canonical name mapping with a populated mapping OpenID', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: '', memberName: '李四', reporterName: '李四' })],
    mappings: [mapping({ memberOpenId: 'ou_li', memberName: '李四', module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
});

test('diagnoses a missing fact OpenID when same-name mappings are different canonical members', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: '', memberName: '李四', reporterName: '李四' })],
    mappings: [
      mapping({ recordId: 'rec_mapping_li', memberOpenId: 'ou_li', memberName: '李四', module3Target: '' }),
      mapping({ recordId: 'rec_mapping_wang', memberOpenId: 'ou_wang', memberName: '李四', module3Target: '' }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['ambiguous_member_name']);
});

test('does not match an empty-OpenID mapping with a different member name', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: '', memberName: '李四', reporterName: '李四' })],
    mappings: [mapping({ memberOpenId: '', memberName: '王五', module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['unmapped_member']);
});

test('does not fall back to a name mapping when the fact has an OpenID', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: 'ou_a', memberName: '李四', reporterName: '李四' })],
    mappings: [mapping({ memberOpenId: '', memberName: '李四', module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['unmapped_member']);
});

test('does not merge same-name mappings when both OpenIDs are absent', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ memberOpenId: '', memberName: '李四', reporterName: '李四' })],
    mappings: [
      mapping({ recordId: 'rec_mapping_a', memberOpenId: '', memberName: '李四', module2Targets: ['收单项目组'], module3Target: '' }),
      mapping({ recordId: 'rec_mapping_b', memberOpenId: '', memberName: '李四', module2Targets: [], module3Target: '对公客群经营及场景建设' }),
    ],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['duplicate_active_mapping']);
});

test('skips a topic-free item and a routine meeting without an outcome', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成无关事项', '参加收单项目例会'] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['no_topic_match', 'routine_meeting_without_result']);
});

test('does not treat completion of a routine meeting as a work outcome', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: ['完成收单项目例会'] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(result.buckets, []);
  assert.deepEqual(diagnosticCodes(result), ['routine_meeting_without_result']);
});

test('allows routine meetings only when they state an observable outcome', () => {
  const result = routeWeeklyFacts({
    facts: [fact({ workItems: [
      '收单例会形成结论',
      '收单例会确认方案',
      '收单例会输出成果',
      '收单例会评审通过',
    ] })],
    mappings: [mapping({ module3Target: '' })],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), [
    '收单例会形成结论',
    '收单例会确认方案',
    '收单例会输出成果',
    '收单例会评审通过',
  ]);
});

test('uses only valid in-period facts and only current work items', () => {
  const result = routeWeeklyFacts({
    facts: [
      fact({ recordId: 'rec_valid', workItems: ['完成收单接口联调'], tomorrowPlanItems: ['下周收单上线'] }),
      fact({ recordId: 'rec_pending', factStatus: '待人工确认', workItems: ['完成收单接口联调'] }),
      fact({ recordId: 'rec_outside', reportDate: '2026-07-24', workItems: ['完成收单接口联调'] }),
    ],
    mappings: [mapping()],
    rules: [rule('模块二', '收单项目组', ['收单'])],
    cellMap,
    period,
  });

  assert.deepEqual(texts(result, '收单项目组'), ['完成收单接口联调']);
  assert.deepEqual(Object.keys(result.evidence), ['rec_valid:current:workItems:0']);
  assert.deepEqual(result.diagnostics, []);
});

test('returns empty routing naturally when facts are empty', () => {
  assert.deepEqual(routeWeeklyFacts({ facts: [], mappings: [], rules: [], cellMap, period }), {
    buckets: [],
    evidence: {},
    diagnostics: [],
  });
});
