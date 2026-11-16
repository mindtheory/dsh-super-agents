# 前沿守望者运行日志

每次运行追加一节：日期 / 发现 / 行动 / 提交号。
基线状态存于同目录 `state.json`，下次运行先读它做 diff。

---

## 2026-11-10 · 首次运行：建立基线

**行动**：建立基线（无功能改动）。

### 基线内容摘要

| 项 | 值 |
| --- | --- |
| 仓库 HEAD | `c41f0fd` feat: super agents for DSH |
| dsh 版本 | `0.2.1-rc.2`（`dsh --version` 与 dsh/package.json 一致） |
| 官方包目录 | `/home/canetwork/.dsh-0.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（305 个包） |
| lobehub/lobehub 最新 commit | `3e750d6` · 2026-11-10T10:53:45Z · `fix(page-collab): keep one Yjs tree per page...` (#22695) |
| 测试 | unit 8/8 pass；smoke `SMOKE OK: 7 tools, 5 routes, scheduler fired & failed gracefully` |

官方包 mtime 快照（包内最新文件的 mtime，UTC）：

| 包 | mtime |
| --- | --- |
| dsh-base | 2026-10-21T02:12:02.160Z |
| dsh-schedule | 2026-10-21T02:12:20.856Z |
| dsh-agent | 2026-10-21T02:12:03.728Z |
| dsh-skill | 2026-10-21T02:12:02.360Z |
| dsh-goals | **不存在**（见下方修正） |
| dsh-subagents | **不存在**（见下方修正） |

### 基线修正：两个"监控包名"是错的

角色设定要求监控 `dsh-goals`、`dsh-subagents`，但本机安装里**没有**这两个目录。
实际存在的包是单数形式：

- `dsh-goal` / `dsh-tool-goal` / `dsh-goal-round-driver`
- `dsh-subagent` / `dsh-tool-subagent` / `dsh-tool-subagent-control` / `dsh-subagent-fork-in-process` / `dsh-subagent-spawn-in-process`

若不修正，这两个监控源会永远"无变化"，上游的 goal / subagent 能力升级将全部漏掉。
处理：`state.json` 里保留 `dsh-goals` / `dsh-subagents` 两个键并标记 `absent: true` 与解析说明，
同时新增 `resolvedTracked` 记录真实包（含 `dsh-experimental-agent-team`）；后续运行以 `resolvedTracked` 做 diff。

### 备注 / 待人工

- lobehub 该 commit 是 page-collab 修复，与 super-agent 无直接关系，本次不移植。
- 仓库自身 `package.json` 的 `exports`/`files`/`dsh.bundle` 与实际文件一致，无需改动。
- 本轮未做任何源码改动，因此没有功能提交（本次只有 `chore: add watch baseline` 一个基线提交）。

---

## 2026-11-11 · 上游 0.2.2-rc.2 发布 + 落地瞬时错误续跑

**一句话**：本机保持 `0.2.1-rc.2` 不动（红线），把上游 0.2.2 的"可配置重试"移植进 runner 并推送。

### 一、检查项 / 实测结果

| 检查项 | 实测结果 |
| --- | --- |
| 工作目录 | `/home/canetwork/dsh/dsh-super-agents` |
| 本机 dsh 版本 | `0.2.1-rc.2`（与基线一致，未改动安装目录） |
| 上游最新 release | **`dsh-v0.2.2-rc.2`**，published 2026-11-11T11:33:06Z（npm `latest` 仍 `0.2.2-rc.1`） |
| 官方包 mtime | 13 个关注包全部仍为 2026-10-21T02:12Z 一批，无源码变更 |
| mtime 口径 | 本次起 `find` 加 `-path '*/node_modules' -prune`；上一版 `dsh-schedule`/`dsh-goal`/`dsh-subagent` 的 `zod` 解包污染值已修正，**属测量方法修正非上游变更** |
| 原型 repo | `deepseek-ai/dsh-superagent-prototype` 最新 commit `8c32a9d`（2026-10-31），pushed 2026-11-03，无变化 |
| lobehub/lobehub | 新 commit `efd8d0d`（2026-11-11T17:49Z）`fix(chat-input): Send now interrupts a run...`，与 super-agent 无直接关系 |
| Web 检索 | "DeepSeek Harness super agent" 等 3 组查询命中原型 repo 与新闻稿，无超越 release notes 的新信息 |
| 单元测试 | `18/18 pass`（`node --test test/unit.test.js`，/tmp 副本） |
| 冒烟测试 | `SMOKE OK: 8 tools, 7 routes, scheduler fired & failed gracefully` |

### 二、上游 0.2.2 的可移植性评估

- **可移植并已实现**：「模型请求重试可配置（条件/次数/等待）」+「工具失败给出更明确错误类型与代码」
  → 落到本仓库 R2 中此前计划未实现的「瞬时错误自动续跑」。
- **仅记录待人工**：SubAgent 具名/多层协作、AgentTeam 统一具名子代理并默认关闭中断工具
  （release notes 明示为破坏性变更，自定义插件/SDK 集成需迁移）；本机未升级故无兼容问题。
  升级属人工决策（红线：不改 DSH 安装目录）。
- **不适用**：PTC 重复等待子代理消息去重、AgentTeam 面板、Git worktree 审阅等宿主 UI/协作能力。

### 三、行动与提交

- `5ddc501` **feat: retry transient run failures with exponential backoff**
  - `isTransientError()`：429/5xx、rate limit、overloaded、timeout、`ECONNRESET`/`EPIPE`/`socket hang up`
  - 瞬时失败重放**同一个 Run 行**：`attempts` 持久化、指数退避（默认 base 2s、封顶 60s、默认 2 次尝试）
  - 确定性失败（agent 缺失 / sessionController 缺失 / 4xx）立即失败
  - 失败行带 `errorCode`：`ERR_RUN_SESSION_CONTROLLER` / `ERR_RUN_AGENT_MISSING` /
    `ERR_RUN_PROMPT` / `ERR_RUN_TRANSIENT` / `ERR_RUN_TIMEOUT`
  - 新增配置 `retryMaxAttempts` / `retryBaseDelayMs` / `pollIntervalMs`；README 与 003 文档同步
  - 测试 +6：瞬时分类、退避、成功续跑、重试耗尽、确定性不重试、服务缺失
- 本提交（`chore: update watch baseline`）只改 `docs/watch/`。

### 四、待人工 / 备注

- **是否升级到 0.2.2-rc.2**：涉及 AgentTeam 迁移与 PTC 超限终止等破坏性变更，建议单独安排升级 + 回归。
- `state.json` 新增 `dsh.upstream`（latestReleaseTag / headlineChanges）与 `prototypeRepo` 两个监控维度，
  下次运行直接 diff 即可发现新版本。

---

## 2026-11-12 · 第四次运行：上游无新版本，移植 LobeHub「取消运行中的子代理」

**结论**：已实现并推送（`ec49826`）。DSH 本地安装、官方包、上游 release、原型 repo 均无变化；
LobeHub 当日新增 `cancel a running sub-agent`（#22496）属可移植项，已落为本仓库的 run 取消能力。

### 一、逐源检查

| 检查项 | 实测结果 |
| --- | --- |
| 工作目录 | `/home/canetwork/dsh/dsh-super-agents` |
| 本机 dsh 版本 | `0.2.1-rc.2`（`dsh --version` 与 dsh/package.json 一致，未改动安装目录） |
| 上游最新 release | `dsh-v0.2.2-rc.2`，published 2026-11-11T11:33:06Z —— 与基线相同，**无新 release** |
| npm 口径修正 | `npm view dsh version` 返回 `1.0.1` 是 2016 年的同名无关包（infusion/node-dsh）；正确的包是 **`@deepseek-ai/dsh`**，dist-tag `latest` = `0.2.2-rc.1`。本次把 `npmPackage` 记入 state.json，属**测量口径修正**非上游变更 |
| 官方包 mtime | 13 个关注包全部仍为 2026-10-21T02:12Z 一批（`find ... -path '*/node_modules' -prune`），无源码变更；包数 305 |
| `grep -ril "super.agent\|superagent"` | 官方包源码/README 内无命中 |
| 上游原型 repo | `deepseek-ai/dsh-superagent-prototype` 最新 commit 仍 `8c32a9d`（2026-10-31），无变化 |
| lobehub/lobehub | 新 head `14b10542`（2026-11-12T17:50Z，upload 测试），基线 `efd8d0d` |
| Web 检索 | "DeepSeek Harness super agent" 等 3 组仍只命中原型 repo + 新闻稿 + 一篇 0.2.2 解读，无 release notes 之外的增量 |
| 单元测试 | `22/22 pass`（`node --test test/unit.test.js`，/tmp 副本） |
| 冒烟测试 | `SMOKE OK: 8 tools, 8 routes, scheduler fired & failed gracefully` |

### 二、LobeHub 当日相关提交评估

- **可移植并已实现**：`6d52b97abe13` ✨ `feat(lobe-agent): cancel a running sub-agent (#22496)`
  → 本仓库此前只有「超时取消」和「全局暂停调度」，无法主动停掉某个 Run，属真实运维缺口。
- 已核对无需行动：`1c4ee6ba2fc1` 🐛 `fix(task): drop the non-existent pending status from CLI help,
  skill docs` —— 本仓库文档中的 Run 状态均与实现一致（无幽灵状态），该问题不存在。
- 不移植：channel / thread、TTS、goal share、file-viewer（宿主 UI 能力）；
  creds / OAuth / sandbox 类（安全红线，只记录不自动改）。

### 三、行动与提交

- `ec49826` **feat: cancel queued or running runs**
  - `makeRunner` 新增内存 in-flight 表 `runId -> { sessionId, cancelled, controller }`：
    ledger 行本身无法寻址运行中的会话，取消必须靠这张表。
  - `POST /api/dsh-super-agents/run-cancel {runId}`（loopback 校验 + POST only）：
    - `queued`：从队列移除并立即落终态 `cancelled`；
    - `running`：置取消标志 + `AbortController.abort()` + `sessionController.cancel()`，
      由 `execute()` 的轮询落终态 —— **runner 仍然是 live 状态的唯一写者**，避免并发改 runs.json；
    - 终态 Run 返回 409，未找到 404。
  - 三类竞态都收口：重试退避期间取消（execute 入口复查 ledger 状态，后台重放不会起会话）、
    会话创建中取消（flight 已登记，创建后复查）、prompt/会话因取消而抛错（catch 里取消优先于失败，
    落 `cancelled` 而非 `failed`）。
  - 面板：queued/running 运行行新增「取消运行」按钮（client.js + 中英文案）。
  - 文档：001 状态判定表新增 `cancelled`（且注明启动清扫只重放 queued）、003 采纳表新增一行、
    005 运维契约新增取消小节、README 与技能文档的状态列表同步。
  - 测试 +4：排队取消不派发、运行中取消（会话收到 cancel）、prompt 被取消不落 failed、终态拒绝；
    smoke 路由断言 7 → 8。全部在 /tmp 副本执行，`22/22` + `SMOKE OK` 全绿后才提交。
- 本提交（`chore: update watch baseline`）只改 `docs/watch/`。

### 四、待人工 / 备注

- **是否升级到 0.2.2-rc.2**：仍待人工决定（红线：不改 DSH 安装目录），破坏性变更见上节记录。
- `package.json` 的 `repository.url`（crazyasp）与实际 remote（mindtheory）不一致，属发布元信息，
  沿用红线不在自动流程改，留待人工确认。
- `state.json` 的 `dsh.upstream` 本次新增 `npmPackage` 字段，避免下次再被同名 npm 包误导。



---

## 2026-11-13 · 第五次运行：上游 rc.3 发布（无可移植项），移植 LobeHub「运行中 steer 子代理」

### 一、逐源检查

| 检查项 | 实测结果 |
| --- | --- |
| 工作目录 / 仓库 HEAD | `/home/canetwork/dsh/dsh-super-agents` · 基线 `3cea4c8`（本次功能提交前） |
| dsh 版本 | `0.2.1-rc.2`（`dsh --version` 与 `<dsh>/package.json` 一致，本机未升级，红线） |
| 上游 release | **新版本 `dsh-v0.2.2-rc.3`**（2026-11-13T07:56:55Z），基线为 rc.2 |
| npm dist-tags | `latest=0.2.2-rc.1`（2026-11-04）、`next=0.2.2-rc.3`；`npm view` 因 ~/.npm 缓存属主报 EACCES，改 registry HTTP |
| 官方包 mtime | 9 个关注包（+ resolvedTracked）仍全为 2026-10-21T02:12Z 一批，无源码变更；包数 305 |
| 上游原型 repo | `deepseek-ai/dsh-superagent-prototype` 最新 commit 仍 `8c32a9d`（2026-10-31），无变化 |
| lobehub/lobehub | 新 head `cb7aa3ef86b2`（2026-11-13T17:40Z），基线 `14b10542`；中间 19 个提交 |
| Web 检索 | 三组检索仍只命中原型 repo、第三方插件与新闻稿，无 release notes 之外的增量 |
| 单元测试 | `26/26 pass`（`node --test test/unit.test.js`，/tmp 副本） |
| 冒烟测试 | `SMOKE OK: 8 tools, 8 routes, scheduler fired & failed gracefully` |

### 二、上游 rc.3 评估

- 新增：实验性「DeepSeek 会话导入」插件（DeepSeek App/网页版历史会话导入工作区）→ 宿主层插件，本插件无权也无必要复刻。
- 修复：Windows 桌面版应用内更新失败后无法重开 → 桌面端外壳问题，不涉及本插件。
- 结论：**无可移植运行时能力**，只更新基线。升级仍待人工（红线：不改安装目录）。

### 三、LobeHub 当日相关提交评估

- **可移植并已实现**：`6444fde0e864` ✨ `feat(sub-agent): steer a running sub-agent instead of refusing the follow-up (#22377)`
  → 本仓库 `sa_say` 原先固定 `mode: "queue"`：运行中的 Run 收到指令只能排到当前轮之后，
  无法中途纠偏（只能取消重派），属真实运维缺口。宿主 `sessionController.prompt`
  本身支持 `'queue' | 'steer'`（`steer` 在下一个步骤前注入），因此这是纯 plugin 层接线。
- 该提交同时把 #22496「取消再重发」的指引改成 steer；与上次移植的 cancel 互补而非冲突：
  cancel 用于「结果不再需要」，steer 用于「方向要改」。
- 不移植：channel/thread、desktop device 注册、TTS、file-viewer、projects UI（宿主 UI 能力）；
  creds / OAuth / sandbox fence（安全红线，只记录不自动改）。

### 四、行动与提交

- `59dbc1e` **feat: steer a running run with sa_say instead of only queueing**
  - `sayMode(run, requested)`：运行中默认 `steer`，已结束默认 `queue`，显式 `mode` 覆盖。
  - `sayRequest(...)`：组装 `{requestId, sessionId, mode, content}`（宿主 prompt 契约）。
  - `isSteerUnavailable(err)`：只认确定性拒绝（`session/steer-unavailable` / `no active`）。
  - `deliverSay(...)`：steer 被拒（读状态与投递之间 Run 恰好结束）→ **仅该确定性拒绝**回退 queue 一次，
    且换 requestId（`-queue` 后缀）避免重复投递；其他失败原样抛出，绝不盲重试。
  - `sa_say` 新增 `mode` 参数（auto/queue/steer）、空消息校验、投递后写 run 日志（`say steer`/`say queue`）。
  - 测试 +4：运行中默认 steer、已结束 queue、steer 被拒回退一次且 id 不同、未知失败只发一次。
  - 文档：README 工具表 + 段落、技能文档 `sa_say` 行、系统提示「续聊/运行中纠偏」。
- 本提交（`chore: update watch baseline`）只改 `docs/watch/`。

### 五、待人工 / 备注

- **是否升级到 0.2.2-rc.3**：待人工决定（红线：不改 DSH 安装目录）。
- `package.json` 的 `repository.url`（crazyasp）与实际 remote（mindtheory）不一致，沿用红线不自动改。
- `npm view` 的 EACCES（~/.npm 缓存含 root 属主文件）属本机环境问题，本次改走 registry HTTP；
  若要修缓存需 `sudo chown -R 1000:1000 ~/.npm`，涉及权限，不自动执行。

---

## 2026-11-14 · 第六次运行：上游无变化；R2 收口（完成判定改为宿主事件，轮询降为兜底）

### 一、逐源检查

| 检查项 | 实测结果 |
| --- | --- |
| 工作目录 / 仓库 HEAD | `/home/canetwork/dsh/dsh-super-agents` · 基线 `b1675e3`（本次功能提交前） |
| dsh 版本 | `0.2.1-rc.2`（`dsh --version` 与 `<dsh>/package.json` 一致，本机未升级，红线） |
| 上游 release | **无新版本**，仍 `dsh-v0.2.2-rc.3`（2026-11-13T07:56:55Z）；`releases/latest` 端点本次返回 404，改 `releases?per_page=3` 列表口径 |
| npm dist-tags | `latest=0.2.2-rc.1`、`next=0.2.2-rc.3`，与基线一致（registry HTTP 口径） |
| 官方包 mtime | 9 个关注包（+ resolvedTracked 共 13 项）仍全为 2026-10-21T02:12Z 一批，包数 305，无源码变更 |
| 上游原型 repo | `deepseek-ai/dsh-superagent-prototype` 最新 commit 仍 `8c32a9d`（2026-10-31），无变化 |
| lobehub/lobehub | 新 head `1b9d3c6ac646`（2026-11-14T18:00Z），基线 `cb7aa3ef`；中间 27 个提交 |
| Web 检索 | 三组检索仍只命中原型 repo、Windows 适配 fork、第三方实现（oxmumu3 / TianzeLuo / aowind / ccndagent）与 rc.2 解析文，无增量能力信息 |
| 单元测试 | `31/31 pass`（`node --test test/unit.test.js`，/tmp 副本） |
| 冒烟测试 | `SMOKE OK: 8 tools, 8 routes, scheduler fired & failed gracefully` |

### 二、上游评估

rc.3 已于上次记录（会话导入插件 + Windows 应用内更新修复），本次复查无新 release、无源码变更。
升级到 0.2.2-rc.3 仍待人工（红线：不改安装目录），无常驻动作。

### 三、LobeHub 27 个提交评估（无可移植项）

- `ab883dde06` `✨ feat(cli): add --tag to lh agent create`、`e5d6033293` `✨ feat(agent): filter the agent list by tag`
  → LobeHub 云端 agent 的标签创建/过滤。本插件常驻 agent 个位数，加标签概念收益低于概念成本（001 被拒概念）。
- `553d091d29` `⚡️ perf(agent-documents)`：服务端上下文引擎的文档索引跨轮缓存，宿主/服务端能力，非插件层。
- `4ac339bcf1` `♻️ refactor(plugin): install MCPs as connectors`：宿主插件系统内部迁移。
- 其余：workspace hover 卡片、devdock/本地数据库、projects 样式、TTS（Fish Audio / Gemini / Doubao）、
  music 生成、execution-target 排序、OIDC/creds/sandbox 类 → 宿主 UI 或安全红线，不移植。

### 四、本次实现：事件驱动完成（R2 收口）

`docs/003-engineering.md` 的 R2 一直挂着「完成判定从轮询 `sc.list()` 改为订阅宿主事件（若 sessionController
暴露 status 事件）」。本次核对宿主包 `dsh-api-session-controller`：

- cordis 事件声明里确有 `'api-session/status'(sessionId: SessionId, running: boolean)`（"One Agent changed
  running state"），另有 `api-session/added|removed|activity|failed`；非文档猜想要件，是可用的宿主契约。
- 因此 runner 不必再每 5s 读一次全量列表：事件到了就能立刻落终态，`sa_runs` 的 running→done 延迟从
  「最多一个 poll 周期」降到「事件到达」。

实现（`a83407a`）：

- 新增 `makeIdleWatcher({timeoutMs})`：按 `sessionId` 维护 waiter 集合，
  `wait(sessionId, signal)` 一次性 resolve `'idle' | 'aborted' | 'poll'`；`onStatus(sessionId, running)`
  只认 `running === false`；abort / 超时 / 迟到事件都保证清理 waiter、不抛。
- `makeRunner` 里 `ctx.on("api-session/status", ...)` **只订阅一次**（`typeof ctx.on === "function"` 防御），
  避免每次 run 注册 listener 造成泄漏。
- `execute()` 的 sleep 轮询改为 `idleWatcher.wait(sessionId, controller.signal)`：`idle` 直接结算，
  `aborted`（取消/超时）立即跳出，`poll` 才走原来的 `sc.list()` 兜底。取消不再需要等下一 tick 才生效。
- 保留轮询的理由写进代码注释：丢事件（旧宿主、Remote owner 重启）不能让 Run 永久挂着；超时仍按
  `runTimeoutMs` → `timeout` 落终态，行为与之前一致。
- 测试 +5（31 全绿）：事件结算为 idle、`running=true` 与他会话事件不结算、abort 结算并清理、
  空 sessionId/迟到事件无害、以及「list 永远报 running=true 时只靠事件也能 done」（证明接线生效，
  且 60s 兜底 tick 未触发）。
- 文档同步：003 二版表与 R2 标 ✅；002 runner 段、005 取消段、README「How a run works」与
  `pollIntervalMs` 注释改为「事件优先、轮询兜底」；配置注释同步。

### 五、待人工 / 备注

- **是否升级到 0.2.2-rc.3**：待人工决定（红线：不改 DSH 安装目录）。
- **测量口径修正**：`repos/deepseek-ai/deepseek-harness/releases/latest` 本次返回 404，
  改用 `releases?per_page=3` 取首项；`state.json` 已记 `releaseCheckNote`，下次沿用列表口径。
- `package.json` 的 `repository.url`（crazyasp）与实际 remote（mindtheory）不一致，沿用红线不自动改。

---

## 2026-11-15（每日守望）

| 检查项 | 实测结果 |
| --- | --- |
| 工作目录 / 仓库 HEAD | `/home/canetwork/dsh/dsh-super-agents` · 基线 `21ace8e`（本次功能提交前） |
| dsh 版本 | `0.2.1-rc.2`（`dsh --version` 与 `<dsh>/package.json` 一致，本机未升级，红线） |
| 上游 release | **无新版本**，仍 `dsh-v0.2.2-rc.3`（2026-11-13T07:56:55Z），`releases?per_page=3` 列表首项口径 |
| npm dist-tags | `latest=0.2.2-rc.1`、`next=0.2.2-rc.3`、`alpha=0.2.2-alpha.3`，与基线一致（registry HTTP 口径） |
| 官方包源码 mtime | 9 个关注包 + 5 个 resolvedTracked 共 13 项仍全为 `2026-10-21T02:12Z` 一批，无变更 |
| 上游原型 repo | 最新 commit 仍 `8c32a9dc5d72`（2026-10-31），无变化 |
| lobehub/lobehub | 新 head `69e7229cf817`（2026-11-15T17:40Z），基线 `1b9d3c6ac646`；中间 29 个提交 |
| Web 检索 | 三组检索仍只命中原型 repo、Windows 适配 fork、第三方实现（oxmumu3 / aowind / RickT34 / @baymaxhit）与 rc.2 解析文，无增量能力信息 |
| 单元测试 | `34/34 pass`（/tmp 副本 `node --test test/unit.test.js`） |
| 冒烟测试 | `SMOKE OK: 8 tools, 8 routes, scheduler fired & failed gracefully` |

### 一、上游评估（无动作）

rc.3 已两次记录，本次复查无新 release、npm dist-tags 未变、官方包源码 mtime 未变、
原型 repo 无提交。升级到 0.2.2-rc.3 仍待人工（红线：不改安装目录）。

### 二、LobeHub 29 个提交评估（1 项可移植）

- `3318b7cbcf` `🐛 fix(goal): close a goal whose planning dispatch was refused its topic (#23033)`
  → **可移植**：被拒的派工必须收口留痕，不能"看起来还开着"。已落地，见下节。
- `564a4b9605` `🐛 fix(agent-runtime): stop gracefully on consecutive unresolvable tool names (#23024)`
  → 宿主 `agent-runtime` 的工具调用环（连续解析不到工具名就优雅停）。本插件不持有该环，
  run 是"建会话 + 投 prompt + 等停止"，复刻只会造成第二份判定。不移植。
- `99a34fb1a5` `✨ feat(channel): expose the failure type and device on public Channel jobs`
  → 本插件 run 行已有 `error` + `errorCode`（`ERR_RUN_TRANSIENT`/`ERR_RUN_TIMEOUT`/`ERR_RUN_PROMPT`/
  `ERR_RUN_SESSION_CONTROLLER`/`ERR_RUN_AGENT_MISSING`），无新增信息。
- MCP 四连 `a8b501bf87` / `641341230f`（SSRF-safe fetch）/ `45d3034f3b` / `30c616e01f`、
  `7fe12d7067` 企业微信 bot 长连接、`e00695bd1f` Antigravity 本地 agent、`d731a5f860` 粘贴图片：
  宿主 connector / 平台通道 / 异构 agent，非插件层，且涉及网络暴露与凭据（安全红线只记录不移植）。
- `55a4ff8494`（实时显示 steer）、`4f1c632724`（上下文裁剪跨轮保留）、`0163ffb6d7`（按旁白切分
  workflow）、`3e56ad1001`（移除 SWR 持久层）与其余 12 个 `style`/UI 提交：宿主或前端表现层，
  steer 本插件已在投递侧结算（`deliverSay` + 回退 queue），无增量。
- `69e7229cf8`（contact 表）等数据库/订阅页改动：云端服务端能力，不移植。

拒绝"为对齐而加"的判断沿用 001 被拒概念：29 个提交里只有 #23033 描述的是本插件**已有对象**
（调度 → 派工）的语义漏洞，其余都不是本插件持有的关注方向。

### 三、本次实现：调度被拒留痕（`4e8605c`）

**问题（真漏洞，不是对齐）**：`makeScheduler.fire()` 旧逻辑先推进 occurrence 标记
（`lastFiredMinute` / `lastFiredAt` / `firedAt`），再检查 `agent` 是否存在/启用，不满足就 `return`。
结果：指向已停用 agent 的 cron/every 调度会**无限期每秒推进标记、永远不派工、且没有任何信号**——
面板上它看起来"到点就触发"，实际上一次都没派。`sa_schedule list` 里也完全看不出区别。

**修法**（对齐 #23033 的"被拒要收口"，不改调度语义）：

- 行上新增 `skippedCount` / `lastSkipAt` / `lastSkipReason`（`agent <id> 不存在` / `已停用`），
  `sa_schedule list` 直接返回整行，无需新字段协议。
- `reportDispatchHealth()` 在 tick 末尾汇总成新健康条目 `scheduleDispatch`（`warn`，
  列出前 3 个 id + 原因，超出省略）；无跳过时置 `ok`。单一写者仍是 scheduler（`health.claim`）。
- 成功派工把三项清零——**恢复 agent 后自动续跑，不逼用户重建调度**（这是与"直接 auto-disable"
  的分歧点：停用通常是临时的，自动停用会让恢复时凭空少任务）。
- 一次性 `at` 被拒：仍标 `firedAt`（已消费，重启用时不会突然补跑），只留痕、**不进持续告警**，
  因为它的拒绝是终态而非"一直在跳"。
- 保留 `skippedCount` 在行内的另一个好处：cron 若长期被跳过，`sa_runs` 里没有 run 行，
  但调度行的 `lastSkipAt` 能证明"tick 在跑、只是派不出去"。

**测试 +3（34 全绿）**：停用 agent 只记 skip 不派工且健康条目为 warn；重新启用后派工一次、
三项清零、健康条目回 ok；一次性 at 被拒即消费（`firedAt` 非空）且不进入持续告警。
（`makeScheduler` 加入 `__internals` 供测试，纯测试出口，无运行时消费者。）

**文档同步**：002 调度段新增"派工被拒不等于已触发"与健康条目清单；003 采纳表新增一行
（含"不自动停用"的理由）；005 健康表新增 `scheduleDispatch` 行；README `sa_health` 条目列表同步。

### 四、待人工 / 备注

- **是否升级到 0.2.2-rc.3**：待人工决定（红线：不改 DSH 安装目录）。
- `package.json` 的 `repository.url`（crazyasp）与实际 remote（mindtheory）不一致，沿用红线不自动改。
- 本次累计改动 145 行（index.js 43 / test 92 / docs 10），在 300 行红线内。

---

## 2026-11-16（每日守望）

| 检查项 | 基线（2026-11-15） | 本次实测（2026-11-16） | 判定 |
| --- | --- | --- | --- |
| 仓库 HEAD | `6a20dc5` | `199ad49`（本次功能提交前为 `6a20dc5`） | 有本仓库提交 |
| dsh 版本 | `0.2.1-rc.2` | `dsh --version` 与 `<dsh>/package.json` 均为 `0.2.1-rc.2` | 无变化 |
| 上游 release | `dsh-v0.2.2-rc.3`（2026-11-13T07:56:55Z） | `releases?per_page=3` 列表首项仍 `dsh-v0.2.2-rc.3` | 无新版本 |
| npm dist-tags | `latest=0.2.2-rc.1` / `next=0.2.2-rc.3` / `alpha=0.2.2-alpha.3` | registry HTTP 口径同上，逐项一致 | 未变 |
| 官方包源码 mtime | 13 项均为 `2026-10-21T02:12Z` 一批 | 13 项逐个比对，全部相同（pruned `find`） | 未变 |
| 上游原型 repo | `8c32a9dc5d72`（2026-10-31） | 最新 commit 仍 `8c32a9dc5d72` | 无变化 |
| lobehub/lobehub | `69e7229cf817`（2026-11-15T17:40Z） | 新 head `a1af6ec231`（2026-11-16T17:56Z），中间 **60** 个提交 | 有新提交 |
| Web 检索 | 原型 repo / 第三方实现 / rc.2 解析文 | 同批来源，无新增能力信息 | 无增量 |
| 单元测试 | `34/34 pass` | `37/37 pass`（/tmp 副本） | 全绿 |
| 冒烟测试 | `SMOKE OK: 8 tools, 8 routes, …` | 同上 | 全绿 |

五项信号里四项无变化，唯一变化是 LobeHub 的 60 个提交；60 个里只有一项补到本插件**已有对象**的洞。

### 一、上游评估（无动作）

rc.3 第三次记录，本次无新 release、dist-tags 未变、官方包源码 mtime 未变、原型 repo 无提交。
升级到 0.2.2-rc.3 仍待人工（红线：不改 DSH 安装目录）。

### 二、LobeHub 60 个提交评估（1 项可移植）

命中项（"永久拒绝不该无限挂起"家族，与 #23033 同源）：

- `1160d07ffc` `🐛 fix(topic): stop re-dispatching topics whose summary model rejected user settings (#23114)`
  → 上游对"永久被拒"的处理是**停止重派并收口**，不是每轮再撞一次。照到本插件的 Run 侧，
  发现 2026-11-15 那次修（调度行 `skippedCount`）**没有覆盖同类残留**：`requeuePersisted()`
  对"agent 已删/已停用"的 `queued` 行直接 `continue`，既不入队也不落终态。

逐项不移植（判据仍是"补本插件已有对象的语义漏洞"，不是"上游有就搬"）：

- `e0724291bf` 长命令 park 而非轮询 → 宿主 `agent-runtime` 的工具调用环，本插件不持有。
- `993eaea31f` 预期条件别报 500 → 本插件路由早已按 400/403/404/405/409 分类（逐个核对
  `registerRoutes`），无缺口，属"已有能力"。
- `a580105b47` 投递失败重试 → 已有 `isTransientError` + `retryDelay` 指数退避重放同一行，无增量。
- `82ef2fd658` 等离线设备而非直接失败 → 已在调度侧实现为"跳过留痕 + 恢复后自动续跑"（`4e8605c`）。
- `88263122a3` 空抽取结果回退 → 反思蒸馏空产物 = 不追加 playbook，本就没有失败路径。
- `1a49740448` / `a940c74c4a` / `9c3aea4d06`（goal marks、验收轮次、评审收件箱）→ 本插件不持有
  goal / 验收对象，引入即新造概念（001 被拒概念）。
- `e5312145e6`、`c68faea0ce`、`a7527870b9`（OAuth 多账号 / MCP 绑设备 / 入站 webhook）→ 宿主
  connector 与凭据、网络暴露（安全红线，只记录不实现）。
- `512559fbb7` 钉钉、`f9bcf152f0` QQ、`1247174af2` 企业微信重启保消息、`d8ef85bd6f` 频道公开
  → 平台通道层，本插件没有通道。
- `2b62c18c8f` / `ac0c3613ee`（step 0 inline）、`60b7dda33f`（feature gate 并发）→ 宿主前沿。
- 其余（艺术画板表、contact 表、chat-input 图片卡、侧边栏/头像/样式、i18n、模型卡片、
  CLI `lh acceptance delete`）→ UI 或云端服务端能力，不移植。

### 三、本次实现：孤儿 `queued` Run 收口（`199ad49`）

**问题（真漏洞）**：宿主停机期间 agent 被删或停用，重启后 `requeuePersisted()` 看到
`row.status === "queued"` 而 agent 查不到就 `continue` —— 该行**既不重新入队，也不落终态**。
启动清扫只跑一次，之后没有任何再入队的触发点，于是这行永远停在 `queued`：
面板显示"排队中 +1"，`sa_runs` 里看着还活着，实际永远不会有下一次派工。
这也让 `docs/001` 的"`queued` 会被重新入队"成了半句真话。

**修法**（只收口落终态，不改重放语义）：

- `settleOrphan(row, code, why)`：`status: failed` + `errorCode` + `endedAt` + 可读 `error`，
  并写 run 日志（`not requeued: …`），与 runner 其它落终态路径同一写者。
- agent 已删除 → `ERR_RUN_AGENT_MISSING`；agent 已停用 → **新代码** `ERR_RUN_AGENT_DISABLED`。
- 停用为什么按"拒绝"而不是"无限等"：`sa_run` 本来就拒绝停用 agent；而排队行没有
  "重新启用 → 自动再入队"的触发点，等着就等价于永远等。行上 `taskText` 保留，
  重新启用后再派一次即可，任务不丢（错误文案里直接写了这句话）。
- `requeuePersisted()` 返回收口的孤儿数（纯返回值，供测试与将来面板计数用，无新协议）。

**测试 +3（37 全绿）**：agent 被删 → `failed` + `ERR_RUN_AGENT_MISSING` + `taskText` 保留 + 队列为空；
agent 被停用 → `failed` + `ERR_RUN_AGENT_DISABLED`；对照组——agent 健在时仍照常重放并跑完
（证明没有把正常重放一起收掉，且这两类都不会真的派工：测试里的 `prompt` 一被调用就抛错）。

**文档同步**：001 判定表补"重放的例外"段；002 启动清扫段补例外与理由；
003 第 9 节 `errorCode` 清单补 `ERR_RUN_AGENT_DISABLED`，采纳表新增"孤儿 `queued` Run 必须收口"行；
README 同步错误码清单与启动清扫例外说明。

### 四、待人工 / 备注

- **是否升级到 0.2.2-rc.3**：待人工决定（红线：不改 DSH 安装目录）。
- **未修（记录待人工）**：`scheduler.fire()` 里 `runner.makeRun()` 返回 `null`（同 id 行已存在去重）时
  仍 `return true` 且不给信号。触发条件是"标记已推进但行已存在"，正常路径下不可达（标记先推进），
  只在人工编辑 ledger 或极端崩溃重放时出现；改动要动幂等语义，超出"小修"范围，本次不动。
- `package.json` 的 `repository.url`（crazyasp）与实际 remote（mindtheory）不一致，沿用红线不自动改。
- 本次累计改动 103 行（index.js 32 / test 54 / docs 17），在 300 行红线内。
