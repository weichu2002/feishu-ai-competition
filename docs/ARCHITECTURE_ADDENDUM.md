# FlowMate 架构补编

本文档是对主架构蓝图的补充，不替代 [ARCHITECTURE.md](/E:/feishu-ai-competition/flowmate/docs/ARCHITECTURE.md:1)。

适用场景：

- 在不删除旧蓝图内容的前提下补充新方向
- 记录 V2 产品扩展与自动化入口修正
- 作为后续“重点事项推进总表”路线的正式依据

---

## A. 向上扩展：重点事项推进总表（V2）

在保留“个人承诺闭环”定位的前提下，FlowMate 可以向上扩展为一个“重点事项推进总表”系统。

这个扩展方向不替代原来的 FlowMate 定位，而是在原定位之上增加一层聚合与推进能力。

### A.1 扩展目标

FlowMate V2 目标是：

- 周期性地从多个飞书来源识别重点事项与 Todo
- 自动汇总到统一总表
- 补齐负责人、优先级、截止时间、来源背景
- 持续同步任务状态、最新进展与阻塞原因
- 对临期、逾期、阻塞事项做预警

### A.2 目标来源

V2 可逐步接入以下来源：

- 飞书消息
- 飞书文档正文
- 飞书文档评论
- 飞书会议纪要
- 飞书任务
- 飞书日历事件

其中第一优先级仍然是：

- 飞书消息
- 会议纪要
- 文档评论

### A.3 与官方智能伙伴的差异

FlowMate 不与官方智能伙伴竞争“通用助手能力”。

FlowMate 的差异点必须收敛到：

- 承诺 / Todo 识别
- 统一账本
- 去重与关联
- 证据链
- 状态回写
- 定时预警
- 复盘视角

也就是说：

- 官方智能伙伴负责“广”
- FlowMate 负责“深”

### A.4 V2 的正式数据中心

V2 仍然坚持：

- 飞书多维表格 = 唯一正式主账本

只是主账本从“承诺账本”逐步扩展为：

- 个人承诺账本
- 团队重点事项推进总表

第一阶段先不推翻当前表，而是在现有“承诺账本”跑通技术路线后，再升级到团队总表。

### A.5 V2 的关键难点

以下能力可以做，但不能吹成“天然就全自动”：

- 团队重点事项自动判断
- 负责人自动补齐到真实飞书用户
- 背景链接自动补齐且保持准确
- 多来源状态持续同步且不打架

要把这几项做稳，必须补足：

- 数据模型
- 去重规则
- 来源优先级
- 增量同步机制
- 更稳的用户映射

### A.6 V2 的产品结论

FlowMate 可以升级成“重点事项推进总表”系统，但必须建立在以下能力之上：

- 多来源扫描
- 统一总表
- 去重关联
- 状态回写
- 定时预警

这属于 V2 / V3 的扩展方向，不覆盖当前 V1 个人消息扫描主链路。

### A.7 V2 第一阶段已落地实现边界

团队级能力第一阶段按“固定来源、独立状态、独立总表”的方式实现，不接管个人监听链路。

已落地模块：

- `src/team-monitor.js`
  - 团队固定来源配置
  - 团队多维表格总表创建 / 复用
  - 团队视图与团队驾驶舱创建
  - 固定群聊扫描
  - 固定文档抽取入口
  - 会议纪要搜索抽取入口
  - 团队事项状态回写
  - 临期 / 逾期 / 阻塞预警
- `scripts/team-entry.js`
  - `team:status`
  - `team:ensure`
  - `team:scan`
  - `team:warn`
  - `team:sync-status`
- `scripts/watch-team-sources.js`
  - 周期性团队固定来源扫描
  - 周期性团队预警

团队总表固定为：

- 表名：`FlowMate_团队重点事项推进总表`
- 状态文件：`openclaw-state/workspace/state/flowmate-team-config.json`
- 扫描状态：`openclaw-state/workspace/state/flowmate-team-scan-state.json`
- 最近团队操作：`openclaw-state/workspace/state/flowmate-team-last-operation.json`

团队级能力必须遵守：

- 不默认扫描所有团队成员和所有群聊
- 只扫描显式配置的固定来源
- 团队扫描不得覆盖个人 `flowmate-last-operation.json`
- 团队扫描必须跳过 Bot 自己的回执和系统消息
- 团队对象读写仍走 `lark-cli`
- 飞书 Bot 对话入口仍只能走 `openclaw-lark`

当前已真实验证：

- 团队总表、视图、驾驶舱可由 `lark-cli` 创建 / 复用
- 固定聊天来源扫描可以读取真实飞书消息并写入团队总表
- 已用真实临时团队群验证固定群聊来源扫描；临时群只包含用户本人和 FlowMate Bot，没有拉入其他成员
- 团队扫描会跳过 Bot 回执，避免“Bot 自己的话又被当成承诺”
- 团队总表记录可以更新为完成
- 团队记录删除会同步清理多维表格、飞书任务、飞书日程
- 团队预警和团队状态回写命令可执行

验证清理要求：

- 临时验证数据必须从团队总表删除
- 对应飞书任务和飞书日程必须同步删除
- 个人承诺账本不得混入团队验证记录

---

## B. 自动化入口修正：从 Bot 被动接收改为用户身份增量扫描

FlowMate 之前默认假设自动化入口是：

- Bot 收到用户发来的消息

这个入口只适合：

- 私聊 Bot
- 用户显式 @Bot
- Bot 已在场的会话

它不适合作为“我发出的消息自动被识别”的唯一正式链路。

### B.1 修正后的结论

FlowMate 的自动化入口应拆成两类：

但这只是在“自动化入口”层面拆分，不改变主架构中的硬边界：

- `openclaw-lark` 仍然是 FlowMate 唯一正式飞书 Bot 通道
- `openclaw-main/extensions/feishu` 不得接管 FlowMate 的正式飞书会话
- `lark-cli` 可以负责用户身份消息搜索与对象读写，但不能替代 Bot 对话入口

#### B.1.1 被动事件入口

由 `openclaw-lark` 负责：

- 私聊 Bot
- 群里 @Bot
- 明确触发的消息处理

这个入口仍然保留，用于：

- 交互式提取
- 交互式同步
- 交互式查询

#### B.1.2 主动增量扫描入口

由 `FlowMate + lark-cli` 负责：

- 以用户身份读取最近发出的消息
- 定时增量扫描
- 只处理新增消息
- 自动识别是否存在承诺 / Todo
- 自动写入飞书账本

这个入口才是“自动记录我发出的消息”的正式实现方式。

### B.2 第一阶段正式链路

V1 扫描链路定为：

`lark-cli 以 user 身份搜索最近我发出的消息`
-> `FlowMate 只取新增消息`
-> `FlowMate 规则筛选`
-> `FlowMate 上下文抽取`
-> `lark-cli 写入承诺账本`
-> `lark-cli 创建任务 / 日历`

它不是“实时偷听”，而是：

- 近实时增量扫描

第一阶段默认目标：

- 每 1 分钟扫描一次

### B.3 为什么这条链成立

根据当前本地项目结构，`openclaw-lark` 已具备“以用户身份读取消息”的工具基础，`lark-cli` 也具备消息历史与搜索能力。

FlowMate 后续不应再把“Bot 被动接收消息事件”视为唯一自动化入口，而应把：

- 用户身份消息扫描

作为正式自动化主链路。

### B.4 第一阶段边界

第一阶段只做：

- 扫描当前用户本人发出的消息
- 支持群聊 / 单聊可见范围内的消息
- 增量识别承诺
- 自动写入个人承诺账本
- 自动创建个人任务 / 日历提醒

第一阶段不做：

- 扫描团队所有成员发言
- 全企业范围消息回溯
- 文档 / 评论 / 会议纪要全量统一扫描
- 团队总表自动分发

### B.5 后续升级方向

当“个人发出消息增量扫描”路线跑通后，再逐步升级到：

- 固定团队群聊扫描
- 固定会议纪要扫描
- 固定文档评论扫描
- 统一写入团队重点事项推进总表
- 自动将任务分发到个人

也就是说，正式升级顺序是：

1. 个人消息扫描
2. 固定来源扫描
3. 团队总表聚合
4. 自动分发与预警

---

## C. 2026-05-01 团队来源管理闭环补充

本次补充只扩展团队固定来源的管理闭环，不改变底层架构边界：

- `openclaw-lark` 仍然只作为飞书 Bot 通信层。
- `lark-cli` 仍然是飞书对象读写执行层。
- `FlowMate` 仍然是业务编排层。
- 未登记群聊的普通消息仍然不得进入 Agent 对话链路。

新增闭环：

- 在群里 `@FlowMate 加入团队扫描`：受信用户可以把当前群加入团队固定来源。
- 在群里 `@FlowMate 移除团队扫描`：受信用户可以把当前群从团队固定来源移除。
- 在群里 `@FlowMate 团队来源列表`：受信用户可以查询当前团队固定来源。

安全边界：

- 只有 `openclaw.json` 中 `channels.feishu.allowFrom` 的受信用户可以触发这些团队来源管理命令。
- 必须真实 @Bot；未 @Bot 的群消息不触发。
- 只放行精确的团队来源管理命令，不放开未登记群聊的普通问答或自动处理。
- 该通道只解决“还没加入来源前无法在群里执行加入命令”的自举问题，不替代群白名单策略。

真实验证：

- 已在真实临时飞书群 `oc_cbb7645fd3727e08b4404708b166482d` 验证 `@Bot 加入团队扫描`，Bot 回复成功，团队来源配置新增该群。
- 已验证 `@Bot 移除团队扫描`，Bot 回复成功，团队来源配置恢复为空。
- 已验证 `@Bot 团队来源列表`，Bot 回复“当前还没有配置团队固定来源”。
- 已重新运行 `npm run self-test:core`，个人承诺提取、多维表格写入、任务/日历创建更新删除、上下文持久化、延期、完成、撤销清理均通过。
- 已用真实飞书私聊验证非预设模型问答链路，Bot 对普通问题正常生成回答。

---

## D. 2026-05-01 团队 V2.1 闭环补充

本次补充继续遵守主架构边界：

- `openclaw-lark` 仍是唯一正式飞书 Bot 通信层。
- `lark-cli` 仍是飞书对象读写执行层。
- FlowMate 只负责承诺识别、owner 解析、去重、同步编排和回归验证。
- 团队能力不得污染个人承诺账本和个人最近操作状态。

新增能力：

- 团队成员映射：
  - `team:member-add`
  - `team:member-list`
  - `team:member-remove`
  - 团队扫描时优先用成员映射将负责人名称 / alias 解析到 OpenID。
- 团队多人闭环：
  - 承诺写入团队总表。
  - 根据负责人 OpenID 创建 / 更新任务。
  - 有明确负责人 OpenID 时发送个人通知。
  - 无法解析负责人时保留记录，但负责人 OpenID 为空，后续需要人工确认或补映射。
- 跨来源去重：
  - 团队记录新增 `去重指纹`、`来源集合`、`最近同步时间` 等字段。
  - 同一来源消息 ID 或同一 owner/title/deadline 指纹重复出现时，更新同一条记录，不重复创建任务和日历。
- 团队驾驶舱指标：
  - 新增指标表 `FlowMate_团队驾驶舱指标`。
  - 当前写入指标包括：本周新增、待完成、临期 24 小时、逾期、阻塞、本周到期、按负责人待完成 / 逾期 / 阻塞。
  - 入口：`team:dashboard`。
- 文档 / 评论 / 会议纪要固定来源：
  - 文档来源优先读取 `docs +fetch` 的正文 markdown，避免 token、log_id 等 metadata 污染承诺标题。
  - 文档评论来源使用 `drive file.comments list`。
  - 会议纪要来源使用 `minutes +search`。
  - 文档、评论、纪要来源均记录内容指纹，内容未变化时跳过重复同步。
- 回归测试矩阵：
  - 新增 `npm run self-test:regression`。
  - 覆盖 lark-cli 授权 / 对象层、个人监听状态、模型问答清洗、个人账本/任务/日历核心闭环、团队表/视图/驾驶舱、团队成员/来源命令、团队状态同步、团队预警。
  - 可加 `-- --live-feishu` 执行 openclaw-lark 入站仿真，验证正式通信层没有被破坏。

本次真实验证：

- `npm run self-test:regression -- --live-feishu` 通过。
- 个人核心闭环通过：承诺提取、多维表格写入、任务/日历创建更新删除、上下文持久化、延期、完成、撤销清理。
- openclaw-lark 入站仿真通过，日志显示 `flowmate p2p message handled`。
- 团队成员映射已验证：`张艺航 -> ou_f6a2032768953df1c08ea6b4b2d7b306`。
- 团队作用域直接同步已验证：`operation-scope=team` 会写入团队总表 `tbl8wopBGLuEENlO`，不再误写个人表。
- 团队去重已验证：同一测试承诺重复同步时命中同一条记录，不重复创建任务 / 日历。
- 团队删除清理已验证：团队测试记录删除时同步清理团队总表记录、飞书任务和飞书日程。
- 文档来源真实验证通过：创建临时飞书文档 -> 加入团队固定来源 -> 扫描 -> 写入团队表 -> 创建任务 / 日历 -> 发送负责人通知 -> 删除记录 / 任务 / 日历 -> 移除来源 -> 删除临时文档。
- 文档评论来源真实验证通过：创建临时飞书文档 -> 添加评论 -> 加入 `document-comments` 来源 -> 扫描评论 -> 写入团队表 -> 创建任务 / 日历 -> 发送负责人通知 -> 删除记录 / 任务 / 日历 -> 移除来源 -> 删除临时文档。
- 会议纪要来源已完成 `minutes +search` 冒烟验证：可加入固定来源、执行扫描、无新增承诺时不写入团队表，并可移除来源；由于当前没有构造真实会议纪要承诺样本，纪要“写入任务/日历”的端到端数据验证留待有实际纪要后补测。

本次踩坑记录：

- 不能只依赖团队扫描器里的环境变量覆盖表 ID；`assistant-entry` 在 `operation-scope=team` 时也必须自己切到团队总表，否则直接调用团队作用域会误写个人表。
- 文档正文不能用通用 JSON 文本抽取，否则会把 token、log_id、message 等 metadata 混入承诺标题；必须优先取 `data.markdown` / `data.content` / `data.text`。
- 提取入口不能先把全文换行压成一行，否则 markdown 标题、正文、说话人会被拼接，影响 owner 和标题解析。
- Windows PowerShell 直接给 `drive +add-comment --content` 传中文 JSON 时可能出现编码/转义问题；自动化验证应通过 Node `spawnSync` 参数数组调用，避免 shell 把 JSON 或中文内容破坏。

---

## E. 2026-05-02 比赛闭环补齐

本轮目标是补齐比赛叙事中需要的“主动分发、精准问答、长期运行、效果验证”闭环，同时不改变主架构边界。

新增闭环：

- 长期运行闭环：
  - 新增 `scripts/flowmate-service.js`。
  - 新增命令：`service:start`、`service:stop`、`service:status`、`service:health`、`service:install-autostart`、`service:uninstall-autostart`。
  - 管理范围：OpenClaw Gateway、个人 watcher、团队 watcher。
  - `service:start` 会优先接管已有 watcher 状态，避免重复启动个人监听进程。
  - Windows 计划任务权限不足时，会 fallback 到当前用户 Startup 文件夹启动脚本。
- 团队 watcher 闭环：
  - `watch:team` 默认周期扫描团队固定来源。
  - 每轮自动执行团队状态同步、预警计算、负责人提醒。
  - 可选执行团队日/周摘要推送。
- 主动推送闭环：
  - 新增 `team:digest`。
  - 生成团队日/周推进摘要，包括待完成、逾期、临期、阻塞、按负责人待完成、下一批建议关注。
  - 可用 `--notify true` 推送给默认告警用户。
- 知识问答闭环：
  - 新增 `team:qa` / `team-knowledge-qa`。
  - 基于团队总表中的标题、负责人、原文、上下文、来源链接做证据检索。
  - 回答必须附证据来源；没有证据时明确拒绝编造。
- 负责人确认 / 重分派闭环：
  - 新增 `team:unassigned`。
  - 新增 `team:reassign`。
  - 支持将待确认或识别错误的负责人补充成员映射后重分派，并同步任务与负责人通知。
- 会议纪要端到端验证闭环：
  - 回归矩阵中新增 synthetic Minutes Action Item 测试。
  - 验证路径：会议纪要文本 -> 团队总表 -> 任务 -> 日历 -> 清理。
  - 真实 `minutes +search` 来源仍保留，等待实际纪要样本继续验证。
- 效果评测闭环：
  - `self-test:regression -- --live-feishu` 扩展到 18 项验证。
  - 新增验证项：待确认负责人重分派、会议纪要 Action Item 落表、团队主动摘要、团队知识问答证据引用、服务状态命令。

本次真实验证：

- `npm run self-test:regression -- --live-feishu` 通过，验证项共 18 项。
- 服务状态通过：
  - Gateway 18789 正在监听。
  - 个人 watcher alive / running。
  - 团队 watcher alive / running。
- 登录自启动已安装为当前用户 Startup 脚本：`FlowMateServices.cmd`。
- 团队总表验证后为空，测试记录、任务、日历已清理。
- 团队成员映射仍为 1 个：当前用户本人。
- 当前团队固定来源为 0 个；后续真实团队演示前需要显式加入群聊、文档或纪要来源。

仍需真实环境补测的边界：

- 真实多人：当前由于不能邀请其他成员进群，已按“分发给当前用户”验证负责人通知链路。后续可加 2-3 个真实成员映射后复测。
- 真实会议纪要：当前已验证纪要文本端到端和 `minutes +search` 冒烟；真实会议妙记中含 Action Item 的样本仍需补测。
- 开机自启动：已有服务管理脚本，但还未写入 Windows 计划任务或系统服务。

---

## F. 2026-05-02 Dashboard 与事件回写补齐

本节继续遵守主架构边界：
- `openclaw-lark` 只负责正式飞书 Bot 通信入口。
- `lark-cli` 负责飞书对象读写与订阅动作。
- FlowMate 只做业务编排、状态协调、验证脚本和回归矩阵。

### F.1 多维表格可视化驾驶舱

之前的“驾驶舱”只有指标表、视图和摘要文本，不是完整图表化 dashboard。本次补齐为飞书多维表格 Dashboard Block：

- 入口命令：`npm run team:ensure` / `npm run team:dashboard`
- Dashboard：`FlowMate 团队推进驾驶舱`
- Dashboard ID：`blk7miUrUi3BxhDo`
- 已创建并幂等更新的 block：
  - `FlowMate 总览说明`
  - `全部团队事项`
  - `待完成事项`
  - `状态分布`
  - `负责人工作量`
  - `来源类型分布`
  - `阻塞风险`

验证结果：
- `npm run team:ensure` 已真实创建 7 个 dashboard block。
- `npm run team:dashboard` 已验证第二次执行为幂等更新，7 个 block 均为 `existed: true, updated: true`，不会重复创建。

### F.2 任务事件订阅与状态回写边界

本次新增飞书任务事件订阅入口：

- 入口命令：`npm run team:subscribe-events`
- 本地状态：`openclaw-state/workspace/state/flowmate-team-event-subscription.json`
- 已验证返回：`subscription.data.ok = true`

当前真实边界必须说清楚：
- 已完成：通过 `lark-cli task +subscribe-event --as user` 完成任务事件订阅，并把订阅状态写入 FlowMate state。
- 已保留：`watch:team` 继续周期执行状态对账，作为事件未送达或网关未接入事件回调时的兜底。
- 未夸大：当前没有证明 openclaw-lark 已经把 Feishu Task 事件实时推送到 FlowMate 业务处理器；所以现阶段应描述为“事件订阅 + 周期对账兜底”，不能宣传成完全实时事件驱动。

### F.3 真实固定来源验证

新增可复用真实验证脚本：

- `npm run self-test:real-doc-source`

验证流程：
- 创建临时飞书文档。
- 将临时文档加入团队固定来源。
- 执行团队扫描。
- 写入团队总表。
- 创建任务 / 日历。
- 刷新 dashboard。
- 删除团队记录，并同步清理任务 / 日历。
- 移除固定来源。
- 删除临时飞书文档。

本次真实结果：
- 临时文档 token：`K3R6dUwqmorvvRxyLZSc2DD0nNc`
- 同步事项：`syncedCount = 1`
- Dashboard block：`dashboardBlockCount = 7`
- 清理后团队固定来源：`0`
- 清理后团队总表记录：`0`
- 服务健康：`healthy = true`

回归矩阵已同步补强：
- `team table/views/dashboard` 会断言 dashboard block 数量不少于 7。
- `team dashboard metrics and visual blocks` 会断言指标和可视化 block 同时刷新成功。
- `team task event subscription` 会断言飞书任务事件订阅返回 `ok`。
- 最新 `npm run self-test:regression -- --live-feishu` 已通过，验证项共 18 项。

### F.4 真实 Minutes 验证策略

真实飞书妙记不能用普通文档完全冒充。当前 `lark-cli minutes` 支持：

- `minutes +search`：搜索已有妙记。
- `minutes +upload`：上传 Drive 中的音/视频文件 token 后生成妙记。
- `vc +notes`：通过 meeting-id、minute-token、calendar-event-id 查询会议 notes。

因此真实 Minutes 的落地验证有两条合规路径：

- 路径一：用真实会议产生一条妙记，再用 `minutes +search` / `vc +notes` 进入 FlowMate 扫描链路。
- 路径二：先用 `drive +upload` 上传一段测试音频/视频，再用 `minutes +upload` 生成妙记，然后用固定 minutes source 扫描。

当前已完成：
- synthetic Minutes 文本端到端：纪要文本 -> 团队总表 -> 任务 -> 日历 -> 清理。
- `minutes +search` 接入冒烟：可配置、可扫描、无承诺时不误写。

仍未完成：
- 用真实 Feishu Minutes 对象中含 Action Item 的样本跑完整端到端。

---

## G. 2026-05-04 本地网页控制台与比赛定位

### G.1 本地控制台

开机自启动从“弹出命令行窗口执行 npm”升级为本地网页控制台：

- 入口脚本：`scripts/flowmate-control-panel.js`
- 运行命令：`npm run service:panel`
- 默认地址：`http://127.0.0.1:18888/`
- 自启动命令：`npm run service:install-autostart`

控制台提供：

- 一键启动 Gateway、个人 watcher、团队 watcher。
- 一键停止服务。
- 健康检查与状态展示。
- 刷新团队驾驶舱。
- 订阅任务事件。
- 真实文档固定来源端到端验证。
- 完整 live 回归验证。

Windows 自启动策略：

- 优先尝试写入 Windows 计划任务。
- 如果权限不足，回退到当前用户 Startup 文件夹。
- Startup 回退不再写入会弹窗的 `.cmd`，而是写入隐藏执行的 `FlowMateServices.vbs`。
- 当前启动脚本路径：`C:\Users\zyh\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\FlowMateServices.vbs`

本次验证：

- `npm run service:health` 通过，Gateway、个人 watcher、团队 watcher 均健康。
- `http://127.0.0.1:18888/api/status` 返回 `ok: true`。
- 控制台“一键启动” API 已验证，任务返回 `completed`，服务状态保持 running。

### G.2 比赛作品定位

FlowMate 当前更适合按“方向 D：团队待办中枢与进展自动对账”作为主线参赛，同时把“方向 A：周期性智能总结与洞察”和“方向 B：会议与项目全链路伴侣”作为增强叙事。

当前已经具备参赛作品雏形：

- 能从个人消息、团队固定来源、文档、文档评论、纪要文本中识别承诺 / Todo。
- 能写入飞书多维表格团队总表。
- 能创建任务 / 日历。
- 能对负责人做分发通知。
- 能周期同步状态、生成预警、生成团队摘要。
- 能基于团队总表证据做知识问答，并附来源。
- 能用多维表格 dashboard 呈现团队推进状态。
- 有 live 回归矩阵证明核心链路没有只停留在 demo 代码。

仍需在答辩前补强的展示点：

- 真实 Feishu Minutes 对象端到端：真实妙记 -> Action Items -> 团队总表 -> 任务 / 日历 -> 负责人通知。
- 2-3 个真实成员映射验证：当前多人链路按当前用户分发验证，比赛演示最好补真实成员。
- 主动推送最好用飞书卡片形态展示，而不只是文本摘要。
- 精准问答最好准备固定知识源样本和评测用例，展示命中证据、拒答无证据问题、幻觉率控制。
- 效率指标需要准备前后对比，例如人工整理耗时、识别准确率、负责人准确率、去重率、任务创建成功率。

### G.3 真实 Feishu Minutes 验证补充

2026-05-04 已补齐真实妙记读取授权并完成验证：

- 新增授权 scopes：
  - `minutes:minutes:readonly`
  - `minutes:minutes.artifacts:read`
  - `minutes:minutes.transcript:export`
- 已验证 `minutes +search` 可以搜索到会议发起者不是当前用户的真实飞书妙记。
- 已验证 `vc +notes --minute-tokens <token>` 可以读取真实妙记 artifacts，包括 summary、chapters、todos 和 transcript 文件。
- FlowMate 的 `minutes` 固定来源扫描已升级：
  - 优先从 `vc +notes` 读取真实妙记正文。
  - 若 artifacts 中存在 `todos`，只把 `todos` 作为 Action Item 输入，避免把长篇分享正文误判为大量承诺。
  - 若没有 `todos`，再退回摘要 / 章节摘要。
  - 长文本通过临时文件传给 `assistant-entry`，避免 Windows 命令行长度限制。

真实验证样本：

- 妙记标题：`飞书 AI 校园竞赛-主题分享直播-产品专场`
- minute token：`obcnb2q4nap98l5ny5as2n11`
- 识别出的真实 todo：
  - `通过 Web coding 生成个性化页面并发送产品发布会信息链接`
  - 负责人：`吴星辉`
- 验证链路：
  - `minutes +search` 找到真实妙记。
  - `vc +notes` 拉取真实妙记待办。
  - FlowMate 写入团队总表。
  - FlowMate 创建飞书任务。
  - `team:qa` 基于团队总表证据回答“吴星辉要做什么”。
  - 删除测试记录并同步清理任务。
  - 移除临时 minutes 固定来源。

清理状态：

- 团队固定来源：`0`
- 团队总表记录：`0`
- 服务健康：`healthy = true`

踩坑记录：

- 不应把真实妙记 transcript 全文直接作为 Action Item 抽取输入，否则模型会把讲座内容误判为大量事项。
- 妙记 source 的产品策略应是：`todos 优先`，没有 `todos` 时才进入摘要级提取。
- 长文本不得通过命令行参数传递，必须走临时文件或 stdin，否则 Windows 会触发 `ENAMETOOLONG`。
