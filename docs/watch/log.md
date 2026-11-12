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


