import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/ai-providers.js';

function previewInput() {
  return {
    group: { project: '数字金融部' },
    reports: [{
      evidenceId: 'rec_1:current:workItems:0',
      factRecordId: 'rec_1',
      category: 'current',
      sourceField: 'workItems',
      itemIndex: 0,
      reportDate: '2026-07-13',
      reporterName: '张三',
      workItems: ['完成收单联调'],
      tomorrowPlanItems: [],
      riskItems: [],
    }],
    weekStart: '2026-07-13',
    weekEnd: '2026-07-17',
    cellMap: { reportPeriod: 'B2' },
  };
}

function configuredProvider() {
  return new OpenAICompatibleProvider({
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
    AI_MODEL: 'glm-4-flash-250414',
  });
}

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

test('strict preview prompt describes the bucket module, section, and current and next targets', async () => {
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
    await configuredProvider().generateWeeklySheetPreview({
      ...previewInput(),
      cellMap: {
        agileProjects: {
          收单项目组: { current: 'D30', next: 'D31' },
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(prompt, /模块二\/收单项目组\/本周重点事项说明 -> D30/);
  assert.match(prompt, /模块二\/收单项目组\/下周工作计划 -> D31/);
  assert.match(prompt, /单元格含义/);
  assert.match(prompt, /rec_1:current:workItems:0/);
  assert.match(prompt, /"factRecordId": "rec_1"/);
  assert.match(prompt, /evidenceId 可作为 evidenceIds/);
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
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
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

test('legacy weekly summaries fall back to templates on timeout and AbortError', async () => {
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
    assert.equal(sheet.values.B2, '2026.07.13-2026.07.17');
    assert.match(sheet.values.D30, /完成收单联调/);
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
    assert.equal(sheet.values.B2, '2026.07.13-2026.07.17');
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
  const contents = ['', 'not JSON'];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: contents.shift() } }] }),
  });

  try {
    await assert.rejects(configuredProvider().generateWeeklySheetPreview(previewInput()), /invalid JSON/);
    await assert.rejects(configuredProvider().generateWeeklySheetPreview(previewInput()), /invalid JSON/);
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
