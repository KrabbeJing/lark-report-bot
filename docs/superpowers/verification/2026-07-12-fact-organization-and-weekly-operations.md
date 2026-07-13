# 事实组织与周报运维验证记录

## 验证结论

- 本地 `npm test`：`186/186` 通过。
- 服务器 `npm test`：`186/186` 通过。
- GitHub、Gitee 推送成功；服务器已从 GitHub 快进到提交 `b3c398e`。

## 修复前只读审计

- 修复前已执行只读审计，并在取得用户批准前汇报结果。
- `matched 9`、`unmatched 0`。
- `real_name mismatch 0`、`agile_group mismatch 9`、`supervisor mismatch 2`、`divisional_leader mismatch 6`。

## 日报事实修复

- 范围：`2026-07-01` 至 `2026-07-12`（含首尾）。
- 使用显式命令开关：`--repair-organization`。
- 退出码：`0`。
- 结果：`created 2`、`updated 57`、`filtered 1315`、`errors 0`。

## 普通复跑与只读审计

- 普通复跑最终结果：`created 0`、`updated 58`、`errors 1`。
- 失败原因为飞书接口 `ECONNRESET`，记录为一次外部瞬时网络异常；本轮不记为完整成功。
- 事后只读审计：`factCount 11`、`duplicateFactKeyCount 0`、`unmatched 0`。
- 最终状态为有效 `10` 条、忽略 `1` 条。
- 姓名、敏捷组、直属上级 mismatch 均为 `0`。

### Ignored-preserved 说明

- 验证日期为 `2026-07-13`；范围内只读复核结果为 `ignoredCount 1`、`syncedOnVerificationDate 1`、`modifiedOnVerificationDate 1`。
- 因此，该 `1` 条忽略事实确实被本次自动流程同步并修改过；结合自动流程无法新造`忽略`状态，可证明该记录经过流程后仍保留为`忽略`。
- 写入逻辑只会在既有事实状态已经为`忽略`时继续写入`忽略`；自动流程不会新造`忽略`状态。
- 修复前审计虽未单独列出事实状态分布，但本次同步时间与最后修改时间提供了该记录直接经过流程的证据。

## 通讯录数据缺口

- 通讯录共 `49` 条，但分管领导字段填充数为 `0`。
- 事实范围内保留 `6` 条历史分管领导值，遵循“无依据不清空”原则。
- 分管领导字段属于待补数据缺口，不能据此宣称通讯录组织信息已完整。
- 这是有意的修复策略：即使使用 `--repair-organization`，匹配联系人中的空分管领导也不会自动清空历史人员归属。重新执行修复前必须先补齐通讯录分管领导；确需解绑时由人工明确清空事实并确认。

## 周报实例

- 周报标题：`数字金融部周报0717`。
- 首次执行创建实例，二次执行复用；同名工作表共 `1` 个。
- 工作表位置为 `index 0`。
- 报告周期正确：`2026-07-13` 至 `2026-07-17`。
- 周报链接包含复制出的 SheetID，可直接定位工作表；Base 实例记录已复用。

## 异常通知与调度边界

- 真实运维异常通知命中 `1` 条，包含 `task`、`scope`、`stage` 和 `failure count`。
- 通知中未检测到完整 ID、token、secret 或原始日报内容。
- `weeklyInstanceCreation`、`dailySupervisorPush`、`dailyFactSync`、`weeklySheet` 等新增调度/能力开关仍关闭；本记录不宣称已启用生产调度。

## 运行态部署

- 2026-07-13 主会话执行 `pm2 restart lark-bot-git` 成功。
- 随后 `describe` 显示 `online`，`unstable restarts 0`。
- 当前启动日志显示 `event-dispatch ready`、`WSClient started`。
- 当前运行配置明确显示 `weekly instance creation`、`daily supervisor push`、`daily fact sync` 均为 `disabled`；`weeklySheet.enabled=false`。
- PM2 已载入 `b3c398e` 的运行代码。
- 最终验证文档提交属于文档更新，主会话稍后再推送并让服务器快进。

## 安全边界

本文不写入姓名、OpenID、ChatID、AppID/AppSecret、Base/table/view/sheet/wiki token、完整飞书链接或日报正文。
