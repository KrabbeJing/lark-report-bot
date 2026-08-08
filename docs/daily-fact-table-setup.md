# 日报数据层表格配置清单

## 表结构单一事实源

字段、必填状态、字段类型和单选/多选选项以 [`docs/report-agent-table-catalog.md`](report-agent-table-catalog.md) 为准。机器人不会自动建表、建字段或修正选项。

当前日报/周报流程需要九张 Base 表：

1. `表单日报表`
2. `群聊日报原始表`
3. `日报统一事实表`
4. `团队通讯录`
5. `周报来源映射表`
6. `周报板块规则表`
7. `周报风格样例表`
8. `核心指标负责人表`
9. `周报实例表`

其中前四张承载日报事实层，后五张承载周报配置与实例状态。新增配置表的完整字段表不在本文重复维护，建表时直接按 catalog 执行。

## 日报事实层的关键要求

`群聊日报原始表`必须保留消息 ID、发送人 OpenID、原始消息文本、内容指纹、消息时间、接收时间，以及 `解析状态`、`原始记录状态` 两个单选字段。选项分别为：

- `解析状态`：`已解析`、`低置信度`、`解析失败`
- `原始记录状态`：`主版本`、`历史版本`、`解析失败`

`日报统一事实表`必须新增 `字段来源快照`（多行文本 JSON），并保留三个业务字段的最终值、字段级来源、来源时间和合并状态。日报来源、有效来源使用 `form`、`chat`、`form+chat`；合并状态使用 `单来源`、`重复已合并`、`互补已合并`、`按字段取最新`。

事实表的匹配状态为 `已匹配`、`未匹配`；冲突状态为 `无冲突`、`已自动处理`；事实记录状态为 `有效`、`待人工确认`、`忽略`。空 incoming 字段不得清空已有非空事实，`忽略`状态也不得被普通同步覆盖。

`团队通讯录`只维护团队名称、成员、真实姓名、别名、当前 OpenID、直属上级和 `团队身份`（`组员`、`组长`）。不要新建或依赖 `敏捷小组`、`分管领导`、人员类型、成员状态等周报归属字段。业务板块来自通讯录的 `团队名称`，周报归集来自四张周报配置表。

## 不再使用的旧字段和旧选项

- `团队通讯录`和`日报统一事实表`不应把 `敏捷小组`、`分管领导` 纳入必需 schema。
- `合并状态`不再使用整体记录的 `按时间取最新` 作为唯一策略；同一记录不同业务字段可以分别保留不同来源。
- 当前周报日期是周五，日报事实周期为上周五至本周五闭区间；Sheet 展示周期仍为本周一至本周五。

部署迁移时可先保留旧字段供人工核对，但在 schema 校验前应完成字段清理或至少确认其不属于受支持的必需 schema。

## 只读表结构校验

校验器只读取配置表的字段元数据，不读取业务记录，也不会创建、更新或删除任何字段：

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run tables:validate
```

输出为脱敏 JSON。退出码为 `0` 表示九张已配置表的必需字段、类型和选项均通过；退出码为 `1` 表示缺表、缺字段、类型不兼容、选项漂移或禁用字段仍存在。正式环境的配置应先保持调度关闭，再执行校验。

事实记录状态的使用规则：

- `有效`：进入周报、小群总结和月报的数据范围。
- `待人工确认`：保留记录但默认不进入正式汇总，修正后可以改为`有效`。
- `忽略`：明确排除，不进入任何 AI 汇总，但不删除原始来源。

## 日报冲突单选值迁移

完整状态矩阵：

| 场景 | 合并状态 | 冲突状态 | 事实记录状态 |
| --- | --- | --- | --- |
| 只有一个来源 | `单来源` | `无冲突` | `有效` |
| 群聊与表单内容一致 | `重复已合并` | `无冲突` | `有效` |
| 群聊与表单内容互补 | `互补已合并` | `无冲突` | `有效` |
| 同一字段来源内容不一致 | `按字段取最新` | `已自动处理` | `有效` |
| 无法匹配成员 | `单来源` | `无冲突` | `待人工确认` |

迁移时先按 catalog 补齐四种合并状态，再用 `npm run tables:validate` 检查选项集合。不能把旧的整体记录状态直接重命名为`已自动处理`。

## 个人组织与正式组织配置

建议保留两套配置文件：

- `config/groups.personal.json`：个人组织沙盒测试。
- `config/groups.formal.example.json`：正式组织迁移模板，默认禁用。

启动时通过 `GROUPS_CONFIG_PATH` 切换：

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm start
```

组织归属的唯一来源约定：

- 群组配置没有敏捷小组值。不要在 group 配置中增加或依赖 `agileGroup`；群组只表达群聊和业务板块等运行范围。
- 通讯录表维护成员的真实姓名、团队名称和直属上级。事实表中的这些快照由匹配到的通讯录记录提供。
- 正常日报事实同步对已匹配记录冻结组织快照：后续通讯录变更不会在普通同步中改写历史事实。需要纠正历史事实时，必须由操作员显式执行带 `--repair-organization` 的一次性回填。

迁移到正式组织时，只替换 `.env` 的飞书应用凭证，并将 `GROUPS_CONFIG_PATH` 指向正式组织配置。表名、字段名、业务含义应保持一致；`chatId`、`appToken`、`tableId`、`viewId`、人员 `open_id` 不要求也无法保持一致。

表配置支持两种写法：

```json
{
  "appToken": "BaseAppToken",
  "tableId": "tblxxxxxxxxxxxx",
  "viewId": "vewxxxxxxxx"
}
```

也可以直接使用知识库中的多维表格链接，机器人会在请求前解析 wiki 节点对应的 Base token：

```json
{
  "wikiUrl": "https://example.feishu.cn/wiki/WikiNodeToken?table=tblxxxxxxxxxxxx&view=vewxxxxxxxx"
}
```

如果飞书字段建成了“日期”或“日期时间”，需要在配置里声明 `fieldTypes`，机器人才会把文本时间转换成飞书 API 要求的 unix timestamp：

```json
{
  "chatDailyRawTable": {
    "wikiUrl": "https://example.feishu.cn/wiki/WikiNodeToken?table=tbl_raw&view=vew_raw",
    "fieldTypes": {
      "messageTime": "datetime",
      "receivedAt": "datetime"
    }
  },
  "dailyFactTable": {
    "wikiUrl": "https://example.feishu.cn/wiki/WikiNodeToken?table=tbl_fact&view=vew_fact",
    "fieldTypes": {
      "reportDate": "date",
      "messageTime": "datetime",
      "syncedAt": "datetime"
    }
  }
}
```

如果这些字段在多维表格里建成了普通文本，则不要配置对应的 `fieldTypes`。

## 错误通知

机器人默认不会把内部异常回复到同事群。错误会写入服务器日志；如果需要主动通知管理员，在当前环境配置中增加：

```json
{
  "errorReporting": {
    "notifyInChat": false,
    "adminOpenIds": ["管理员open_id"],
    "adminChatIds": ["运维通知群chat_id"]
  }
}
```

- `notifyInChat=false`：不在原群回复错误。
- `adminOpenIds`：私聊通知指定管理员。
- `adminChatIds`：通知指定运维群。

`errorReporting.adminChatIds` 只覆盖进程已经启动并进入应用逻辑后的异常，例如定时任务或处理流程中的失败；它不能覆盖 Node.js 启动失败、凭证/环境变量缺失、主机宕机、进程管理器未拉起等进程外故障。启动和主机级故障必须另配外部进程、主机或平台监控。

也可以通过环境变量配置，多个 ID 用英文逗号分隔：

```bash
ERROR_REPORT_OPEN_IDS=ou_xxx,ou_yyy
ERROR_REPORT_CHAT_IDS=oc_xxx
```

## 事实回填与组织修复

回填是操作员手动运行的命令，日期范围为**包含起止日期**的闭区间。`--start 2026-07-01 --end 2026-07-12` 会处理 7 月 1 日至 7 月 12 日（含首尾）能够定位到的日报事实：

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run daily-fact:backfill -- \
  --start 2026-07-01 --end 2026-07-12
```

普通回填不修复已存在事实的组织快照；它遵守“正常同步冻结匹配快照”的规则。只有在完成只读审计、确认范围并取得单独批准后，才可显式执行纠正写入：

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm run daily-fact:backfill -- \
  --start 2026-07-01 --end 2026-07-12 --repair-organization
```

`--repair-organization` 是一次性的显式纠正开关，会把匹配到的通讯录组织值写回历史事实；不能放入任何循环、定时任务、服务启动命令或其他 recurring scheduler。修复前先运行不带该开关的只读审计流程，修复后再运行不带该开关的回填以检查幂等性。任何新调度在受控验证完成并取得单独批准前都必须保持禁用。

联系人中的空人员字段不表示解绑指令。正常同步和 `--repair-organization` 都遵循“无依据不清空历史人员归属”：通讯录没有填写`直属上级`时，已有日报事实中的值不会被自动清空。如确需解绑，必须由人工明确清空对应事实字段并完成确认。

## 启用步骤

1. 按 catalog 建好或扩展九张 Base 表和字段。
2. 在 URL 或多维表格 API 中确认每张表的 `tableId`，或直接复制带 `table` 参数的 wiki 链接。
3. 更新当前环境配置文件中的九个表配置块。
4. 保持所有日报/周报调度为 `false`，先执行 `npm run tables:validate`。
5. 只读校验通过后，再按计划执行受控回填和周报 dry-run。
6. 受控验证完成并取得单独批准后，才设置对应调度为 `true` 并重启机器人服务。
