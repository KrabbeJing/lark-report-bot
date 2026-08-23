import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/ai-providers.js';

function previewInput() {
  return {
    group: { project: '数字金融部' },
    target: {
      module: 'module2',
      target: '收单项目组',
      contentType: '本周重点事项说明',
      cells: ['D30'],
    },
    evidence: [{
      evidenceId: 'rec_1:current:workItems:0',
      factRecordId: 'rec_1',
      date: '2026-07-13',
      text: '完成收单联调',
    }],
    styleExamples: [
      { module: 'module2', target: '收单项目组', contentType: '本周重点事项说明', finalText: '完成接口联调并进入试运行。' },
      { module: 'module2', target: '收单项目组', contentType: '本周重点事项说明', finalText: '完成交易链路验证。' },
      { module: 'module2', target: '收单项目组', contentType: '本周重点事项说明', finalText: '完成阶段性功能交付。' },
    ],
    reports: [{
      reportDate: '2026-07-13',
      reporterName: '张三',
      project: '历史收单项目',
      agileGroup: '收单项目组',
      workItems: ['完成收单联调'],
      tomorrowPlanItems: [],
      riskItems: [],
    }],
    weekStart: '2026-07-13',
    weekEnd: '2026-07-17',
    cellMap: {
      reportPeriod: 'B2',
      agileProjects: {
        收单项目组: { current: 'D30', next: 'D31' },
      },
      management: {},
    },
  };
}

function configuredProvider() {
  return new OpenAICompatibleProvider({
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    AI_MODEL: 'glm-4-flash-250414',
  });
}

function classificationInput() {
  return {
    items: [
      {
        evidenceId: 'evidence-a',
        factRecordId: 'rec_secret_a',
        mappingRecordId: 'map_secret_a',
        member: '张三',
        memberOpenId: 'ou_secret_a',
        date: '2026-07-28',
        text: '完成收单接口联调',
        allowedTargets: [{
          targetId: 'target-a',
          module: 'module2',
          target: '收单项目组',
          contentType: '本周重点事项说明',
          cells: ['C26'],
          owner: { openId: 'ou_owner_secret' },
          businessScope: '收单业务建设',
          includeTopics: ['收单'],
          excludeTopics: ['云缴费'],
          matchedIncludeTopics: ['收单'],
          matchedExcludeTopics: [],
          positiveExamples: ['完成收单接口联调'],
          negativeExamples: ['处理云缴费工单'],
        }],
      },
      {
        evidenceId: 'evidence-b',
        date: '2026-07-29',
        text: '完成银企直联证书更新',
        allowedTargets: [{
          targetId: 'target-b',
          module: 'module3',
          target: '对公客群经营及场景建设',
          contentType: '本周工作进展',
          businessScope: '银企直联及场景建设',
          includeTopics: ['银企直联'],
          excludeTopics: [],
          positiveExamples: ['完成证书更新并通过验证'],
          negativeExamples: [],
        }],
      },
    ],
  };
}

test('semantic classification uses item-scoped sanitized JSON input at low temperature', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        classifications: [{
          evidenceId: 'evidence-a',
          targetId: 'target-a',
          confidence: 'high',
          reason: '事项明确涉及收单接口',
        }],
      }) } }] }),
    };
  };

  try {
    const result = await configuredProvider().classifyWeeklyEvidence(classificationInput());
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'glm-4-flash-250414');
    assert.equal(result.classifications[0].targetId, 'target-a');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(body.temperature, 0.1);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const system = body.messages[0].content;
  const prompt = body.messages[1].content;
  assert.match(system, /allowedTargets.*唯一边界/s);
  assert.match(system, /只能选择一个/);
  assert.match(system, /主题词和正反例只是语义提示/);
  assert.match(system, /每条事项必须独立判断/);
  assert.match(system, /不得把候选板块说明中的词语当作事项原文事实/);
  assert.match(system, /只命中一个候选板块的明确主题.*强语义证据/);
  assert.match(system, /完整语义明确冲突/);
  assert.match(system, /matchedIncludeTopics.*程序预先计算的命中提示/);
  assert.match(system, /matchedExcludeTopics.*排除提示/);
  assert.match(prompt, /high.*medium.*low/s);
  const match = prompt.match(/待分类事项：\n([\s\S]*?)\n\n输出格式：/);
  assert.ok(match);
  const modelItems = JSON.parse(match[1]);
  assert.deepEqual(modelItems[0].allowedTargets.map(item => item.targetId), ['target-a']);
  assert.deepEqual(modelItems[1].allowedTargets.map(item => item.targetId), ['target-b']);
  assert.deepEqual(modelItems[0].allowedTargets[0].matchedIncludeTopics, ['收单']);
  assert.deepEqual(modelItems[0].allowedTargets[0].matchedExcludeTopics, []);
  assert.equal(modelItems[0].date, '2026-07-28');
  assert.equal(modelItems[0].text, '完成收单接口联调');
  assert.doesNotMatch(prompt, /张三|ou_secret|ou_owner|rec_secret|map_secret|C26/);
});

test('semantic classification rejects strict JSON shape failures without fallback parsing', async () => {
  const originalFetch = globalThis.fetch;
  const contents = [
    '```json\n{"classifications":[]}\n```',
    JSON.stringify({ cells: {} }),
    JSON.stringify({ classifications: {} }),
  ];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: contents.shift() } }] }),
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(
        configuredProvider().classifyWeeklyEvidence(classificationInput()),
        error => {
          assert.equal(error.message, 'AI classification returned invalid JSON');
          assert.equal(error.retryable, false);
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic classification converts HTTP and transport failures into safe errors', async () => {
  const originalFetch = globalThis.fetch;
  const failures = [
    async () => ({ ok: false, status: 503, text: async () => 'secret response body' }),
    async () => { throw new Error('Authorization: Bearer secret-token'); },
  ];
  globalThis.fetch = async (...args) => failures.shift()(...args);

  try {
    await assert.rejects(
      configuredProvider().classifyWeeklyEvidence(classificationInput()),
      error => {
        assert.equal(error.message, 'AI classification request failed: status=503');
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /secret response body|test-key/);
        return true;
      },
    );
    await assert.rejects(
      configuredProvider().classifyWeeklyEvidence(classificationInput()),
      error => {
        assert.equal(error.message, 'AI classification request failed');
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /secret-token|Authorization/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic classification exposes a bounded retry-after delay for rate limits', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '0.25' : null },
    text: async () => 'secret response body',
  });

  try {
    await assert.rejects(
      configuredProvider().classifyWeeklyEvidence(classificationInput()),
      error => {
        assert.equal(error.message, 'AI classification request failed: status=429');
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMs, 250);
        assert.doesNotMatch(error.message, /secret response body|test-key/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic classification uses a conservative cooldown when a rate limit has no retry-after header', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => '',
  });

  try {
    await assert.rejects(
      configuredProvider().classifyWeeklyEvidence(classificationInput()),
      error => {
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfterMs, 30000);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic classification can disable model thinking without affecting other chat calls', async () => {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ classifications: [] }) } }] }),
    };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
      AI_MODEL: 'glm-4.7-flash',
      AI_CLASSIFICATION_THINKING: 'disabled',
    });
    await provider.classifyWeeklyEvidence({ items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
});

test('semantic classification omits unsupported thinking configuration', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ classifications: [] }) } }] }),
    };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      AI_API_KEY: 'test-key',
      AI_CLASSIFICATION_THINKING: 'sometimes',
    });
    await provider.classifyWeeklyEvidence({ items: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Object.hasOwn(body, 'thinking'), false);
});

test('semantic classification converts aborts into a safe timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error('private timeout detail'), { name: 'AbortError' });
  };

  try {
    await assert.rejects(
      configuredProvider().classifyWeeklyEvidence(classificationInput()),
      error => {
        assert.equal(error.message, 'AI classification request timed out');
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /private timeout detail|AbortError/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('semantic classification treats a missing API key as a non-retryable configuration error', async () => {
  const provider = new OpenAICompatibleProvider({
    AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    AI_MODEL: 'glm-4-flash-250414',
  });

  await assert.rejects(
    provider.classifyWeeklyEvidence(classificationInput()),
    error => {
      assert.equal(error.message, 'AI_API_KEY missing');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('strict preview rejects missing API key instead of using template fallback', async () => {
  const provider = new OpenAICompatibleProvider({
    AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    AI_MODEL: 'glm-4-flash-250414',
  });

  await assert.rejects(
    provider.generateWeeklySheetPreview(previewInput()),
    /AI_API_KEY missing/,
  );
});

test('strict preview returns structured cells with evidence ids', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'glm-4-flash-250414');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        cells: { D30: [{ text: '完成收单联调', evidenceIds: ['rec_1:current:workItems:0'] }] },
      }) } }] }),
    };
  };

  try {
    const result = await configuredProvider().generateWeeklySheetPreview(previewInput());
    assert.deepEqual(result.cells.D30, [{
      text: '完成收单联调',
      evidenceIds: ['rec_1:current:workItems:0'],
    }]);
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.model, 'glm-4-flash-250414');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview requests JSON mode', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ cells: {} }) } }] }),
    };
  };

  try {
    await configuredProvider().generateWeeklySheetPreview(previewInput());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('weekly preview prompt asks AI to merge repeated daily items and retain communication evidence', async () => {
  const originalFetch = globalThis.fetch;
  let prompt;
  globalThis.fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).messages[1].content;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ cells: {} }) } }] }),
    };
  };

  try {
    await configuredProvider().generateWeeklySheetPreview(previewInput());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(prompt, /合并重复|同一事项/);
  assert.match(prompt, /沟通、讨论、协调/);
  assert.match(prompt, /阶段性成果|提炼/);
  assert.match(prompt, /不得简单复制日报原文/);
});

test('weekly sheet summary requests JSON mode', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ cells: {} }) } }] }),
    };
  };

  try {
    await configuredProvider().summarizeWeeklySheet(previewInput());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('plain weekly report summary does not request JSON mode', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '本周完成收单联调' } }] }),
    };
  };

  try {
    await configuredProvider().summarizeWeeklyReports(previewInput());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Object.hasOwn(body, 'response_format'), false);
});

test('strict preview prompt is target-scoped, style-guided, current-only, and anonymous by default', async () => {
  const originalFetch = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (_url, request) => {
    prompt = JSON.parse(request.body).messages.at(-1).content;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ cells: {} }) } }] }),
    };
  };

  try {
    await configuredProvider().generateWeeklySheetPreview(previewInput());
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(prompt, /模块二\/收单项目组\/本周重点事项说明 -> D30/);
  assert.match(prompt, /完成接口联调并进入试运行/);
  assert.match(prompt, /完成交易链路验证/);
  assert.match(prompt, /完成阶段性功能交付/);
  assert.match(prompt, /"evidenceId":\s*"rec_1:current:workItems:0"/);
  assert.match(prompt, /"date":\s*"2026-07-13"/);
  assert.match(prompt, /"text":\s*"完成收单联调"/);
  assert.match(prompt, /只总结本周期事实/);
  assert.match(prompt, /不得生成下周计划/);
  assert.match(prompt, /不得添加来源中不存在的项目、数字、日期、状态或责任人/);
  assert.match(prompt, /历史样例只用于风格，不是事实/);
  assert.match(prompt, /没有足够证据时返回空数组/);
  assert.doesNotMatch(prompt, /factRecordId/);
  assert.doesNotMatch(prompt, /张三|tomorrowPlanItems|riskItems|下周工作计划|D31/);
});

test('strict preview rejects HTTP failures without leaking key or response body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'response body' });

  try {
    await assert.rejects(
      configuredProvider().generateWeeklySheetPreview(previewInput()),
      error => {
        assert.match(error.message, /status=503/);
        assert.doesNotMatch(error.message, /test-key|response body/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview converts an aborted short timeout into a safe timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => new Promise((_, reject) => {
    const guard = setTimeout(() => {
      reject(new Error('mock fetch did not observe abort within 100ms'));
    }, 100);
    request.signal.addEventListener('abort', () => {
      clearTimeout(guard);
      reject(request.signal.reason);
    }, { once: true });
  });

  try {
    const provider = new OpenAICompatibleProvider({
      AI_API_KEY: 'test-key',
      AI_TIMEOUT_MS: '1',
    });
    await assert.rejects(
      provider.generateWeeklySheetPreview(previewInput()),
      error => {
        assert.equal(error.message, 'AI preview request timed out');
        assert.doesNotMatch(error.message, /test-key|TimeoutError/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview converts AbortError into the same safe timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error('request aborted'), { name: 'AbortError' });
  };

  try {
    await assert.rejects(
      configuredProvider().generateWeeklySheetPreview(previewInput()),
      error => {
        assert.equal(error.message, 'AI preview request timed out');
        assert.doesNotMatch(error.message, /request aborted|AbortError/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview converts transport rejection into a fixed safe request error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Authorization: Bearer secret-token; AI_API_KEY=private-key');
  };

  try {
    await assert.rejects(
      configuredProvider().generateWeeklySheetPreview(previewInput()),
      error => {
        assert.equal(error.message, 'AI preview request failed');
        assert.doesNotMatch(error.message, /secret-token|private-key|Authorization|AI_API_KEY/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy weekly summaries do not restore broad weekly sheet routing on timeout', async () => {
  const originalFetch = globalThis.fetch;
  const input = {
    group: { project: '数字金融部', chatId: 'oc_test' },
    reports: [{
      reportDate: '2026-07-13',
      reporterName: '张三',
      agileGroup: '收单项目组',
      workItems: ['完成收单联调'],
      tomorrowPlanItems: ['下周上线'],
      riskItems: [],
    }],
    weekStart: '2026-07-13',
    weekEnd: '2026-07-17',
    cellMap: {
      reportPeriod: 'B2',
      agileProjects: { 收单项目组: { current: 'D30', next: 'D31', aliases: ['收单'] } },
      management: {},
    },
  };
  const errors = ['TimeoutError', 'AbortError'];
  globalThis.fetch = async () => {
    const name = errors.shift();
    throw Object.assign(new Error(name), { name });
  };

  try {
    const provider = configuredProvider();
    const summary = await provider.summarizeWeeklyReports(input);
    const sheet = await provider.summarizeWeeklySheet(input);

    assert.equal(summary.reportCount, 1);
    assert.match(summary.summaryText, /完成收单联调/);
    assert.equal(sheet.values.B2, '2026年7月13日-7月17日');
    assert.equal(sheet.values.D30, '');
    assert.equal(sheet.values.D31, undefined);
    assert.equal(summary.provider, undefined);
    assert.equal(sheet.provider, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy weekly summaries also fall back when response body reading aborts', async () => {
  const originalFetch = globalThis.fetch;
  const abortBody = async () => {
    throw Object.assign(new Error('body aborted'), { name: 'AbortError' });
  };
  globalThis.fetch = async () => ({ ok: true, json: abortBody });
  const input = {
    group: { project: '数字金融部' },
    reports: [],
    weekStart: '2026-07-13',
    weekEnd: '2026-07-17',
    cellMap: { reportPeriod: 'B2', agileProjects: {}, management: {} },
  };

  try {
    const provider = configuredProvider();
    const summary = await provider.summarizeWeeklyReports(input);
    const sheet = await provider.summarizeWeeklySheet(input);
    assert.equal(summary.reportCount, 0);
    assert.equal(sheet.values.B2, '2026年7月13日-7月17日');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview converts a response body AbortError into a safe timeout error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => {
      throw Object.assign(new Error('body aborted'), { name: 'AbortError' });
    },
  });

  try {
    await assert.rejects(
      configuredProvider().generateWeeklySheetPreview(previewInput()),
      /AI preview request timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview rejects empty and invalid JSON responses', async () => {
  const originalFetch = globalThis.fetch;
  const contents = [
    '',
    'not JSON',
    '```json\n{"cells":{}}\n```',
    'prefix {"cells":{}} suffix',
  ];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: contents.shift() } }] }),
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      await assert.rejects(configuredProvider().generateWeeklySheetPreview(previewInput()), /invalid JSON/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview rejects non-string response content as invalid JSON', async () => {
  const originalFetch = globalThis.fetch;
  const contents = [{ cells: {} }, [], 42];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: contents.shift() } }] }),
  });

  try {
    for (let index = 0; index < 3; index += 1) {
      await assert.rejects(
        configuredProvider().generateWeeklySheetPreview(previewInput()),
        /AI preview returned invalid JSON/,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('strict preview rejects malformed structured cell entries', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      cells: { D30: [{ text: '完成收单联调', evidenceIds: 'rec_1' }] },
    }) } }] }),
  });

  try {
    await assert.rejects(
      configuredProvider().generateWeeklySheetPreview(previewInput()),
      /AI preview returned invalid JSON/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('builds weekly sheet prompt from discovered semantic targets without fixed coordinates', async () => {
  const originalFetch = globalThis.fetch;
  let prompt = '';
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    prompt = body.messages.at(-1).content;
    return { ok: false, status: 503, text: async () => 'unavailable' };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'https://example.invalid/v1',
      AI_MODEL: 'test-model',
    });
    await provider.summarizeWeeklySheet({
      group: { project: '数字金融部' },
      reports: [],
      weekStart: '2026-07-13',
      weekEnd: '2026-07-17',
      cellMap: {
        reportPeriod: 'B2',
        agileProjects: {
          收单项目组: { current: 'D30', next: 'D31', aliases: ['收单'] },
        },
        management: {
          业务风控合规: {
            current: ['D50', 'D51', 'D52'],
            next: ['D54', 'D55', 'D56'],
            aliases: ['风控'],
          },
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(prompt, /模块二\/收单项目组\/本周重点事项说明 -> D30/);
  assert.match(prompt, /模块三\/业务风控合规\/本周工作进展 -> D50, D51, D52/);
  assert.match(prompt, /模块二单元格可写多条，不受三条限制/);
  assert.doesNotMatch(prompt, /C26\/C27/);
  assert.doesNotMatch(prompt, /C39:C68/);
});
