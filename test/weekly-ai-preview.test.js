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
    runPreview: async () => ({ warnings: ['AI_API_KEY=test-ai-key Authorization: Bearer secret APP_SECRET=app-secret response body'] }),
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

test('creates a read-only preview from latest valid facts and validated model evidence', async () => {
  const calls = [];
  const forbidden = () => { throw new Error('write operation called'); };
  const aiProvider = {
    name: 'openai-compatible',
    model: 'glm-4-flash-250414',
    generateWeeklySheetPreview: async input => {
      calls.push(input);
      const currentId = input.reports.find(item => item.category === 'current')?.evidenceId;
      const nextId = input.reports.find(item => item.category === 'next')?.evidenceId;
      if (input.cellMap.agileProjects) {
        return {
          cells: {
            D30: [
              { text: '  完成联调  ', evidenceIds: [currentId] },
              { text: '无依据事项', evidenceIds: [] },
            ],
            D31: [{ text: '下周上线', evidenceIds: [nextId, 'unknown'] }],
            B5: [{ text: '核心指标猜测', evidenceIds: [currentId] }],
          },
          provider: 'openai-compatible',
          model: 'glm-4-flash-250414',
        };
      }
      return {
        cells: {
          D40: [{ text: '事项一', evidenceIds: [currentId] }],
          D41: [{ text: '事项二', evidenceIds: [currentId] }],
          D42: [{ text: '事项三', evidenceIds: [currentId] }],
          D43: [{ text: '下周事项', evidenceIds: [nextId] }],
          D44: [{ text: '没有依据', evidenceIds: ['unknown'] }],
          D45: [{ text: '额外事项', evidenceIds: [nextId] }],
          Z99: [{ text: '越权单元格', evidenceIds: [currentId] }],
        },
        provider: 'openai-compatible',
        model: 'glm-4-flash-250414',
      };
    },
  };
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: {
      listAllDailyReportsForRange: async () => [
        report({ recordId: 'fact_old', sourceTime: 10, workItems: ['旧版本'] }),
        report({ recordId: 'fact_new', sourceTime: 20 }),
        report({ recordId: 'fact_pending', factStatus: '待人工确认' }),
        report({ recordId: 'fact_ignored', factStatus: '忽略' }),
        report({ recordId: 'fact_outside', reportDate: '2026-07-18' }),
      ],
      findTeamContact: forbidden,
      upsertWeeklyInstance: forbidden,
      upsertWeeklySummary: forbidden,
    },
    sheetWriter: {
      discoverTemplateTargets: async () => cellMap,
      copyTemplateSheet: forbidden,
      writeCells: forbidden,
    },
    aiProvider,
    options,
  });

  assert.equal(result.mode, 'read_only_preview');
  assert.equal(result.weekStart, '2026-07-13');
  assert.equal(result.weekEnd, '2026-07-17');
  assert.equal(result.cells.B2, '2026.07.13-2026.07.17');
  assert.equal(result.cells.B5, '');
  assert.equal(result.cells.D30, '1. 张三：完成联调');
  assert.equal(result.cells.D31, '1. 张三：下周上线');
  assert.equal(result.cells.D40, '张三：事项一');
  assert.equal(result.cells.D41, '张三：事项二');
  assert.equal(result.cells.D42, '张三：事项三');
  assert.equal(result.cells.D43, '张三：下周事项');
  assert.equal(result.cells.D44, '');
  assert.equal(result.cells.D45, '张三：额外事项');
  assert.equal(result.cells.Z99, undefined);
  assert.deepEqual(result.evidence.D30, [{
    evidenceId: 'fact_new:current:workItems:0',
    factRecordId: 'fact_new',
    date: '2026-07-13',
    member: '张三',
  }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].reports.every(item => item.factRecordId === 'fact_new'), true);
  assert.equal(calls[0].reports.some(item => item.text === '旧版本'), false);
  assert.deepEqual(calls[0].reports.find(item => item.category === 'current').workItems, ['完成联调']);
  assert.deepEqual(calls[0].reports.find(item => item.category === 'next').tomorrowPlanItems, ['下周上线']);
  assert.equal(calls[0].group.weeklySheet, undefined);
  assert.deepEqual(Object.keys(calls[0].cellMap), ['agileProjects']);
  assert.deepEqual(Object.keys(calls[1].cellMap), ['management']);
  assert.match(result.warnings.join('\n'), /unknown|无证据|白名单/);
  assert.deepEqual(result.groups[0].cells, result.cells);
  assert.deepEqual(result.groups[0].evidence, result.evidence);
  assert.deepEqual(result.groups[0].warnings, result.warnings);
});

test('keeps distinct persisted members who share a forwarding sender and report date', async () => {
  const previewInputs = [];
  await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: {
      listAllDailyReportsForRange: async () => [
        report({ recordId: 'fact_a', reporterName: '甲', memberOpenId: 'ou_member_a', senderOpenId: 'ou_forwarder', workItems: ['事项A'], tomorrowPlanItems: [] }),
        report({ recordId: 'fact_b', reporterName: '乙', memberOpenId: 'ou_member_b', senderOpenId: 'ou_forwarder', workItems: ['事项B'], tomorrowPlanItems: [] }),
      ],
    },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async input => {
        previewInputs.push(input);
        return { cells: {} };
      },
    },
    options,
  });

  assert.deepEqual(
    previewInputs.find(input => input.cellMap.agileProjects).reports.map(item => item.factRecordId).sort(),
    ['fact_a', 'fact_b'],
  );
});

test('counts a fact that matches agile and management buckets once', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: { listAllDailyReportsForRange: async () => [report({ recordId: 'fact_shared' })] },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async () => ({ cells: {} }),
    },
    options,
  });

  assert.equal(result.groups[0].reportCount, 1);
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

test('silently keeps explicitly empty model entries blank', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: { listAllDailyReportsForRange: async () => [report()] },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => input.cellMap.agileProjects
        ? { cells: { D30: [{ text: '', evidenceIds: [] }] } }
        : { cells: {} },
    },
    options,
  });

  assert.equal(result.cells.D30, '');
  assert.doesNotMatch(result.warnings.join('\n'), /D30.*缺少有效证据或文本/);
});

test('rejects evidence crossing current and next cell source boundaries', async () => {
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: {
      listAllDailyReportsForRange: async () => [
        report({ recordId: 'fact_current', reporterName: '甲', memberOpenId: 'ou_a', workItems: ['本周完成'], tomorrowPlanItems: [] }),
        report({ recordId: 'fact_next', reporterName: '乙', memberOpenId: 'ou_b', workItems: [], tomorrowPlanItems: ['下周计划'] }),
      ],
    },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async input => {
        const currentId = input.reports.find(item => item.factRecordId === 'fact_current')?.evidenceId;
        const nextId = input.reports.find(item => item.factRecordId === 'fact_next')?.evidenceId;
        return input.cellMap.agileProjects
          ? { cells: {
            D30: [{ text: '误用下周证据', evidenceIds: [nextId] }],
            D31: [{ text: '误用本周证据', evidenceIds: [currentId] }],
          } }
          : { cells: {} };
      },
    },
    options,
  });

  assert.equal(result.cells.D30, '');
  assert.equal(result.cells.D31, '');
  assert.match(result.warnings.join('\n'), /不属于对应/);
});

test('rejects current and next cross-references from the same fact record', async () => {
  let observedIds;
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: { listAllDailyReportsForRange: async () => [report({ recordId: 'fact_shared' })] },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => {
        if (!input.cellMap.agileProjects) return { cells: {} };
        const currentId = input.reports.find(item => item.category === 'current')?.evidenceId;
        const nextId = input.reports.find(item => item.category === 'next')?.evidenceId;
        observedIds = { currentId, nextId };
        return { cells: {
          D30: [{ text: '误用同事实下周事项', evidenceIds: [nextId] }],
          D31: [{ text: '误用同事实本周事项', evidenceIds: [currentId] }],
        } };
      },
    },
    options,
  });

  assert.notEqual(observedIds.currentId, observedIds.nextId);
  assert.match(observedIds.currentId, /^fact_shared:current:workItems:0$/);
  assert.match(observedIds.nextId, /^fact_shared:next:tomorrowPlanItems:0$/);
  assert.equal(result.cells.D30, '');
  assert.equal(result.cells.D31, '');
  assert.match(result.warnings.join('\n'), /不属于对应/);
});

test('keeps same-coordinate previews independent for multiple groups', async () => {
  let modelCalls = 0;
  const groups = [
    createGroup(),
    { ...createGroup(), name: '另一个组', project: '另一个组' },
  ];
  const result = await runWeeklyAiPreview({
    config: { groups },
    bitable: {
      listAllDailyReportsForRange: async group => [report({
        recordId: group.name === '另一个组' ? 'fact_group_2' : 'fact_group_1',
        workItems: [group.name === '另一个组' ? '第二组事项' : '第一组事项'],
      })],
    },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      generateWeeklySheetPreview: async input => {
        modelCalls += 1;
        if (!input.cellMap.agileProjects) return { cells: {} };
        const source = input.reports.find(item => item.category === 'current');
        return {
          cells: { D30: [{ text: source.workItems[0], evidenceIds: [source.evidenceId] }] },
        };
      },
    },
    options,
  });

  assert.equal(modelCalls, 4);
  assert.equal(result.groups[0].cells.D30, '1. 张三：第一组事项');
  assert.equal(result.groups[1].cells.D30, '1. 张三：第二组事项');
  assert.equal(result.groups[0].evidence.D30[0].factRecordId, 'fact_group_1');
  assert.equal(result.groups[1].evidence.D30[0].factRecordId, 'fact_group_2');
  assert.deepEqual(result.cells, {});
  assert.deepEqual(result.evidence, {});
  assert.match(result.warnings.join('\n'), /multiple groups.*top-level cells and evidence are empty/i);
});

test('keeps empty buckets blank without calling the model', async () => {
  let modelCalls = 0;
  const result = await runWeeklyAiPreview({
    config: { groups: [createGroup()] },
    bitable: { listAllDailyReportsForRange: async () => [] },
    sheetWriter: { discoverTemplateTargets: async () => cellMap },
    aiProvider: {
      name: 'openai-compatible',
      model: 'glm-4-flash-250414',
      generateWeeklySheetPreview: async () => { modelCalls += 1; return { cells: {} }; },
    },
    options,
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.cells.B5, '');
  assert.equal(result.cells.D30, '');
  assert.equal(result.cells.D40, '');
  assert.match(result.warnings.join('\n'), /空/);
});

test('fails closed when the model request fails', async () => {
  await assert.rejects(
    runWeeklyAiPreview({
      config: { groups: [createGroup()] },
      bitable: { listAllDailyReportsForRange: async () => [report()] },
      sheetWriter: { discoverTemplateTargets: async () => cellMap },
      aiProvider: {
        name: 'openai-compatible',
        model: 'glm-4-flash-250414',
        generateWeeklySheetPreview: async () => { throw new Error('AI preview request failed: status=503'); },
      },
      options,
    }),
    /status=503/,
  );
});
