# 智谱周报 AI 只读预览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个只读取日报事实表和周报模板、调用智谱生成带事实证据的周报单元格候选 JSON、且绝不写飞书或发送消息的命令。

**Architecture:** 在现有 `OpenAICompatibleProvider` 上增加严格的结构化预览方法，保留现有周报降级行为不变；新增独立的预览领域服务负责日期参数、事实筛选、模板目标分桶、证据校验和结果组装；CLI 只负责飞书客户端依赖注入和 JSON 输出。所有外部依赖在测试中使用假实现，验证只调用读取接口。

**Tech Stack:** Node.js 20、ES modules、`node:test`、飞书 Node SDK、OpenAI-compatible Chat Completions API。

## Global Constraints

- 命令固定入口为 `npm run weekly:ai-preview -- --start YYYY-MM-DD --end YYYY-MM-DD`。
- 只使用日期闭区间内且 `事实记录状态` 为“有效”的日报事实记录。
- 历史归属以事实表为准，不使用当前通讯录覆盖。
- 核心指标保持空白；模块二每个内容类型对应一个单元格；模块三每类最多三个单元格。
- 只读取日报事实表、Wiki 节点和模板工作表；禁止复制或写入工作表、写 Base、上传图片、发送消息。
- 模型只能返回模板定位器允许的单元格，每个非空事项必须引用本次输入中的事实记录 ID。
- 无事实依据不生成；API Key 缺失、超时、HTTP 失败、空响应或非法 JSON 必须以非零状态失败，不得将本地模板值作为 AI 结果。
- `AI_API_KEY` 只来自环境变量，不写入 Git、日志或预览输出。
- 现有周六模板海报生成及其降级行为保持不变。
- 子代理不执行 `git add`、`git commit` 或 `git push`；所有 Git 操作由主会话完成。

---

### Task 1: 严格的结构化 AI 预览接口

**Files:**
- Modify: `src/ai-providers.js`
- Modify: `test/ai-providers.test.js`

**Interfaces:**
- Consumes: `OpenAICompatibleProvider` 的 `baseUrl`、`apiKey`、`model` 配置。
- Produces: `OpenAICompatibleProvider.generateWeeklySheetPreview(input)`，返回 `{ cells, provider, model }`；`cells[cell]` 为 `[{ text, evidenceIds }]`。

- [ ] **Step 1: 写缺少密钥、HTTP 失败和合法结构化响应的失败测试**

```js
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
        cells: { D30: [{ text: '完成收单联调', evidenceIds: ['rec_1'] }] },
      }) } }] }),
    };
  };
  try {
    const result = await configuredProvider().generateWeeklySheetPreview(previewInput());
    assert.deepEqual(result.cells.D30, [{ text: '完成收单联调', evidenceIds: ['rec_1'] }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: 运行测试并确认新方法尚不存在**

Run: `node --test test/ai-providers.test.js`

Expected: FAIL，错误包含 `generateWeeklySheetPreview is not a function`。

- [ ] **Step 3: 提取请求方法并实现严格预览方法**

```js
async generateWeeklySheetPreview(input) {
  if (!this.apiKey) throw new Error('AI_API_KEY missing');
  const response = await this.requestChatCompletion({
    system: '你是企业周报助手。只能使用提供的事实事项，只输出合法 JSON。',
    user: buildWeeklyPreviewPrompt(input),
  });
  const parsed = parseJsonObject(response);
  if (!parsed || !parsed.cells || typeof parsed.cells !== 'object') {
    throw new Error('AI preview returned invalid JSON');
  }
  return {
    cells: normalizePreviewCells(parsed.cells),
    provider: this.name,
    model: this.model,
  };
}
```

`requestChatCompletion` 必须复用现有 URL、Authorization、低温度和消息结构；严格方法对非 2xx、空内容、非法 JSON 抛出不含响应正文和密钥的错误。现有 `summarizeWeeklyReports`、`summarizeWeeklySheet` 仍在失败时返回本地模板结果，行为不得改变。

- [ ] **Step 4: 增加非法 JSON、空内容和 HTTP 失败测试**

```js
await assert.rejects(
  provider.generateWeeklySheetPreview(previewInput()),
  /status=503/,
);
assert.doesNotMatch(error.message, /test-key|response body/);
```

- [ ] **Step 5: 运行 Provider 测试**

Run: `node --test test/ai-providers.test.js`

Expected: PASS。

---

### Task 2: 事实分桶、证据校验和只读预览领域服务

**Files:**
- Create: `src/weekly-ai-preview.js`
- Create: `test/weekly-ai-preview.test.js`
- Modify: `src/weekly-sheet-content.js`
- Modify: `test/weekly-sheet-content.test.js`

**Interfaces:**
- Consumes: `bitable.listAllDailyReportsForRange(group, start, end)`、`sheetWriter.discoverTemplateTargets(...)`、`aiProvider.generateWeeklySheetPreview(input)`。
- Produces: `parseWeeklyAiPreviewArgs(argv)`、`buildWeeklyPreviewBuckets({ reports, cellMap, group })`、`runWeeklyAiPreview({ config, bitable, sheetWriter, aiProvider, options })`。

- [ ] **Step 1: 写日期参数和事实最新版本选择测试**

```js
assert.deepEqual(parseWeeklyAiPreviewArgs([
  '--start', '2026-07-13', '--end', '2026-07-17',
]), {
  startDate: '2026-07-13',
  endDate: '2026-07-17',
  outputPath: '',
});

assert.throws(
  () => parseWeeklyAiPreviewArgs(['--start', '2026-07-18', '--end', '2026-07-17']),
  /start.*end/,
);
```

测试数据包含同一成员、日期、有效来源的两条记录，断言只保留 `sourceTime` 较新的记录；同时断言“待人工确认”和“忽略”不进入模型输入。虽然正式 `BitableService` 已过滤无效记录，领域服务仍执行一次防御性过滤。

- [ ] **Step 2: 运行测试并确认模块不存在**

Run: `node --test test/weekly-ai-preview.test.js`

Expected: FAIL，错误为找不到 `src/weekly-ai-preview.js`。

- [ ] **Step 3: 从现有周报内容逻辑导出可复用的分桶选择器**

在 `src/weekly-sheet-content.js` 增加：

```js
export function buildWeeklyPreviewBuckets({ reports = [], cellMap = {}, group = {} }) {
  return [
    ...buildAgilePreviewBuckets(reports, cellMap.agileProjects || {}),
    ...buildManagementPreviewBuckets(reports, cellMap.management || {}, group),
  ];
}
```

每个 bucket 结构固定为：

```js
{
  module: 'agileProjects',
  name: '收单项目组',
  targets: { current: ['D30'], next: ['D31'] },
  sources: {
    current: [{ evidenceId: 'rec_1', date: '2026-07-13', member: '张三', text: '完成联调' }],
    next: [{ evidenceId: 'rec_2', date: '2026-07-17', member: '李四', text: '下周上线' }]
  }
}
```

分桶必须复用现有别名和匹配函数，不能复制另一套关键词口径。核心指标不生成 bucket。模块三目标数组保持模板定位出的三个 cell。

- [ ] **Step 4: 实现参数解析、事实选择和预览编排**

```js
export async function runWeeklyAiPreview({ config, bitable, sheetWriter, aiProvider, options }) {
  const results = [];
  for (const group of config.groups) {
    const cellMap = await sheetWriter.discoverTemplateTargets(
      group.weeklySheet,
      group.weeklySheet.templateSheetId,
      { aliasMap: group.weeklySheet.entityAliases },
    );
    const listed = await bitable.listAllDailyReportsForRange(
      group,
      options.startDate,
      options.endDate,
    );
    const reports = selectPreviewFacts(listed, options);
    const buckets = buildWeeklyPreviewBuckets({ reports, cellMap, group });
    results.push(await previewGroup({ group, cellMap, buckets, aiProvider, options }));
  }
  return buildPreviewDocument(results, options, aiProvider);
}
```

每个 bucket 单独调用模型。传给模型的 allowed cells 只包含该 bucket 的 current/next 目标；传入事实项使用 `evidenceId`，不包含 API Key 或飞书 token。

- [ ] **Step 5: 实现严格输出校验和证据组装**

校验规则：

```js
function validateBucketResult(bucket, modelCells) {
  const allowedCells = new Set([...bucket.targets.current, ...bucket.targets.next]);
  const allowedEvidence = new Set([
    ...bucket.sources.current,
    ...bucket.sources.next,
  ].map(item => item.evidenceId));
  // 丢弃白名单外 cell、空 text、无证据、未知 evidenceId。
  // agile cell 将事项格式化成编号多行文本。
  // management cell 每格最多一条，且最多使用三个目标 cell。
}
```

最终结果包含 `mode`、日期、provider、model、groups、cells、evidence、warnings。`evidence[cell]` 保存经验证的记录 ID、日期和成员姓名。报告周期可由本地确定性逻辑填入；核心指标 cell 必须为空字符串。

- [ ] **Step 6: 写只读边界集成测试**

```js
const forbidden = () => { throw new Error('write operation called'); };
const result = await runWeeklyAiPreview({
  config,
  bitable: {
    listAllDailyReportsForRange: async () => reports,
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
```

同时断言白名单外 cell 被过滤、未知证据被过滤、无事实 bucket 保持空白、模块三最多三格、模型异常使整个命令失败且不返回伪 AI cells。

- [ ] **Step 7: 运行领域服务测试**

Run: `node --test test/weekly-ai-preview.test.js test/weekly-sheet-content.test.js`

Expected: PASS。

---

### Task 3: CLI 接线、配置说明和输出文件

**Files:**
- Create: `scripts/preview-weekly-ai.js`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `test/weekly-ai-preview.test.js`

**Interfaces:**
- Consumes: Task 2 的 `parseWeeklyAiPreviewArgs`、`runWeeklyAiPreview`。
- Produces: `npm run weekly:ai-preview -- --start ... --end ... [--output path]`。

- [ ] **Step 1: 增加 `--output` 参数测试**

```js
assert.deepEqual(parseWeeklyAiPreviewArgs([
  '--start', '2026-07-13', '--end', '2026-07-17', '--output', 'out/preview.json',
]), {
  startDate: '2026-07-13',
  endDate: '2026-07-17',
  outputPath: 'out/preview.json',
});
```

拒绝未知参数、缺少参数值、非法日历日期。输出目录只在显式指定 `--output` 时创建。

- [ ] **Step 2: 编写 CLI 依赖注入入口**

```js
import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BitableService } from '../src/bitable-service.js';
import { createAiProvider } from '../src/ai-providers.js';
import { loadGroupConfig } from '../src/config.js';
import { buildLarkClientOptions } from '../src/lark-client.js';
import { WeeklySheetWriter } from '../src/weekly-sheet-writer.js';
import { parseWeeklyAiPreviewArgs, runWeeklyAiPreview } from '../src/weekly-ai-preview.js';

const options = parseWeeklyAiPreviewArgs(process.argv.slice(2));
const provider = createAiProvider();
if (provider.name !== 'openai-compatible') {
  throw new Error('weekly:ai-preview requires AI_PROVIDER=openai-compatible');
}
// 创建只读依赖，运行并输出 JSON；catch 时仅打印安全错误摘要并设置 process.exitCode=1。
```

CLI 不创建 `LarkMessenger`，从依赖层面排除发送消息能力。

- [ ] **Step 3: 注册 npm script 和智谱示例环境变量**

`package.json`：

```json
"weekly:ai-preview": "node scripts/preview-weekly-ai.js"
```

`.env.example`：

```dotenv
# 智谱只读预览示例
# AI_PROVIDER=openai-compatible
# AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
# AI_MODEL=glm-4-flash-250414
# AI_API_KEY=仅配置在本地或服务器环境
```

- [ ] **Step 4: 验证帮助失败路径不会泄露敏感信息**

测试序列化错误和 warnings，断言不包含 `AI_API_KEY` 的测试值、Authorization、飞书 app secret 或完整 API 响应正文。

- [ ] **Step 5: 运行任务相关测试**

Run: `node --test test/ai-providers.test.js test/weekly-ai-preview.test.js test/weekly-sheet-content.test.js`

Expected: PASS。

---

### Task 4: 全量验证和真实只读试运行

**Files:**
- Create: `docs/superpowers/verification/2026-07-18-zhipu-weekly-ai-preview.md`

**Interfaces:**
- Consumes: 已实现的 CLI 和测试组织环境变量。
- Produces: 可复核的测试记录与真实只读预览文件。

- [ ] **Step 1: 运行静态差异检查和完整测试**

Run: `git diff --check`

Expected: 无输出。

Run: `npm test`

Expected: 全部测试 PASS，0 failures。

- [ ] **Step 2: 检查 Git 差异不包含密钥**

Run: `git diff | rg -n "AI_API_KEY=.+|Bearer [A-Za-z0-9]"`

Expected: 无真实密钥；只允许 `.env.example` 的说明性占位文本。

- [ ] **Step 3: 在本地测试组织执行真实只读预览**

Run:

```bash
DOTENV_CONFIG_PATH=.env \
GROUPS_CONFIG_PATH=config/groups.personal.json \
npm run weekly:ai-preview -- \
  --start 2026-07-13 \
  --end 2026-07-17 \
  --output out/weekly-ai-preview-2026-07-13.json
```

Expected: 退出码 0，输出包含 `mode=read_only_preview`、智谱 provider/model、模板允许的 cells 和对应 evidence；执行日志没有写表、复制、上传或发送操作。

- [ ] **Step 4: 人工核对飞书无变化**

确认周报模板工作表数量、周报实例表记录数和当前测试群消息在命令执行前后没有变化。将核对时间、命令、测试数量、模型、输入事实数量、输出单元格数量和 warnings 数量写入验证文档，不记录日报正文或密钥。

- [ ] **Step 5: 主会话统一提交**

主会话审查子代理修改后执行：

```bash
git add package.json .env.example scripts/preview-weekly-ai.js \
  src/ai-providers.js src/weekly-ai-preview.js src/weekly-sheet-content.js \
  test/ai-providers.test.js test/weekly-ai-preview.test.js test/weekly-sheet-content.test.js \
  docs/superpowers/verification/2026-07-18-zhipu-weekly-ai-preview.md
git commit -m "feat: add read-only zhipu weekly preview"
```

Expected: 单个由主会话创建的功能提交，子代理没有提交记录。
