---
name: super-agents
description: DSH 超级智能体（dsh-super-agents 插件）：创建持久化 agent 角色卡、后台派活、定时自主领活（cron/间隔/一次性）、运行结果回收、经验 playbook 自学习。当用户要创建常驻 AI 员工、定时自动任务、后台批量任务、或问超级智能体状态时使用。
---

# 超级智能体（dsh-super-agents）

你面前有一套「超级智能体」工具。设计思路来自 LobeHub 的 super-agent：**agent 是持久化的数据（角色卡），能自己领活（调度），每次运行后变强一点（经验蒸馏）**。

## 工具一览

| 工具 | 用途 |
|---|---|
| `sa_agent` | 角色卡 CRUD：name / systemRole（人设）/ model（provider/model）/ cwd / learn（自学习开关） |
| `sa_run` | 派活：后台新建会话执行任务，立即返回 runId |
| `sa_runs` | 运行列表（queued/running/done/done_no_artifact/failed/timeout/interrupted/cancelled） |
| `sa_run_result` | 取某次运行的交付物全文 |
| `sa_say` | 对已有 run 的会话追加指令：运行中 `steer` 中途纠偏，结束后 `queue` 追问（`mode` 可强制） |
| `sa_schedule` | 自主领活：cron / everySeconds / at 三种模式登记任务 |
| `sa_learn` | 手动/从某次 run 蒸馏经验进 playbook |
| `sa_health` | 健康板（scheduler/runner/sessionController/pause）+ 全局暂停/恢复调度 |

## 标准工作流

1. **建角色**：`sa_agent create`，systemRole 写清楚职责、口吻、验收标准。模型留空则用插件默认（本机通常是本地模型，适合高频任务）。
2. **派活**：`sa_run`。任务文本要**具体、可验收**（"把 X 目录的 TODO 汇总成清单写入 Y" 而不是 "整理代码"）。
3. **回收**：轮询 `sa_runs`（running→done），`sa_run_result` 拿交付物。交付物是 agent 写入 result 文件的完整内容，第一行是一句话结论。
4. **自主运行**：`sa_schedule set` 给某 agent 挂 cron（如 `0 9 * * 1-5` 工作日九点）或 everySeconds。到点自动跑，产物照常落盘。cron 默认按主机本地时区匹配；用户说"北京时间 X 点"而主机不在东八区时，传 `tz: "Asia/Shanghai"`。
5. **变强**：learn 开启时，每次 done 后自动跑一次 reflection，把 ≤8 条可复用教训追加进该 agent 的 playbook；playbook 会在该 agent 之后每次派活时注入其提示词（滚动上限 60 条）。

## 注意

- 派活是**后台异步**的：不要同步等待，告诉用户 runId 和稍后用 `sa_runs` 查看。
- 一个 agent 可并行多次派活；并发上限由插件配置（默认 2），超出的排队。
- 运行超时（默认 30 分钟）会被标记 timeout 并取消会话。
- 用户说"别让它跑了/停掉那个任务"→ 在面板运行行点「取消运行」，或 `POST /api/dsh-super-agents/run-cancel` 传 `{runId}`（queued/running 可取消，终态拒绝）；不要删 agent 来代替取消。
- 用户说"每天/每周自动做 X"→ 用 `sa_schedule`，不要自己挂 shell cron。
- 用户说"让它记住……"→ 用 `sa_learn` 直接写 playbook。
- 用户说"暂停自动任务/先别让它自己跑"→ `sa_health pause`（不杀运行中的 run，错过的 occurrence 不补发）；恢复用 `sa_health resume`。
- 排查"定时任务没跑"：先 `sa_health list` 看是否 paused、cron 的 tz 是否符预期、agent 是否被停用。
