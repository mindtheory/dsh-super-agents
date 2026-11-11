# 002 架构（Architecture）

本文给出两层内容：**参考架构**——官方原型 dsh-superagent 的分层与机制（值得任何自主
agent 系统借鉴的完整形态）；**本项目架构**——dsh-super-agents 在 DSH 插件约束下的落地形态，
以及每个裁剪的决定与理由。承接 [000 理念](000-philosophy.md)、[001 领域](001-domain.md)。

---

## 第一部分：参考架构（原型 dsh-superagent）

### 分层与依赖方向

```
core      纯领域层：Engine + 五个部件（Intake/Evals/Tickets/Assignments/Replies）
          规则：不 import 自身以外的任何东西（唯一例外 node:crypto），不做 I/O
app       组合根与适配层：Runtime（composition root，不含领域规则）、Store、Effects、
          Sessions、Settings、Prompts、Outbox、Passes、HTTP 路由、工具面
executor  DshExecutor（实现 core 的 Executor 端口）+ background（jobs/subagents 管理）
sources   SourceKind 插件协议 + GitHub/飞书实现（不 import app 层）
infra     Commands（CLI 传输）、environment（worker shim/git）、HealthBoard、text
client    管理面板（只 import 宿主类型与少量纯值）
```

依赖严格单向：`sources → core`、`app → core`、`executor → core`。core 定义**端口**
（`ports.ts`）：`Repositories`、`Policy`、`SourceScope`、`Assessor`、`Executor`、`Outbox`、
`DomainEvents`——全部由 app 层提供适配器。这就是依赖倒置：领域不知道数据库和会话的存在。

### 六条可移植的架构纪律

1. **单一写者。** Triggers/Threads/Decisions/Tickets/Assignments 只由 Engine 写；Settings 只由
   Settings；effect 行只由 Effects；outbox 回执只由 Outbox；每个健康条目由认领它的唯一部件写。
   写者表贴在读代码的人脸上，冲突与竞态就无处藏身。
2. **命令同步、事务包裹、副作用出事务。** Engine 的每条命令一个 `atomic` 事务；端口方法在事务内
   只 **enqueue**（"each method only queues work"），真正的 I/O 在 commit 之后由持久队列执行。
   回滚不会误杀 worker，崩溃后队列还在。
3. **确定性幂等 id。** `key(...values) = sha256(JSON.stringify(values))`，等输入必等 id。
   ticket/assignment/input/ack/eval/decision 全部派生 id，重放天然安全。
4. **窄接口。** 每个类只收到它需要的 `Pick` 切片；调用方拿到 Engine 的角色切片
   （`EngineForSources` / `EngineForMainSession` / `EngineForPeople` / …）。
5. **命名纪律。** 请求用命令式（`stopTicket`），适配器回报事实用过去式（`assignmentStarted`）。
   拒绝一律 `UserError(code)`，文案与 HTTP 状态码从码派生。
6. **持久副作用队列（Effects）。** SQLite 表上的耐久队列：事务内 `enqueue(kind,key,payload)`，
   同 kind+key 合流（换 payload、generation+1、attempts 清零、保留队列位置）；处理器按 kind
   注册并发限额；失败指数退避；抛 `Later` 表示"不是失败，只是不能现在做"（没槽位/暂停了），
   不计失败；连续 3 次失败才把同名健康条目转 error。

### 执行模型（原型）

一个 Ticket 一个持久 worker 会话一个目录。要点：

- **worker preset**：前台 shell 命令 5 秒转后台 job（长命令不挡住人的消息）；去掉问人/present/
  plan/调度/goals 等工具——无人值守会话不该有"问人"按钮。
- **事件回路**：worker 的 turn 结束（idle）→ 若报告是 ready/提问/blocked/failed 则交接给人；
  否则盯住它的后台 jobs/subagents 至多 30 分钟，超时杀 job 并报 waiting。job 结束会唤醒 worker。
- **瞬时错误自愈**：`agent/error` 命中瞬时正则（ECONNRESET/429/5xx/overloaded…）→ 15s×2^n
  后自动投一条"上一轮因瞬时原因失败，继续"续跑，3 次为止；否则报 failed。
- **崩溃恢复**：启动时把 running 的 Assignment cancel(keepInbox) 后按报告决定重启还是补投输入。
- **worker 槽位**：并发限额；**人的消息可以多用一个超额槽位**（人的跟进优先于新工单启动）。

### 授权模型（原型，值得共享的完整思路）

- **Policy 无状态、有版本**：`policyVersion = hash(规则+accept模式+各Source策略)`。模型/并发等
  运行参数不进版本——只有授权相关的变化才使 Mandate 失效。
- **gate 判定强度**：`explicit`（名单内 + 点名）> `inferred`（准入表格 / bot / 线程跟进）。
  bot 至多 inferred，永不 explicit、永不 stop。
- **Mandate 不可变**：accept 时快照 `{strength, policyVersion, basis, actor, scope}`；
  Policy 变了不撤销 Mandate，只把变化作为 Input 通知运行中的工单；`revalidate` 用存下的
  basis 在新 Policy 下重查。
- **accept mode**：`off`（禁主动）/ `observe`（评估但只记录"本来会接受"，不真开工）/ `auto`
  （规则命中即开工）。**从 observe 开始**是理念"start narrow"的机制化。
- **评估超时与 unavailable**：评估有截止时间；超时/工具故障记 `unavailable`（可重试），
  与 `ignore`（可读但不构成需求）严格分开。

### Source 插件协议（可扩展性的样板）

`SourceKind` 一个对象声明全部：`schema`（zod 配置校验，默认什么都不接收）、`fields`
（声明式表单——面板 UI 零代码生成）、`health`（认领健康条目名，注册时认领、重复即拒）、
`scope`（监听判定，只能依赖 meta+配置）、`channel`（幂等 send → sent/gone、link）、
`threadContext`（有界分页上下文读取）、`policy`（该来源的允许名单/准入表行/名册同步）、
`environment`（注册执行环境变量，绝不放凭据）。

轮询循环纪律：游标只在**全部 Trigger 落库后**推进（中断轮保持游标，稳定 id 让重放安全）；
坏条目逐条计数跳过不整批失败；连续 3 次轮询失败才报 error；AbortSignal 贯穿一切等待。

---

## 第二部分：本项目架构（dsh-super-agents）

### 约束与形态

DSH 插件 = 一个 npm 包 + `cordis.patch.yml`，入口导出 `{name, inject, Config, apply(ctx, config)}`。
我们运行在宿主进程内，可用的宿主服务：`sessionController`（建会话/选模型/投消息/取消）、
`tools`（注册工具）、`systemPrompt`（注入提示词段）、`skills`（注册技能）、`webServer`（HTTP 路由）。
浏览器面板是另一个入口（`dsh.client` + `exports["./client"]`）。

```
index.js (Node 半区)
├── storage      原子 JSON 台账（agents/schedules/runs）+ 追加日志 + 产物/经验册文件
├── domain       cron 解析与 IANA 时区匹配、幂等 key、playbook 合并、提示词组装
├── runner       并发队列 + sessionController 执行 + 产物判定 + reflection 回路
├── scheduler    中央 tick（every 30s）扫描到期调度 → 派生 occurrence → 建 Run
├── health       命名条目 + 单一写者 + 状态码
├── tools        sa_agent / sa_run / sa_runs / sa_run_result / sa_say / sa_schedule / sa_learn
├── routes       /api/dsh-super-agents/*（state / run / agent-save / agent-delete / run-detail）
└── skill        注册 super-agents 技能（教宿主模型怎么用这套工具）

client.js (浏览器半区)
└── 侧边栏面板：概览（需要人的事）/ 角色卡 / 调度 / 运行 四个视图
```

单文件实现（index.js ~1100 行）是刻意的：DSH 插件走 `dsh plugin add` 安装，无构建步骤，
单文件 = 可 grep、可手改、可 diff。内部仍按上表分区注释，模块边界用工厂函数
（`makeLedger` / `makeRunner` / `makeScheduler`）表达——**先在一个文件里守住分层，
等规模逼拆分时再物理拆**（见 003 的"重构路线"）。

### 端口与依赖方向（对齐原型的依赖倒置）

```
tools/routes ──┐
scheduler ─────┼──→ runner ──→ sessionController（宿主端口）
               │        └──→ ledger（存储端口）
               └──→ ledger
```

- `ledger` 是唯一存储端口：所有读写过它，工厂返回闭包封装文件路径。换 SQLite 只改这一层。
- `sessionController` 是唯一的宿主执行端口：runner 通过 `ctx.get("sessionController")` 取，
  取不到时 Run 直接 `failed`（错误码 `session_controller_unavailable`），不崩插件。
- 工具与路由是薄胶层：翻译参数 → 调 ledger/runner → 序列化结果，不含领域规则。

### 关键机制

**调度器**：中央 tick（默认 30s）扫全部启用调度。三种 kind：
`cron`（5 字段，支持 `* a a-b a,b */n a-b/n`，dow 7=0）、`every`（≥60s 间隔）、`at`（一次性 ISO）。
cron 匹配用 `zonedParts(date, tz)`——`Intl.DateTimeFormat` 按 IANA 时区取墙钟
（分钟/时/日/月/周），**DST 自动正确**；`tz` 为空退回主机本地。去重键是"时区内的分钟"
（`minuteKey`），同一分钟多次 tick 只触发一次。错过的 occurrence **不补发**（001 被拒概念）。

**runner**：内存并发队列（`maxConcurrent`，默认 2）。执行序：`makeRun` 先落盘（queued）→
出队时建会话（`sc.create({cwd})`）→ 选模型（`provider/model` 切分）→ `sc.prompt(...)` 投任务
→ 轮询 `sc.list()` 的 `running` 标志直到会话停止 → 读产物文件判定 `done / done_no_artifact` →
超时则 `sc.cancel` + `timeout`。产物路径必须在 run 的 cwd 内（`.sa-results/<runId>.md`）——
worker 会话的沙箱只允许写自己 cwd，这是踩过坑后写死的契约。

**自学习回路**：任务 Run 结束且有产物 → 自动 enqueue 一个 reflection Run（同一 agent、同一 cwd）
→ reflection 的产物按 `- ` 行合并进 playbook（去重、60 行上限、丢最旧）→ 下次任务 Run 的
提示词注入 playbook 尾部（超 2400 字符取尾部）。`learn: false` 全链路关闭。

**启动清扫**：宿主重启后，`running` 的 Run 标 `interrupted`（会话没了，重放不安全）；
`queued` 的 Run 重新入队（从没开始过，重放安全）。面板显示真相而非永恒的"执行中"。

**健康条目**：`scheduler`（tick 异常）、`runner`（连续执行失败）、`sessionController`（服务缺失）。
单一写者：每个条目只有一个部件写；面板顶部只显示 `error` 级。

### 与 DSH 宿主的集成面

| 宿主服务 | 用途 | 失败策略 |
| --- | --- | --- |
| `sessionController` | create / selectModel / prompt / list / cancel | 缺失 → Run failed（码），插件照常服务 |
| `tools` | 注册 7 个 sa_* 工具 | 注册失败仅告警 |
| `systemPrompt` | 注入在册 agent 清单（空清单 = 空段 = 不占 token） | — |
| `skills` | 注册 super-agents 技能（provider 模式） | 失败仅告警 |
| `webServer` | 5 条 exact 路由；默认仅回环（`allowLanState` 可放） | 路由随 effect 卸载 |
| 浏览器 `dsh.client` | 侧边栏面板席位（sidebar.panellist + main） | — |

### 扩展点（为下一个项目预留）

1. **新触发源**：照 Schedule 的样子加 `TriggerSource`——实现 `due(now)` 返回 occurrence 列表，
   occurrence 用 `key('run', sourceId, externalId)` 派生 Run id，其余全复用 runner。
   这就是原型 SourceKind 的最小可用子集（schema + 轮询循环 + 幂等 id）。
2. **换存储**：实现 ledger 工厂的同名方法（agents/schedules/runs 的读写 + 路径），SQLite/PG 随意。
3. **换执行后端**：实现 runner 依赖的四个方法（create/selectModel/prompt/list/cancel），
   就能把执行挪到别的会话系统或容器。
4. **授权**：如果哪天要开放多用户，gate 的形态照抄原型（名单 + 强度 + Mandate 快照），
   加在 tools/routes 入口，不进 domain。
