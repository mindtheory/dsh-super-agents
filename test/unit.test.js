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

const { parseCron, cronMatches, minuteKey, makeLedger, appendPlaybook, readPlaybook, buildTaskPrompt } = __internals;

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
