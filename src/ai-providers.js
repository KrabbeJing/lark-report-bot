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
      const body = await res.text();
      console.warn(`[ai] chat completion failed: ${res.status} ${body}`);
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
      const body = await res.text();
      console.warn(`[ai] weekly sheet completion failed: ${res.status} ${body}`);
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
    '- C26/C27 融羲项目组本周重点事项/下周计划',
    '- C28/C29 收单项目组本周重点事项/下周计划',
    '- C30/C31 线上营业厅项目组本周重点事项/下周计划',
    '- C32/C33 手机银行项目组本周重点事项/下周计划',
    '- C34/C35 新核心项目组本周重点事项/下周计划',
    '- C39:C68 部门管理工作，按零售大众客群、对公客群及场景、渠道创新、风控合规、业务转型分组填写',
    '',
    '日报数据：',
    JSON.stringify(reports, null, 2),
    '',
    '请输出 JSON，格式为：{"cells":{"C26":"...","C27":"..."}}。每个单元格内容简洁，最多 3 条；无信息时留空字符串。',
    '',
    '本地规则生成的参考值：',
    JSON.stringify(fallbackValues, null, 2),
  ].join('\n');
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
