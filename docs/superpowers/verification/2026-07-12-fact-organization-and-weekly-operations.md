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

## 2026-07-17 通讯录映射纠正

- 发现个人环境原 `contactTable` 指向另一张仅有 4 个字段的旧通讯录；已改为日报 Base 内的完整团队通讯录。
- 新通讯录共读取 `52` 条记录，其中 `51` 条包含成员数据；真实姓名、敏捷小组和直属上级字段均可用。
- 按最新业务口径，日报链路只保留`直属上级`作为日报汇报人；个人配置已显式停用`分管领导`映射。
- 回放范围为 `2026-07-13` 至 `2026-07-17`。读取群消息 `67` 条，均已存在于原始表；事实修复 `updated 129`、`errors 0`。
- 最终事实共 `85` 条，全部为`有效`，姓名和直属上级空值均为 `0`；同一日期内人数与唯一姓名数一致。
- 来源分布为表单 `48`、群聊 `28`、表单与群聊合并 `9`。敏捷小组空值 `38` 条，保持“无依据不生成”，待通讯录维护后再修复。
- 批量转发遗漏的根因是消息并发写同一 Base 触发瞬时冲突，同时旧逻辑错误地按代发账号覆盖标题姓名；当前实现改为消息串行队列、瞬时错误重试和标题姓名优先匹配，并提供幂等历史回放命令。
- 同一成员、日期、渠道的多次提交在事实同步前按来源时间只选最新版本。最终普通复跑结果为 `created 0`、`updated 0`、`unchanged 77`、`errors 0`。
- 个人测试配置已启用 `dailyFactSync`，每天 `18:10` 回看最近 `7` 天；该开关不影响正式组织配置。
- 本地完整测试 `234/234` 通过。

## 最终发布与部署记录

- 发布提交 `f01967e` 已推送至 GitHub 和 Gitee；服务器已从 GitHub 快进至该提交，`npm ci` 成功。
- 本地和服务器完整测试均为 `225/225` 通过。
- PM2 服务已重启并处于 `online`，`unstable restarts 0`；启动日志确认事件分发器就绪且 WS 客户端已启动。
- `weeklySheet`、`weeklyInstanceCreation`、`dailySupervisorPush`、`dailyFactSync` 均保持 `false`；既有 `weeklyPush` 保持 `true`，这是有意配置。
- 普通 `weekly:ensure` 以 `weekly_sheet_disabled` 跳过，符合预期。
- 一次性内存启用验证未修改配置，复用既有 `2026-W29` 实例，并确认工作簿非空、SheetID 存在及报告周期语义目标可用。
- 最终独立复审结论：`CLEAN FOR COMMIT AND DEPLOY`。
