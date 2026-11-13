/**
 * dsh-super-agents — persistent super agents for DeepSeek Harness.
 *
 * Inspired by lobehub/lobehub's super-agent model ("agents that take on work
 * by themselves and get better every week"), rebuilt on DSH primitives:
 *
 *  - Agent config as data (LobeHub `agents` table)      -> JSON ledger + sa_agent tool
 *  - Central tick + fan-out dispatch (tasks automation) -> in-process scheduler (cron/every/at)
 *  - Server-side agent runs (agent-runtime)             -> ctx.sessionController create/selectModel/prompt
 *  - Expertise lessons -> playbook injection            -> per-agent playbook.md + reflection runs
 *
 * Node half: registers sa_* tools, the scheduler, the run runner, and the
 * panel HTTP API. The browser half lives in client.js.
 */
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "super-agents";
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  dataDir: z.string().default(""),
  defaultModel: z.string().default(""),
  defaultCwd: z.string().default(""),
  maxConcurrent: z.number().default(2),
  runTimeoutMs: z.number().default(1800000),
  tickSeconds: z.number().default(30),
  allowLanState: z.boolean().default(true),
  // transient-failure retry (upstream dsh 0.2.2 made model retries configurable):
  // max attempts per run (first try included), exponential backoff base, poll cadence.
  retryMaxAttempts: z.number().default(2),
  retryBaseDelayMs: z.number().default(2000),
  pollIntervalMs: z.number().default(5000),
});

// ---------------------------------------------------------------------------
// storage helpers (atomic JSON ledger files, append-only logs)
// ---------------------------------------------------------------------------

function resolveDataDir(config) {
  const raw = config?.dataDir && String(config.dataDir).trim();
  if (raw) return path.resolve(raw);
  const home = process.env.DSH_HOME || path.join(process.env.HOME || "/tmp", ".dsh");
  return path.join(home, "dsh-super-agents");
}

function ensureDirs(dir) {
  for (const sub of ["", "logs", "results", "playbooks"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function appendLine(file, line) {
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}

// ---------------------------------------------------------------------------
// domain: deterministic ids (docs/001: equal inputs -> equal id -> dedupe)
// ---------------------------------------------------------------------------

function key(...values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// minimal 5-field cron matcher: minute hour dom month dow
// supports *, a, a-b, a,b, *\/n, a-b/n — no month names, dow 0-7 (7=Sunday)
// ---------------------------------------------------------------------------

function cronField(spec, min, max, dowMode) {
  const values = new Set();
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const range = m[1].split("-").map(Number);
      lo = range[0];
      hi = range.length > 1 ? range[1] : (m[2] ? max : range[0]);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(dowMode && v === 7 ? 0 : v);
  }
  return values;
}

function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = fields;
  const spec = {
    minute: cronField(mi, 0, 59, false),
    hour: cronField(ho, 0, 23, false),
    dom: cronField(dom, 1, 31, false),
    month: cronField(mo, 1, 12, false),
    dow: cronField(dow, 0, 7, true),
  };
  if (Object.values(spec).some((v) => v === null)) return null;
  return spec;
}

// IANA zone → wall-clock parts of `date` in that zone (host-local when tz is empty).
// Returns null for an invalid zone so callers can fall back instead of throwing.
function zonedParts(date, tz) {
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    const parts = {};
    for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
    const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
    if (dow === undefined) return null;
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour),
      day: Number(parts.day),
      month: Number(parts.month),
      dow,
      key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
    };
  } catch {
    return null;
  }
}

function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cronMatches(spec, date, tz) {
  const z = zonedParts(date, tz);
  if (z) {
    return (
      spec.minute.has(z.minute) &&
      spec.hour.has(z.hour) &&
      spec.dom.has(z.day) &&
      spec.month.has(z.month) &&
      spec.dow.has(z.dow)
    );
  }
  return (
    spec.minute.has(date.getMinutes()) &&
    spec.hour.has(date.getHours()) &&
    spec.dom.has(date.getDate()) &&
    spec.month.has(date.getMonth() + 1) &&
    spec.dow.has(date.getDay())
  );
}

function minuteKey(date, tz) {
  const z = zonedParts(date, tz);
  if (z) return z.key;
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// ledger: agents / schedules / runs
// ---------------------------------------------------------------------------

function makeLedger(dir) {
  const files = {
    agents: path.join(dir, "agents.json"),
    schedules: path.join(dir, "schedules.json"),
    runs: path.join(dir, "runs.json"),
  };
  return {
    agents: () => readJson(files.agents, []),
    saveAgents: (rows) => writeJsonAtomic(files.agents, rows),
    schedules: () => readJson(files.schedules, []),
    saveSchedules: (rows) => writeJsonAtomic(files.schedules, rows),
    runs: () => readJson(files.runs, []),
    saveRuns: (rows) => writeJsonAtomic(files.runs, rows.slice(-300)),
    logPath: (runId) => path.join(dir, "logs", `${runId}.log`),
    resultPath: (runId) => path.join(dir, "results", `${runId}.md`),
    playbookPath: (agentId) => path.join(dir, "playbooks", `${agentId}.md`),
  };
}

// ---------------------------------------------------------------------------
// health: named entries, single writer each (docs/005). set(name, level, note)
// only the first claimant of a name may write it; late writes after release
// are dropped, so a torn-down component can never resurrect its entries.
// ---------------------------------------------------------------------------

function makeHealth() {
  const owners = new Map(); // name -> writer token
  const entries = new Map(); // name -> { level, note, at }
  return {
    claim(name, token) {
      if (owners.has(name) && owners.get(name) !== token) return false;
      owners.set(name, token);
      return true;
    },
    set(name, level, note = "") {
      if (!owners.has(name)) return false;
      entries.set(name, { level, note, at: new Date().toISOString() });
      return true;
    },
    release(name, token) {
      if (owners.get(name) === token) owners.delete(name);
    },
    list() {
      return [...entries].map(([name, e]) => ({ name, ...e }));
    },
    problems() {
      return [...entries].filter(([, e]) => e.level === "error").map(([name, e]) => ({ name, ...e }));
    },
  };
}

// ---------------------------------------------------------------------------
// pause: global schedule-trigger switch (does not kill running runs).
// Persisted; survives restarts; missed occurrences are never replayed.
// ---------------------------------------------------------------------------

function makePause(dir) {
  const file = path.join(dir, "pause.json");
  return {
    on: () => !!readJson(file, {}).paused,
    set(v) {
      writeJsonAtomic(file, { paused: !!v, at: new Date().toISOString() });
    },
  };
}

const MAX_PLAYBOOK_LINES = 60;

function appendPlaybook(file, text) {
  const incoming = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l));
  if (incoming.length === 0) return { added: 0, total: 0 };
  let existing = [];
  try {
    existing = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch { /* fresh playbook */ }
  const seen = new Set(existing);
  const added = [];
  for (const line of incoming) {
    if (seen.has(line)) continue;
    seen.add(line);
    added.push(line);
  }
  let merged = [...existing, ...added];
  if (merged.length > MAX_PLAYBOOK_LINES) merged = merged.slice(merged.length - MAX_PLAYBOOK_LINES);
  fs.writeFileSync(file, merged.join("\n") + "\n");
  return { added: added.length, total: merged.length };
}

function readPlaybook(file, maxChars = 2400) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return "";
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// task prompt assembly (persona + playbook + task + artifact contract)
// ---------------------------------------------------------------------------

function buildTaskPrompt(agent, taskText, runId, resultPath, playbook) {
  const parts = [];
  parts.push(`[SUPER AGENT RUN ${runId}]`);
  parts.push(`你是超级智能体「${agent.name}」。角色设定：\n${(agent.systemRole || "").trim() || "一个可靠的执行型助手。"}`);
  if (playbook) {
    parts.push(`## 历史经验（此前运行沉淀，优先遵守）\n${playbook}`);
  }
  parts.push(`## 本次任务\n${taskText.trim()}`);
  parts.push(
    `## 输出要求\n` +
      `1. 完成任务后，把**完整交付物**用 write 工具写入文件：${resultPath}（覆盖写入；这是本次运行唯一的正式产物，宿主只读这个文件）。文件第一行写一句话结论，其后写正文/清单/代码等。\n` +
      `2. 若任务无法完成，也要写该文件：第一行以「未完成：」开头并说明原因与已尝试路径。\n` +
      `3. 最终对话回复保持简短（三句以内），不要重复交付物全文。`
  );
  return parts.join("\n\n");
}

function buildReflectionPrompt(agentName, taskText, resultText, resultPath) {
  return (
    `[SUPER AGENT REFLECTION]\n你是「${agentName}」，刚完成一项任务。请从这次执行中提炼**可复用教训**：\n` +
    `- 每条一行 markdown 列表项（以 - 开头），一句话，总计不超过 8 条；\n` +
    `- 只写「下次做类似任务时直接有用」的具体经验：有效步骤、踩过的坑、验证方法、该环境的事实（路径/命令/参数）；\n` +
    `- 不写通用常识，不复述任务内容，不写空泛态度。\n\n## 任务\n${taskText.slice(0, 1500)}\n\n## 交付物（节选）\n${resultText.slice(0, 4000)}\n\n` +
    `## 输出要求\n用 write 工具把教训列表（只有这些 - 开头的行）写入文件：${resultPath}（覆盖写入，这是本次运行唯一产物）。对话回复保持一句以内。`
  );
}

// ---------------------------------------------------------------------------
// retry policy: only transient host/LLM failures retry; deterministic failures
// (bad agent, missing service, prompt contract errors) fail immediately.
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS = [
  /(^|\D)(429|500|502|503|504)(\D|$)/,
  /rate.?limit/i,
  /overloaded|temporarily unavailable|try again later/i,
  /timed?\s?out|ETIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up/i,
];

function isTransientError(err) {
  const message = String((err && (err.message || err)) || "");
  return message ? TRANSIENT_PATTERNS.some((re) => re.test(message)) : false;
}

// attempt 2 -> base, attempt 3 -> 2x base, ... capped at 60s.
function retryDelay(attempt, baseDelayMs) {
  const base = Math.max(1, Number(baseDelayMs) || 2000);
  const exponent = Math.max(0, Number(attempt) - 2);
  return Math.min(base * 2 ** exponent, 60000);
}

// ---------------------------------------------------------------------------
// runner: sessionController-backed agent runs with a small concurrency queue
// ---------------------------------------------------------------------------

function makeRunner(ctx, config, ledger, state, health) {
  const queue = [];
  let active = 0;
  let consecutiveFailures = 0;
  // Live runs, keyed by runId: `{ sessionId, cancelled, controller }`. Kept in
  // memory so an operator-initiated cancel can reach the session that is
  // actually in flight (the LobeHub "cancel a running sub-agent" equivalent);
  // a ledger row alone cannot address a session mid-run.
  const inFlight = new Map();
  const retryMaxAttempts = Math.max(1, Math.min(5, Number(config.retryMaxAttempts) || 2));
  const retryBaseDelayMs = Math.max(50, Math.min(60000, Number(config.retryBaseDelayMs) || 2000));
  const pollIntervalMs = Math.max(10, Math.min(60000, Number(config.pollIntervalMs) || 5000));
  health.claim("runner", "runner");
  health.claim("sessionController", "runner");

  function reportRunnerHealth() {
    if (consecutiveFailures >= 3) health.set("runner", "error", `${consecutiveFailures} consecutive run failures`);
    else if (consecutiveFailures > 0) health.set("runner", "warn", `${consecutiveFailures} consecutive run failures`);
    else health.set("runner", "ok", "");
  }

  function log(runId, line) {
    try {
      appendLine(ledger.logPath(runId), `[${new Date().toISOString()}] ${line}`);
    } catch { /* log must never break a run */ }
  }

  function patchRun(runId, patch) {
    const runs = ledger.runs();
    const row = runs.find((r) => r.id === runId);
    if (!row) return null;
    Object.assign(row, patch);
    ledger.saveRuns(runs);
    state.emit();
    return row;
  }

  function getSessionController() {
    let sc = null;
    try { sc = typeof ctx.get === "function" ? ctx.get("sessionController") : null; } catch { sc = null; }
    if (!sc && ctx.sessionController) sc = ctx.sessionController;
    return sc;
  }

  function makeRun(agent, opts) {
    // Deterministic ids for scheduled triggers: equal (scheduleId, occurrence)
    // always maps to one run row, so a double tick or a crash-replay cannot
    // double-dispatch. Manual runs keep randomness (same-second dispatch is real).
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const id = opts.id || `r-${stamp}-${randomUUID().slice(0, 8)}`;
    const cwd = opts.cwd || agent.cwd || config.defaultCwd || process.cwd();
    // The artifact must live INSIDE the run cwd: worker sessions run under a
    // workspace-write sandbox and are denied writes outside their own cwd.
    let resultPath = path.join(cwd, ".sa-results", `${id}.md`);
    try {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    } catch {
      resultPath = ledger.resultPath(id); // cwd not writable yet: host-side fallback
    }
    const run = {
      id,
      agentId: agent.id,
      agentName: agent.name,
      kind: opts.kind || "manual",
      trigger: opts.trigger || "manual",
      taskText: opts.taskText || "",
      reflectionSource: opts.reflectionSource,
      cwd,
      model: opts.model || "",
      resultPath,
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
      sessionId: "",
      onFinish: null,
    };
    // persist the row now: patchRun below only updates existing rows, and a
    // crash between enqueue and execute would otherwise lose the run entirely.
    const runs = ledger.runs();
    if (opts.id && runs.some((r) => r.id === id)) return null; // occurrence already dispatched (dedupe)
    runs.push({ ...run, onFinish: undefined, reflectionSource: undefined });
    ledger.saveRuns(runs);
    state.emit();
    return run;
  }

  function requeuePersisted() {
    // startup replay: queued rows never started, so re-enqueuing is safe.
    for (const row of ledger.runs()) {
      if (row.status === "queued") {
        const agent = ledger.agents().find((a) => a.id === row.agentId);
        if (!agent) continue;
        queue.push({ ...row, onFinish: null });
      }
    }
    if (queue.length) void pump();
  }

  function enqueue(run) {
    queue.push(run);
    void pump();
    return run;
  }

  function settleCancelled(runId) {
    const row = ledger.runs().find((r) => r.id === runId);
    // queued cancels are already settled by cancelRun; do not rewrite endedAt.
    if (row && row.status === "cancelled") return;
    patchRun(runId, {
      status: "cancelled",
      endedAt: new Date().toISOString(),
      error: "cancelled by operator",
    });
    log(runId, "cancelled");
  }

  // Cancel a run the operator no longer wants. A queued row is dropped from the
  // queue and settled immediately; a running row gets a cancel signal + session
  // cancel and is settled by execute()'s poll loop, so the runner stays the only
  // writer of a live run's status (no racing writes on runs.json).
  function cancelRun(runId) {
    const row = ledger.runs().find((r) => r.id === runId);
    if (!row) return { ok: false, error: "run not found" };
    if (row.status !== "queued" && row.status !== "running") {
      return { ok: false, error: `run already ${row.status}` };
    }
    const flight = inFlight.get(runId);
    if (flight) {
      flight.cancelled = true;
      try { flight.controller.abort(); } catch { /* best effort */ }
      const sc = getSessionController();
      if (sc && typeof sc.cancel === "function" && flight.sessionId) {
        try { sc.cancel({ sessionId: flight.sessionId }); } catch { /* best effort */ }
      }
      log(runId, "cancel requested (running)");
      return { ok: true, runId, status: "cancelling" };
    }
    const idx = queue.findIndex((r) => r.id === runId);
    if (idx >= 0) queue.splice(idx, 1);
    patchRun(runId, {
      status: "cancelled",
      endedAt: new Date().toISOString(),
      error: "cancelled before the session started",
    });
    log(runId, "cancelled (queued)");
    return { ok: true, runId, status: "cancelled" };
  }

  async function pump() {
    while (active < (config.maxConcurrent || 2) && queue.length > 0) {
      const run = queue.shift();
      active += 1;
      void execute(run)
        .catch((err) => {
          // a cancelled run may fail on its way out (aborted prompt, dead
          // session): cancellation wins over the failure it induced.
          const flight = inFlight.get(run.id);
          if (flight && flight.cancelled) { settleCancelled(run.id); return; }
          const message = String((err && err.message) || err).slice(0, 400);
          const attempt = run.attempts || 1;
          const transient = isTransientError(err);
          // transient failure with attempts left: back off and replay the *same*
          // run row (attempts persisted, so replay-after-restart stays bounded).
          if (transient && attempt < retryMaxAttempts) {
            const delay = retryDelay(attempt + 1, retryBaseDelayMs);
            patchRun(run.id, { status: "queued", attempts: attempt, error: `transient failure; retry ${attempt + 1}/${retryMaxAttempts} in ${delay}ms: ${message}` });
            log(run.id, `retry ${attempt + 1}/${retryMaxAttempts} in ${delay}ms: ${message}`);
            setTimeout(() => enqueue(run), delay);
            return;
          }
          consecutiveFailures += 1;
          reportRunnerHealth();
          patchRun(run.id, {
            status: "failed",
            attempts: attempt,
            endedAt: new Date().toISOString(),
            error: message,
            errorCode: transient ? "ERR_RUN_TRANSIENT" : (err && err.code ? err.code : "ERR_RUN_FAILED"),
          });
          log(run.id, `failed: ${message}`);
        })
        .then(() => {
          // completion hook (reflection -> playbook append)
          if (typeof run.onFinish === "function") {
            try {
              const finalRow = ledger.runs().find((r) => r.id === run.id);
              if (finalRow && ["done", "done_no_artifact"].includes(finalRow.status)) run.onFinish(finalRow);
            } catch { /* hook failure never breaks the queue */ }
          }
        })
        .finally(() => {
          inFlight.delete(run.id);
          active -= 1;
          void pump();
        });
    }
  }

  async function execute(run) {
    // a cancel may land while the row sits in a retry backoff: the timer still
    // re-enqueues it, so the dispatch itself has to re-check the ledger.
    const current = ledger.runs().find((r) => r.id === run.id);
    if (current && current.status === "cancelled") {
      log(run.id, "skip dispatch: cancelled before start");
      return;
    }
    const sc = getSessionController();
    if (!sc || typeof sc.create !== "function" || typeof sc.prompt !== "function") {
      health.set("sessionController", "error", "宿主会话服务不可用：run 依赖 sessionController（web profile 默认可用）");
      const err = new Error("sessionController 服务不可用：run 依赖宿主会话服务（web profile 默认可用）");
      err.code = "ERR_RUN_SESSION_CONTROLLER";
      throw err;
    }
    health.set("sessionController", "ok", "");
    const agent = ledger.agents().find((a) => a.id === run.agentId);
    if (!agent) {
      const err = new Error(`agent ${run.agentId} not found`);
      err.code = "ERR_RUN_AGENT_MISSING";
      throw err;
    }
    const attempt = (run.attempts || 0) + 1;
    run.attempts = attempt;
    const playbook = agent.learn === false ? "" : readPlaybook(ledger.playbookPath(agent.id));
    const promptText = run.kind === "reflection"
      ? buildReflectionPrompt(agent.name, run.taskText || "", run.reflectionSource || "", run.resultPath)
      : buildTaskPrompt(agent, run.taskText, run.id, run.resultPath, playbook);

    patchRun(run.id, { status: "running", attempts: attempt, startedAt: new Date().toISOString() });
    log(run.id, `start agent=${agent.name} kind=${run.kind} attempt=${attempt}/${retryMaxAttempts} cwd=${run.cwd}`);

    const controller = new AbortController();
    const flight = { sessionId: "", cancelled: false, controller };
    inFlight.set(run.id, flight);

    const created = await sc.create({ cwd: run.cwd });
    const sessionId = created.sessionId;
    flight.sessionId = sessionId;
    patchRun(run.id, { sessionId });
    log(run.id, `session ${sessionId}`);
    if (flight.cancelled) { settleCancelled(run.id); return; }

    const modelStr = run.model || agent.model || config.defaultModel || "";
    if (modelStr && typeof sc.selectModel === "function") {
      const slash = modelStr.indexOf("/");
      if (slash > 0) {
        try {
          await sc.selectModel({ sessionId, provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) });
          log(run.id, `model ${modelStr}`);
        } catch (err) {
          log(run.id, `selectModel failed (keep default): ${String((err && err.message) || err).slice(0, 200)}`);
        }
      }
    }

    const timer = setTimeout(() => controller.abort(), config.runTimeoutMs || 1800000);
    try {
      await sc.prompt(
        { requestId: `sa-${run.id}`, sessionId, mode: "queue", content: [{ type: "text", text: promptText }] },
        controller.signal,
      );
      log(run.id, "prompt accepted");
    } catch (err) {
      clearTimeout(timer);
      const message = String((err && err.message) || err).slice(0, 300);
      const wrapped = new Error(`prompt failed: ${message}`);
      wrapped.code = "ERR_RUN_PROMPT";
      throw wrapped;
    }

    // poll session liveness until it stops running (same signal the GUI list uses)
    const startedAt = Date.now();
    const limit = config.runTimeoutMs || 1800000;
    let settled = false;
    while (Date.now() - startedAt < limit) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (flight.cancelled) break;
      let running = true;
      try {
        const list = await sc.list({}, new AbortController().signal);
        const row = (list.items || []).find((i) => i.sessionId === sessionId);
        running = row ? row.running : false;
      } catch { /* transient read error: keep waiting */ }
      if (flight.cancelled) break;
      if (!running) { settled = true; break; }
    }
    clearTimeout(timer);

    if (flight.cancelled) {
      settleCancelled(run.id);
      return;
    }

    if (!settled) {
      try { sc.cancel({ sessionId }); } catch { /* best effort */ }
      consecutiveFailures += 1;
      reportRunnerHealth();
      patchRun(run.id, { status: "timeout", attempts: run.attempts, endedAt: new Date().toISOString(), error: `run exceeded ${limit}ms; cancelled`, errorCode: "ERR_RUN_TIMEOUT" });
      log(run.id, "timeout");
      return;
    }

    let resultHead = "";
    try {
      resultHead = fs.readFileSync(run.resultPath, "utf8").slice(0, 200);
    } catch { /* no artifact */ }
    patchRun(run.id, {
      status: resultHead ? "done" : "done_no_artifact",
      endedAt: new Date().toISOString(),
      resultHead: (resultHead.split("\n")[0] || "").slice(0, 160),
    });
    if (resultHead) {
      consecutiveFailures = 0;
      reportRunnerHealth();
    }
    log(run.id, `finished status=${resultHead ? "done" : "done_no_artifact"}`);

    // self-improvement: reflect and append lessons (LobeHub expertise loop)
    if (run.kind !== "reflection" && agent.learn !== false) {
      let resultFull = "";
      try { resultFull = fs.readFileSync(run.resultPath, "utf8"); } catch { /* none */ }
      if (resultFull.trim()) {
        const refl = makeRun(agent, {
          kind: "reflection",
          trigger: "reflection",
          taskText: run.taskText,
          reflectionSource: resultFull,
          cwd: run.cwd,
          model: run.model,
        });
        refl.onFinish = (finalRun) => {
          try {
            const lessons = fs.readFileSync(finalRun.resultPath, "utf8");
            const r = appendPlaybook(ledger.playbookPath(agent.id), lessons);
            log(finalRun.id, `playbook +${r.added} (total ${r.total})`);
          } catch { /* reflection without artifact is a no-op */ }
        };
        enqueue(refl);
      }
    }
  }

  return { enqueue, log, patchRun, makeRun, requeuePersisted, cancelRun, queueSize: () => queue.length, activeCount: () => active };
}

// ---------------------------------------------------------------------------
// scheduler: central tick scanning schedule rows (LobeHub scheduleDispatch)
// ---------------------------------------------------------------------------

function makeScheduler(config, ledger, runner, state, health, pause) {
  let timer = null;
  let tickFailures = 0;
  health.claim("scheduler", "scheduler");
  health.claim("pause", "scheduler");

  function dueSchedules(now) {
    const out = [];
    for (const s of ledger.schedules()) {
      if (!s.enabled) continue;
      if (s.kind === "at") {
        if (!s.firedAt && Date.parse(s.at) <= now.getTime()) out.push({ s, occ: s.at });
        continue;
      }
      if (s.kind === "every") {
        const base = s.lastFiredAt ? Date.parse(s.lastFiredAt) : Date.parse(s.createdAt);
        const interval = (s.everySeconds || 3600) * 1000;
        if (now.getTime() - base >= interval) {
          // deterministic occurrence: the scheduled boundary, not the tick time
          out.push({ s, occ: new Date(base + interval).toISOString() });
        }
        continue;
      }
      if (s.kind === "cron") {
        const spec = parseCron(s.cron);
        if (!spec) continue;
        const key = minuteKey(now, s.tz);
        if (s.lastFiredMinute === key) continue; // occurrence dedup
        if (cronMatches(spec, now, s.tz)) out.push({ s, occ: key });
      }
    }
    return out;
  }

  function fire(s, occ) {
    const rows = ledger.schedules();
    const row = rows.find((x) => x.id === s.id);
    if (!row) return;
    if (row.kind === "at") row.firedAt = new Date().toISOString();
    if (row.kind === "cron") row.lastFiredMinute = occ;
    if (row.kind === "every") row.lastFiredAt = new Date().toISOString();
    ledger.saveSchedules(rows);
    const agent = ledger.agents().find((a) => a.id === row.agentId);
    if (!agent || agent.enabled === false) return;
    const run = runner.makeRun(agent, {
      id: `r-${key("run", row.id, occ)}`, // deterministic: replay-safe (docs/001)
      kind: "scheduled",
      trigger: "schedule",
      taskText: row.prompt,
      cwd: row.cwd,
      model: row.model,
    });
    if (run) runner.enqueue(run);
    state.emit();
  }

  function tick() {
    try {
      health.set("pause", pause.on() ? "warn" : "ok", pause.on() ? "调度已暂停：不会触发新任务（运行中的不受影响）" : "");
      if (pause.on()) return; // pause stops triggering; missed occurrences are not replayed
      const now = new Date();
      for (const { s, occ } of dueSchedules(now)) fire(s, occ);
      if (tickFailures > 0) tickFailures = 0;
      health.set("scheduler", "ok", "");
    } catch (err) {
      tickFailures += 1;
      health.set("scheduler", tickFailures >= 3 ? "error" : "warn", `tick failed x${tickFailures}: ${String(err && err.message || err).slice(0, 160)}`);
      console.warn("[dsh-super-agents] scheduler tick failed:", err && err.message);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, Math.max(10, config.tickSeconds || 30) * 1000);
    if (typeof timer.unref === "function") timer.unref();
    setTimeout(tick, 3000); // catch-up shortly after boot
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render(_args, value) {
    return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
  },
};

function json(value) {
  return JSON.stringify(value, null, 2);
}

function parseModelString(model) {
  if (!model) return true;
  return model.includes("/");
}

// Follow-up delivery to a run's session (LobeHub #22377: steer a running
// sub-agent instead of refusing the follow-up). A run that is still executing
// takes the message as `steer`, which the host injects before its next step so
// the operator can correct course mid-run; an ended run takes it as `queue`, a
// normal follow-up turn. `requestedMode` lets the operator force either one.
function sayMode(run, requestedMode) {
  if (requestedMode === "queue" || requestedMode === "steer") return requestedMode;
  return run && run.status === "running" ? "steer" : "queue";
}

function sayRequest(run, message, requestedMode, requestId) {
  return {
    requestId: requestId || `sa-say-${randomUUID().slice(0, 8)}`,
    sessionId: (run && run.sessionId) || "",
    mode: sayMode(run, requestedMode),
    content: [{ type: "text", text: String(message == null ? "" : message) }],
  };
}

// The host refuses `steer` with `session/steer-unavailable` once no turn is
// active (the run ended between the status read and the prompt). Only that
// deterministic rejection falls back to `queue`; any other failure propagates,
// because a blind retry after an unknown outcome could deliver twice.
function isSteerUnavailable(err) {
  const code = String((err && (err.code || err.message)) || err || "").toLowerCase();
  return code.includes("steer") && (code.includes("unavailable") || code.includes("no active"));
}

async function deliverSay(run, message, requestedMode, sc, opts = {}) {
  const requestId = (opts && opts.requestId) || `sa-say-${randomUUID().slice(0, 8)}`;
  const signal = (opts && opts.signal) || new AbortController().signal;
  const first = sayRequest(run, message, requestedMode, requestId);
  try {
    await sc.prompt(first, signal);
    return { mode: first.mode, steered: first.mode === "steer", fallback: false };
  } catch (err) {
    if (first.mode !== "steer" || !isSteerUnavailable(err)) throw err;
    const queued = { ...first, requestId: `${requestId}-queue`, mode: "queue" };
    await sc.prompt(queued, signal);
    return { mode: queued.mode, steered: false, fallback: true };
  }
}

function registerTools(ctx, config, ledger, runner, scheduler, state, health, pause) {
  ctx.tools.register(defineTool({
    name: "sa_agent",
    description:
      "超级智能体注册表：创建/查看/修改/删除持久化的 agent 角色卡（配置即数据）。角色卡包含名字、系统人设、默认模型(provider/model)、工作目录、是否自学习(learn)。创建后用 sa_run 派活，或 sa_schedule 让它自主领活。",
    parameters: {
      action: { type: "string", required: true, enum: ["create", "list", "show", "update", "delete"], description: "操作" },
      agentId: { type: "string", description: "create 之外的操作必填" },
      name: { type: "string", description: "create/update：agent 名字" },
      systemRole: { type: "string", description: "create/update：系统人设（角色设定提示词）" },
      model: { type: "string", description: "create/update：默认模型 provider/model（留空用插件默认）" },
      cwd: { type: "string", description: "create/update：干活的工作目录" },
      learn: { type: "boolean", description: "create/update：是否在每次运行后自动蒸馏经验教训进 playbook（默认 true）" },
      enabled: { type: "boolean", description: "update：停用/启用" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const agents = ledger.agents();
      if (args.action === "create") {
        if (!args.name || !String(args.name).trim()) throw new Error("create 需要 name");
        if (args.model && !parseModelString(args.model)) throw new Error("model 必须是 provider/model 格式");
        const row = {
          id: `a-${randomUUID().slice(0, 8)}`,
          name: String(args.name).trim(),
          systemRole: args.systemRole || "",
          model: args.model || "",
          cwd: args.cwd || config.defaultCwd || "",
          learn: args.learn !== false,
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        agents.push(row);
        ledger.saveAgents(agents);
        state.emit();
        return json({ ok: true, agent: row });
      }
      if (args.action === "list") {
        return json({ ok: true, agents: agents.map((a) => ({ ...a, playbookLines: readPlaybook(ledger.playbookPath(a.id)).split("\n").filter(Boolean).length })) });
      }
      const row = agents.find((a) => a.id === args.agentId);
      if (!row) throw new Error(`agent 不存在: ${args.agentId}`);
      if (args.action === "show") {
        return json({ ok: true, agent: row, playbook: readPlaybook(ledger.playbookPath(row.id)) });
      }
      if (args.action === "update") {
        if (args.name !== undefined) row.name = String(args.name).trim();
        if (args.systemRole !== undefined) row.systemRole = args.systemRole;
        if (args.model !== undefined) {
          if (args.model && !parseModelString(args.model)) throw new Error("model 必须是 provider/model 格式");
          row.model = args.model;
        }
        if (args.cwd !== undefined) row.cwd = args.cwd;
        if (args.learn !== undefined) row.learn = args.learn !== false;
        if (args.enabled !== undefined) row.enabled = args.enabled !== false;
        ledger.saveAgents(agents);
        state.emit();
        return json({ ok: true, agent: row });
      }
      // delete
      ledger.saveAgents(agents.filter((a) => a.id !== row.id));
      ledger.saveSchedules(ledger.schedules().filter((s) => s.agentId !== row.id));
      state.emit();
      return json({ ok: true, deleted: row.id });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_run",
    description:
      "给某个超级智能体派活：新建独立会话、注入角色人设与历史经验(playbook)、后台执行任务，产物写入 result 文件。立即返回 runId，用 sa_runs 看状态、sa_run_result 取结果。同一 agent 可并行多次派活。",
    parameters: {
      agentId: { type: "string", required: true, description: "目标 agent id（sa_agent list 可查）" },
      prompt: { type: "string", required: true, description: "本次任务要它做什么（具体、可验收）" },
      cwd: { type: "string", description: "覆盖工作目录（可选）" },
      model: { type: "string", description: "覆盖模型 provider/model（可选）" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const agent = ledger.agents().find((a) => a.id === args.agentId);
      if (!agent) throw new Error(`agent 不存在: ${args.agentId}`);
      if (agent.enabled === false) throw new Error(`agent 已停用: ${agent.id}`);
      if (args.model && !parseModelString(args.model)) throw new Error("model 必须是 provider/model 格式");
      const run = runner.makeRun(agent, {
        kind: "manual",
        trigger: "tool",
        taskText: args.prompt,
        cwd: args.cwd,
        model: args.model,
      });
      runner.enqueue(run);
      return json({ ok: true, runId: run.id, agent: agent.name, status: "queued", queue: runner.queueSize(), active: runner.activeCount() });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_runs",
    description: "列出超级智能体的运行记录（状态 queued/running/done/done_no_artifact/failed/timeout），可按 agent 与状态过滤。",
    parameters: {
      agentId: { type: "string", description: "只看某 agent（可选）" },
      status: { type: "string", enum: ["queued", "running", "done", "done_no_artifact", "failed", "timeout"], description: "按状态过滤（可选）" },
      limit: { type: "integer", description: "返回条数，默认 20，最新在前" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      let rows = ledger.runs().slice().reverse();
      if (args.agentId) rows = rows.filter((r) => r.agentId === args.agentId);
      if (args.status) rows = rows.filter((r) => r.status === args.status);
      const limit = Math.max(1, Math.min(100, args.limit || 20));
      return json({ ok: true, runs: rows.slice(0, limit).map(({ taskText, ...r }) => ({ ...r, taskText: (taskText || "").slice(0, 120) })) });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_run_result",
    description: "读取某次运行的交付物（result 文件全文）与运行元信息；running 时返回当前进度日志尾部。",
    parameters: {
      runId: { type: "string", required: true, description: "运行 id" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const run = ledger.runs().find((r) => r.id === args.runId);
      if (!run) throw new Error(`run 不存在: ${args.runId}`);
      let artifact = "";
      try { artifact = fs.readFileSync(run.resultPath, "utf8"); } catch { /* not yet */ }
      if (!artifact) {
        let tail = "";
        try {
          const lines = fs.readFileSync(run.logPath || ledger.logPath(run.id), "utf8").split("\n");
          tail = lines.slice(-20).join("\n");
        } catch { /* none */ }
        return json({ ok: true, run, artifact: null, logTail: tail });
      }
      return json({ ok: true, run, artifact: artifact.slice(0, 60000) });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_say",
    description:
      "对某次运行所在的会话追加指令（续聊/纠偏）：运行中的 Run 以 steer 注入，在当前轮下一个步骤前生效（不打断产物，可中途改方向）；已结束的 Run 以 queue 追加新一轮。`mode` 可强制 queue（总是新开一轮）或 steer。",
    parameters: {
      runId: { type: "string", required: true, description: "目标运行 id（须已有 sessionId）" },
      message: { type: "string", required: true, description: "追加的消息" },
      mode: { type: "string", enum: ["auto", "queue", "steer"], description: "auto（默认）：运行中用 steer、已结束用 queue；queue：总是追加新一轮；steer：仅在运行中注入" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const run = ledger.runs().find((r) => r.id === args.runId);
      if (!run) throw new Error(`run 不存在: ${args.runId}`);
      if (!run.sessionId) throw new Error("该运行还没有会话（尚未开始执行）");
      const message = String(args.message == null ? "" : args.message);
      if (!message.trim()) throw new Error("消息不能为空");
      let sc = null;
      try { sc = typeof ctx.get === "function" ? ctx.get("sessionController") : null; } catch { sc = null; }
      if (!sc) sc = ctx.sessionController;
      if (!sc || typeof sc.prompt !== "function") throw new Error("sessionController 不可用");
      const requested = args.mode === "queue" || args.mode === "steer" ? args.mode : null;
      const delivered = await deliverSay(run, message, requested, sc);
      try {
        appendLine(run.logPath || ledger.logPath(run.id), `[${new Date().toISOString()}] say ${delivered.mode}${delivered.fallback ? " (steer unavailable, queued)" : ""}`);
      } catch { /* logging must never lose the delivery result */ }
      return json({
        ok: true,
        runId: run.id,
        sessionId: run.sessionId,
        mode: delivered.mode,
        steered: delivered.steered,
        fallback: delivered.fallback,
        accepted: true,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_schedule",
    description:
      "超级智能体自主领活的调度器：set 登记（cron 表达式 / everySeconds 固定间隔 / at 一次性时刻 + 任务文本），list 查看，delete 删除。到点自动新建 run 执行任务；cron 按分钟去重不会重复触发。",
    parameters: {
      action: { type: "string", required: true, enum: ["set", "list", "delete"], description: "操作" },
      agentId: { type: "string", description: "set 必填：目标 agent" },
      prompt: { type: "string", description: "set 必填：到点执行的任务文本" },
      cron: { type: "string", description: "set：5 字段 cron（分 时 日 月 周），如 '0 9 * * 1-5' 工作日九点" },
      tz: { type: "string", description: "set：cron 的 IANA 时区（如 Asia/Shanghai）；留空按主机本地时区" },
      everySeconds: { type: "integer", description: "set：固定间隔秒数（>=60）" },
      at: { type: "string", description: "set：一次性时刻 ISO 字符串（如 2026-11-11T09:00:00+08:00）" },
      title: { type: "string", description: "set：调度名（可选）" },
      scheduleId: { type: "string", description: "delete 必填" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const rows = ledger.schedules();
      if (args.action === "set") {
        const agent = ledger.agents().find((a) => a.id === args.agentId);
        if (!agent) throw new Error(`agent 不存在: ${args.agentId}`);
        if (!args.prompt) throw new Error("set 需要 prompt");
        const kinds = [args.cron, args.everySeconds, args.at].filter(Boolean);
        if (kinds.length !== 1) throw new Error("set 需要且仅需要 cron / everySeconds / at 之一");
        let kind;
        let spec = {};
        if (args.cron) {
          if (!parseCron(args.cron)) throw new Error(`非法 cron 表达式: ${args.cron}（需 5 字段：分 时 日 月 周）`);
          if (args.tz && !isValidTz(String(args.tz))) throw new Error(`非法时区: ${args.tz}（需 IANA 名，如 Asia/Shanghai）`);
          kind = "cron";
          spec = { cron: String(args.cron).trim(), tz: args.tz ? String(args.tz).trim() : "" };
        } else if (args.everySeconds) {
          if (args.everySeconds < 60) throw new Error("everySeconds 至少 60");
          kind = "every";
          spec = { everySeconds: args.everySeconds };
        } else {
          if (Number.isNaN(Date.parse(args.at))) throw new Error(`非法时刻: ${args.at}`);
          kind = "at";
          spec = { at: new Date(args.at).toISOString() };
        }
        const row = {
          id: `s-${randomUUID().slice(0, 8)}`,
          agentId: agent.id,
          agentName: agent.name,
          title: args.title || "",
          prompt: args.prompt,
          kind,
          ...spec,
          enabled: true,
          createdAt: new Date().toISOString(),
          lastFiredAt: "",
          lastFiredMinute: "",
          firedAt: "",
        };
        rows.push(row);
        ledger.saveSchedules(rows);
        state.emit();
        return json({ ok: true, schedule: row });
      }
      if (args.action === "list") {
        return json({ ok: true, schedules: rows });
      }
      const row = rows.find((s) => s.id === args.scheduleId);
      if (!row) throw new Error(`schedule 不存在: ${args.scheduleId}`);
      ledger.saveSchedules(rows.filter((s) => s.id !== row.id));
      state.emit();
      return json({ ok: true, deleted: row.id });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_learn",
    description:
      "手动把一段经验教训追加进某 agent 的 playbook（下次派活自动注入其提示词）。也可在 agent 上开 learn 让每次运行后自动蒸馏。传 fromRun 时从该运行的交付物自动蒸馏。",
    parameters: {
      agentId: { type: "string", required: true, description: "目标 agent" },
      lessons: { type: "string", description: "教训文本，每行一条 '- 教训'；与 fromRun 二选一" },
      fromRun: { type: "string", description: "从某 runId 的交付物后台蒸馏教训" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const agent = ledger.agents().find((a) => a.id === args.agentId);
      if (!agent) throw new Error(`agent 不存在: ${args.agentId}`);
      if (args.fromRun) {
        const run = ledger.runs().find((r) => r.id === args.fromRun);
        if (!run) throw new Error(`run 不存在: ${args.fromRun}`);
        let source = "";
        try { source = fs.readFileSync(run.resultPath, "utf8"); } catch { throw new Error("该运行没有交付物可蒸馏"); }
        const refl = runner.makeRun(agent, { kind: "reflection", trigger: "learn", taskText: run.taskText, reflectionSource: source, cwd: run.cwd });
        refl.onFinish = (finalRun) => {
          try {
            appendPlaybook(ledger.playbookPath(agent.id), fs.readFileSync(finalRun.resultPath, "utf8"));
          } catch { /* noop */ }
        };
        runner.enqueue(refl);
        return json({ ok: true, started: refl.id, note: "后台蒸馏中，完成后自动并入 playbook" });
      }
      if (!args.lessons) throw new Error("传 lessons 或 fromRun 之一");
      const r = appendPlaybook(ledger.playbookPath(agent.id), args.lessons);
      return json({ ok: true, added: r.added, total: r.total });
    },
  }));

  ctx.tools.register(defineTool({
    name: "sa_health",
    description:
      "超级智能体系统健康与暂停开关：list 查看健康条目（scheduler/runner/sessionController/pause）与队列水位；pause 暂停调度触发（不杀运行中的 run，错过的 occurrence 不补发）；resume 恢复。对应理念「agent 吵了就暂停它」。",
    parameters: {
      action: { type: "string", required: true, enum: ["list", "pause", "resume"], description: "操作" },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.action === "pause") {
        pause.set(true);
        state.emit();
        return json({ ok: true, paused: true, note: "调度已暂停：不再触发新任务；运行中的 run 不受影响；错过的 occurrence 不补发" });
      }
      if (args.action === "resume") {
        pause.set(false);
        state.emit();
        return json({ ok: true, paused: false, note: "调度已恢复" });
      }
      return json({
        ok: true,
        paused: pause.on(),
        health: health.list(),
        problems: health.problems(),
        queue: runner.queueSize(),
        active: runner.activeCount(),
      });
    },
  }));
}

// ---------------------------------------------------------------------------
// panel HTTP API (same ledger as the tools; loopback unless allowLanState)
// ---------------------------------------------------------------------------

function writeJson(res, code, value) {
  try {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  } catch { /* client gone */ }
}

function isAllowedRequest(req, allowLan) {
  if (allowLan) return true;
  const ip = String(req.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 262144) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function registerRoutes(ctx, config, ledger, runner, state, health, pause) {
  ctx.inject(["webServer"], (wctx) => {
    const allowLan = config.allowLanState !== false;
    const routes = [];

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/health",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        return writeJson(res, 200, {
          ok: health.problems().length === 0,
          paused: pause.on(),
          health: health.list(),
          problems: health.problems(),
          queue: runner.queueSize(),
          active: runner.activeCount(),
        });
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/pause",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if ((req.method || "GET") !== "POST") return writeJson(res, 405, { error: "POST only" });
        try {
          const body = await readBody(req);
          pause.set(body.paused === true);
          state.emit();
          return writeJson(res, 200, { ok: true, paused: pause.on() });
        } catch (err) {
          return writeJson(res, 400, { error: String((err && err.message) || err).slice(0, 200) });
        }
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/state",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        return writeJson(res, 200, {
          ok: true,
          agents: ledger.agents().map((a) => ({ ...a, playbook: readPlaybook(ledger.playbookPath(a.id), 1200) })),
          schedules: ledger.schedules(),
          runs: ledger.runs().slice(-60).reverse(),
          queue: runner.queueSize(),
          active: runner.activeCount(),
          paused: pause.on(),
          health: health.list(),
        });
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/run",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if ((req.method || "GET") !== "POST") return writeJson(res, 405, { error: "POST only" });
        try {
          const body = await readBody(req);
          const agent = ledger.agents().find((a) => a.id === body.agentId);
          if (!agent) return writeJson(res, 404, { error: "agent not found" });
          if (!body.prompt || !String(body.prompt).trim()) return writeJson(res, 400, { error: "prompt required" });
          const run = runner.makeRun(agent, { kind: "manual", trigger: "panel", taskText: String(body.prompt) });
          runner.enqueue(run);
          return writeJson(res, 200, { ok: true, runId: run.id });
        } catch (err) {
          return writeJson(res, 400, { error: String(err && err.message || err).slice(0, 200) });
        }
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/run-cancel",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if ((req.method || "GET") !== "POST") return writeJson(res, 405, { error: "POST only" });
        try {
          const body = await readBody(req);
          const out = runner.cancelRun(String(body.runId || ""));
          if (!out.ok) return writeJson(res, out.error === "run not found" ? 404 : 409, out);
          return writeJson(res, 200, out);
        } catch (err) {
          return writeJson(res, 400, { error: String(err && err.message || err).slice(0, 200) });
        }
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/agent-save",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if ((req.method || "GET") !== "POST") return writeJson(res, 405, { error: "POST only" });
        try {
          const body = await readBody(req);
          const agents = ledger.agents();
          if (body.id) {
            const row = agents.find((a) => a.id === body.id);
            if (!row) return writeJson(res, 404, { error: "agent not found" });
            for (const k of ["name", "systemRole", "model", "cwd", "enabled"]) if (body[k] !== undefined) row[k] = body[k];
            if (body.learn !== undefined) row.learn = body.learn !== false;
            ledger.saveAgents(agents);
            state.emit();
            return writeJson(res, 200, { ok: true, agent: row });
          }
          if (!body.name) return writeJson(res, 400, { error: "name required" });
          const row = {
            id: `a-${randomUUID().slice(0, 8)}`,
            name: String(body.name).trim(),
            systemRole: body.systemRole || "",
            model: body.model || "",
            cwd: body.cwd || config.defaultCwd || "",
            learn: body.learn !== false,
            enabled: true,
            createdAt: new Date().toISOString(),
          };
          agents.push(row);
          ledger.saveAgents(agents);
          state.emit();
          return writeJson(res, 200, { ok: true, agent: row });
        } catch (err) {
          return writeJson(res, 400, { error: String(err && err.message || err).slice(0, 200) });
        }
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/agent-delete",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if ((req.method || "GET") !== "POST") return writeJson(res, 405, { error: "POST only" });
        try {
          const body = await readBody(req);
          ledger.saveAgents(ledger.agents().filter((a) => a.id !== body.agentId));
          ledger.saveSchedules(ledger.schedules().filter((s) => s.agentId !== body.agentId));
          state.emit();
          return writeJson(res, 200, { ok: true });
        } catch (err) {
          return writeJson(res, 400, { error: String(err && err.message || err).slice(0, 200) });
        }
      },
    }));

    routes.push(wctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-super-agents/run-detail",
      handler: async (req, res) => {
        if (!isAllowedRequest(req, allowLan)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        const params = new URLSearchParams(String(req.url || "").split("?")[1] || "");
        const runId = params.get("runId") || "";
        const run = ledger.runs().find((r) => r.id === runId);
        if (!run) return writeJson(res, 404, { error: "run not found" });
        let artifact = "";
        try { artifact = fs.readFileSync(run.resultPath, "utf8").slice(0, 60000); } catch { /* none */ }
        let logTail = "";
        try { logTail = fs.readFileSync(ledger.logPath(run.id), "utf8").split("\n").slice(-40).join("\n"); } catch { /* none */ }
        return writeJson(res, 200, { ok: true, run, artifact, logTail });
      },
    }));

    ctx.effect(() => () => { for (const d of routes) { try { d && d(); } catch { /* ignore */ } } }, "dsh-super-agents: api routes");
  });
}

// ---------------------------------------------------------------------------
// skill registration (same pattern as dsh-novel-writer)
// ---------------------------------------------------------------------------

const SKILL_NAME = "super-agents";
const SKILL_DESCRIPTION = "DSH 超级智能体（dsh-super-agents 插件）：创建持久化 agent 角色卡、后台派活、定时自主领活（cron/间隔/一次性）、运行结果回收、经验 playbook 自学习。当用户要创建常驻 AI 员工、定时自动任务、后台批量任务、或问超级智能体状态时使用。";
const SKILL_WHEN_TO_USE = "用户提到超级智能体、AI 员工、定时任务、自动领活、后台任务、sa_ 工具时";

function registerSkill(ctx) {
  ctx.inject(["skills"], (sctx) => {
    if (!sctx || !sctx.skills || typeof sctx.skills.registerProvider !== "function") return;
    const skillUrl = new URL("./skills/super-agents/SKILL.md", import.meta.url);
    const provider = {
      name,
      list: () => Promise.resolve([{
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        invocation: { modelInvocable: true, userInvocable: true },
        source: "custom",
        provider: name,
        rank: 600,
        resourceBase: { kind: "directory", path: skillUrl.pathname.replace(/\/SKILL\.md$/, "/") },
        locator: skillUrl,
      }]),
      async get() {
        try {
          let text = fs.readFileSync(skillUrl, "utf8");
          if (text.startsWith("---")) {
            const end = text.indexOf("\n---", 3);
            if (end !== -1) text = text.slice(end + 4).replace(/^\s*\n/, "");
          }
          return {
            name: SKILL_NAME,
            description: SKILL_DESCRIPTION,
            whenToUse: SKILL_WHEN_TO_USE,
            invocation: { modelInvocable: true, userInvocable: true },
            source: "custom",
            provider: name,
            resourceBase: { kind: "directory", path: skillUrl.pathname.replace(/\/SKILL\.md$/, "/") },
            content: text,
          };
        } catch {
          return null;
        }
      },
    };
    try { sctx.skills.registerProvider(() => provider); } catch (err) {
      console.warn("[dsh-super-agents] skill provider failed:", err && err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export { name, inject, Config };

/** Pure helpers exported for Node-side unit tests (no runtime consumer). */
export const __internals = { parseCron, cronMatches, minuteKey, zonedParts, isValidTz, key, makeLedger, makeHealth, appendPlaybook, readPlaybook, buildTaskPrompt, buildReflectionPrompt, resolveDataDir, isTransientError, retryDelay, makeRunner, sayMode, sayRequest, isSteerUnavailable, deliverSay };

export function apply(ctx, config) {
  const resolved = config || {};
  const dir = resolveDataDir(resolved);
  ensureDirs(dir);
  const ledger = makeLedger(dir);
  const health = makeHealth();
  const pause = makePause(dir);
  // startup sweep (docs/001 run-state table): a run left mid-flight by the old
  // process can never complete — its session died with it, and replaying could
  // repeat external side effects, so mark it. queued rows never started and are
  // replay-safe: the runner re-enqueues them below.
  {
    const stale = ledger.runs();
    let touched = false;
    for (const r of stale) {
      if (r.status === "running") {
        r.status = "interrupted";
        r.endedAt = new Date().toISOString();
        r.error = "host restarted while the run was in flight";
        touched = true;
      }
    }
    if (touched) ledger.saveRuns(stale);
  }
  const listeners = new Set();
  const state = {
    emit() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  const runner = makeRunner(ctx, resolved, ledger, state, health);
  const scheduler = makeScheduler(resolved, ledger, runner, state, health, pause);
  runner.requeuePersisted();
  scheduler.start();
  ctx.effect(() => scheduler.stop, "dsh-super-agents: scheduler");

  registerTools(ctx, resolved, ledger, runner, scheduler, state, health, pause);
  registerRoutes(ctx, resolved, ledger, runner, state, health, pause);
  registerSkill(ctx);

  // light system-prompt hint so the model knows the roster exists (empty = dropped)
  ctx.systemPrompt.section({
    name: "super-agents",
    order: 160,
    text: () => {
      const agents = ledger.agents().filter((a) => a.enabled !== false);
      if (agents.length === 0) return "";
      const lines = agents.slice(0, 12).map((a) => `- ${a.id} 「${a.name}」${a.model ? ` model=${a.model}` : ""}`).join("\n");
      return [
        "本机装有 dsh-super-agents 插件：持久化超级智能体可后台领活与自学习。",
        "可用工具：sa_agent（角色卡）、sa_run（派活）、sa_runs/sa_run_result（回收）、sa_say（续聊/运行中纠偏）、sa_schedule（定时自主）、sa_learn（经验沉淀）、sa_health（健康与暂停）。",
        "当前在册 agent：",
        lines,
      ].join("\n");
    },
  });
}
