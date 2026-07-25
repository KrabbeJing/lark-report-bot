import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeeklyAiPreviewArgs, runWeeklyAiPreview } from '../src/weekly-ai-preview.js';
import { runWeeklyAiPreviewCli } from '../src/weekly-ai-preview-cli.js';

const options = { startDate: '2026-07-13', endDate: '2026-07-17', outputPath: '' };

const cellMap = {
  reportPeriod: 'B2',
  coreMetrics: { current: ['B5'] },
  agileProjects: {
    收单项目组: { current: 'D30', next: 'D31', aliases: ['收单'] },
  },
  management: {
    渠道创新建设: { current: ['D40', 'D41', 'D42'], next: ['D43', 'D44', 'D45'], aliases: ['收单'] },
  },
};

function createGroup() {
  return {
    name: '数字金融部',
    project: '数字金融部',
    dailyFactTable: { appToken: 'bas_fact', tableId: 'tbl_fact' },
    weeklySourceMappingTable: {
      appToken: 'bas_weekly',
      tableId: 'tbl_mapping',
      fields: {
        member: '成员',
        memberRealName: '成员真实姓名',
        memberOpenId: '成员OpenID',
        module2Targets: '模块二可归集板块',
        module3Target: '模块三归属板块',
        effectiveFrom: '生效日期',
        effectiveTo: '失效日期',
        enabled: '是否启用',
      },
    },
    weeklySectionRuleTable: {
      appToken: 'bas_weekly',
      tableId: 'tbl_rules',
      fields: {
        module: '模块',
        target: '周报板块',
        contentType: '内容类型',
        includeTopics: '包含主题',
        excludeTopics: '排除主题',
        owners: '周报负责人',
        remindOwners: '负责人提醒',
        order: '排序',
        enabled: '是否启用',
      },
    },
    weeklyStyleExampleTable: {
      appToken: 'bas_weekly',
      tableId: 'tbl_styles',
      fields: {
        module: '模块',
        target: '周报板块',
        contentType: '内容类型',
        weekKey: '样例周次',
        finalText: '最终样例正文',
        reviewedAt: '审核时间',
        highQuality: '纳入优质样例',
        enabled: '是否启用',
      },
    },
    coreMetricOwnerTable: {
      appToken: 'bas_weekly',
      tableId: 'tbl_metrics',
      fields: {
        metricName: '指标名称',
        owners: '指标负责人',
        remindersEnabled: '启用提醒',
        enabled: '是否启用',
      },
    },
    weeklySheet: {
      templateSheetId: 'tpl_1',
      entityAliases: { 收单项目组: ['收单'] },
    },
  };
}

function report(overrides = {}) {
  return {
    recordId: 'fact_1',
    reportDate: '2026-07-13',
    reporterName: '张三',
    senderOpenId: 'ou_1',
    project: '历史收单项目',
    agileGroup: '收单项目组',
    source: 'form',
    effectiveSource: 'form',
    sourceTime: 100,
    factStatus: '有效',
    workItems: ['完成联调'],
    tomorrowPlanItems: ['下周上线'],
    riskItems: [],
    ...overrides,
  };
}

function configRecord(recordId, fields) {
  return { record_id: recordId, fields };
}

function mappingRecord(recordId, {
  memberOpenId,
  memberName,
  module2Targets = [],
  module3Target = '',
}) {
  return configRecord(recordId, {
    成员: [`contact_${recordId}`],
    成员真实姓名: memberName,
    成员OpenID: memberOpenId,
    模块二可归集板块: module2Targets,
    模块三归属板块: module3Target,
    生效日期: '',
    失效日期: '',
    是否启用: true,
  });
}

function ruleRecord(recordId, {
  module,
  target,
  contentType,
  includeTopics,
  order = 1,
}) {
  return configRecord(recordId, {
    模块: module,
    周报板块: target,
    内容类型: contentType,
    包含主题: includeTopics,
    排除主题: [],
    周报负责人: [],
    负责人提醒: false,
    排序: order,
    是否启用: true,
  });
}

function styleRecord(recordId, {
  module,
  target,
  contentType,
  finalText,
  weekKey = '2026-W28',
  reviewedAt = '2026-07-18',
  highQuality = true,
  enabled = true,
}) {
  return configRecord(recordId, {
    模块: module,
    周报板块: target,
    内容类型: contentType,
    样例周次: weekKey,
    最终样例正文: finalText,
    审核时间: reviewedAt,
    纳入优质样例: highQuality,
    是否启用: enabled,
  });
}

function defaultConfiguration() {
  return {
    mappings: [
      mappingRecord('mapping_agile', {
        memberOpenId: 'ou_1',
        memberName: '张三',
        module2Targets: ['收单项目组'],
      }),
      mappingRecord('mapping_management', {
        memberOpenId: 'ou_2',
        memberName: '李四',
        module3Target: '渠道创新建设',
      }),
    ],
    rules: [
      ruleRecord('rule_agile', {
        module: '模块二',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        includeTopics: ['收单'],
      }),
      ruleRecord('rule_management', {
        module: '模块三',
        target: '渠道创新建设',
        contentType: '本周工作进展',
        includeTopics: ['渠道'],
      }),
    ],
    styles: [
      ...[1, 2, 3, 4, 5, 6].map(index => styleRecord(`style_agile_${index}`, {
        module: '模块二',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        finalText: `收单正式样例${index}`,
        weekKey: `2026-W${20 + index}`,
      })),
      ...[1, 2, 3].map(index => styleRecord(`style_management_${index}`, {
        module: '模块三',
        target: '渠道创新建设',
        contentType: '本周工作进展',
        finalText: `渠道正式样例${index}`,
        weekKey: `2026-W${20 + index}`,
      })),
      styleRecord('style_wrong_target', {
        module: '模块二',
        target: '其他项目组',
        contentType: '本周重点事项说明',
        finalText: '不相关板块样例',
      }),
      styleRecord('style_wrong_type', {
        module: '模块二',
        target: '收单项目组',
        contentType: '下周工作计划',
        finalText: '不相关内容类型样例',
      }),
      styleRecord('style_unreviewed', {
        module: '模块二',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        finalText: '未审核样例',
        reviewedAt: '',
      }),
      styleRecord('style_low_quality', {
        module: '模块二',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        finalText: '低质量样例',
        highQuality: false,
      }),
      styleRecord('style_disabled', {
        module: '模块二',
        target: '收单项目组',
        contentType: '本周重点事项说明',
        finalText: '停用样例',
        enabled: false,
      }),
    ],
    metrics: [],
  };
}

function createBitable({
  facts = [],
  configuration = defaultConfiguration(),
  calls = [],
} = {}) {
  return {
    listAllDailyReportsForRange: async () => {
      calls.push('facts');
      return facts;
    },
    listRecords: async (_table, operation) => {
      calls.push(operation);
      if (operation === 'weeklyConfig.mappings') return configuration.mappings;
      if (operation === 'weeklyConfig.rules') return configuration.rules;
      if (operation === 'weeklyConfig.styles') return configuration.styles;
      if (operation === 'weeklyConfig.metrics') return configuration.metrics;
      throw new Error(`unexpected operation ${operation}`);
    },
  };
}

test('parses required preview dates and rejects an inverted range', () => {
  assert.deepEqual(parseWeeklyAiPreviewArgs([
    '--start', '2026-07-13', '--end', '2026-07-17',
  ]), options);
  assert.throws(
    () => parseWeeklyAiPreviewArgs(['--start', '2026-07-18', '--end', '2026-07-17']),
    /start.*end/i,
  );
});

test('parses an explicit output path and rejects invalid preview arguments', () => {
  assert.deepEqual(parseWeeklyAiPreviewArgs([
    '--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json',
  ]), {
    startDate: '2026-07-13',
    endDate: '2026-07-17',
    outputPath: 'out/preview.json',
  });
  assert.throws(() => parseWeeklyAiPreviewArgs(['--start', '2026-07-13', '--wat']), /Unknown option/);
  assert.throws(() => parseWeeklyAiPreviewArgs(['--start', '2026-07-13', '--end']), /Missing value/);
  assert.throws(
    () => parseWeeklyAiPreviewArgs(['--start', '2026-02-30', '--end', '2026-03-01']),
    /valid YYYY-MM-DD dates/,
  );
});

test('CLI writes a read-only preview only when an explicit output path is provided', async () => {
  const calls = [];
  const stdout = [];
  const result = await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-ai-key' }),
    createClient: () => ({ client: true }),
    createBitable: client => ({ client, kind: 'bitable' }),
    createSheetWriter: client => ({ client, kind: 'template-reader' }),
    loadConfig: () => ({ groups: [] }),
    runPreview: async input => {
      calls.push(input);
      return { mode: 'read_only_preview', warnings: [] };
    },
    mkdir: async (...args) => { calls.push(['mkdir', ...args]); },
    realpath: async value => value,
    lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: async (...args) => { calls.push(['writeFile', ...args]); },
    stdout: text => stdout.push(text),
  });

  assert.deepEqual(result, { mode: 'read_only_preview', warnings: [] });
  assert.deepEqual(calls[0], ['mkdir', 'out', { recursive: true }]);
  assert.deepEqual(calls[1], {
    config: { groups: [] },
    bitable: { client: { client: true }, kind: 'bitable' },
    sheetWriter: { client: { client: true }, kind: 'template-reader' },
    aiProvider: { name: 'openai-compatible', apiKey: 'test-ai-key' },
    options: { startDate: '2026-07-13', endDate: '2026-07-17', outputPath: 'out/preview.json' },
  });
  assert.deepEqual(calls[2], ['writeFile', 'out/preview.json', '{\n  "mode": "read_only_preview",\n  "warnings": []\n}\n', { encoding: 'utf8', flag: 'wx' }]);
  assert.deepEqual(stdout, ['{\n  "mode": "read_only_preview",\n  "warnings": []\n}\n']);
});

test('CLI does not create a directory without an explicit output path', async () => {
  let mkdirCalls = 0;
  await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-ai-key' }),
    createClient: () => ({}),
    createBitable: () => ({}),
    createSheetWriter: () => ({}),
    loadConfig: () => ({ groups: [] }),
    runPreview: async () => ({ mode: 'read_only_preview', warnings: [] }),
    mkdir: async () => { mkdirCalls += 1; },
    stdout: () => {},
  });
  assert.equal(mkdirCalls, 0);
});

test('CLI rejects non-compatible providers and emits only a safe failure summary', async () => {
  const stderr = [];
  const processRef = { exitCode: 0 };
  const result = await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
    createAiProvider: () => ({ name: 'template', apiKey: 'test-ai-key' }),
    stderr: text => stderr.push(text),
    processRef,
  });

  assert.equal(result, null);
  assert.equal(processRef.exitCode, 1);
  assert.match(stderr.join(''), /AI_PROVIDER=openai-compatible/);
  assert.doesNotMatch(stderr.join(''), /test-ai-key|Authorization|APP_SECRET|response body/);
});

test('CLI rejects a missing provider API key before creating a Lark client', async () => {
  let createClientCalls = 0;
  const stderr = [];
  const processRef = { exitCode: 0, cwd: () => '/workspace' };
  const result = await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: '' }),
    createClient: () => { createClientCalls += 1; },
    stderr: text => stderr.push(text),
    processRef,
  });

  assert.equal(result, null);
  assert.equal(createClientCalls, 0);
  assert.equal(processRef.exitCode, 1);
  assert.doesNotMatch(stderr.join(''), /API key|Authorization|APP_SECRET/);
});

test('CLI rejects output paths outside its injected current working directory', async () => {
  const rejected = [];
  for (const outputPath of ['/tmp/preview.json', '../preview.json', 'out/../../preview.json']) {
    let createClientCalls = 0;
    const result = await runWeeklyAiPreviewCli({
      argv: ['--start', '2026-07-13', '--end', '2026-07-17', '--output', outputPath],
      createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-key' }),
      createClient: () => { createClientCalls += 1; },
      stderr: text => rejected.push(text),
      processRef: { exitCode: 0, cwd: () => '/workspace' },
    });
    assert.equal(result, null);
    assert.equal(createClientCalls, 0);
  }
  assert.match(rejected.join(''), /weekly:ai-preview failed/);
});

test('CLI rejects an output parent directory symlink that resolves outside the working directory', async () => {
  let writeFileCalls = 0;
  const result = await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-key' }),
    createClient: () => ({}),
    createBitable: () => ({}),
    createSheetWriter: () => ({}),
    loadConfig: () => ({ groups: [] }),
    runPreview: async () => ({ mode: 'read_only_preview', warnings: [] }),
    mkdir: async () => {},
    realpath: async value => value === '/workspace' ? '/workspace' : '/outside',
    lstat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    writeFile: async () => { writeFileCalls += 1; },
    stderr: () => {},
    processRef: { exitCode: 0, cwd: () => '/workspace' },
  });

  assert.equal(result, null);
  assert.equal(writeFileCalls, 0);
});

test('CLI rejects an existing output file symlink before writing', async () => {
  let writeFileCalls = 0;
  const result = await runWeeklyAiPreviewCli({
    argv: ['--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-key' }),
    createClient: () => ({}),
    createBitable: () => ({}),
    createSheetWriter: () => ({}),
    loadConfig: () => ({ groups: [] }),
    runPreview: async () => ({ mode: 'read_only_preview', warnings: [] }),
    mkdir: async () => {},
    realpath: async value => value,
    lstat: async () => ({ isSymbolicLink: () => true }),
    writeFile: async () => { writeFileCalls += 1; },
    stderr: () => {},
    processRef: { exitCode: 0, cwd: () => '/workspace' },
  });

  assert.equal(result, null);
  assert.equal(writeFileCalls, 0);
});

test('CLI rejects every existing output target, including ordinary files and hard links', async () => {
  for (const existing of [
    { label: 'ordinary file', stats: { isSymbolicLink: () => false, nlink: 1 } },
    { label: 'hard link', stats: { isSymbolicLink: () => false, nlink: 2 } },
  ]) {
    let createClientCalls = 0;
    let runPreviewCalls = 0;
    let writeFileCalls = 0;
    const result = await runWeeklyAiPreviewCli({
      argv: ['--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json'],
      createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-key' }),
      createClient: () => { createClientCalls += 1; return {}; },
      createBitable: () => ({}),
      createSheetWriter: () => ({}),
      loadConfig: () => ({ groups: [] }),
      runPreview: async () => {
        runPreviewCalls += 1;
        return { mode: 'read_only_preview', warnings: [] };
      },
      mkdir: async () => {},
      realpath: async value => value,
      lstat: async () => existing.stats,
      writeFile: async () => { writeFileCalls += 1; },
      stderr: () => {},
      processRef: { exitCode: 0, cwd: () => '/workspace' },
    });

    assert.equal(result, null, existing.label);
    assert.equal(createClientCalls, 0, existing.label);
    assert.equal(runPreviewCalls, 0, existing.label);
    assert.equal(writeFileCalls, 0, existing.label);
  }
});

test('CLI removes secrets and response bodies from serialized warnings and errors', async () => {
  const stdout = [];
  const stderr = [];
  const processRef = { exitCode: 0 };
  const common = {
    argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
    createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-ai-key' }),
    createClient: () => ({}),
    createBitable: () => ({}),
    createSheetWriter: () => ({}),
    loadConfig: () => ({ groups: [] }),
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
    processRef,
  };
  await runWeeklyAiPreviewCli({
    ...common,
    runPreview: async () => ({
      warnings: ['AI_API_KEY=test-ai-key Authorization: Bearer secret APP_SECRET=app-secret response body'],
      diagnostics: [{
        code: 'provider_error',
        detail: 'AI_API_KEY=test-ai-key Authorization: Bearer secret APP_SECRET=app-secret response body',
      }],
      groups: [{
        warnings: ['AI_API_KEY=test-ai-key response body'],
        diagnostics: [{ code: 'provider_error', detail: 'APP_SECRET=app-secret response body' }],
      }],
    }),
  });
  await runWeeklyAiPreviewCli({
    ...common,
    runPreview: async () => { throw new Error('AI_API_KEY=test-ai-key Authorization: Bearer secret APP_SECRET=app-secret response body'); },
  });

  const serialized = JSON.stringify({ stdout, stderr });
  assert.doesNotMatch(serialized, /test-ai-key/);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /app-secret/);
  assert.doesNotMatch(serialized, /response body/);
  assert.match(stderr.join(''), /weekly:ai-preview failed/);
});

test('CLI emits only whitelisted safe runPreview failure categories', async () => {
  const cases = [
    ['AI preview request timed out', 'weekly:ai-preview AI request timed out'],
    ['AI preview request failed: status=429', 'weekly:ai-preview AI request failed: status=429'],
    ['AI preview returned invalid JSON', 'weekly:ai-preview AI response invalid'],
  ];

  for (const [errorMessage, expectedMessage] of cases) {
    const stderr = [];
    const processRef = { exitCode: 0 };
    const result = await runWeeklyAiPreviewCli({
      argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
      createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-ai-key' }),
      createClient: () => ({}),
      createBitable: () => ({}),
      createSheetWriter: () => ({}),
      loadConfig: () => ({ groups: [] }),
      runPreview: async () => { throw new Error(errorMessage); },
      stderr: text => stderr.push(text),
      processRef,
    });

    assert.equal(result, null);
    assert.equal(processRef.exitCode, 1);
    assert.deepEqual(stderr, [`[weekly:ai-preview] ${expectedMessage}\n`]);
  }
});

test('CLI keeps non-whitelisted runPreview failures generic', async () => {
  const messages = [
    'AI_API_KEY=secret',
    'Authorization: Bearer secret',
    'APP_SECRET=secret',
    'response body: sensitive details',
    'AI preview request failed: status=42',
    'AI preview request failed: status=4290',
    'AI preview request failed: status=429 response body: sensitive details',
  ];

  for (const errorMessage of messages) {
    const stderr = [];
    const result = await runWeeklyAiPreviewCli({
      argv: ['--start', '2026-07-13', '--end', '2026-07-17'],
      createAiProvider: () => ({ name: 'openai-compatible', apiKey: 'test-ai-key' }),
      createClient: () => ({}),
      createBitable: () => ({}),
      createSheetWriter: () => ({}),
      loadConfig: () => ({ groups: [] }),
      runPreview: async () => { throw new Error(errorMessage); },
      stderr: text => stderr.push(text),
      processRef: { exitCode: 0 },
    });

    assert.equal(result, null);
    assert.deepEqual(stderr, ['[weekly:ai-preview] weekly:ai-preview failed\n']);
  }
});

test('loads facts and weekly configuration before generating target-scoped current previews', async () => {
  const sequence = [];
  const previewInputs = [];
  const forbidden = () => { throw new Error('write operation called'); };
  const facts = [
    report({
      recordId: 'fact_old',
      sourceTime: 10,
      memberOpenId: 'ou_1',
      workItems: ['旧版收单事项'],
    }),
    report({
      recordId: 'fact_agile',
      sourceTime: 20,
      memberOpenId: 'ou_1',
      workItems: ['完成收单接口联调，交易100笔，状态已完成'],
    }),
    report({
      recordId: 'fact_management',
      source: 'chat',
      effectiveSource: 'chat',
      sourceTime: 30,
      reporterName: '李四',
      memberOpenId: 'ou_2',
      workItems: ['完成渠道制度修订'],
    }),
    report({ recordId: 'fact_pending', factStatus: '待人工确认' }),
    report({ recordId: 'fact_outside', reportDate: '2026-07-18' }),
  ];
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({ facts, calls: sequence }),
    sheetWriter: {
      discoverTemplateTargets: async () => {
        sequence.push('discover');
        return cellMap;
      },
      copyTemplateSheet: forbidden,
      writeCells: forbidden,
    },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async input => {
        sequence.push(`ai:${input.target.module}:${input.target.target}`);
        previewInputs.push(input);
        const evidenceId = input.evidence[0].evidenceId;
        if (input.target.module === 'module2') {
          return {
            cells: {
              D30: [
                { text: '完成收单接口联调，交易100笔，状态已完成', evidenceIds: [evidenceId] },
                { text: '收单交易100笔，状态已完成', evidenceIds: [evidenceId] },
              ],
            },
            provider: 'openai-compatible',
            model: 'glm-4-flash-250414',
          };
        }
        return {
          cells: {
            D40: [{ text: '完成渠道制度修订', evidenceIds: [evidenceId] }],
          },
          provider: 'openai-compatible',
          model: 'glm-4-flash-250414',
        };
      },
    },
    options,
  });

  assert.deepEqual(sequence.slice(0, 6), [
    'facts',
    'weeklyConfig.mappings',
    'weeklyConfig.rules',
    'weeklyConfig.styles',
    'weeklyConfig.metrics',
    'discover',
  ]);
  assert.equal(result.mode, 'read_only_preview');
  assert.equal(result.cells.B2, '2026.07.13-2026.07.17');
  assert.deepEqual(result.cells.D30, [
    {
      text: '完成收单接口联调，交易100笔，状态已完成',
      evidenceIds: ['fact_agile:current:workItems:0'],
    },
    {
      text: '收单交易100笔，状态已完成',
      evidenceIds: ['fact_agile:current:workItems:0'],
    },
  ]);
  assert.deepEqual(result.cells.D40, [{
    text: '完成渠道制度修订',
    evidenceIds: ['fact_management:current:workItems:0'],
  }]);
  assert.equal(result.cells.D31, undefined);
  assert.equal(result.cells.D43, undefined);
  assert.equal(result.cells.B5, undefined);
  assert.equal(result.groups[0].reportCount, 2);
  assert.equal(previewInputs.length, 2);

  const agileInput = previewInputs.find(input => input.target.module === 'module2');
  assert.deepEqual(agileInput.target, {
    module: 'module2',
    target: '收单项目组',
    contentType: '本周重点事项说明',
    cells: ['D30'],
  });
  assert.deepEqual(agileInput.evidence.map(item => item.text), [
    '完成收单接口联调，交易100笔，状态已完成',
  ]);
  assert.equal(JSON.stringify(agileInput).includes('旧版收单事项'), false);
  assert.equal(JSON.stringify(agileInput).includes('tomorrowPlanItems'), false);
  assert.equal(JSON.stringify(agileInput).includes('riskItems'), false);
  assert.equal(JSON.stringify(agileInput).includes('张三'), false);
  assert.deepEqual(agileInput.styleExamples.map(item => item.finalText), [
    '收单正式样例6',
    '收单正式样例5',
    '收单正式样例4',
    '收单正式样例3',
    '收单正式样例2',
  ]);
  assert.ok(agileInput.styleExamples.every(item => (
    item.module === 'module2'
    && item.target === '收单项目组'
    && item.contentType === '本周重点事项说明'
  )));
  const managementInput = previewInputs.find(input => input.target.module === 'module3');
  assert.equal(managementInput.styleExamples.length, 3);
  assert.ok(managementInput.styleExamples.every(item => (
    item.target === '渠道创新建设'
    && item.contentType === '本周工作进展'
  )));
  assert.deepEqual(result.evidence.D30.map(item => item.evidenceId), [
    'fact_agile:current:workItems:0',
  ]);
  assert.deepEqual(result.groups[0].cells, result.cells);
  assert.deepEqual(result.groups[0].evidence, result.evidence);
  assert.deepEqual(result.groups[0].diagnostics, result.diagnostics);
});

test('requires dailyFactTable before any preview reads and never falls back to dailyTable', async () => {
  let listCalls = 0;
  let discoveryCalls = 0;
  const group = {
    ...createGroup(),
    dailyFactTable: {},
    dailyTable: { appToken: 'bas_daily', tableId: 'tbl_daily' },
  };

  await assert.rejects(
    runWeeklyAiPreview({
      config: { groups: [group] },
      bitable: {
        listAllDailyReportsForRange: async () => {
          listCalls += 1;
          return [report()];
        },
      },
      sheetWriter: {
        discoverTemplateTargets: async () => {
          discoveryCalls += 1;
          return cellMap;
        },
      },
      aiProvider: { generateWeeklySheetPreview: async () => ({ cells: {} }) },
      options,
    }),
    /dailyFactTable.*configured/i,
  );

  assert.equal(listCalls, 0);
  assert.equal(discoveryCalls, 0);
});

test('returns current cells blank with configuration diagnostics when weekly tables are absent', async () => {
  const group = {
    ...createGroup(),
    weeklySourceMappingTable: {},
    weeklySectionRuleTable: {},
    weeklyStyleExampleTable: {},
    coreMetricOwnerTable: {},
  };
  let modelCalls = 0;
  const result = await runWeeklyAiPreview({
    config: { groups: [group] },
    bitable: createBitable({ facts: [report({ memberOpenId: 'ou_1', workItems: ['收单事项'] })] }),
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async () => {
        modelCalls += 1;
        return { cells: {} };
      },
    },
    options,
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.cells.B2, '2026.07.13-2026.07.17');
  assert.deepEqual(result.cells.D30, []);
  assert.deepEqual(result.cells.D40, []);
  assert.equal(result.cells.D31, undefined);
  assert.equal(result.cells.B5, undefined);
  assert.match(result.warnings.join('\n'), /weekly_config_table_not_configured:mappings/);
  assert.match(result.diagnostics.map(item => item.code).join('\n'), /unmapped_member/);
});

test('silently keeps explicitly empty current entries blank', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({ facts: [report({ memberOpenId: 'ou_1', workItems: ['完成收单联调'] })] }),
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async () => ({
        cells: { D30: [{ text: '', evidenceIds: [] }] },
      }),
    },
    options,
  });

  assert.deepEqual(result.cells.D30, []);
  assert.doesNotMatch(result.diagnostics.map(item => item.code).join('\n'), /invalid_entry/);
});

test('rejects the whole target when AI emits any next-plan or non-current cell', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({
      facts: [report({
        recordId: 'fact_current',
        memberOpenId: 'ou_1',
        workItems: ['完成收单联调'],
      })],
    }),
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => {
        const evidenceId = input.evidence[0].evidenceId;
        return { cells: {
          D30: [{ text: '完成收单联调', evidenceIds: [evidenceId] }],
          D31: [{ text: '下周上线', evidenceIds: [evidenceId] }],
        } };
      },
    },
    options,
  });

  assert.deepEqual(result.cells.D30, []);
  assert.equal(result.cells.D31, undefined);
  assert.match(result.diagnostics.map(item => item.code).join('\n'), /invalid_cell/);
});

test('rejects entries whose evidence is not in the current target', async () => {
  const configuration = defaultConfiguration();
  configuration.mappings.push(mappingRecord('mapping_other', {
    memberOpenId: 'ou_3',
    memberName: '王五',
    module2Targets: ['云缴费项目组'],
  }));
  configuration.rules.push(ruleRecord('rule_other', {
    module: '模块二',
    target: '云缴费项目组',
    contentType: '本周重点事项说明',
    includeTopics: ['云缴费'],
  }));
  configuration.styles.push(...[1, 2, 3].map(index => styleRecord(`style_other_${index}`, {
    module: '模块二',
    target: '云缴费项目组',
    contentType: '本周重点事项说明',
    finalText: `云缴费正式样例${index}`,
  })));
  const expandedCellMap = {
    ...cellMap,
    agileProjects: {
      ...cellMap.agileProjects,
      云缴费项目组: { current: 'D32', next: 'D33' },
    },
  };
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({
      configuration,
      facts: [
        report({ recordId: 'fact_agile', memberOpenId: 'ou_1', workItems: ['完成收单联调'] }),
        report({ recordId: 'fact_other', memberOpenId: 'ou_3', reporterName: '王五', workItems: ['完成云缴费联调'] }),
      ],
    }),
    sheetWriter: { discoverTemplateTargets: async () => expandedCellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => {
        if (input.target.target !== '收单项目组') return { cells: {} };
        return {
          cells: {
            D30: [{
              text: '完成云缴费联调',
              evidenceIds: ['fact_other:current:workItems:0'],
            }],
          },
        };
      },
    },
    options,
  });

  assert.deepEqual(result.cells.D30, []);
  assert.deepEqual(result.cells.D32, []);
  assert.match(result.diagnostics.map(item => item.code).join('\n'), /invalid_evidence/);
});

test('rejects module three output that uses more than three cells', async () => {
  const managementCellMap = {
    reportPeriod: 'B2',
    agileProjects: {},
    management: {
      渠道创新建设: {
        current: ['D40', 'D41', 'D42', 'D43'],
        next: ['D44', 'D45', 'D46'],
      },
    },
  };
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({
      facts: [report({
        recordId: 'fact_management',
        memberOpenId: 'ou_2',
        reporterName: '李四',
        workItems: ['完成渠道制度修订'],
      })],
    }),
    sheetWriter: { discoverTemplateTargets: async () => managementCellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => {
        const evidenceId = input.evidence[0].evidenceId;
        return {
          cells: Object.fromEntries(['D40', 'D41', 'D42', 'D43'].map(cell => [
            cell,
            [{ text: '完成渠道制度修订', evidenceIds: [evidenceId] }],
          ])),
        };
      },
    },
    options,
  });

  assert.deepEqual(
    ['D40', 'D41', 'D42', 'D43'].map(cell => result.cells[cell]),
    [[], [], [], []],
  );
  assert.match(result.diagnostics.map(item => item.code).join('\n'), /module3_cell_limit/);
});

test('keeps targets blank and skips AI when no current evidence is routed', async () => {
  let modelCalls = 0;
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({ facts: [] }),
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async () => { modelCalls += 1; return { cells: {} }; },
    },
    options,
  });

  assert.equal(modelCalls, 0);
  assert.deepEqual(result.cells.D30, []);
  assert.deepEqual(result.cells.D40, []);
  assert.equal(result.cells.D31, undefined);
});

test('isolates AI failure per target without template fallback or secret leakage', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: createBitable({
      facts: [
        report({ recordId: 'fact_agile', memberOpenId: 'ou_1', workItems: ['完成收单联调'] }),
        report({
          recordId: 'fact_management',
          memberOpenId: 'ou_2',
          reporterName: '李四',
          source: 'chat',
          effectiveSource: 'chat',
          workItems: ['完成渠道制度修订'],
        }),
      ],
    }),
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async input => {
        if (input.target.module === 'module2') {
          throw new Error('AI preview request failed: status=503 response body secret-key');
        }
        return {
          cells: {
            D40: [{
              text: '完成渠道制度修订',
              evidenceIds: [input.evidence[0].evidenceId],
            }],
          },
        };
      },
    },
    options,
  });

  assert.deepEqual(result.cells.D30, []);
  assert.deepEqual(result.cells.D40, [{
    text: '完成渠道制度修订',
    evidenceIds: ['fact_management:current:workItems:0'],
  }]);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /provider_error/);
  assert.match(serialized, /status=503/);
  assert.doesNotMatch(serialized, /response body|secret-key/);
});

test('rejects numeric prefixes, new full dates, changed statuses, responsibility, and visible names', async () => {
  const cases = [
    {
      source: '推进收单接口联调，交易100笔',
      output: '推进收单接口联调，交易10笔',
    },
    {
      source: '推进收单接口联调，2026年度核查07项并验证10项，交易100笔',
      output: '推进收单接口联调，新增日期2026-07-10，交易100笔',
    },
    {
      source: '推进收单接口联调，交易100笔',
      output: '收单接口已上线，交易100笔',
    },
    {
      source: '推进收单接口联调，交易100笔',
      output: '负责人王五推进收单接口联调，交易100笔',
    },
    {
      source: '推进收单接口联调，交易100笔',
      output: '张三推进收单接口联调，交易100笔',
    },
  ];

  for (const { source, output } of cases) {
    const result = await runWeeklyAiPreview({
      config: { groups: [createGroup()] },
      bitable: createBitable({
        facts: [report({
          recordId: 'fact_agile',
          memberOpenId: 'ou_1',
          workItems: [source],
        })],
      }),
      sheetWriter: { discoverTemplateTargets: async () => cellMap },
      aiProvider: {
        generateWeeklySheetPreview: async input => ({
          cells: {
            D30: [{ text: output, evidenceIds: [input.evidence[0].evidenceId] }],
          },
        }),
      },
      options,
    });

    assert.deepEqual(result.cells.D30, [], output);
    assert.match(
      result.diagnostics.map(item => item.code).join('\n'),
      /changed_protected_fact|visible_member_name/,
      output,
    );
  }
});
