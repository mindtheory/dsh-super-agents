# 003 工程与解决思路（Engineering）

本文回答两个问题：**遇到过的硬问题是怎么解的**（解决思路，可直接复用到任何"在会话式
宿主里跑无人值守 agent"的项目）；**原型的哪些做法我们采纳、哪些裁剪、为什么**。
承接 [001 领域](001-domain.md)、[002 架构](002-architecture.md)。

## 一、硬问题与解法

### 1. 无人值守会话的"完成"如何判定

**问题**：模型说"完成了"不算完成。会话 turn 结束也不等于交付——它可能忘了写东西。

**解**：产物文件是唯一凭据。任务提示词里写死输出契约（"完整交付物用 write 写入
`<path>`，第一行一句话结论；干不完也要写，第一行以「未完成：」开头"）。turn 结束后
读文件：有 → `done`，无 → `done_no_artifact`（进"需要人"名单）。原型的对应物是 worker 的
`orchestrator_report` 六态（progress/waiting/ready/blocked/failed/dropped）+ "草稿必须标
未完成"的提示词硬规——都是**把完成定义从自然语言挪到结构化事实**。

### 2. 沙箱写权限与产物路径

**问题**：worker 会话跑在 workspace-write 沙箱里，写自己 cwd 之外被拒。产物若定在
插件数据目录，worker 写不进去，表现为"跑完了但永远没有产物"。

**解**：产物路径必须落在 run 的 cwd 内（`<cwd>/.sa-results/<runId>.md`），插件侧读取。
cwd 不可创建时回退插件目录并记录。**通用教训：给无人值守会话定产物位置时，先确认它的
写权限边界，再定契约。** 这条已写进守望 agent 的 playbook。

### 3. 崩溃/重启后的运行状态

**问题**：宿主进程重启，内存里的执行队列没了；台账里一堆 Run 永远"running"。

**解**：Run 创建即落盘（queued 先持久化再执行）。启动清扫：`running` → `interrupted`
（会话随旧进程消失，重放可能有外部副作用，不重放）；`queued` → 重新入队（从未开始，
重放安全）。原型的对应机制更完整：Effects 队列在 SQLite 里，重启后到期重跑；running 的
Assignment 被 cancel(keepInbox) 后带 RECOVERY_NOTE 恢复（"检查现场，勿重复已完成的外部
操作"）。**通用教训：区分"未发生"与"进行中"——前者可重放，后者只能标记+人工确认。**

### 4. 调度重复触发与时区漂移

**问题**：tick 周期（30s）小于 cron 粒度（1min），一次 occurrence 会被扫到多次；主机时区
（America/New_York）与用户时区（Asia/Shanghai）差 13 小时且都有 DST，用"小时换算"必然漂。

**解**：去重键 = **时区内的墙钟分钟**（`minuteKey`），命中即记 `lastFiredMinute`，同键不再
触发。时区换算用 `Intl.DateTimeFormat({timeZone})` 取墙钟 parts，DST 由 ICU 处理，
零手写偏移。`sa_schedule` 暴露 `tz` 参数（IANA 名，校验后存库）。**通用教训：永远不要
手工算时区偏移；把时区作为调度的一等属性存下来。**

### 5. 调度器错过 occurrence 的诱惑

**问题**：宕机一夜，早上重启，要不要把错过的 5 次"每小时"补发？

**解**：不补。补发的噪音远大于价值（理念：只在人能用上结果时说话）。错过的 cron/every
直接跳过，下一次正常触发。**被拒概念表里最常被要求复活的就是这条，每次都要顶住。**

### 6. 自学习不能污染主流程

**问题**：蒸馏（reflection）本身是一次模型调用，会失败、会超时、会产出垃圾。

**解**：reflection 是普通 Run，走同一队列同一超时；它的失败静默（catch 后只记日志）；
playbook 合并只收 `- ` 开头的行、按行去重、60 行上限丢最旧——垃圾行有界。蒸馏提示词
明确"不写通用常识、不复述任务、不写空泛态度"。**通用教训：自学习回路必须比主流程更
宽容失败，且其输出必须有格式闸门。**

### 7. 无人值守会话的工具面

**问题**：worker 会话带着 `ask_user_question`、`present` 这类工具，会"问人"然后永远等不到回答。

**解**：原型用 agent preset 物理裁剪（worker preset 去掉问人/present/plan/调度/goals 工具，
shell 5 秒转后台）；我们目前靠提示词约束（产物契约里"最终回复三句以内"）。**采纳项**：
后续给 run 会话传 preset 或工具白名单（见重构路线 R4）。**通用教训：能力裁剪放在工具层，
提示词层只能兜底。**

### 8. 宿主服务缺失的降级

**问题**：`sessionController` 只在 web profile 有；CLI profile 装了这个插件会怎样？

**解**：插件照常启动（工具、调度、台账都可用），Run 执行时才检查端口，缺失即
`failed: session_controller_unavailable`。**通用教训：可选依赖在调用点失败并给出可行动的
错误码，不在装配点崩溃整个插件。**

### 9. 瞬时错误自动续跑（对齐上游 0.2.2）

**问题**：模型网关的 429/5xx、连接被重置、读超时都是**迟早会好**的错误，但当前表现为
Run 直接 `failed`；定时任务因此白跑一轮，下一轮要等到下一个 occurrence。

**解**：把"可重试"收敛成一个纯函数 `isTransientError`（429/5xx、rate limit、overloaded、
timeout、`ECONNRESET`/`EPIPE`/`socket hang up`），只对**瞬时**错误重放**同一个 Run 行**：
`attempts` 持久化、指数退避（base × 2ⁿ，封顶 60s）、上限 `retryMaxAttempts`（默认 2，
即首试 + 1 次重试）。确定性错误（agent 不存在、宿主服务缺失、4xx）立即失败，不浪费重试。
重放复用同一 Run id 与产物路径，因此重启后启动清扫看到 `queued` 行仍会接着跑，且
`attempts` 已落盘、不会因重启突破上限。失败行统一带 `errorCode`
（`ERR_RUN_SESSION_CONTROLLER` / `ERR_RUN_AGENT_MISSING` / `ERR_RUN_PROMPT` /
`ERR_RUN_TRANSIENT` / `ERR_RUN_TIMEOUT`），与上游 0.2.2"工具失败提供更明确错误类型与代码"同向。
**通用教训：重试只应重放"同一份工作"，且尝试次数必须是持久化事实而不是内存计数。**

## 二、对原型的采纳与裁剪

| 原型机制 | 我们的处置 | 理由 |
| --- | --- | --- |
| 确定性幂等 id（key=sha256） | ✅ 采纳（调度触发的 Run id 派生） | 一行代码换全链重放安全 |
| 单一写者 + 健康条目认领 | ✅ 采纳（health 模块） | 面板可信的前提 |
| 判定表（stage 表首行命中） | ✅ 采纳（Run 状态判定表） | 状态可解释、可测试 |
| 被拒概念表 | ✅ 采纳（001 文档） | 防止每个聪明人重新发明一遍 |
| 文档按序构建 + 文档即测试 | ✅ 采纳（编号文档；测试校验文档存在） | 文档漂移比没文档更糟 |
| 提示词版本化 + 覆盖记 base | ⏸ 简化（playbook 有去重上限，无版本快照） | 个人场景改动少；升级 diff 机制留给多团队场景 |
| Policy/Mandate/gate/强度 | ⏸ 简化（单宿主单操作者，无准入问题） | 001 被拒概念；接口预留见 002 |
| Effects 持久队列 | ⏸ 简化（内存队列 + 启动清扫） | 低频小写入；换存储时一并升级（R3） |
| SQLite + 生成列工作集 | ⏸ 简化（原子 JSON） | 同上 |
| Source 插件协议 | ⏸ 预留最小接口（TriggerSource 思路） | 当前只有两条触发路 |
| worker preset 工具裁剪 | ⏸ 计划（R4） | 宿主 preset 服务可用后接入 |
| 事件驱动完成（agent/status 订阅） | ⏸ 计划（R2） | 当前轮询 5s 可用但延迟高 |
| 瞬时错误自动续跑 | ✅ 采纳（`retryMaxAttempts`/`retryBaseDelayMs`，同 Run 行重放） | 上游 0.2.2 把模型请求重试做成可配置；失败重放是持久化事实 |
| 取消运行中的子代理 | ✅ 采纳（`/run-cancel` + 内存 in-flight 表；LobeHub #22496） | queued 立即落终态；running 先通知会话再由 runner 落 `cancelled`，保持单一写者 |
| observe 模式渐进放权 | ✅ 精神采纳（调度先手动验证再挂 cron） | 理念"start narrow" |

## 三、重构路线（按基准对齐的顺序）

- **R1（本次）**：文档系列落地；index.js 内部按 storage/domain/runner/scheduler/health/tools/routes
  分区重排；新增 `key()` 幂等 id 并接入调度触发；新增 health 模块与 `/api/.../health`；
  启动清扫区分 queued/running；测试补齐（key 幂等、health 单一写者、queued 重放）。
- **R2**：完成判定从轮询 `sc.list()` 改为订阅宿主事件（若 sessionController 暴露 status 事件）；
  瞬时错误续跑已落地（见一.9，同 Run 行 + 指数退避 + 持久化 attempts）。
- **R3**：ledger 端口化（同名方法集），提供 SQLite 实现（node:sqlite），JSON 实现保留为默认。
- **R4**：run 会话接入工具裁剪 preset（宿主 `permissionPresets`/preset 服务）。
- **R5**：TriggerSource 接口（webhook / 文件监听等），复用 runner 与幂等 id。

## 四、测试策略

对齐原型"测试与模块一一对应 + 文档即测试"：

| 测试 | 覆盖 |
| --- | --- |
| `test/unit.test.js` | 纯函数：cron 解析/匹配、IANA 时区、`key()` 幂等、playbook 合并去重、提示词组装、判定表、瞬时错误重试（fake sessionController：成功续跑/重试耗尽/确定性失败/服务缺失） |
| `test/smoke.test.mjs` | 假 ctx 装配全插件：工具注册数、路由注册、调度 tick 触发、健康板 |
| （R1 新增） | queued 重放/running 清扫、health 单一写者、文档存在性 |

约定：测试在 /tmp 副本跑（防 node_modules 符号链接污染插件仓库）；`node --test` 零依赖。
