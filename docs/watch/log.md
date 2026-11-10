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
