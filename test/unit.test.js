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

const { parseCron, cronMatches, minuteKey, zonedParts, isValidTz, key, makeLedger, makeHealth, appendPlaybook, readPlaybook, buildTaskPrompt, isTransientError, retryDelay, makeRunner, sayMode, sayRequest, isSteerUnavailable, deliverSay } = __internals;

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
  assert.equal(ledger.runs().length, 300); // trimmed to last 300
  assert.equal(ledger.runs()[299].id, "r-349");
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

function fakeCtx(sessionController) {
  return { get: () => sessionController };
}

function makeTestRunner(dir, sc, overrides) {
  const ledger = makeLedger(dir);
  const agent = { id: "a-1", name: "T", systemRole: "r", model: "", cwd: dir, learn: false, enabled: true };
  ledger.saveAgents([agent]);
  const state = { emit() {}, subscribe() { return () => {}; } };
  const runner = makeRunner(fakeCtx(sc), {
    maxConcurrent: 1,
    runTimeoutMs: 5000,
    pollIntervalMs: 10,
    retryMaxAttempts: 2,
    retryBaseDelayMs: 50,
    ...(overrides || {}),
  }, ledger, state, makeHealth());
  return { ledger, agent, runner };
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
