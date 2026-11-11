# dsh-super-agents

> Super agents for [DeepSeek Harness](https://github.com/deepseek-ai) — persistent AI personas that take on work by themselves and get better every run.

Inspired by the super-agent model in [lobehub/lobehub](https://github.com/lobehub/lobehub) ("agents that pick up tasks on a schedule and compound expertise"), rebuilt from scratch on DSH plugin primitives. No LobeHub code is used; this is an independent implementation of the same ideas.

The engineering baseline — philosophy, domain discipline, idempotent ids, health board, panel principles — follows the official research prototype [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) ("Towards a More Autonomous Agent System"), adapted to a single-host personal scale. See [docs/](docs/) for the shared design documents.

## Design docs (shared with other projects)

| Doc | Contents |
|---|---|
| [000 Philosophy](docs/000-philosophy.md) | Core principle: take as little human attention as possible, give as much value as possible |
| [001 Domain](docs/001-domain.md) | Concepts (Agent / Schedule / Run / Artifact / Playbook / Health), run-state table, rejected concepts |
| [002 Architecture](docs/002-architecture.md) | Reference architecture (prototype) + this plugin's layering, ports and extension points |
| [003 Engineering](docs/003-engineering.md) | Hard problems and solutions; adopted vs. cut prototype mechanisms; refactor roadmap |
| [004 Prompts](docs/004-prompts.md) | Prompt inventory, assembly principles, playbook-as-versioning |
| [005 Panel & Ops](docs/005-panel.md) | Panel answers three questions; health entries; pause contract, backup, troubleshooting |

## What it does

| Capability | Mechanism |
|---|---|
| **Agent = data, not code** | Each agent is a persona card (name, system role, model, cwd, learn flag) in a JSON ledger. CRUD via the `sa_agent` tool or the Web panel. |
| **Background dispatch** | `sa_run` starts a fresh host session per task, injects the persona + accumulated playbook, and collects the artifact when the session goes idle. Runs are visible in the DSH GUI session list. |
| **Self-scheduled work** | `sa_schedule` registers cron / fixed-interval / one-shot triggers. A central tick scans due schedules and auto-dispatches runs — agents "pick up work by themselves". |
| **Gets stronger every run** | After each successful run, a reflection run distills ≤8 reusable lessons into the agent's `playbook.md`, which is injected into every future dispatch (rolling 60-line cap). |
| **Web GUI panel** | A sidebar panel (agents, dispatch box, run feed, result viewer) served by the host's own web server. |
| **Model routing per agent** | Each agent picks `provider/model`; empty falls back to the plugin default, then the host default. |

## Requirements

- DSH `>= 0.2.0` with a profile that provides the `sessionController` service (the `web` profile does).
- Node.js >= 20.

## Install

```bash
# from a local checkout
dsh plugin --profile web add link:/path/to/dsh-super-agents

# or once published to npm
dsh plugin --profile web add dsh-super-agents
```

The bundle patch (`cordis.patch.yml`) mounts the plugin automatically. Restart or hot-reload the host, then open the Web GUI — a **超级智能体 / Super Agents** entry appears in the sidebar.

## Configuration

Override in your profile's own `cordis.patch.yml` (it layers after bundle patches):

```yaml
- insert:
    - id: super-agents
      name: 'dsh-super-agents'
      config:
        dataDir: ''            # ledger root; empty = $DSH_HOME/dsh-super-agents
        defaultModel: ''       # "provider/model" fallback; empty = host default
        maxConcurrent: 2       # parallel worker cap; extra runs queue
        runTimeoutMs: 1800000  # hard per-run limit (30 min), then cancelled
        tickSeconds: 30        # scheduler tick interval (min 10)
        allowLanState: true    # let non-loopback GUI clients use the panel API
        retryMaxAttempts: 2    # total attempts per run on transient errors (1 = no retry)
        retryBaseDelayMs: 2000 # backoff base; attempt 2 waits base, 3 waits 2x, ... cap 60s
        pollIntervalMs: 5000   # session liveness poll cadence
```

Transient failures (HTTP 429/5xx, rate limit, timeouts, `ECONNRESET` / `socket hang up`)
are retried on the **same run row** with exponential backoff, so `attempts` stays visible
and a host restart during backoff cannot exceed the cap. Deterministic failures (bad agent,
missing `sessionController`, `4xx`) fail immediately with an `errorCode`
(`ERR_RUN_SESSION_CONTROLLER` / `ERR_RUN_AGENT_MISSING` / `ERR_RUN_PROMPT` /
`ERR_RUN_TRANSIENT` / `ERR_RUN_TIMEOUT`).

## Tools

| Tool | Purpose |
|---|---|
| `sa_agent` | Persona card CRUD: `create` / `list` / `show` / `update` / `delete` |
| `sa_run` | Dispatch a task to an agent (async; returns `runId`) |
| `sa_runs` | List runs (`queued/running/done/done_no_artifact/failed/timeout/interrupted`) |
| `sa_run_result` | Fetch a run's full artifact |
| `sa_say` | Follow-up message into a run's session |
| `sa_schedule` | Self-dispatch: `set` (cron / everySeconds / at, optional `tz`) / `list` / `delete` |
| `sa_learn` | Append lessons manually, or distill from a finished run |
| `sa_health` | Health board (`scheduler` / `runner` / `sessionController` / `pause`) + global schedule pause/resume |

A matching **skill** (`super-agents`) is registered so the host model knows when and how to use these tools.

## Typical flow

```text
sa_agent create   → "日报员", systemRole=..., model=provider/model
sa_schedule set   → cron "0 9 * * 1-5", tz="Asia/Shanghai", prompt="汇总昨日提交记录写入 report.md"
(auto)            → every weekday 09:00 a run fires, artifact lands in <cwd>/.sa-results/
(auto)            → reflection distills lessons into the agent playbook
sa_run_result     → collect any run's artifact anytime
```

> Cron expressions are matched against the **host's local clock** by default.
> Pass `tz` (an IANA zone such as `Asia/Shanghai`) when the schedule should keep
> wall-clock time in a zone other than the host's — DST is handled for you.

## How a run works

1. `sa_run` persists a run row and enqueues it (concurrency-capped queue).
2. The runner creates a host session (`sessionController.create`), selects the agent's model, and prompts it with: persona + playbook + task + **artifact contract** (write the full deliverable to `<cwd>/.sa-results/<runId>.md`, first line = one-sentence verdict).
3. The runner polls session liveness until idle (or timeout → cancelled).
4. Status is settled from the artifact's presence; if `learn` is on, a reflection run follows and its lessons are appended to the playbook.

Artifacts live inside the run's working directory on purpose: worker sessions run under a workspace-write sandbox and cannot write outside their cwd.

## Data layout

```text
$DSH_HOME/dsh-super-agents/
├── agents.json      # persona cards
├── schedules.json   # self-dispatch triggers
├── runs.json        # run ledger (last 300)
├── logs/<runId>.log # per-run runner log
├── results/         # host-side artifact fallback
├── pause.json       # global schedule-pause flag (survives restarts)
└── playbooks/<agentId>.md
```

Boot sweep: `running` rows → `interrupted` (their sessions died with the old process; replaying could repeat external side effects), `queued` rows are re-enqueued (never started, replay-safe). `GET /api/dsh-super-agents/health` exposes the health board for external monitors.

## Development

```bash
node --test test/unit.test.js   # cron matcher, ledger, playbook, prompts
node test/smoke.test.mjs        # fake-host apply(): tools/routes/scheduler wiring
```

Both test files need the peer deps resolvable; when working inside a DSH install you can point `node_modules` at the host's resolved tree (see test headers).

## Security notes

- The panel API (`/api/dsh-super-agents/*`) is served by the host web server and follows its auth; `allowLanState: false` restricts it to loopback.
- The plugin never stores credentials; models are addressed by `provider/model` and resolved by the host.

## License

[MIT](LICENSE)
