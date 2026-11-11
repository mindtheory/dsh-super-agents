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

const { parseCron, cronMatches, minuteKey, zonedParts, isValidTz, key, makeLedger, makeHealth, appendPlaybook, readPlaybook, buildTaskPrompt, isTransientError, retryDelay, makeRunner } = __internals;

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
