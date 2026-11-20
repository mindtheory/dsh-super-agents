/**
 * Unit tests for pure helpers (no host services needed).
 * Run: node --test test/unit.test.js
 *
 * Peer deps (@deepseek-ai/schemastery, @deepseek-ai/dsh-tools) must resolve:
 * inside a DSH install, point node_modules at the host tree first, e.g.
 *   ln -sfn "$(dirname $(which dsh))/../lib/node_modules/@deepseek-ai/dsh/node_modules" node_modules
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __internals } from "../index.js";

const { parseCron, cronMatches, minuteKey, zonedParts, isValidTz, key, RUN_STATUSES, RUN_HISTORY_LIMIT, LIVE_RUN_STATUSES, listRuns, trimRuns, agentDeleteImpact, makeLedger, makeHealth, appendPlaybook, readPlaybook, buildTaskPrompt, isTransientError, retryDelay, makeRunner, makeIdleWatcher, makeScheduler, sayMode, sayRequest, isSteerUnavailable, deliverSay } = __internals;

test("key: deterministic id (equal inputs -> equal id)", () => {
  assert.equal(key("run", "s-1", "2026-11-10T02:00"), key("run", "s-1", "2026-11-10T02:00"));
  assert.notEqual(key("run", "s-1", "2026-11-10T02:00"), key("run", "s-1", "2026-11-10T03:00"));
  assert.match(key("a"), /^[0-9a-f]{16}$/);
});

test("health: single writer per entry, release drops late writes", () => {
  const h = makeHealth();
  assert.ok(h.claim("runner", "runner"));
  assert.ok(!h.claim("runner", "scheduler")); // second claimant refused
  assert.ok(h.set("runner", "ok", ""));
  assert.ok(!h.set("unclaimed", "error", "x")); // no writer -> dropped
  h.release("runner", "runner");
  assert.ok(!h.set("runner", "error", "late")); // after release: no-op
  h.claim("runner", "scheduler"); // re-claimable after release
  h.set("runner", "error", "boom");
  assert.equal(h.problems().length, 1);
  assert.equal(h.problems()[0].name, "runner");
});

test("cron: basic wildcards and ranges", () => {
  const spec = parseCron("0 9 * * 1-5");
  assert.ok(spec);
  assert.ok(cronMatches(spec, new Date(2026, 10, 10, 9, 0))); // Tue
  assert.ok(!cronMatches(spec, new Date(2026, 10, 10, 9, 1)));
  assert.ok(!cronMatches(spec, new Date(2026, 10, 10, 10, 0)));
  assert.ok(!cronMatches(spec, new Date(2026, 10, 8, 9, 0))); // Sunday
  assert.ok(cronMatches(spec, new Date(2026, 10, 9, 9, 0))); // Monday
});

test("cron: steps and lists", () => {
  const every15 = parseCron("*/15 * * * *");
  assert.ok(cronMatches(every15, new Date(2026, 10, 10, 3, 30)));
  assert.ok(!cronMatches(every15, new Date(2026, 10, 10, 3, 31)));
  const list = parseCron("0,30 8 * * *");
  assert.ok(cronMatches(list, new Date(2026, 10, 10, 8, 30)));
  assert.ok(!cronMatches(list, new Date(2026, 10, 10, 8, 15)));
});

test("cron: dow 7 equals Sunday", () => {
  const spec = parseCron("0 0 * * 7");
  assert.ok(spec);
  assert.ok(cronMatches(spec, new Date(2026, 10, 8, 0, 0))); // Sunday
});

test("cron: invalid expressions rejected", () => {
  assert.equal(parseCron("* * * *"), null); // 4 fields
  assert.equal(parseCron("60 * * * *"), null); // out of range
  assert.equal(parseCron("a * * * *"), null);
  assert.equal(parseCron(""), null);
});

test("minuteKey format", () => {
  assert.equal(minuteKey(new Date(2026, 10, 9, 8, 5)), "2026-11-09T08:05");
});

test("cron: IANA tz shifts wall-clock matching (host-tz independent)", () => {
  const spec = parseCron("0 2 * * *");
  // 2026-11-10 02:00 Asia/Shanghai (UTC+8, no DST) == 2026-11-09 18:00 UTC
  const instant = new Date("2026-11-09T18:00:00Z");
  assert.ok(cronMatches(spec, instant, "Asia/Shanghai"));
  assert.ok(!cronMatches(spec, instant, "America/New_York")); // 13:00 EST there
  assert.equal(minuteKey(instant, "Asia/Shanghai"), "2026-11-10T02:00");
  assert.equal(minuteKey(instant, "America/New_York"), "2026-11-09T13:00");
  // empty tz falls back to host-local parts
  assert.equal(minuteKey(instant, ""), minuteKey(instant));
});

test("tz validation", () => {
  assert.ok(isValidTz("Asia/Shanghai"));
  assert.ok(isValidTz("America/New_York"));
  assert.ok(!isValidTz("Mars/Olympus"));
  assert.ok(!isValidTz(""));
  assert.equal(zonedParts(new Date(), "Mars/Olympus"), null);
  assert.ok(zonedParts(new Date(), "Asia/Shanghai"));
});

test("ledger: atomic round-trip and run trimming", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const ledger = makeLedger(dir);
  assert.deepEqual(ledger.agents(), []);
  ledger.saveAgents([{ id: "a-1", name: "x" }]);
  assert.equal(ledger.agents()[0].name, "x");
  const many = Array.from({ length: 350 }, (_, i) => ({ id: `r-${i}` }));
  ledger.saveRuns(many);
  assert.equal(ledger.runs().length, 300); // trimmed to last 300 settled rows
  assert.equal(ledger.runs()[299].id, "r-349");
});

test("ledger: the retention cap never discards a live (queued/running) row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const ledger = makeLedger(dir);
  // 350 rows deep in history, with a long-running run and a parked queued run
  // created early: trimming by recency alone would evict both, and patchRun
  // then silently drops their terminal state (no row -> no sa_runs entry).
  const rows = Array.from({ length: 350 }, (_, i) => ({
    id: `r-${i}`,
    status: i === 5 ? "running" : i === 10 ? "queued" : "done",
  }));
  ledger.saveRuns(rows);
  const kept = ledger.runs();
  const ids = kept.map((r) => r.id);
  assert.ok(ids.includes("r-5"), "running row must survive the cap");
  assert.ok(ids.includes("r-10"), "queued row must survive the cap");
  assert.ok(!ids.includes("r-0"), "oldest settled row is evicted first");
  assert.ok(!ids.includes("r-49"), "settled rows are capped");
  assert.equal(kept.length, 302); // 300 settled + 2 live
  // oldest -> newest order is preserved (patchRun/sa_runs depend on it)
  const nums = ids.map((id) => Number(id.slice(2)));
  assert.deepEqual(nums, nums.slice().sort((a, b) => a - b));
  assert.equal(ids[ids.length - 1], "r-349");
});

test("ledger: retention cap is configurable and clamped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const small = makeLedger(dir, { maxRows: 100 });
  const many = Array.from({ length: 150 }, (_, i) => ({ id: `r-${i}`, status: "done" }));
  small.saveRuns(many);
  assert.equal(small.runs().length, 100);
  assert.equal(small.runs()[99].id, "r-149");
  // below the floor: 50 (a cap of 1 would make the run index useless)
  const tiny = makeLedger(fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-")), { maxRows: 1 });
  tiny.saveRuns(many);
  assert.equal(tiny.runs().length, 50);
  // pure helper: no mutation of the input array
  const input = Array.from({ length: 120 }, (_, i) => ({ id: `r-${i}`, status: "failed" }));
  const out = trimRuns(input, 60);
  assert.equal(out.length, 60);
  assert.equal(input.length, 120);
  assert.ok(LIVE_RUN_STATUSES.every((s) => RUN_STATUSES.includes(s)));
  assert.equal(RUN_HISTORY_LIMIT, 300);
});

test("playbook: dedupe, list-line filter, rolling cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const file = path.join(dir, "pb.md");
  let r = appendPlaybook(file, "- lesson one\n- lesson two\nnot a list line\n- lesson one");
  assert.equal(r.added, 2); // dup + non-list filtered
  r = appendPlaybook(file, Array.from({ length: 70 }, (_, i) => `- l${i}`).join("\n"));
  assert.equal(r.total, 60); // cap
  const text = readPlaybook(file);
  assert.ok(text.includes("- l69"));
  assert.ok(!text.includes("- lesson one")); // oldest evicted
});

test("task prompt: persona + playbook + artifact contract", () => {
  const text = buildTaskPrompt(
    { name: "测试员", systemRole: "你是测试员。" },
    "做X",
    "r-1",
    "/tmp/out.md",
    "- 先跑测试",
  );
  assert.ok(text.includes("[SUPER AGENT RUN r-1]"));
  assert.ok(text.includes("你是测试员。"));
  assert.ok(text.includes("- 先跑测试"));
  assert.ok(text.includes("/tmp/out.md"));
});

test("retry policy: only transient failures are retryable", () => {
  for (const msg of ["429 Too Many Requests", "HTTP 503 Service Unavailable", "rate limit exceeded", "request timed out", "socket hang up", "read ECONNRESET", "model overloaded"]) {
    assert.ok(isTransientError(new Error(msg)), msg);
  }
  for (const msg of ["400 bad request", "invalid api key", "agent a-1 not found", "prompt contract violated"]) {
    assert.ok(!isTransientError(new Error(msg)), msg);
  }
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
});

test("retry policy: exponential backoff with 60s cap", () => {
  assert.equal(retryDelay(2, 2000), 2000);
  assert.equal(retryDelay(3, 2000), 4000);
  assert.equal(retryDelay(4, 2000), 8000);
  assert.equal(retryDelay(10, 2000), 60000);
  assert.equal(retryDelay(2, 0), 2000); // invalid base falls back
});

test("idle watcher: host running-state event settles a wait as idle", async () => {
  const w = makeIdleWatcher({ timeoutMs: 1000 });
  const p = w.wait("s-1", new AbortController().signal);
  w.onStatus("s-1", false);
  assert.equal(await p, "idle");
  assert.equal(w.waiterCount(), 0); // registry cleaned, no listener leak
});

test("idle watcher: running=true and unrelated sessions never settle a wait", async () => {
  const w = makeIdleWatcher({ timeoutMs: 30 });
  const p = w.wait("s-1", new AbortController().signal);
  w.onStatus("s-1", true); // still running: not a settlement
  w.onStatus("s-2", false); // another session's event: not ours
  assert.equal(await p, "poll"); // only the fallback tick settles it
  assert.equal(w.waiterCount(), 0);
});

test("idle watcher: an abort settles as aborted and drops the waiter", async () => {
  const w = makeIdleWatcher({ timeoutMs: 1000 });
  const c = new AbortController();
  const p = w.wait("s-1", c.signal);
  c.abort();
  assert.equal(await p, "aborted");
  assert.equal(w.waiterCount(), 0);
  w.onStatus("s-1", false); // late event after the abort must not throw
});

test("idle watcher: a missing session or a late event is harmless", async () => {
  const w = makeIdleWatcher({ timeoutMs: 10 });
  assert.equal(await w.wait("", new AbortController().signal), "poll");
  assert.equal(await w.wait("s-1", new AbortController().signal), "poll");
  w.onStatus("s-1", false); // no waiter left: must not throw
  assert.equal(w.waiterCount(), 0);
});

function fakeCtx(sessionController) {
  // hosts from 0.2.2 emit 'api-session/status'; the fake carries the same
  // subscribe/emit pair so a test can settle a run from an event alone.
  const handlers = new Map();
  return {
    get: () => sessionController,
    on(name, fn) {
      const set = handlers.get(name) || new Set();
      set.add(fn);
      handlers.set(name, set);
      return () => set.delete(fn);
    },
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
  };
}

function makeTestRunner(dir, sc, overrides) {
  const ledger = makeLedger(dir);
  const agent = { id: "a-1", name: "T", systemRole: "r", model: "", cwd: dir, learn: false, enabled: true };
  ledger.saveAgents([agent]);
  const state = { emit() {}, subscribe() { return () => {}; } };
  const ctx = fakeCtx(sc);
  const runner = makeRunner(ctx, {
    maxConcurrent: 1,
    runTimeoutMs: 5000,
    pollIntervalMs: 10,
    retryMaxAttempts: 2,
    retryBaseDelayMs: 50,
    ...(overrides || {}),
  }, ledger, state, makeHealth());
  return { ledger, agent, runner, ctx };
}

async function waitForStatus(ledger, runId, wanted, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    row = ledger.runs().find((r) => r.id === runId) || null;
    if (row && wanted.includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  return row;
}

test("runner: transient failure retries the same run and then completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let promptCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    selectModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) throw new Error("429 Too Many Requests");
      return {};
    },
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["done", "done_no_artifact", "failed", "timeout"]);
  assert.equal(row.status, "done_no_artifact");
  assert.equal(row.attempts, 2);
  assert.equal(promptCalls, 2);
});

test("runner: exhausted retries end as failed with a transient error code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let promptCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => { promptCalls += 1; throw new Error("503 Service Unavailable"); },
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["failed"]);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 2);
  assert.equal(promptCalls, 2);
  assert.equal(row.errorCode, "ERR_RUN_TRANSIENT");
});

test("runner: deterministic failures do not retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let promptCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => { promptCalls += 1; throw new Error("400 bad request"); },
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["failed"]);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1);
  assert.equal(promptCalls, 1);
  assert.equal(row.errorCode, "ERR_RUN_PROMPT");
});

test("runner: missing sessionController fails immediately with a clear code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const { ledger, agent, runner } = makeTestRunner(dir, undefined);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["failed"]);
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "ERR_RUN_SESSION_CONTROLLER");
  assert.equal(row.attempts, 1);
});

test("startup sweep: a queued run whose agent was deleted is settled, not left queued", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => { throw new Error("must not dispatch an orphan"); },
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "orphan work" }); // persisted as queued
  assert.equal(ledger.runs().find((r) => r.id === run.id).status, "queued");
  ledger.saveAgents([]); // the agent was deleted while the host was down
  assert.equal(runner.requeuePersisted(), 1);
  const row = ledger.runs().find((r) => r.id === run.id);
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "ERR_RUN_AGENT_MISSING");
  assert.ok(row.endedAt);
  assert.equal(row.taskText, "orphan work"); // the task is not lost
  assert.equal(runner.queueSize(), 0);
});

test("startup sweep: a queued run for a disabled agent is settled with its own code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => { throw new Error("must not dispatch for a disabled agent"); },
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "x" });
  ledger.saveAgents([{ ...agent, enabled: false }]);
  assert.equal(runner.requeuePersisted(), 1);
  const row = ledger.runs().find((r) => r.id === run.id);
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "ERR_RUN_AGENT_DISABLED");
});

test("startup sweep: a queued run with a live agent still replays", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => ({}),
    list: async () => ({ items: [{ sessionId: "s-1", running: false }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "replay me" }); // never enqueued: simulates a died host
  assert.equal(runner.requeuePersisted(), 0);
  assert.equal(runner.queueSize() + runner.activeCount(), 1);
  const row = await waitForStatus(ledger, run.id, ["done", "done_no_artifact", "failed", "timeout"]);
  assert.equal(row.status, "done_no_artifact");
});

test("runner: cancel a queued run settles it without dispatching", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let promptCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-1" }),
    prompt: async () => { promptCalls += 1; return {}; },
    // the first run never goes idle, so the second one stays queued
    list: async () => ({ items: [{ sessionId: "s-1", running: true }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc, { runTimeoutMs: 400 });
  const blocker = runner.makeRun(agent, { taskText: "blocker" });
  runner.enqueue(blocker);
  const queued = runner.makeRun(agent, { taskText: "doomed" });
  runner.enqueue(queued);
  assert.equal(ledger.runs().find((r) => r.id === queued.id).status, "queued");
  const out = runner.cancelRun(queued.id);
  assert.equal(out.ok, true);
  assert.equal(out.status, "cancelled");
  const row = await waitForStatus(ledger, queued.id, ["cancelled"]);
  assert.equal(row.status, "cancelled");
  assert.match(row.error, /cancelled before the session started/);
  await waitForStatus(ledger, blocker.id, ["timeout"]);
  assert.equal(promptCalls, 1); // the cancelled run never reached the host
});

test("runner: cancel a running run cancels its session and settles as cancelled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const cancelledSessions = [];
  const sc = {
    create: async () => ({ sessionId: "s-9" }),
    prompt: async () => ({}),
    list: async () => ({ items: [{ sessionId: "s-9", running: true }] }),
    cancel: (arg) => cancelledSessions.push(arg && arg.sessionId),
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc, { runTimeoutMs: 2000 });
  const run = runner.makeRun(agent, { taskText: "long job" });
  runner.enqueue(run);
  await waitForStatus(ledger, run.id, ["running"]);
  await new Promise((r) => setTimeout(r, 40)); // let the poll loop start
  const out = runner.cancelRun(run.id);
  assert.equal(out.ok, true);
  assert.equal(out.status, "cancelling");
  const row = await waitForStatus(ledger, run.id, ["cancelled"]);
  assert.equal(row.status, "cancelled");
  assert.equal(row.error, "cancelled by operator");
  assert.deepEqual(cancelledSessions, ["s-9"]);
});

test("runner: a cancel that aborts prompt settles cancelled, not failed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const sc = {
    create: async () => ({ sessionId: "s-2" }),
    prompt: () => new Promise((resolve, reject) => setTimeout(() => reject(new Error("This operation was aborted")), 30)),
    list: async () => ({ items: [{ sessionId: "s-2", running: true }] }),
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  await waitForStatus(ledger, run.id, ["running"]);
  await new Promise((r) => setTimeout(r, 5)); // cancel while prompt is in flight
  assert.equal(runner.cancelRun(run.id).ok, true);
  const row = await waitForStatus(ledger, run.id, ["cancelled", "failed"]);
  assert.equal(row.status, "cancelled");
});

test("runner: cancel refuses a run that already finished", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  const { ledger, agent, runner } = makeTestRunner(dir, undefined);
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.patchRun(run.id, { status: "done" });
  assert.deepEqual(runner.cancelRun(run.id), { ok: false, error: "run already done" });
  assert.equal(runner.cancelRun("r-missing").ok, false);
  assert.equal(ledger.runs().find((r) => r.id === run.id).status, "done");
});

test("say: a running run steers by default, an ended run queues", () => {
  assert.equal(sayMode({ status: "running" }, null), "steer");
  assert.equal(sayMode({ status: "done" }, null), "queue");
  assert.equal(sayMode({ status: "queued" }, null), "queue");
  // explicit operator choice wins over the run state
  assert.equal(sayMode({ status: "running" }, "queue"), "queue");
  assert.equal(sayMode({ status: "done" }, "steer"), "steer");
  const req = sayRequest({ status: "running", sessionId: "s-1" }, "改方向", null, "req-1");
  assert.equal(req.requestId, "req-1");
  assert.equal(req.sessionId, "s-1");
  assert.equal(req.mode, "steer");
  assert.deepEqual(req.content, [{ type: "text", text: "改方向" }]);
});

test("say: deliver steers a running run and queues a finished one", async () => {
  const calls = [];
  const sc = { prompt: async (req) => { calls.push(req); return {}; } };
  const running = await deliverSay({ id: "r-1", status: "running", sessionId: "s-1" }, "纠正", null, sc, { requestId: "q-1" });
  assert.equal(running.mode, "steer");
  assert.equal(running.steered, true);
  assert.equal(running.fallback, false);
  assert.equal(calls[0].mode, "steer");
  await deliverSay({ id: "r-2", status: "done", sessionId: "s-2" }, "追问", null, sc, { requestId: "q-2" });
  assert.equal(calls[1].mode, "queue");
  assert.equal(calls[1].content[0].text, "追问");
});

test("say: a steer refused because the turn ended falls back to queue once", async () => {
  const calls = [];
  const sc = {
    prompt: async (req) => {
      calls.push(req);
      if (req.mode === "steer") {
        const err = new Error("session/steer-unavailable: no active turn");
        err.code = "session/steer-unavailable";
        throw err;
      }
      return {};
    },
  };
  const out = await deliverSay({ id: "r-3", status: "running", sessionId: "s-3" }, "补充", null, sc, { requestId: "q-3" });
  assert.deepEqual(out, { mode: "queue", steered: false, fallback: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].mode, "steer");
  assert.equal(calls[1].mode, "queue");
  assert.equal(calls[1].requestId, "q-3-queue"); // distinct id: no duplicate delivery
});

test("say: an unknown delivery failure propagates instead of retrying blind", async () => {
  let calls = 0;
  const sc = { prompt: async () => { calls += 1; throw new Error("socket hang up"); } };
  await assert.rejects(() => deliverSay({ id: "r-4", status: "running", sessionId: "s-4" }, "x", null, sc), /socket hang up/);
  assert.equal(calls, 1); // never a second send after an unknown outcome
  assert.equal(isSteerUnavailable(new Error("socket hang up")), false);
  assert.equal(isSteerUnavailable({ code: "session/steer-unavailable" }), true);
});

test("runner: settles on the host running-state event, not on a poll tick", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let listCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-event" }),
    prompt: async () => ({}),
    // the list never reports idle: only the host event can settle this run
    list: async () => { listCalls += 1; return { items: [{ sessionId: "s-event", running: true }] }; },
    cancel: () => {},
  };
  const { ledger, agent, runner, ctx } = makeTestRunner(dir, sc, { runTimeoutMs: 3000, pollIntervalMs: 60000 });
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  await waitForStatus(ledger, run.id, ["running"]);
  await new Promise((r) => setTimeout(r, 20));
  ctx.emit("api-session/status", "s-event", false);
  const row = await waitForStatus(ledger, run.id, ["done", "done_no_artifact"]);
  assert.ok(["done", "done_no_artifact"].includes(row.status), `unexpected ${row.status}`);
  assert.equal(listCalls, 0); // 60s fallback never fired: the event settled it
});

test("runner: a session that disappears from the host list is interrupted, not guessed done", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let listCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-lost" }),
    prompt: async () => ({}),
    // still running, then the row is gone (session deleted or swept)
    list: async () => {
      listCalls += 1;
      const items = listCalls === 1
        ? [{ sessionId: "s-lost", running: true }]
        : [{ sessionId: "s-other", running: true }];
      return { items };
    },
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc, { runTimeoutMs: 3000, pollIntervalMs: 20 });
  const run = runner.makeRun(agent, { taskText: "x" });
  // a partial artifact exists: the old read turned exactly this into `done`
  fs.mkdirSync(path.dirname(run.resultPath), { recursive: true });
  fs.writeFileSync(run.resultPath, "partial\n");
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["interrupted", "done", "done_no_artifact"]);
  assert.equal(row.status, "interrupted");
  assert.equal(row.errorCode, "ERR_RUN_SESSION_LOST");
  assert.match(row.error, /outcome unverified/);
  assert.ok(row.endedAt);
});

test("runner: a failed list read is not a lost session (keeps waiting)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  let listCalls = 0;
  const sc = {
    create: async () => ({ sessionId: "s-flaky" }),
    prompt: async () => ({}),
    list: async () => {
      listCalls += 1;
      if (listCalls <= 2) throw new Error("read timeout");
      return { items: [{ sessionId: "s-flaky", running: false }] };
    },
    cancel: () => {},
  };
  const { ledger, agent, runner } = makeTestRunner(dir, sc, { runTimeoutMs: 3000, pollIntervalMs: 20 });
  const run = runner.makeRun(agent, { taskText: "x" });
  runner.enqueue(run);
  const row = await waitForStatus(ledger, run.id, ["done", "done_no_artifact", "interrupted"]);
  assert.ok(["done", "done_no_artifact"].includes(row.status), `unexpected ${row.status}`);
  assert.ok(listCalls >= 3);
});

function makeTestScheduler(schedules, agents) {
  const rows = schedules.map((s) => ({ ...s }));
  const dispatched = [];
  const ledger = {
    schedules: () => rows,
    saveSchedules: (next) => {
      const snapshot = [...next]; // next may be `rows` itself: copy before clearing
      rows.length = 0;
      rows.push(...snapshot);
    },
    agents: () => agents,
  };
  const runner = {
    makeRun: (agent, opts) => ({ id: opts.id, agentId: agent.id, kind: opts.kind }),
    enqueue: (run) => dispatched.push(run),
  };
  const health = makeHealth();
  const state = { emit() {} };
  const pause = { on: () => false };
  const scheduler = makeScheduler({ tickSeconds: 30 }, ledger, runner, state, health, pause);
  return { scheduler, rows, dispatched, health };
}

function everyRow(extra) {
  return {
    id: "s-every",
    agentId: "a-1",
    agentName: "T",
    title: "",
    prompt: "p",
    kind: "every",
    everySeconds: 60,
    // created two minutes ago: the next occurrence is already due
    createdAt: new Date(Date.now() - 120000).toISOString(),
    lastFiredAt: "",
    firedAt: "",
    enabled: true,
    ...(extra || {}),
  };
}

test("scheduler: a refused dispatch is recorded on the row, not silently skipped", () => {
  const agent = { id: "a-1", name: "T", enabled: false };
  const { scheduler, rows, dispatched, health } = makeTestScheduler([everyRow()], [agent]);
  scheduler.tick();
  assert.equal(dispatched.length, 0); // disabled target: nothing dispatched
  assert.equal(rows[0].skippedCount, 1);
  assert.match(rows[0].lastSkipReason, /已停用/);
  assert.ok(rows[0].lastSkipAt);
  const entry = health.list().find((e) => e.name === "scheduleDispatch");
  assert.equal(entry.level, "warn");
  assert.match(entry.note, /s-every/);
});

test("scheduler: re-enabling the agent dispatches and clears the skip record", () => {
  const agent = { id: "a-1", name: "T", enabled: true };
  const { scheduler, rows, dispatched, health } = makeTestScheduler(
    [everyRow({ skippedCount: 3, lastSkipReason: "agent a-1 已停用" })],
    [agent],
  );
  scheduler.tick();
  assert.equal(dispatched.length, 1);
  assert.equal(rows[0].skippedCount, 0);
  assert.equal(rows[0].lastSkipReason, "");
  const entry = health.list().find((e) => e.name === "scheduleDispatch");
  assert.equal(entry.level, "ok");
});

test("scheduler: a refused one-shot is consumed and stays out of the ongoing warning", () => {
  const agent = { id: "a-1", name: "T", enabled: false };
  const row = {
    id: "s-at",
    agentId: "a-1",
    agentName: "T",
    prompt: "p",
    kind: "at",
    at: new Date(Date.now() - 60000).toISOString(),
    firedAt: "",
    enabled: true,
  };
  const { scheduler, rows, dispatched, health } = makeTestScheduler([row], [agent]);
  scheduler.tick();
  assert.equal(dispatched.length, 0);
  assert.ok(rows[0].firedAt); // consumed: must never resurrect after a later re-enable
  assert.match(rows[0].lastSkipReason, /已停用/);
  const entry = health.list().find((e) => e.name === "scheduleDispatch");
  assert.equal(entry.level, "ok"); // history on the row, not an ongoing skip
});

// The `sa_runs` filter is a tool-schema enum, so a status it omits is not an
// empty result — the host rejects the argument outright. Every terminal state
// this plugin writes must therefore be nameable (`interrupted` from the boot
// sweep, `cancelled` from an operator cancel); these two tests pin the list and
// the shared filter to each other so the enum cannot silently drift again.
test("runs: the sa_runs filter names every status the plugin writes", () => {
  assert.ok(Object.isFrozen(RUN_STATUSES));
  assert.deepEqual([...RUN_STATUSES].sort(), [
    "cancelled", "done", "done_no_artifact", "failed", "interrupted", "queued", "running", "timeout",
  ]);
  assert.equal(new Set(RUN_STATUSES).size, RUN_STATUSES.length); // no duplicate entries
});

test("runs: listRuns filters newest-first by status and agent within a bounded limit", () => {
  const rows = [
    { id: "r1", agentId: "a-1", status: "queued" },
    { id: "r2", agentId: "a-1", status: "cancelled" },
    { id: "r3", agentId: "a-2", status: "interrupted" },
    { id: "r4", agentId: "a-1", status: "interrupted" },
  ];
  // both states the old enum could not name are reachable through the filter
  assert.deepEqual(listRuns(rows, { status: "interrupted" }).map((r) => r.id), ["r4", "r3"]);
  assert.deepEqual(listRuns(rows, { status: "cancelled" }).map((r) => r.id), ["r2"]);
  assert.deepEqual(listRuns(rows, { agentId: "a-1", status: "interrupted" }).map((r) => r.id), ["r4"]);
  assert.deepEqual(listRuns(rows, { agentId: "a-1" }).map((r) => r.id), ["r4", "r2", "r1"]);
  assert.deepEqual(listRuns(rows, { limit: 2 }).map((r) => r.id), ["r4", "r3"]);
  assert.equal(listRuns(rows, { limit: 999 }).length, 4); // clamped to 100, not unbounded
  assert.equal(listRuns(rows, {}).length, 4); // default limit keeps every row here
  assert.deepEqual(listRuns(rows, { status: "nope" }), []); // unknown status never throws
});

// `sa_agent delete` removes the card, its schedules and nothing else, but it
// used to answer `{ok:true}` only: an operator (or a model) could delete an
// agent and never learn that N cron jobs and M runs went with it. LobeHub #22313
// makes the delete impact-aware for exactly this reason. These two tests pin the
// counts to the ledger the delete actually rewrites — counts only, no writes.
test("delete impact: counts schedules and run rows by agent, ignoring other agents", () => {
  const schedules = [
    { id: "s1", agentId: "a-1" },
    { id: "s2", agentId: "a-1" },
    { id: "s3", agentId: "a-2" },
  ];
  const runs = [
    { id: "r1", agentId: "a-1", status: "queued" },
    { id: "r2", agentId: "a-1", status: "running" },
    { id: "r3", agentId: "a-1", status: "done" },
    { id: "r4", agentId: "a-1", status: "interrupted" },
    { id: "r5", agentId: "a-2", status: "queued" },
  ];
  assert.deepEqual(agentDeleteImpact("a-1", schedules, runs), {
    schedules: 2,
    queuedRuns: 1,
    runningRuns: 1,
    endedRuns: 2, // history stays in the ledger index on purpose
  });
  // an id with nothing attached reports zeros rather than throwing or guessing
  assert.deepEqual(agentDeleteImpact("a-9", schedules, runs), {
    schedules: 0, queuedRuns: 0, runningRuns: 0, endedRuns: 0,
  });
  // missing ledgers (first run, empty data dir) must not break the delete
  assert.deepEqual(agentDeleteImpact("a-1", null, undefined), {
    schedules: 0, queuedRuns: 0, runningRuns: 0, endedRuns: 0,
  });
});

test("delete impact: the counts match what a delete leaves behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-del-"));
  const ledger = makeLedger(dir);
  ledger.saveAgents([
    { id: "a-1", name: "gone" },
    { id: "a-2", name: "kept" },
  ]);
  ledger.saveSchedules([
    { id: "s1", agentId: "a-1", kind: "every", everySeconds: 60, enabled: true },
    { id: "s2", agentId: "a-2", kind: "every", everySeconds: 60, enabled: true },
  ]);
  ledger.saveRuns([
    { id: "r1", agentId: "a-1", status: "queued" },
    { id: "r2", agentId: "a-1", status: "failed" },
  ]);
  const impact = agentDeleteImpact("a-1", ledger.schedules(), ledger.runs());
  ledger.saveAgents(ledger.agents().filter((a) => a.id !== "a-1"));
  ledger.saveSchedules(ledger.schedules().filter((s) => s.agentId !== "a-1"));
  // the reported impact is exactly the state the delete removed
  assert.equal(impact.schedules, 1);
  assert.equal(ledger.schedules().length, 2 - impact.schedules);
  assert.deepEqual(ledger.agents().map((a) => a.id), ["a-2"]);
  assert.deepEqual(ledger.runs().map((r) => r.id), ["r1", "r2"]); // history untouched
  assert.equal(impact.queuedRuns + impact.runningRuns + impact.endedRuns, ledger.runs().length);
});
