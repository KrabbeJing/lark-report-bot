import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider } from '../src/ai-providers.js';

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
