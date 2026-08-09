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

  async classifyWeeklyEvidence(input) {
    if (!this.apiKey) throw classificationError('AI_API_KEY missing', false);

    let res;
    try {
      res = await this.requestChatCompletion({
        system: [
          '你是企业周报事项分类器。来源映射给出的 allowedTargets 是唯一边界。',
          '你必须逐条判断，且每条只能选择一个 allowed target。主题词和正反例只是语义提示。',
          '不得拆分、合并、改写事项，不得输出人员信息，只输出严格 JSON。',
        ].join('\n'),
        user: buildWeeklyClassificationPrompt(input),
        jsonMode: true,
        temperature: 0.1,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw classificationError('AI classification request timed out', true);
      }
      throw classificationError('AI classification request failed', true);
    }

    if (!res.ok) {
      try { await res.text(); } catch {}
      throw classificationError(`AI classification request failed: status=${res.status}`, true);
    }

    let json;
    try {
      json = await res.json();
    } catch (error) {
      if (isAbortError(error)) {
        throw classificationError('AI classification request timed out', true);
      }
      throw classificationError('AI classification returned invalid JSON', false);
    }
    const content = json?.choices?.[0]?.message?.content;
    const parsed = parseStrictJsonObject(content);
    if (!parsed || !Array.isArray(parsed.classifications)) {
      throw classificationError('AI classification returned invalid JSON', false);
    }

    return {
      classifications: parsed.classifications,
      provider: this.name,
      model: this.model,
    };
  }

  async generateWeeklySheetPreview(input) {
    if (!this.apiKey) throw new Error('AI_API_KEY missing');

    let res;
    try {
      res = await this.requestChatCompletion({
        system: '你是企业周报助手。只能使用当前目标的本周期事实，只输出严格 JSON，不显示成员姓名。',
        user: buildWeeklyPreviewPrompt(input),
        jsonMode: true,
      });
    } catch (error) {
      if (isAbortError(error)) throw new Error('AI preview request timed out');
      throw new Error('AI preview request failed');
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
    const parsed = parseStrictJsonObject(content);
    if (!parsed || !parsed.cells || typeof parsed.cells !== 'object' || Array.isArray(parsed.cells)) {
      throw new Error('AI preview returned invalid JSON');
    }

    return {
      cells: normalizePreviewCells(parsed.cells),
      provider: this.name,
      model: this.model,
    };
  }

  async requestChatCompletion({ system, user, jsonMode = false, temperature = 0.2 }) {
    return fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature,
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

function classificationError(message, retryable) {
  return Object.assign(new Error(message), { retryable });
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

function buildWeeklyClassificationPrompt(input = {}) {
  const items = (input.items || []).map(item => ({
    evidenceId: String(item?.evidenceId || '').trim(),
    date: String(item?.date || '').trim(),
    text: String(item?.text || '').trim(),
    allowedTargets: (item?.allowedTargets || []).map(target => ({
      targetId: String(target?.targetId || '').trim(),
      module: String(target?.module || '').trim(),
      target: String(target?.target || '').trim(),
      contentType: String(target?.contentType || '').trim(),
      businessScope: String(target?.businessScope || '').trim(),
      includeTopics: toStringArray(target?.includeTopics),
      excludeTopics: toStringArray(target?.excludeTopics),
      positiveExamples: toStringArray(target?.positiveExamples),
      negativeExamples: toStringArray(target?.negativeExamples),
    })),
  }));
  const outputShape = {
    classifications: [{
      evidenceId: '与输入完全一致',
      targetId: '该事项 allowedTargets 中的一个 targetId',
      confidence: 'high | medium | low',
      reason: '简短分类理由',
    }],
  };
  return [
    '待分类事项：',
    JSON.stringify(items),
    '',
    `输出格式：${JSON.stringify(outputShape)}`,
    '必须为每条输入返回且只返回一个结果。',
    'targetId 必须来自该条事项自己的 allowedTargets，不能使用其他事项独有的目标。',
    'confidence 只能是 high、medium 或 low。',
    'high 表示存在明确业务、系统、项目或可识别对象；medium 表示完整语义足以合理确定；low 表示只能判断最可能目标或信息不足。',
    '包含主题、排除主题、分类正例和分类反例只用于理解语义，不是关键词硬匹配规则。',
  ].join('\n');
}

function buildWeeklyPreviewPrompt(input) {
  const target = input.target || {};
  const cells = toCellArray(target.cells);
  const evidence = (input.evidence || []).map(item => ({
    evidenceId: item.evidenceId,
    date: item.date,
    text: item.text,
  }));
  const styleExamples = (input.styleExamples || []).map(item => ({
    module: item.module,
    target: item.target,
    contentType: item.contentType,
    finalText: item.finalText,
  }));
  const exampleCells = Object.fromEntries(cells.map(cell => [cell, [{ text: '', evidenceIds: [] }]]));
  return [
    `周期：${input.weekStart} 至 ${input.weekEnd}`,
    `目标：${describePreviewTarget(target)} -> ${cells.join(', ')}`,
    `可填写的单元格：${cells.join(', ')}`,
    '',
    '当前目标的本周期事实（仅这些 evidenceId 可作为 evidenceIds）：',
    JSON.stringify(evidence, null, 2),
    '',
    '当前目标的最终历史样例：',
    JSON.stringify(styleExamples, null, 2),
    '',
    `请只输出 JSON，格式为：${JSON.stringify({ cells: exampleCells })}。`,
    '每个 cells 单元格值必须是数组；数组每项只包含 text 字符串和 evidenceIds 字符串数组。',
    '只总结本周期事实。',
    '不得生成下周计划。',
    '不得添加来源中不存在的项目、数字、日期、状态或责任人。',
    '不得输出风险、姓名或日报覆盖率。',
    '不要因为出现“沟通、讨论、协调、参加会议”等词就直接判定为没有成果；结合完整事实判断其是否体现了推进、确认、解决、交付、测试或阶段性进展。',
    '合并同一事项在不同日期的重复日报，优先提炼阶段性成果、当前进展和已确认事项。',
    '不得简单复制日报原文或逐条罗列日报；在不改变事实的前提下，用更适合周报的概括性表述输出。',
    '如果只有沟通或讨论动作且没有任何可确认的进展，不要擅自补写成果，可以留空或保留准确的推进表述。',
    '历史样例只用于风格，不是事实。',
    '没有足够证据时返回空数组。',
    '每条输出必须引用至少一个当前目标事实的 evidenceId。',
    target.module === 'module3'
      ? '模块三最多使用三个当前单元格，每个单元格最多一条。'
      : '模块二使用当前目标单元格，可在数组中输出多条。',
  ].join('\n');
}

function describePreviewTarget(target) {
  const moduleLabel = target.module === 'module2'
    ? '模块二'
    : target.module === 'module3'
      ? '模块三'
      : String(target.module || '');
  return `${moduleLabel}/${target.target || ''}/${target.contentType || ''}`;
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

function toCellArray(value) {
  return (Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .map(item => String(item).trim())
    .filter(Boolean);
}

function toStringArray(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .map(item => String(item || '').trim())
    .filter(Boolean);
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

function parseStrictJsonObject(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
