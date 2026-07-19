import { buildWeeklySummary } from './weekly-summary.js';
import { buildWeeklySheetValues, getWeeklySheetExpectedCells } from './weekly-sheet-content.js';

export function createAiProvider(env = process.env) {
  if (env.AI_PROVIDER === 'openai-compatible') {
    return new OpenAICompatibleProvider(env);
  }
  return new TemplateAiProvider();
}

export class TemplateAiProvider {
  name = 'template';

  async summarizeWeeklyReports(input) {
    return buildWeeklySummary(input);
  }

  async summarizeWeeklySheet(input) {
    return buildWeeklySheetValues(input);
  }
}

export class OpenAICompatibleProvider {
  constructor(env = process.env) {
    this.name = 'openai-compatible';
    this.baseUrl = env.AI_BASE_URL || 'https://api.openai.com/v1';
    this.apiKey = env.AI_API_KEY;
    this.model = env.AI_MODEL || 'gpt-4o-mini';
    this.timeoutMs = parseTimeoutMs(env.AI_TIMEOUT_MS);
  }

  async summarizeWeeklyReports(input) {
    const fallback = buildWeeklySummary(input);
    if (!this.apiKey) {
      console.warn('[ai] AI_API_KEY missing; fallback to template provider');
      return fallback;
    }

    const prompt = buildPrompt(input, fallback.summaryText);
    let res;
    try {
      res = await this.requestChatCompletion({
        system: '你是企业项目管理助手，请基于日报生成简洁、真实、可执行的中文周报摘要。不要编造未出现的信息。',
        user: prompt,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      console.warn('[ai] chat completion timed out; fallback to template provider');
      return fallback;
    }

    if (!res.ok) {
      try {
        await res.text();
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
      console.warn(`[ai] chat completion failed: status=${res.status}`);
      return fallback;
    }

    let json;
    try {
      json = await res.json();
    } catch (error) {
      if (!isAbortError(error)) throw error;
      console.warn('[ai] chat completion timed out; fallback to template provider');
      return fallback;
    }
    const content = json?.choices?.[0]?.message?.content?.trim();
    if (!content) return fallback;
    return { ...fallback, summaryText: content };
  }

  async summarizeWeeklySheet(input) {
    const fallback = buildWeeklySheetValues(input);
    if (!this.apiKey) {
      console.warn('[ai] AI_API_KEY missing; fallback to template weekly sheet provider');
      return fallback;
    }

    const prompt = buildWeeklySheetPrompt(input, fallback.values);
    let res;
    try {
      res = await this.requestChatCompletion({
        system: '你是企业项目管理助手。请基于日报内容填写周报模板指定单元格，只输出合法 JSON，不要编造日报中没有的信息。',
        user: prompt,
        jsonMode: true,
      });
    } catch (error) {
      if (!isAbortError(error)) throw error;
      console.warn('[ai] weekly sheet completion timed out; fallback to template provider');
      return fallback;
    }

    if (!res.ok) {
      try {
        await res.text();
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
      console.warn(`[ai] weekly sheet completion failed: status=${res.status}`);
      return fallback;
    }

    let json;
    try {
      json = await res.json();
    } catch (error) {
      if (!isAbortError(error)) throw error;
      console.warn('[ai] weekly sheet completion timed out; fallback to template provider');
      return fallback;
    }
    const content = json?.choices?.[0]?.message?.content?.trim();
    const parsed = parseJsonObject(content);
    if (!parsed) return fallback;

    return {
      ...fallback,
      values: {
        ...fallback.values,
        ...sanitizeCellValues(parsed.cells || parsed.values || parsed, input.cellMap),
      },
      provider: this.name,
    };
  }

  async generateWeeklySheetPreview(input) {
    if (!this.apiKey) throw new Error('AI_API_KEY missing');

    let res;
    try {
      res = await this.requestChatCompletion({
        system: '你是企业周报助手。只能使用提供的事实事项，只输出合法 JSON。',
        user: buildWeeklyPreviewPrompt(input),
        jsonMode: true,
      });
    } catch (error) {
      if (isAbortError(error)) throw new Error('AI preview request timed out');
      throw error;
    }

    if (!res.ok) {
      try {
        await res.text();
      } catch {}
      throw new Error(`AI preview request failed: status=${res.status}`);
    }

    let json;
    try {
      json = await res.json();
    } catch (error) {
      if (isAbortError(error)) throw new Error('AI preview request timed out');
      throw new Error('AI preview returned invalid JSON');
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('AI preview returned invalid JSON');
    }
    const parsed = parseJsonObject(content.trim());
    if (!parsed || !parsed.cells || typeof parsed.cells !== 'object' || Array.isArray(parsed.cells)) {
      throw new Error('AI preview returned invalid JSON');
    }

    return {
      cells: normalizePreviewCells(parsed.cells),
      provider: this.name,
      model: this.model,
    };
  }

  async requestChatCompletion({ system, user, jsonMode = false }) {
    return fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  }
}

function parseTimeoutMs(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
}

function isAbortError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

function buildPrompt(input, fallbackText) {
  const reports = input.reports.map(report => ({
    date: report.reportDate,
    name: report.reporterName,
    items: report.workItems,
    risks: report.riskItems,
  }));
  return [
    `项目组：${input.group.project}`,
    `周期：${input.weekStart} 至 ${input.weekEnd}`,
    '日报数据：',
    JSON.stringify(reports, null, 2),
    '',
    '请输出：本周概览、重点事项、风险阻塞、待跟进事项。每部分 3-6 条以内。',
    '',
    '本地模板摘要参考：',
    fallbackText,
  ].join('\n');
}

function buildWeeklySheetPrompt(input, fallbackValues) {
  const cells = getWeeklySheetExpectedCells(input.cellMap);
  const targetDescriptions = describeWeeklySheetTargets(input.cellMap);
  const exampleCells = Object.fromEntries(
    cells
      .filter(cell => cell !== input.cellMap?.reportPeriod)
      .slice(0, 2)
      .map(cell => [cell, '']),
  );
  const reports = input.reports.map(report => ({
    date: report.reportDate,
    name: report.reporterName,
    project: report.project,
    agileGroup: report.agileGroup,
    workItems: report.workItems,
    tomorrowPlanItems: report.tomorrowPlanItems,
    riskItems: report.riskItems,
  }));
  return [
    `周期：${input.weekStart} 至 ${input.weekEnd}`,
    `需要填写的单元格：${cells.join(', ')}`,
    '',
    '单元格含义：',
    ...targetDescriptions,
    '',
    '日报数据：',
    JSON.stringify(reports, null, 2),
    '',
    `请输出 JSON，格式为：${JSON.stringify({ cells: exampleCells })}。无信息时留空字符串。`,
    '模块二单元格可写多条，不受三条限制；模块三每个目标单元格只写一条，最多使用三个目标单元格。',
    '',
    '本地规则生成的参考值：',
    JSON.stringify(fallbackValues, null, 2),
  ].join('\n');
}

function buildWeeklyPreviewPrompt(input) {
  const cells = getWeeklySheetExpectedCells(input.cellMap);
  const targetDescriptions = describeWeeklySheetTargets(input.cellMap);
  const reports = input.reports.map(report => ({
    evidenceId: report.evidenceId,
    date: report.reportDate,
    member: report.reporterName,
    category: report.category,
    kind: report.sourceField,
    text: report[report.sourceField]?.[0] ?? '',
  }));
  const exampleCells = Object.fromEntries(cells.map(cell => [cell, [{ text: '', evidenceIds: [] }]]));
  return [
    `周期：${input.weekStart} 至 ${input.weekEnd}`,
    `可填写的单元格：${cells.join(', ')}`,
    '',
    '单元格含义：',
    ...targetDescriptions,
    '',
    '日报事实（每项的 evidenceId 可作为 evidenceIds）：',
    JSON.stringify(reports),
    '',
    `请只输出 JSON，格式为：${JSON.stringify({ cells: exampleCells })}。`,
    '每个 cells 单元格值必须是数组；数组每项包含 text 字符串和 evidenceIds 字符串数组。只可引用提供的 evidenceId，不得编造事实。',
  ].join('\n');
}

function describeWeeklySheetTargets(cellMap = {}) {
  const descriptions = [];
  for (const [name, spec] of Object.entries(cellMap.agileProjects || {})) {
    descriptions.push(`- 模块二/${name}/本周重点事项说明 -> ${spec.current}`);
    descriptions.push(`- 模块二/${name}/下周工作计划 -> ${spec.next}`);
  }
  for (const [name, spec] of Object.entries(cellMap.management || {})) {
    descriptions.push(`- 模块三/${name}/本周工作进展 -> ${toCellList(spec.current)}`);
    descriptions.push(`- 模块三/${name}/下周工作计划 -> ${toCellList(spec.next)}`);
  }
  return descriptions;
}

function toCellList(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(', ');
}

function sanitizeCellValues(values, cellMap) {
  const allowed = new Set(getWeeklySheetExpectedCells(cellMap));
  const result = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return result;
  for (const [cell, value] of Object.entries(values)) {
    if (!allowed.has(cell)) continue;
    result[cell] = value == null ? '' : String(value).trim();
  }
  return result;
}

function normalizePreviewCells(cells) {
  const result = {};
  for (const [cell, entries] of Object.entries(cells)) {
    if (!Array.isArray(entries)) throw new Error('AI preview returned invalid JSON');
    result[cell] = entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.text !== 'string' || !Array.isArray(entry.evidenceIds)
        || entry.evidenceIds.some(id => typeof id !== 'string')) {
        throw new Error('AI preview returned invalid JSON');
      }
      return {
        text: entry.text.trim(),
        evidenceIds: entry.evidenceIds,
      };
    });
  }
  return result;
}

function parseJsonObject(content) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {}

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
