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
  }

  async summarizeWeeklyReports(input) {
    const fallback = buildWeeklySummary(input);
    if (!this.apiKey) {
      console.warn('[ai] AI_API_KEY missing; fallback to template provider');
      return fallback;
    }

    const prompt = buildPrompt(input, fallback.summaryText);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你是企业项目管理助手，请基于日报生成简洁、真实、可执行的中文周报摘要。不要编造未出现的信息。' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      await res.text();
      console.warn(`[ai] chat completion failed: status=${res.status}`);
      return fallback;
    }

    const json = await res.json();
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
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是企业项目管理助手。请基于日报内容填写周报模板指定单元格，只输出合法 JSON，不要编造日报中没有的信息。',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      await res.text();
      console.warn(`[ai] weekly sheet completion failed: status=${res.status}`);
      return fallback;
    }

    const json = await res.json();
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
