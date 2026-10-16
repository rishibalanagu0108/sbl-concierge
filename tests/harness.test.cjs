const test = require("node:test");
const assert = require("node:assert/strict");

// The harness against a fake engine and a fake background store: hear / boot / finish / stop, the ways a run can start twice or come back to life.
for (const m of ["task", "turn", "trace", "guard", "constitution", "sbl-knowledge", "screens"]) require(`../core/${m}.js`);
const stored = new Map(); // what the background worker holds, per (this one) tab
let puts = 0;
// id: this stub IS the extension context (bg() keys on runtime.id, not on sendMessage, which a plain page also exposes).
globalThis.chrome = { runtime: { id: "fake-extension", sendMessage: async (m) => {
  if (m.op === "put") { puts++; stored.set("t", JSON.parse(JSON.stringify(m.task))); return { ok: true }; }
  if (m.op === "clear") { stored.delete("t"); return { ok: true }; }
  return { ok: true, task: stored.get("t") ? JSON.parse(JSON.stringify(stored.get("t"))) : null };
} } };
Object.assign(globalThis, { document: Object.assign(new EventTarget(), { readyState: "complete", body: { innerText: "" }, getElementsByTagName: () => [], querySelectorAll: () => [] }),
  location: { href: "https://sbl.so/pricing/", pathname: "/pricing/" }, addEventListener() {}, MutationObserver: class { observe() {} disconnect() {} } });

const agents = [];
class FakeAgent {
  constructor(cfg) { this.cfg = cfg; this.tasks = []; this.observed = []; this.pageController = { selectorMap: new Map() }; agents.push(this); }
  addEventListener() {}
  pushObservation(t) { this.observed.push(t); }
  execute(task) { this.tasks.push(task); return new Promise((resolve) => { this.end = resolve; }); }
  stop() { this.end?.({ success: false, data: "Task aborted", history: [] }); }
}
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
globalThis.SBLEngine = { PageAgentCore: FakeAgent, PageController: class {}, tool: (t) => t, z: new Proxy({}, { get: () => chain }) };
require("../harness.js");

const build = () => {
  const said = [], calls = { endCards: 0 };
  const h = SBLHarness.create({ proof: true, cursor: () => null, say: (t) => said.push(t), note() {}, needs() {}, busy() {}, acting() {}, endCards: () => calls.endCards++, context: () => ({}),
    tools: {}, remember: async () => {}, confirm: async () => "", askSecret: async () => "", chat: async () => ({ status: 200, body: {} }) });
  return { h, said, calls };
};
const reset = () => { stored.clear(); agents.length = 0; puts = 0; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const active = (over = {}) => ({ ...SBLTask.newTask("show me pricing"), log: [{ name: "navigate", args: "/pricing", key: "k", at: 1, result: "navigating" }], steps: 3, ...over });

test("hear starts one run; a second message pre-empts it (the old run is stopped, a new one starts), and done clears the task", async () => {
  reset();
  const { h, said } = build();
  const first = h.hear("recommend a plan");
  await tick();
  assert.equal(agents.length, 1);
  assert.match(agents[0].tasks[0], /Goal: recommend a plan/);
  const again = h.hear("and I have three teammates");
  assert.equal((await first).status, "preempted", "the old run was stopped");
  await tick();
  assert.equal(agents.length, 2, "a second run for the second message");
  assert.match(agents[1].tasks[0], /Goal: and I have three teammates/);
  assert.match(agents[1].tasks[0], /recommend a plan/, "the new turn's preface carries what the old turn was doing");
  assert.notEqual(again, first);
  agents[1].end({ success: true, data: "Here is Pro.", history: [{ type: "step" }] });
  assert.equal((await again).status, "done");
  assert.deepEqual(said, ["Here is Pro."]);
  assert.equal(stored.size, 0, "a finished task is gone from storage");
});

test("boot resumes a stored task exactly once, however many times it is called", async () => {
  reset();
  stored.set("t", active());
  const { h } = build();
  await Promise.all([h.boot(), h.boot()]);
  await tick(700);
  assert.equal(agents.length, 1, "one run");
  assert.match(agents[0].tasks[0], /CONTINUATION/);
  assert.match(agents[0].tasks[0], /navigate/);
  assert.equal(stored.get("t").resumes, 1);
  await h.boot();
  assert.equal(agents.length, 1, "still one run while it is active");
  agents[0].end({ success: true, data: "", history: [{ type: "step" }] });
});

test("a task that is expired, out of budget, out of resumes or waiting on the visitor does not resume", async () => {
  for (const over of [{ visitorAt: 1 }, { steps: SBLTask.BUDGET }, { resumes: SBLTask.MAX_RESUMES }, { status: "waiting_user" }, { status: "stopped" }]) {
    reset();
    stored.set("t", active(over));
    await build().h.boot();
    await tick(30);
    assert.equal(agents.length, 0, JSON.stringify(over));
  }
});

test("Stop ends the task for good: the run stops, storage is cleared, and the next page load has nothing to resume", async () => {
  reset();
  const a = build();
  const run = a.h.hear("sign me up");
  await tick();
  a.h.stop();
  const result = await run;
  assert.equal(result.status, "stopped");
  assert.equal(stored.size, 0);
  assert.ok(a.calls.endCards >= 1, "the card and the secret box go with it");
  const b = build();
  await b.h.boot();
  await tick(30);
  assert.equal(agents.length, 1, "no second agent was created");
  // stopping with nothing running also clears what a waiting task left behind
  stored.set("t", active({ status: "waiting_user" }));
  await b.h.boot();
  b.h.stop();
  await tick();
  assert.equal(stored.size, 0);
});

test("an answer to ask_user resolves it however it arrives (typed, or spoken), and is what the agent sees", async () => {
  reset();
  const { h } = build();
  h.hear("please sign me up for the trial");
  await tick();
  const agent = agents[0];
  const asked = agent.cfg.customTools.ask_user.execute.call(agent, { question: "What is your email?", because: "sign me up for the trial" }, { signal: new AbortController().signal });
  await tick();
  assert.equal(h.isWaiting(), true);
  h.hear("me@example.com"); // the voice path calls hear(text) too: same door
  assert.match(await asked, /The visitor answered: me@example\.com/);
  assert.equal(h.isWaiting(), false);
  agent.end({ success: true, data: "", history: [{ type: "step" }] });
});

test("the visitor speaking breaks the repeat streak: what was stuck before their words starts from zero", async () => {
  reset();
  const { h } = build();
  const runP = h.hear("open the pricing table");
  await tick();
  const agent = agents[0];
  const click = () => agent.cfg.customTools.click.execute.call(agent, { index: 4 }, { signal: new AbortController().signal });
  const outs1 = [await click(), await click(), await click()];
  assert.ok(outs1.every((o) => /^[❌⚠️]/.test(o)), "the fake has no elements: every click fails or is warned");
  h.hear("no, the other one"); // the visitor speaks while the run is going
  await tick();
  // without the barrier the very next click would already be at the warn threshold and the one after it would stop
  const outs2 = [await click(), await click(), await click(), await click()];
  assert.ok(!outs2.some((o) => /Stopped/.test(o)), "no wall stop after the visitor spoke: the streak broke");
  agent.end({ success: true, data: "", history: [{ type: "step" }] });
  await runP;
});

test("a new request after a halt is a NEW task, never a resume of the old goal with the old history", async () => {
  reset();
  const { h, said } = build();
  const runP = h.hear("walk me through the plans");
  await tick();
  const agent = agents[0];
  // the run hits a wall: five identical failed clicks raise the stop verdict
  const click = () => agent.cfg.customTools.click.execute.call(agent, { index: 7 }, { signal: new AbortController().signal });
  for (let i = 0; i < 5; i++) await click();
  const stopped = await runP;
  assert.equal(stopped.status, "waiting_user");
  assert.equal(said.length, 1, "nothing had been said this turn, so the wall ends it with exactly one honest line");
  assert.match(said[0], /same wall/);
  // the visitor's next words: a NEW task, fresh goal, no old log, no old repeat history
  h.hear("just show me the enterprise plan");
  await tick();
  assert.equal(agents.length, 2, "a second run started");
  assert.match(agents[1].tasks[0], /Goal: just show me the enterprise plan/);
  assert.doesNotMatch(agents[1].tasks[0], /walk me through the plans/, "the old goal is not resumed");
  agents[1].end({ success: true, data: "", history: [{ type: "step" }] });
});

test("pointing and talking never count as page-progress failures: no stop however often they repeat", async () => {
  reset();
  const { h } = build();
  const runP = h.hear("show me around");
  await tick();
  const agent = agents[0];
  const signal = new AbortController().signal;
  for (let i = 0; i < 8; i++) {
    const p = await agent.cfg.customTools.point_at.execute.call(agent, { index: 3, note: "the plan" }, { signal });
    if (/Stopped/.test(p)) throw new Error("a point repeat raised a stop");
  }
  assert.doesNotMatch(await agent.cfg.customTools.say.execute.call(agent, { text: "This one.", then: "show" }, { signal }), /Stopped/);
  agent.end({ success: true, data: "", history: [{ type: "step" }] });
  await runP;
});

test("a run that fails for lack of the model says so plainly, and a page that is leaving says nothing", async () => {
  reset();
  const { h, said } = build();
  const run = h.hear("hello");
  await tick();
  agents[0].end({ success: false, data: "InvokeError: Authentication failed: assistant_unavailable", history: [{ type: "error" }] });
  await run;
  assert.match(said.at(-1), /temporarily unavailable/);
  assert.doesNotMatch(said.at(-1), /could not finish/);
});

test("one line per turn: a re-worded repeat is refused before it is spoken, whatever the wording", async () => {
  reset();
  const { h, said } = build();
  h.hear("what was the strategy in the finance study");
  await tick();
  const agent = agents[0];
  const signal = new AbortController().signal;
  const say = (t) => agent.cfg.customTools.say.execute.call(agent, { text: t, then: "show" }, { signal });
  const first = await say("The strategy was a three-day, persona-led LinkedIn system: target the right finance buyers, tailor messages to their triggers, then scale carefully across six profiles.");
  assert.match(first, /^Said to the visitor/);
  assert.equal(said.length, 1);
  // the founder's second wording of the same content: refused, nothing spoken. The first refusal warns the model (was: ended the turn); the second ends it.
  const reworded = "The strategy is laid out here: define finance-specific personas and triggers first, then run tightly controlled, human-sounding outreach across six profiles.";
  assert.match(await say(reworded), /^⚠️/);
  assert.equal(await say(reworded), "Stopped.");
  assert.equal(said.length, 2, "the re-worded line never reached the visitor; the turn had already said something, so one apology line (was: none)");
  assert.match(said[1], /got stuck partway/);
  await assert.rejects(say("Their results section shows the $60,000 pipeline number."), { name: "AbortError" }); // the turn is over
  // a genuinely new line goes out in the visitor's next turn
  h.hear("and the results?");
  await tick();
  const third = await agents.at(-1).cfg.customTools.say.execute.call(agents.at(-1), { text: "Their results section shows the $60,000 pipeline number.", then: "end" }, { signal });
  assert.match(third, /^Said to the visitor/);
  assert.equal(said.length, 3);
  await runPromiseOf();
});

test("options are listed at most once per turn; a second listing is refused with the act-now instruction", async () => {
  reset();
  const { h, said } = build();
  h.hear("what can sbl do for me");
  await tick();
  const agent = agents[0];
  const signal = new AbortController().signal;
  const say = (t) => agent.cfg.customTools.say.execute.call(agent, { text: t, then: "show" }, { signal });
  await say("Here are a few concrete paths: consulting, SaaS, and healthcare campaigns, each with a different acquisition goal.");
  assert.equal(said.length, 1);
  const again = await say("You can explore a consulting win, a SaaS demand-validation pilot, or a healthcare qualification campaign next; tell me which is closest to your business.");
  assert.match(again, /^⚠️/, "the first refusal warns the model (was: ended the turn)");
  assert.equal(await say("You can explore a consulting win, a SaaS demand-validation pilot, or a healthcare qualification campaign next; tell me which is closest to your business."), "Stopped.", "the second listing ends the turn");
  assert.equal(said.length, 2, "the listing was never spoken; the turn had spoken, so one apology line follows");
  await runPromiseOf();
});

test("ask-once: a question the visitor has not answered is never re-asked, in the say loop or ask_user", async () => {
  reset();
  const { h, said } = build();
  h.hear("create a campaign for me");
  await tick();
  const agent = agents[0];
  const signal = new AbortController().signal;
  const say = (t) => agent.cfg.customTools.say.execute.call(agent, { text: t, then: "show" }, { signal });
  await say("Tell me who you want to reach, and what offer should I lead with?");
  assert.equal(said.length, 1);
  // ask_user with the same question (already said aloud, unanswered): refused, no second wait, the turn ends
  const ask = await agent.cfg.customTools.ask_user.execute.call(agent, { question: "Tell me who you want to reach, and what offer should I lead with?" }, { signal });
  assert.match(ask, /^⚠️/, "refused, with a warning for the model (was: Stopped.)");
  assert.equal(h.isWaiting(), false, "no second wait was opened");
  // and in the say loop, in the visitor's next turn of the same task: the re-ask ends that turn too
  h.hear("hmm");
  await tick();
  const next = agents.at(-1), say2 = (t) => next.cfg.customTools.say.execute.call(next, { text: t, then: "show" }, { signal });
  await say2("Who do you want to reach, and what offer should I lead with?");
  assert.match(await say2("Tell me who you want to reach, what offer are we leading with?"), /^⚠️/, "the re-ask is refused (was: ended the turn at once)");
  assert.equal(await say2("Tell me who you want to reach, and which offer are we leading with?"), "Stopped.", "the second ends the turn");
  assert.equal(said.length, 3, "each question was spoken exactly once, then one apology line");
  await runPromiseOf();
});

test("point_at logs what it outlined against what was said, and the proof can read the alignment", async () => {
  reset();
  const { h } = build();
  h.hear("show me the finance study");
  await tick();
  const agent = agents[0];
  const events = [];
  const listener = (e) => { try { events.push({ type: e.type, detail: e.detail }); } catch {} };
  globalThis.document.addEventListener("sbl-agent-action", listener);
  globalThis.document.addEventListener("sbl-point", listener);
  const signal = new AbortController().signal;
  await agent.cfg.customTools.say.execute.call(agent, { text: "Their strategy section defines finance personas and triggers." }, { signal });
  const fakeEl = {
    innerText: "Keshav Pawar",
    getAttribute: () => null,
    type: "",
    getBoundingClientRect: () => ({ width: 120, height: 20, top: 10, bottom: 30, left: 0, right: 120 }),
    closest: () => null,
    scrollIntoView() {},
  };
  agent.pageController.selectorMap.set(3, { ref: fakeEl });
  const res = await agent.cfg.customTools.point_at.execute.call(agent, { index: 3, note: "the strategy" }, { signal });
  globalThis.document.removeEventListener("sbl-agent-action", listener);
  globalThis.document.removeEventListener("sbl-point", listener);
  assert.match(res, /Pointing at/);
  const align = events.filter((e) => e.type === "sbl-agent-action" && /point-align/.test(e.detail || ""));
  assert.ok(align.length >= 1, "the alignment line is in the action log");
  assert.match(align.at(-1).detail, /strategy/, "the narrated topic rides along for scoring");
  agent.end({ success: true, data: "", history: [{ type: "step" }] });
  await new Promise((r) => setTimeout(r, 30));
});

// wait for the last heard run to settle
function runPromiseOf() { return new Promise((r) => setTimeout(r, 30)); }
