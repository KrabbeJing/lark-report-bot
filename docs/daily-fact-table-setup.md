# 日报数据层表格配置清单

## 需要手动新增的数据表

在现有日报多维表格 Base 内新增：

1. `群聊日报原始表`
2. `日报统一事实表`

机器人不会自动建表或建字段。

## 群聊日报原始表字段

- 消息ID：文本
- 群ID：文本
- 群名称：文本
- 发送人OpenID：文本
- 标题姓名：文本
- 日报日期范围：文本
- 拆分日期列表：文本
- 原始消息文本：长文本
- 解析后工作总结：长文本
- 内容指纹：文本
- 消息时间：文本或日期时间
- 接收时间：文本或日期时间
- 解析状态：单选或文本
- 原始记录状态：单选或文本

## 日报统一事实表字段

- 事实唯一键：文本
- 日报日期：日期
- 实际日报提交人：人员
- 日报提交人姓名：文本
- 成员OpenID：文本
- 发送人OpenID：文本
- 群ID：文本
- 所属板块：文本
- 敏捷小组：文本
- 直属上级：人员或文本
- 分管领导：人员或文本
- 原文：长文本
- 今日工作总结：长文本
- 明日工作计划：长文本
- 遇到的问题：长文本
- 内容指纹：文本
- 日报来源：单选或文本
- 来源记录ID：文本
- 来源消息ID：文本
- 来源组合：长文本
- 日报类型：单选或文本
- 日期覆盖范围：文本
- 消息时间：文本或日期时间
- 来源时间：文本或日期时间
- 有效来源：单选或文本
- 自动处理说明：长文本
- 匹配方式：单选或文本
- 匹配状态：单选或文本
- 合并状态：单选或文本，选项为 `单来源`、`重复已合并`、`按时间取最新`
- 冲突状态：单选或文本，选项为 `无冲突`、`已自动处理`
- 事实记录状态：单选或文本，选项为 `有效`、`待人工确认`、`忽略`
- 同步时间：文本或日期时间

## 团队通讯录建议补充字段

- 成员真实姓名：文本
- 成员别名：长文本
- 当前OpenID：文本，机器人后续可回填
- 历史OpenID/历史账号说明：长文本
- 账号类型：单选或文本
- 成员状态：单选或文本
- 敏捷小组：文本
- 直属上级：人员或文本
- 分管领导：人员或文本

`直属上级`表示组织架构中的直接汇报关系；`分管领导`表示成员当前工作的业务板块归属。两者可以是不同人员，必须独立维护。日报事实归属、三个分管领导群和按领导生成的周报使用`分管领导`；直属上级提醒或组织管理功能使用`直属上级`。周报负责人、指标负责人和月报章节负责人仍在各自配置表中单独维护。

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
| 群聊与表单内容不一致 | `按时间取最新` | `已自动处理` | `有效` |
| 无法匹配成员 | `单来源` | `无冲突` | `待人工确认` |

迁移时先新增`按时间取最新`和`已自动处理`选项，再按来源时间重新计算现有`内容冲突`记录。确认旧记录已经处理后，才删除旧单选值，不能直接把所有旧`内容冲突`重命名为`已自动处理`。

## 个人组织与正式组织配置

建议保留两套配置文件：

- `config/groups.personal.json`：个人组织沙盒测试。
- `config/groups.formal.example.json`：正式组织迁移模板，默认禁用。

启动时通过 `GROUPS_CONFIG_PATH` 切换：

```bash
GROUPS_CONFIG_PATH=config/groups.personal.json npm start
```

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

也可以通过环境变量配置，多个 ID 用英文逗号分隔：

```bash
ERROR_REPORT_OPEN_IDS=ou_xxx,ou_yyy
ERROR_REPORT_CHAT_IDS=oc_xxx
```

## 启用步骤

1. 建好两张新表和字段。
2. 在 URL 或多维表格 API 中确认新表 `tableId`，或直接复制带 `table` 参数的 wiki 链接。
3. 更新当前环境配置文件的 `chatDailyRawTable` 和 `dailyFactTable`。
4. 保持 `dailyFactSync.enabled=false`，先用群聊日报手动测试实时链路。
5. 测试通过后设置 `dailyFactSync.enabled=true`。
6. 重启机器人服务。
