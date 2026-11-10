/**
 * Host-simulation smoke test: fake ctx -> apply() -> tools registered,
 * ledger writes, scheduler tick fires, routes registered, skill provider ok.
 * Run: node test/smoke.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-smoke-"));

const registered = { tools: [], routes: [], sections: [], skills: [], effects: [] };
const fakeWebServer = { register: (r) => { registered.routes.push(r); return () => {}; } };

const ctx = {
  tools: { register: (t) => registered.tools.push(t.name) },
  systemPrompt: { section: (s) => registered.sections.push(s.name) },
  skills: { registerProvider: (f) => registered.skills.push(typeof f === "function" ? f() : f) },
  effect: (fn, label) => registered.effects.push(label),
  inject: (deps, cb) => {
    if (deps.includes("webServer")) cb({ webServer: fakeWebServer });
    if (deps.includes("skills")) cb({ skills: ctx.skills });
  },
  get: (name) => (name === "webServer" ? fakeWebServer : undefined),
};

apply(ctx, { dataDir: dir, defaultModel: "local-qwen/test", tickSeconds: 10 });

// tools registered
assert.deepEqual(registered.tools.sort(), ["sa_agent", "sa_learn", "sa_run", "sa_run_result", "sa_runs", "sa_say", "sa_schedule"].sort());
// routes registered
assert.equal(registered.routes.length, 5);
assert.ok(registered.routes.map((r) => r.path).includes("/api/dsh-super-agents/state"));
// system prompt section + skill
assert.ok(registered.sections.includes("super-agents"));
assert.equal(registered.skills.length, 1);
const provider = registered.skills[0];
const listed = await provider.list();
assert.equal(listed[0].name, "super-agents");
const got = await provider.get();
assert.ok(got && got.content && got.content.includes("sa_agent"), "skill body loads");
assert.equal(got.source, "custom");

// extract handlers via re-register capture: call the tool execute through registry is not exposed;
// instead exercise the ledger paths the tools use directly through a second apply is overkill.
// Simulate: create agent row via same code path the tool uses (ledger file format).
const agentsFile = path.join(dir, "agents.json");
fs.writeFileSync(agentsFile, JSON.stringify([{ id: "a-1", name: "T", systemRole: "r", model: "", cwd: dir, learn: true, enabled: true }]));

// scheduler tick with a due 'at' schedule should enqueue a run (sessionController absent -> run fails gracefully)
const schedFile = path.join(dir, "schedules.json");
fs.writeFileSync(schedFile, JSON.stringify([{
  id: "s-1", agentId: "a-1", agentName: "T", prompt: "hello", kind: "at",
  at: new Date(Date.now() - 1000).toISOString(), enabled: true, createdAt: new Date().toISOString(),
  lastFiredAt: "", lastFiredMinute: "", firedAt: "",
}]));

await new Promise((r) => setTimeout(r, 12000)); // wait for boot tick (3s) + margin

const runs = JSON.parse(fs.readFileSync(path.join(dir, "runs.json"), "utf8"));
assert.equal(runs.length, 1, "schedule fired one run");
assert.equal(runs[0].status, "failed"); // sessionController absent in fake ctx -> graceful failure
assert.ok(runs[0].error.includes("sessionController"));
const sched = JSON.parse(fs.readFileSync(schedFile, "utf8"));
assert.ok(sched[0].firedAt, "one-shot marked fired (no refire)");

console.log("SMOKE OK:", registered.tools.length, "tools,", registered.routes.length, "routes, scheduler fired & failed gracefully");
process.exit(0);
