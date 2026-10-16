const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanup, elements, agents, scripts, stored, assigned, build, tick, say, act, done, scr } = require("./fake-engine.cjs");
const Turn = require("../core/turn.js");

const FALLBACK = "Sorry, I lost my thread there. Could you ask me that again?";
const STUCK = "Sorry, I got stuck partway through that. Ask me again and I will pick it up.";
test.afterEach(cleanup);
const set = (a) => [...a].sort();
const lines = (events) => events.filter((e) => e.k === "line" && !e.refused).map((e) => e.text);
const endsOf = (events) => events.filter((e) => e.k === "turn_end").map((e) => e.status);

test("pure: shapes, budgets and tool sets", () => {
  assert.deepEqual([Turn.LIMITS.end.actions, Turn.LIMITS.show.actions, Turn.LIMITS.do.actions], [3, 3, 12]);
  assert.deepEqual([Turn.LIMITS.end.ms, Turn.LIMITS.show.ms, Turn.LIMITS.do.ms, Turn.WATCHDOG_MS], [20_000, 20_000, 120_000, 8_000]);
  const t = Turn.create(1, 0);
  assert.deepEqual(Turn.allowed(t), ["say", "ask_user", "done"]);
  t.then = "show";
  assert.ok(Turn.allowed(t).includes("navigate") && !Turn.allowed(t).includes("input_text") && !Turn.allowed(t).includes("ask_user"));
  t.actions = 3;
  assert.deepEqual(Turn.allowed(t), ["say", "done", "request_human_call"]);
  t.then = "do"; t.actions = 0;
  assert.equal(Turn.allowed(t), null, "a do turn is offered everything");
  assert.equal(Turn.revive({ ...Turn.snap(t), ended: true }), null, "an ended turn does not come back");
});

test("the first step offers only say, ask_user and done; the shape of the line decides what follows", async () => {
  const { h } = build();
  scripts.push([say("Pro is the one for teams.", "show"), scr(1), done()]);
  await h.hear("which plan");
  const a = agents[0];
  assert.deepEqual(set(a.seen[0].tools), set(["say", "ask_user", "done"]));
  assert.match(a.seen[0].page, /new turn begins/);
  assert.ok(a.seen[1].tools.includes("navigate") && a.seen[1].tools.includes("point_at") && a.seen[1].tools.includes("click"));
  assert.ok(!a.seen[1].tools.includes("input_text") && !a.seen[1].tools.includes("fill_secret") && !a.seen[1].tools.includes("ask_user"));
  assert.match(a.seen[1].page, /Now act/); // a show turn that has promised and not acted is told to act, and cannot speak again
  assert.match(a.seen[2].page, /2 of 3 actions left/);
  assert.deepEqual(a.bad, []);
});

test('then:"end" ends the run after one line: nothing else of the script runs', async () => {
  const { h, said, events } = build();
  scripts.push([say("Pro is $189 a month.", "end"), act("scroll"), say("More.", "end")]);
  const r = await h.hear("price of pro?");
  assert.equal(r.status, "done");
  assert.deepEqual(said, ["Pro is $189 a month."]);
  assert.deepEqual(agents[0].ran, ["say"], "the model's next actions never started");
  assert.deepEqual(endsOf(events), ["answered"]);
  assert.equal(h.isRunning(), false);
  assert.equal(stored.size, 0);
});

test("a show turn: the second say is the closing line and ends it; a third line is impossible", async () => {
  const { h, said, events } = build();
  scripts.push([say("Here is the pricing page.", "show"), scr(1), say("That is Pro, on the right.", "end"), say("Anything else?", "end"), scr(2)]);
  const r = await h.hear("show me pricing");
  assert.equal(r.status, "done");
  assert.deepEqual(said, ["Here is the pricing page.", "That is Pro, on the right."]);
  assert.deepEqual(agents[0].ran, ["say", "scroll", "say"]);
  assert.deepEqual(endsOf(events), ["answered"]);
});

test("show budget: after 3 actions only a closing line or done is on offer; a 4th action is refused and the turn ends", async () => {
  const { h, said, events } = build();
  scripts.push([say("Let me show you.", "show"), scr(1), scr(2), scr(3), say("That is all of it.", "end")]);
  await h.hear("show me around");
  const a = agents[0];
  assert.deepEqual(set(a.seen[4].tools), set(["say", "done", "request_human_call"]), "actions used up: closing set");
  assert.deepEqual(said, ["Let me show you.", "That is all of it."]);
  // defence in depth: a 4th action that somehow arrives is refused by the hand itself
  const b = build();
  scripts.push([say("Let me show you.", "show"), scr(1), scr(2), scr(3), { hang: true }]);
  b.h.hear("show me around");
  await tick(150);
  const out = await agents[0].cfg.customTools.scroll.execute.call(agents[0], { index: 1, pixels: 99 }, { signal: new AbortController().signal });
  assert.equal(out, "Stopped.");
  assert.deepEqual(b.said, ["Let me show you."], "something was said already: no extra line");
  assert.deepEqual(endsOf(b.events), []); // the run settles through closeTurn
  await tick(30);
  assert.deepEqual(endsOf(b.events), ["answered"]);
});

test("a do turn gets 12 actions; the 13th is not on offer", async () => {
  const c = build();
  scripts.push([say("On it.", "do", { because: "fill the signup form for me" }), ...Array.from({ length: 12 }, (_, i) => scr(i)), say("All done.", "end")]);
  await c.h.hear("please fill the signup form for me");
  const a = agents.at(-1);
  assert.equal(a.seen[1].tools.includes("input_text"), true);
  assert.deepEqual(set(a.seen.at(-1).tools), set(["say", "done", "request_human_call"]));
  assert.deepEqual(c.said, ["On it.", "All done."]);
  assert.equal(a.ran.filter((n) => n === "scroll").length, 12);
});

test("dashboard draft work must act between progress lines, but can always ask or finish", async () => {
  const { h, said } = build({ context: () => ({ surface: "dashboard" }) });
  scripts.push([say("I will create a draft.", "do", { because: "create a draft campaign" }), scr(1), say("The form is open.", "do"), done()]);
  await h.hear("create a draft campaign");
  const a = agents[0];
  assert.ok(!a.seen[1].tools.includes("say"));
  for (const tool of ["click", "input_text", "ask_user", "done"]) assert.ok(a.seen[1].tools.includes(tool), tool);
  assert.ok(a.seen[2].tools.includes("say"));
  assert.ok(!a.seen[3].tools.includes("say"), "the next progress line also needs an intervening action");
  assert.ok(a.seen[3].tools.includes("done") && a.seen[3].tools.includes("ask_user"));
  assert.deepEqual(said, ["I will create a draft.", "The form is open."]);
  assert.deepEqual(a.bad, []);
});

test("do without matching evidence is refused and the turn ends with a line", async () => {
  const { h, said, events } = build();
  scripts.push([say("Sure, I will sign you up.", "do", { because: "the weather is nice" }), say("Sure, signing you up now.", "do", { because: "the weather is nice" }), scr(1)]);
  const r = await h.hear("what does the product do");
  assert.deepEqual(said, [FALLBACK], "the refused lines are not spoken; the fallback is, once (the first refusal only warns the model)");
  assert.deepEqual(agents[0].ran, ["say", "say"]);
  assert.deepEqual(endsOf(events), ["failed"]);
  assert.equal(r.status, "stopped");
  assert.equal(events.filter((e) => e.k === "line" && e.refused).length, 2);
});

test("a message during a run cancels it: the new turn starts after the old run settles, with the old turn's context", async () => {
  const { h, said, events } = build();
  scripts.push([say("Filling the form.", "do", { because: "fill the signup form" }), { hang: true }]);
  scripts.push([say("Sure, using your work email.", "end")]);
  const first = h.hear("fill the signup form");
  await tick(40);
  const second = h.hear("use my work email instead");
  assert.equal((await first).status, "preempted");
  const r = await second;
  assert.equal(r.status, "done");
  assert.equal(agents.length, 2);
  assert.match(agents[1].tasks[0], /Goal: use my work email instead/);
  assert.match(agents[1].tasks[0], /fill the signup form/, "the preface carries what the old turn was doing");
  assert.match(agents[1].tasks[0], /Filling the form\./);
  assert.deepEqual(set(agents[1].seen[0].tools), set(["say", "ask_user", "done"]), "the new turn starts at its first step");
  assert.deepEqual(said, ["Filling the form.", "Sure, using your work email."]);
  assert.deepEqual(endsOf(events), ["preempted", "answered"]);
});

test("a tool that is past its first check when the message arrives never runs its body (generation check after the save)", async () => {
  let hold, release, bodies = 0;
  const orig = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (m) => { if (m.op === "put" && hold) await hold; return orig(m); };
  try {
    const { h, said } = build({ say: (t) => { said.push(t); hold = new Promise((r) => { release = r; }); } });
    scripts.push([say("Filling the form.", "do", { because: "fill the signup form" }), scr(1), scr(2)]);
    scripts.push([say("Okay.", "end")]);
    const first = h.hear("fill the signup form");
    await tick(10);
    agents[0].pageController.scroll = async () => { bodies++; return { message: "ok" }; };
    await tick(40);
    assert.deepEqual(agents[0].ran, ["say", "scroll"], "the scroll was started by the engine and is waiting on the save");
    const second = h.hear("never mind");
    release(); hold = null;
    assert.equal((await first).status, "preempted");
    await second;
    assert.equal(bodies, 0, "the body of the old turn's tool never ran");
    assert.deepEqual(agents[0].ran, ["say", "scroll"], "and the engine started nothing more");
  } finally { globalThis.chrome.runtime.sendMessage = orig; }
});

test("an action already executing when the message arrives completes, but nothing starts after it", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { h, events } = build({ tools: { read_campaigns: async () => { await gate; return []; }, read_account: async () => { throw new Error("must not run"); } } });
  scripts.push([say("Working.", "do", { because: "please check my campaigns" }), act("read_campaigns"), act("read_account")]);
  scripts.push([say("Okay.", "end")]);
  const first = h.hear("please check my campaigns");
  await tick(50);
  assert.ok(agents[0].ran.includes("read_campaigns"), "the slow action is in flight");
  const second = h.hear("never mind, what is the price?");
  await tick(30);
  assert.equal(agents.length, 1, "the new turn waits for the old run to settle");
  release();
  assert.equal((await first).status, "preempted");
  assert.equal((await second).status, "done");
  assert.ok(!agents[0].ran.includes("read_account"));
  assert.deepEqual(endsOf(events), ["preempted", "answered"]);
});

test("a message during a pending private field releases it, closes the box, and gets a reply", async () => {
  let secretAsked = false, released = false;
  const { h, said, calls } = build({ askSecret: (label, signal) => new Promise((resolve) => { secretAsked = true; signal.addEventListener("abort", () => { released = true; resolve(""); }); }) });
  elements.set(3, { tagName: "INPUT", type: "password", name: "pw", id: "pw", innerText: "", value: "", getAttribute: () => null, matches: () => true });
  scripts.push([say("Setting up.", "do", { because: "sign me up for the trial" }), act("fill_secret", { index: 3 }), scr(1)]);
  scripts.push([say("Of course.", "end")]);
  const first = h.hear("sign me up for the trial");
  await tick(60);
  assert.equal(secretAsked, true);
  const before = calls.endCards;
  const second = h.hear("actually, wait, what does it cost?");
  assert.equal((await first).status, "preempted");
  assert.equal(released, true, "the pending box was released by the stop");
  assert.ok(calls.endCards > before, "the private box is closed");
  assert.equal((await second).status, "done");
  assert.deepEqual(said, ["Setting up.", "Of course."]);
  assert.ok(!agents[0].ran.includes("scroll"));
});

test("refused line: the first refusal warns the model, the second ends the turn (apology only if something was said, else the fallback)", async () => {
  const a = build();
  scripts.push([say("Pro is the plan for teams of ten or more.", "show"), scr(1), say("Pro is the plan for teams of ten or more people.", "show"), say("Pro is the plan for teams of ten or more folks.", "show"), scr(2)]);
  await a.h.hear("compare plans");
  assert.deepEqual(a.said, ["Pro is the plan for teams of ten or more."], "it said its line and showed something: a second refused closing line just ends the turn, no apology");
  assert.deepEqual(agents[0].ran, ["say", "scroll", "say", "say"]);
  assert.deepEqual(endsOf(a.events), ["answered"]);
  // after one refusal the model can say something different and carry on
  const a2 = build();
  scripts.push([say("Pro is the plan for teams of ten or more.", "show"), scr(1), say("Pro is the plan for teams of ten or more people.", "show"), say("It costs 189 dollars.", "end")]);
  await a2.h.hear("compare plans");
  assert.deepEqual(a2.said, ["Pro is the plan for teams of ten or more.", "It costs 189 dollars."]);
  const b = build();
  scripts.push([act("ask_user", { question: "What is your name?" })]); // a plain question needs no consent
  b.h.hear("hi"); await tick();
  assert.deepEqual(b.said, ["What is your name?"]);
});

test("crash, failed model call, engine budget, watchdog: exactly one line each when nothing was said", async () => {
  for (const [name, script, expected, status] of [
    ["crash", [{ crash: true }], FALLBACK, "failed"],
    ["failed model", [{ fail: "InvokeError: upstream 500" }], FALLBACK, "failed"],
    ["unavailable", [{ fail: "InvokeError: Authentication failed: assistant_unavailable" }], "My assistant is temporarily unavailable, so I cannot do this right now. Please try again in a little while.", "failed"],
    ["engine step budget", [{ fail: "Step count exceeded maximum limit" }], "I have used all the steps I get for one request and did not finish. Tell me if you want me to keep going.", "failed"],
    ["watchdog", [{ hang: true }], FALLBACK, "failed"],
  ]) {
    const { h, said, events } = build({ limits: { watchdog: 60 } });
    scripts.push(script);
    await h.hear("hello");
    assert.deepEqual(said, [expected], name);
    assert.deepEqual(endsOf(events), [status], name);
    assert.equal(h.isRunning(), false, name);
  }
});

test("a turn that already spoke gets exactly one apology line when it crashes or runs out of time", async () => {
  const a = build();
  scripts.push([say("Looking.", "show"), { crash: true }]);
  await a.h.hear("hello");
  assert.deepEqual(a.said, ["Looking.", STUCK], "was: silent after the first line");
  const b2 = build({ limits: { do: 60 }, tools: { read_campaigns: async () => { await tick(200); return []; } } }); // a slow action that ignores the abort
  scripts.push([say("Looking.", "do", { because: "check my campaigns" }), act("read_campaigns")]);
  b2.h.hear("check my campaigns");
  await tick(450);
  assert.deepEqual(b2.said, ["Looking.", STUCK], "the time budget ended the turn: one apology line (was: none)");
  assert.deepEqual(endsOf(b2.events), ["answered"]);
});

test("done text is spoken when this turn said nothing, even if an earlier turn of the task spoke", async () => {
  const a = build();
  scripts.push([done("Here you go.")]);
  assert.equal((await a.h.hear("hi")).status, "done");
  assert.deepEqual(a.said, ["Here you go."]);
  // a question in turn 1, its answer opens turn 2, which says nothing but done(text)
  const b = build();
  scripts.push([act("ask_user", { question: "What is your name?" }), done("Nice to meet you, Sam.")]);
  const run = b.h.hear("hi");
  await tick(40);
  assert.equal(b.h.isWaiting(), true);
  b.h.hear("Sam");
  await run;
  assert.deepEqual(b.said, ["What is your name?", "Nice to meet you, Sam."]);
  assert.deepEqual(set(agents[0].seen[1].tools), set(["say", "ask_user", "done"]), "the answer opened a new turn: first-step tools again");
  // done with a line already said this turn: not repeated
  const c = build();
  scripts.push([say("Pro is best.", "show"), done("Pro is best for teams.")]);
  await c.h.hear("which plan");
  assert.deepEqual(c.said, ["Pro is best."]);
  // done with nothing at all: never silent
  const d = build();
  scripts.push([done("")]);
  await d.h.hear("hello");
  assert.deepEqual(d.said, [FALLBACK]);
});

test("the answer to ask_user ends one turn as asked and opens the next; the trace says so", async () => {
  const { h, events } = build();
  scripts.push([act("ask_user", { question: "Which plan are you looking at?" }), say("Pro then.", "end")]);
  const run = h.hear("help me choose");
  await tick(40);
  h.hear("the pro one");
  await run;
  assert.deepEqual(events.filter((e) => e.k === "turn_open").length, 2);
  assert.deepEqual(endsOf(events), ["asked", "answered"]);
});

test("turn ends map to the trace statuses: handed_off, cannot, stopped", async () => {
  const a = build();
  scripts.push([say("I will get you a person.", "show"), act("request_human_call", { summary: "wants a call" }), scr(1)]);
  await a.h.hear("can I talk to someone");
  assert.deepEqual(endsOf(a.events), ["handed_off"]);
  assert.deepEqual(agents[0].ran, ["say", "request_human_call"]);
  const b = build();
  scripts.push([done("I cannot do that from here.", false)]);
  await b.h.hear("delete my account");
  assert.deepEqual(b.said, ["I cannot do that from here."]);
  assert.deepEqual(endsOf(b.events), ["cannot"]);
  const c = build();
  scripts.push([say("Working.", "do", { because: "check the campaigns" }), { hang: true }]);
  const run = c.h.hear("please check the campaigns");
  await tick(40);
  c.h.stop();
  assert.equal((await run).status, "stopped");
  assert.deepEqual(c.said, ["Working.", "Okay, I have stopped."]);
  assert.deepEqual(endsOf(c.events), ["stopped"]);
  assert.equal(stored.size, 0);
});

test("running is never stale: a run that fails to start, a run winding down, and a run that ended all leave it clear", async () => {
  // a run that throws before its first await settles
  const { FakeAgent } = require("./fake-engine.cjs");
  const a = build();
  const orig = FakeAgent.prototype.execute;
  FakeAgent.prototype.execute = () => { throw new TypeError("sync boom"); };
  const r = await a.h.hear("go");
  FakeAgent.prototype.execute = orig;
  assert.equal(r.status, "error");
  assert.equal(a.h.isRunning(), false);
  assert.deepEqual(a.said, [FALLBACK]);
  scripts.push([say("Back.", "end")]);
  assert.equal((await a.h.hear("again")).status, "done", "the next message starts a run normally");
  // a message that arrives while the old run is winding down is not lost
  let h2, sent = false;
  const b = build({ endCards: () => { if (!sent) { sent = true; h2.hear("and one more thing"); } } });
  h2 = b.h;
  scripts.push([say("First.", "end")]);
  scripts.push([say("Second.", "end")]);
  await b.h.hear("first thing");
  await tick(60);
  assert.deepEqual(b.said, ["First.", "Second."]);
  assert.equal(b.h.isRunning(), false);
});

test("the page load is not the turn's time: a slow load does not spend the show budget and strand the visitor", async () => {
  // Live on sbl.so: "Show me the features" said its line, navigated to /linkedin/, and the visitor was met on
  // arrival with "Sorry, I got stuck partway through that." A show turn has 20 s; Turn.revive keeps startedAt,
  // so unloading, fetching, parsing and booting the next page were all charged to the turn, and the deadline
  // fired the moment it resumed. The agent cannot act during a page load, so that time is not its own.
  const a = build();
  scripts.push([say("Taking you there.", "show"), scr(1), { hang: true }]);
  a.h.hear("show me the features");
  await tick(60);
  const saved = JSON.parse(JSON.stringify(stored.get("t")));
  assert.equal(saved.turn.then, "show");

  // The turn opened 18 s ago and the navigate was written 14 s ago: a 14 s page load of a 20 s budget.
  const now = Date.now();
  saved.turn.startedAt = now - 18_000;
  saved.updatedAt = now - 14_000;
  saved.visitorAt = now - 18_000; // still inside the task TTL

  const b = build();
  stored.set("t", saved);
  scripts.push([say("Here are the features.", "end")]);
  await b.h.boot();
  await tick(900);

  const page = agents[0]?.seen?.[0]?.page || "";
  const secs = Number((page.match(/(\d+)s\./) || [])[1]);
  // Without the credit only ~2 s of the 20 s remain and the deadline fires on arrival; with it, ~16 s.
  assert.ok(secs >= 10, `the resumed turn should keep most of its budget, got ${secs}s from: ${page}`);
  assert.ok(!b.said.some((l) => /got stuck partway/.test(l)), `stranded the visitor after a slow load: ${JSON.stringify(b.said)}`);
});

test("a turn that navigates resumes as the SAME turn on the next page, with what is left of its budget", async () => {
  const a = build();
  scripts.push([say("Taking you there.", "show"), scr(1), { hang: true }]);
  a.h.hear("show me pricing");
  await tick(60);
  const saved = stored.get("t");
  assert.equal(saved.turn.then, "show");
  assert.equal(saved.turn.actions, 1);
  assert.equal(saved.turn.lines, 1);
  // the next page: a fresh harness boots from the stored task (as after navigation)
  const b = build();
  stored.set("t", saved);
  scripts.push([say("And here is Pro.", "end")]);
  await b.h.boot();
  await tick(900);
  const r = agents[0];
  assert.deepEqual(r.seen[0].tools.includes("navigate"), true, "not a fresh first step");
  assert.deepEqual(r.seen[0].tools.includes("input_text"), false);
  assert.match(r.seen[0].page, /2 of 3 actions left/);
  assert.deepEqual(b.said, ["And here is Pro."]);
  assert.equal(b.events.filter((e) => e.k === "turn_open").length, 0, "no new turn was opened");
});

test("the backoff before a model retry is abortable", async () => {
  const { h } = build({ chat: async () => ({ status: 500, body: {} }) });
  h.hear("hello"); await tick();
  const cfg = agents[0].cfg, body = JSON.stringify({});
  await cfg.customFetch("u", { body, signal: new AbortController().signal }); // a failure: the next call backs off
  const ac = new AbortController(), t0 = Date.now();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(cfg.customFetch("u", { body, signal: ac.signal }), { name: "AbortError" });
  assert.ok(Date.now() - t0 < 500, "did not sleep out the 1 s backoff");
});

test("the engine limit is exact: maxSteps is the remaining budget minus one", async () => {
  const { h } = build();
  scripts.push([say("Hi.", "end")]);
  await h.hear("hi");
  assert.equal(agents[0].cfg.maxSteps, SBLTask.BUDGET - 1);
});

// ---- the review fixes (B1, B2, S5-S11) ----
const pw = () => ({ tagName: "INPUT", type: "password", name: "pw", id: "pw", innerText: "", value: "", isContentEditable: false, getAttribute: () => null, matches: () => true });
const unref8 = () => { const st = globalThis.setTimeout; globalThis.setTimeout = (f, ms, ...r) => { const t = st(f, ms, ...r); if (ms >= 8000) t.unref(); return t; }; return () => { globalThis.setTimeout = st; }; }; // the navigate sleep and the 8 s cap must not hold the test process
const spyPuts = () => { const puts = [], orig = globalThis.chrome.runtime.sendMessage; globalThis.chrome.runtime.sendMessage = async (m) => { if (m.op === "put") puts.push(m.task.goal); return orig(m); }; return { puts, restore: () => { globalThis.chrome.runtime.sendMessage = orig; } }; };

test("B1: a message during an in-flight navigation is stored at once; the next page resumes THAT message as a turn that owes its first line", async () => {
  const orig = location.assign, undo = unref8(); location.assign = (h) => { assigned.push(h); }; // the navigation starts; the page is still alive for a moment
  try {
    const a = build();
    scripts.push([say("Here are the features.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" }), scr(1)]);
    a.h.hear("show me the features"); await tick(80);
    assert.deepEqual(assigned, ["https://sbl.so/whatsapp/"]);
    a.h.hear("no wait, I want the pricing instead"); await tick(30);
    const saved = JSON.parse(JSON.stringify(stored.get("t")));
    assert.equal(saved.goal, "no wait, I want the pricing instead", "the new message is stored before the old run settles");
    assert.deepEqual([saved.turn.lines, saved.turn.then, saved.turn.ended], [0, null, false]);
    const b = build(); stored.set("t", saved); scripts.push([say("Pricing it is.", "end")]);
    await b.h.boot(); await tick(900);
    assert.match(agents[0].tasks[0], /Goal: no wait, I want the pricing instead/);
    assert.doesNotMatch(agents[0].tasks[0], /show me the features/);
    assert.deepEqual(set(agents[0].seen[0].tools), set(["say", "ask_user", "done"]), "the first step again");
    assert.deepEqual(b.said, ["Pricing it is."]);
  } finally { location.assign = orig; undo(); }
});

test("B1: Stop during an in-flight navigation clears the stored task at once", async () => {
  const orig = location.assign, undo = unref8(); location.assign = (h) => { assigned.push(h); };
  try {
    const a = build();
    scripts.push([say("Here are the features.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" }), scr(1)]);
    a.h.hear("show me the features"); await tick(80);
    assert.ok(stored.get("t"));
    a.h.stop();
    assert.equal(stored.size, 0, "cleared synchronously");
    await tick(80);
    assert.equal(stored.size, 0, "and the run winding down does not write it back");
  } finally { location.assign = orig; undo(); }
});

test("B1: the tail of a dead turn's tool never overwrites the stored task", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const spy = spyPuts();
  try {
    const { h } = build({ tools: { read_campaigns: async () => { await gate; return []; } } });
    scripts.push([say("Working.", "do", { because: "please check my campaigns" }), act("read_campaigns")]);
    scripts.push([{ hang: true }]);
    const first = h.hear("please check my campaigns"); await tick(50);
    const second = h.hear("never mind, forget it"); await tick(10);
    release(); await first; await tick(40);
    const after = spy.puts.lastIndexOf("never mind, forget it");
    assert.ok(after >= 0);
    assert.ok(!spy.puts.slice(after).includes("please check my campaigns"), "no put of the old goal after the new message was stored");
    h.stop(); await second;
  } finally { spy.restore(); }
});

test("B2: time spent on a private field does not count against a do turn", async () => {
  const c = build({ limits: { do: 1000 }, askSecret: async () => { await tick(2500); return "hunter2xyz"; }, tools: { read_campaigns: async () => { await tick(800); return []; } } });
  elements.set(3, pw());
  scripts.push([say("Setting up.", "do", { because: "sign me up for the trial" }), act("fill_secret", { index: 3 }), act("read_campaigns"), say("All set.", "do"), done()]);
  const r = await c.h.hear("sign me up for the trial");
  assert.deepEqual(c.said, ["Setting up.", "All set."], "was: the budget line fired within 2 s of the wait and cut the turn");
  assert.equal(r.status, "done");
  assert.ok(stored.get("t") === undefined);
});

test("B2: a pending confirmation card is not the turn's time either; the wait rides the snapshot", async () => {
  const card = { tagName: "BUTTON", type: "", innerText: "Launch campaign", getAttribute: () => null, closest: () => null, matches: () => false, isConnected: true };
  const c = build({ limits: { do: 1000 }, confirm: async () => { await tick(2500); return "Approved."; }, tools: { read_campaigns: async () => { await tick(800); return []; } } });
  elements.set(4, card);
  scripts.push([say("Launching it.", "do", { because: "please launch my campaign" }), act("request_confirmation", { index: 4, action: "Launch", effect: "Starts it" }), act("read_campaigns"), say("Launched.", "do"), done()]);
  await c.h.hear("please launch my campaign");
  assert.deepEqual(c.said, ["Launching it.", "Launched."]);
  // the snapshot carries it across a page load
  const t = Turn.create(1, 0); t.then = "do"; t.waited = 5000;
  assert.equal(Turn.revive(Turn.snap(t)).waited, 5000);
  assert.equal(Turn.msLeft(t, 100_000), 25_000, "100 s elapsed, 5 s of them waiting on the visitor: 120 - 95");
});

test("S5: Stop is a refusal; a message after a stopped turn gets no 'you were working on' preface", async () => {
  const c = build();
  scripts.push([say("Signing you up.", "do", { because: "sign me up for the trial" }), { hang: true }]);
  scripts.push([say("Hello.", "end")]);
  const run = c.h.hear("sign me up for the trial"); await tick(40);
  c.h.stop();
  const next = c.h.hear("hello again"); // while the stopped run winds down
  await run; await next;
  assert.doesNotMatch(agents[1].tasks[0], /interrupted you|signing you up|sign me up/i);
  scripts.push([say("Pro is 189.", "show"), act("navigate", { url: "https://app.secondbrainlabs.com/signup", because: "sign me up for the trial" }), done()]);
  await c.h.hear("what is the price");
  assert.deepEqual(assigned, [], "the old request predates the Stop");
});

test("S5: a bare 'no' / 'not yet' is recorded as a refusal by the harness, with no help from the model", async () => {
  const c = build();
  scripts.push([say("Happy to.", "end")]);
  await c.h.hear("sign me up for the trial");
  scripts.push([say("Okay.", "end")]); // the model does NOT mark declined
  await c.h.hear("not yet");
  scripts.push([say("Pro is 189.", "show"), act("navigate", { url: "https://app.secondbrainlabs.com/signup", because: "sign me up for the trial" }), done()]);
  await c.h.hear("what is the price");
  assert.deepEqual(assigned, []);
});

test("S5: the visitor taking over the page is a refusal too", async () => {
  const handlers = {}, orig = globalThis.addEventListener; globalThis.addEventListener = (t, f) => { (handlers[t] ||= []).push(f); };
  try {
    const c = build();
    scripts.push([say("Signing you up.", "do", { because: "sign me up for the trial" }), { hang: true }]);
    const run = c.h.hear("sign me up for the trial"); await tick(40);
    for (const f of handlers.pointerdown) f({ type: "pointerdown", isTrusted: true, composedPath: () => [] });
    await run;
    scripts.push([say("Pro is 189.", "show"), act("navigate", { url: "https://app.secondbrainlabs.com/signup", because: "sign me up for the trial" }), done()]);
    await c.h.hear("what is the price");
    assert.deepEqual(assigned, []);
  } finally { globalThis.addEventListener = orig; }
});

test("S6a/b: the line that answers an answer is not a re-statement; the answered question is cleared", async () => {
  const { h, said } = build();
  scripts.push([say("On it.", "do", { because: "sign me up for the trial" }), act("ask_user", { question: "What is your work email?", because: "sign me up for the trial" }),
    say("Thanks, adding your email now.", "do", { because: "sign me up for the trial" }), act("ask_user", { question: "Which company are you with?" }),
    say("Thanks, adding your company now.", "do", { because: "sign me up for the trial" }), scr(2), done("All set.")]);
  const run = h.hear("please sign me up for the trial"); await tick(40);
  h.hear("sam@example.com"); await tick(60);
  h.hear("Acme"); const r = await run;
  assert.deepEqual(said, ["On it.", "What is your work email?", "Thanks, adding your email now.", "Which company are you with?", "Thanks, adding your company now."]);
  assert.equal(r.status, "done");
  const q = build();
  scripts.push([act("ask_user", { question: "Which plan are you looking at?" }), { hang: true }]);
  const qrun = q.h.hear("help me choose"); await tick(40);
  assert.equal(stored.get("t").question, "Which plan are you looking at?");
  q.h.hear("the pro one"); await tick(40);
  assert.equal(stored.get("t").question, null, "the answer clears the stored question");
  q.h.stop(); await qrun;
});

test("S6d: after an action a re-worded closing line is fine; without one it is still refused", async () => {
  const a = build();
  scripts.push([say("Here is the Pro plan for teams.", "show"), scr(1), say("Pro is on the right, 189 dollars a month.", "end")]);
  await a.h.hear("show me pro");
  assert.deepEqual(a.said, ["Here is the Pro plan for teams.", "Pro is on the right, 189 dollars a month."], "was: dropped (overlap 0.33 >= 0.25)");
  const b = build();
  scripts.push([say("Filling the form.", "do", { because: "fill the signup form" }), say("Form filling now, over there.", "do"), say("Everything is submitted.", "do"), done()]);
  await b.h.hear("fill the signup form");
  assert.deepEqual(b.said, ["Filling the form.", "Everything is submitted."], "no action between the two lines: the re-word is refused once, then something different goes through");
});

test("S7: a turn resumed after a human step is active again, has its deadline armed, and the human wait is not its time", async () => {
  const a = build({ limits: { do: 400 } });
  const now = Date.now();
  stored.set("t", { ...SBLTask.newTask("sign me up for the trial"), status: "waiting_human", turn: { id: 4, then: "do", actions: 5, lines: 1, said: ["On it."], startedAt: now - 3000, ended: false, system: false } });
  scripts.push([{ hang: true }]);
  await a.h.boot();
  assert.equal(stored.get("t").status, "active", "was: stuck at waiting_human, so the deadline re-armed for ever");
  await tick(1500)  /* the resumed page settles first (the real DOM-settle, 600 ms quiet) */;
  assert.equal(a.h.isRunning(), false, "the deadline ended it (3 s of a 0.4 s budget, the human wait was only just now)");
  assert.deepEqual(a.said, [STUCK]);
});

test("S8: after the pre-emption cap the old run's late settle does not tear down the new turn", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { h, events, calls } = build({ limits: { preempt: 60 }, tools: { read_campaigns: async () => { await gate; return []; } } });
  scripts.push([say("Checking.", "do", { because: "check my campaigns" }), act("read_campaigns")]);
  scripts.push([say("Okay.", "show"), { hang: true }]);
  h.hear("check my campaigns"); await tick(60);
  h.hear("never mind, show me the pricing"); await tick(200);
  assert.equal(agents.length, 2, "the new run started with the old one still alive");
  const cards = calls.endCards, n = events.length;
  release(); await tick(100);
  assert.equal(calls.endCards, cards, "the old run did not close the new turn's cards");
  assert.deepEqual(events.slice(n).filter((e) => e.k === "error" || e.k === "turn_end"), [], "and traced nothing into the new turn");
  assert.equal(h.isRunning(), true);
  h.stop();
});

test("S9: a message that arrives during ask_user's own save leaves no stale waiter", async () => {
  let hold, release; const orig = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (m) => { if (m.op === "put" && m.task.awaiting === "answer" && hold) await hold; return orig(m); };
  try {
    const { h, said } = build();
    hold = new Promise((r) => { release = r; });
    scripts.push([act("ask_user", { question: "Which plan are you looking at?" })]);
    scripts.push([say("Pro is 189 a month.", "end")]);
    h.hear("help me choose"); await tick(40);
    const b = h.hear("actually what does pro cost"); await tick(5); release(); hold = null;
    await b;
    assert.equal(h.isWaiting(), false, "was: the dead turn's ask_user left a waiter");
    assert.deepEqual(said, ["Pro is 189 a month."], "the dead turn's question was never shown");
    scripts.push([say("Yes, there is a 14 day trial.", "end")]);
    assert.equal((await h.hear("is there a free trial")).status, "done", "the next message is not swallowed");
  } finally { globalThis.chrome.runtime.sendMessage = orig; }
});

test("S10: the engine's 'no text provided' stand-in for an empty done is treated as empty", async () => {
  const a = build();
  scripts.push([done("")]);
  await a.h.hear("hello");
  assert.deepEqual(a.said, [FALLBACK]);
  const b = build();
  scripts.push([done("", false)]);
  await b.h.hear("hello");
  assert.ok(!b.said.includes("no text provided"));
});

test("S11: the wall after a line speaks one apology and stores no question the visitor never saw; a watchdog during ask_user's save is not a second line", async () => {
  const a = build();
  scripts.push([say("Working.", "do", { because: "fill the signup form" }), ...Array.from({ length: 6 }, () => scr(1))]);
  await a.h.hear("fill the signup form");
  assert.deepEqual(a.said, ["Working.", STUCK]);
  assert.equal(stored.get("t").question, null);
  let hold, release; const orig = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (m) => { if (m.op === "put" && m.task.awaiting === "answer" && hold) await hold; return orig(m); };
  try {
    const b = build({ limits: { watchdog: 60 } });
    hold = new Promise((r) => { release = r; });
    scripts.push([act("ask_user", { question: "Which plan are you looking at?" })]);
    const run = b.h.hear("help me choose"); await tick(150);
    release(); hold = null; await run; await tick(30);
    assert.deepEqual(b.said, [FALLBACK], "the fallback only, not the question as well");
  } finally { globalThis.chrome.runtime.sendMessage = orig; }
});
