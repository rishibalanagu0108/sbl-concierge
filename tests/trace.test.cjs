const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The turn trace (FR-15, docs/TRACE-SCHEMA.md): the page-side tracer, the harness hooks, and the server side (/trace, model events).
for (const m of ["task", "turn", "trace", "guard", "constitution", "sbl-knowledge", "screens"]) require(`../core/${m}.js`);
const Trace = require("../core/trace.js");
const stored = new Map();
// id: this stub IS the extension context (bg() keys on runtime.id, not on sendMessage, which a plain page also exposes).
globalThis.chrome = { runtime: { id: "fake-extension", sendMessage: async (m) => (m.op === "put" ? (stored.set("t", JSON.parse(JSON.stringify(m.task))), { ok: true }) : m.op === "clear" ? (stored.delete("t"), { ok: true }) : { ok: true, task: stored.get("t") || null }) } };
Object.assign(globalThis, { document: Object.assign(new EventTarget(), { readyState: "complete", body: { innerText: "" }, getElementsByTagName: () => [], querySelectorAll: () => [] }),
  location: { href: "https://sbl.so/pricing/", pathname: "/pricing/" }, addEventListener() {}, MutationObserver: class { observe() {} disconnect() {} } });
const agents = [];
class FakeAgent {
  constructor(cfg) { this.cfg = cfg; this.pageController = { selectorMap: new Map(), inputText: async () => {} }; agents.push(this); }
  addEventListener() {}
  pushObservation() {}
  execute() { return new Promise((resolve) => { this.end = resolve; }); }
  stop() { this.end?.({ success: false, data: "Task aborted", history: [] }); }
}
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
globalThis.SBLEngine = { PageAgentCore: FakeAgent, PageController: class {}, tool: (t) => t, z: new Proxy({}, { get: () => chain }) };
require("../harness.js");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const build = () => {
  stored.clear(); agents.length = 0;
  const events = [], said = [], chats = [];
  const h = SBLHarness.create({ cursor: () => null, say: (t) => said.push(t), note() {}, needs() {}, busy() {}, acting() {}, endCards() {}, context: () => ({}), tools: {}, remember: async () => {},
    confirm: async () => "", askSecret: async () => "hunter22!", chat: async (body, headers) => { chats.push(headers); return { status: 200, body: {} }; }, tracePost: (e) => events.push(e) });
  return { h, events, said, chats };
};
const kinds = (events, k) => events.filter((e) => e.k === k);

test("an event has the schema's common fields and clipped text", () => {
  const events = [];
  const t = Trace.create({ v: "11111111-1111-4111-8111-111111111111", send: (e) => events.push(e), storage: null, now: () => 42 });
  t.open("x".repeat(900), "typed", "https://sbl.so/");
  t.line("y".repeat(900));
  t.action("click", "z".repeat(300));
  t.error("e".repeat(900));
  assert.deepEqual(events[0], { t: 42, v: "11111111-1111-4111-8111-111111111111", turn: "11111111-" + events[0].turn.split("-")[1] + "-1", k: "turn_open", text: "x".repeat(500), mode: "typed", url: "https://sbl.so/" });
  assert.equal(events[1].text.length, 500);
  assert.equal(events[1].refused, undefined, "an ordinary line has no refused flag");
  assert.equal(events[2].target.length, 120);
  assert.equal(events[3].detail.length, 300);
  assert.equal(events[3].turn, events[0].turn);
  assert.match(events[0].turn, /^11111111-[a-z0-9]{4}-1$/);
});

test("turn ids increment per visitor message, and a turn ends once", () => {
  const events = [];
  const t = Trace.create({ v: "abcdef12-0000-4000-8000-000000000000", send: (e) => events.push(e), storage: null });
  t.open("one", "typed", "u"); t.end("answered", "u"); t.end("failed", "u");
  t.open("two", "voice", "u");
  const tab = events[0].turn.split("-")[1];
  assert.deepEqual(events.map((e) => [e.k, e.turn]), [["turn_open", `abcdef12-${tab}-1`], ["turn_end", `abcdef12-${tab}-1`], ["turn_open", `abcdef12-${tab}-2`]]);
  assert.deepEqual(t.headers(), { "X-SBL-V": "abcdef12-0000-4000-8000-000000000000", "X-SBL-Turn": `abcdef12-${tab}-2` });
});

test("the counter survives a page load (same tab storage)", () => {
  const map = new Map(), storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const first = []; Trace.create({ v: "aaaaaaaa-0", send: (e) => first.push(e), storage }).open("a", "typed", "u");
  const again = []; const t2 = Trace.create({ v: "aaaaaaaa-0", send: (e) => again.push(e), storage });
  t2.open("b", "typed", "u");
  assert.equal(again[0].turn, `aaaaaaaa-${first[0].turn.split("-")[1]}-2`);
});

test("the harness opens a turn per visitor message (typed, voice, answer) and ends it with a status", async () => {
  const { h, events } = build();
  h.hear("show me pricing", "typed");
  await tick();
  assert.equal(kinds(events, "turn_open")[0].mode, "typed");
  assert.equal(kinds(events, "turn_open")[0].text, "show me pricing");
  h.hear("and teams", "voice"); // pre-empts the run: the first turn is preempted
  await tick();
  assert.deepEqual(kinds(events, "turn_open").map((e) => e.mode), ["typed", "voice"]);
  assert.equal(kinds(events, "turn_end")[0].status, "preempted");
  assert.notEqual(kinds(events, "turn_open")[0].turn, kinds(events, "turn_open")[1].turn);
  agents[1].end({ success: true, data: "Here is Pro.", history: [{ type: "step" }] });
  await tick();
  const end = kinds(events, "turn_end").at(-1);
  assert.equal(end.status, "answered");
  assert.equal(end.turn, kinds(events, "turn_open")[1].turn);
  assert.equal(kinds(events, "line").at(-1).text, "Here is Pro.", "the final line the visitor saw is traced");
});

test("a refused line is traced with refused: true and the visitor never saw it; actions are traced without proof mode", async () => {
  const { h, events, said } = build();
  h.hear("compare plans", "typed");
  await tick();
  const tools = agents[0].cfg.customTools;
  await tools.say.execute({ text: "Pro is the plan for teams of ten or more." }, {});
  await tools.say.execute({ text: "Pro is the plan for teams of ten or more people." }, {}); // re-worded duplicate: refused by the guard
  const lines = kinds(events, "line");
  assert.deepEqual(lines.map((e) => !!e.refused), [false, true]);
  assert.equal(said.length, 1);
  assert.deepEqual(kinds(events, "action").map((e) => e.type), ["say", "say"]);
});

test("masking: a typed secret and the fill value never reach an event; fill carries the label only", async () => {
  const { h, events } = build();
  h.hear("sign me up", "typed");
  await tick();
  const el = { tagName: "INPUT", type: "password", name: "pw", id: "pw", innerText: "", value: "", getAttribute: (a) => (a === "placeholder" ? "Password" : null), matches: () => true };
  agents[0].pageController.selectorMap.set(3, { ref: el });
  await agents[0].cfg.customTools.fill_secret.execute({ index: 3 }, { signal: new AbortController().signal });
  await agents[0].cfg.customTools.say.execute({ text: "Your password hunter22! is set." }, {});
  const all = JSON.stringify(events);
  assert.ok(!all.includes("hunter22"), "the secret appears nowhere in the trace");
  assert.match(kinds(events, "line").at(-1).text, /\[hidden\]/);
  assert.deepEqual(kinds(events, "action").find((e) => e.type === "fill").target, "Password");
});

test("a crash keeps its cause in the trace and the visitor gets exactly one honest line", async () => {
  const { h, events, said } = build();
  const orig = FakeAgent.prototype.execute;
  FakeAgent.prototype.execute = () => Promise.reject(new TypeError("boom: model exploded"));
  h.hear("go", "typed");
  await tick();
  FakeAgent.prototype.execute = orig;
  assert.match(kinds(events, "error")[0].detail, /boom: model exploded/);
  assert.equal(kinds(events, "turn_end").at(-1).status, "failed");
  assert.deepEqual(said, ["Sorry, I lost my thread there. Could you ask me that again?"], "never silent: one fallback line");
});

// ---- review fixes ----
test("blocked site storage (the getter throws) does not stop the tracer or SBLHarness.create", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    const events = [];
    const t = Trace.create({ v: "v", send: (e) => events.push(e) });
    t.open("hi", "typed", "u");
    assert.equal(events.length, 1);
    assert.doesNotThrow(() => build());
  } finally { real ? Object.defineProperty(globalThis, "sessionStorage", real) : delete globalThis.sessionStorage; }
});

test("every tracer method is exception-safe: throwing mask, corrupt state, throwing send; the visitor id is a string", () => {
  const bad = { getItem: () => '{"v":123,"n":"x","turn":5}', setItem() { throw new Error("full"); } };
  const t = Trace.create({ v: null, send: () => { throw new Error("send"); }, mask: () => { throw new Error("mask"); }, storage: bad });
  for (const f of [() => t.open("a", "typed", "u"), () => t.line("a", true), () => t.action("x", "y"), () => t.nav("u"), () => t.error("e"), () => t.end("answered", "u"), () => t.headers()]) assert.doesNotThrow(f);
  assert.equal(typeof t.headers()["X-SBL-V"], "string");
  const events = [];
  const t2 = Trace.create({ v: 12345678901, send: (e) => events.push(e), mask: () => { throw new Error("mask"); }, storage: null });
  t2.open("secret", "typed", "u");
  assert.equal(events[0].text, "[hidden]", "a failing mask hides the text rather than leaking it");
  assert.match(events[0].turn, /^12345678-/);
});

test("urls are traced as origin + path only; 13-19 digit runs are masked", () => {
  const events = [];
  const t = Trace.create({ v: "vvvvvvvv", send: (e) => events.push(e), storage: null });
  t.open("my card 4111 1111-1111 1111 ok, ref 12345", "typed", "https://sbl.so/a?token=abc#frag");
  t.nav("https://sbl.so/b?x=1"); t.nav("https://sbl.so/b?x=2"); t.end("answered", "https://sbl.so/c?q=1#h");
  assert.equal(events[0].text, "my card [number] ok, ref 12345");
  assert.deepEqual([events[0].url, events[1].url, events[2].url], ["https://sbl.so/a", "https://sbl.so/b", "https://sbl.so/c"]);
  assert.equal(events.filter((e) => e.k === "nav").length, 1, "same path with another query is not a new nav");
});

test("two tabs of one visitor never share a turn id; a seed carries the turn to the next page", () => {
  const ev = [], mk = () => Trace.create({ v: "same-visitor-id", send: (e) => ev.push(e), storage: null });
  const a = mk(), b = mk(); a.open("x", "typed", "u"); b.open("x", "typed", "u");
  assert.notEqual(ev[0].turn, ev[1].turn);
  const c = mk(); c.seed(a.state()); c.line("resumed"); c.end("answered", "u"); a.end("answered", "u");
  assert.equal(ev[2].turn, ev[0].turn, "the resumed page speaks in the same turn");
  assert.equal(ev.filter((e) => e.k === "turn_end").length, 1 + 1, "each tracer object ends its own once; the seed copies ended state");
});

test("a turn crossing a page load keeps its id: the task record carries it and boot seeds from it", async () => {
  const { h, events } = build();
  h.hear("go to pricing", "typed");
  await tick();
  await agents[0].cfg.customTools.say.execute({ text: "Opening it." }, {}); // hand() saves the task
  const task = stored.get("t");
  assert.match(task.trace.turn, /^[0-9a-f]{8}-[a-z0-9]{4}-\d+$/);
  assert.equal(task.trace.ended, false);
  // the next page, another origin: a fresh harness, fresh tracer, no shared storage
  const second = []; agents.length = 0;
  const h2 = SBLHarness.create({ cursor: () => null, say() {}, note() {}, needs() {}, busy() {}, acting() {}, endCards() {}, context: () => ({}), tools: {}, remember: async () => {},
    confirm: async () => "", askSecret: async () => "", chat: async () => ({ status: 200, body: {} }), tracePost: (e) => second.push(e) });
  await h2.boot(); await tick(900); // loaded() settles first
  assert.equal(second[0].turn, task.trace.turn, "the resumed run's events carry the same turn id");
  agents.at(-1).end({ success: true, data: "Done.", history: [{ type: "step" }] });
  await tick();
  const ends = kinds(second, "turn_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].turn, task.trace.turn);
});

test("NFR-12: the trace label of an editable never carries what is typed; the proof event is unchanged", async () => {
  const { h, events } = build();
  h.hear("write to them", "typed");
  await tick();
  const attrs = { "aria-label": "Message composer", contenteditable: "true" };
  const el = { tagName: "DIV", type: undefined, isContentEditable: true, innerText: "my pin is 4821", value: "my pin is 4821", getAttribute: (a) => attrs[a] ?? null, matches: () => false, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  agents[0].pageController.selectorMap.set(7, { ref: el });
  await agents[0].cfg.customTools.input_text.execute({ index: 7, text: "my pin is 4821" }, {}).catch(() => {});
  const fill = kinds(events, "action").find((a) => a.type === "fill");
  assert.equal(fill.target, "Message composer");
  assert.ok(!JSON.stringify(events).includes("4821"));
  delete attrs["aria-label"];
  const bare = build(); bare.h.hear("again", "typed"); await tick();
  agents[0].pageController.selectorMap.set(7, { ref: el });
  await agents[0].cfg.customTools.input_text.execute({ index: 7, text: "x" }, {}).catch(() => {});
  assert.equal(kinds(bare.events, "action").find((a) => a.type === "fill").target, "<div>");
});

test("NFR-12: a visitor message traced while a secret is awaited is recorded as [hidden]", async () => {
  const events = []; let release; stored.clear(); agents.length = 0;
  const h = SBLHarness.create({ cursor: () => null, say() {}, note() {}, needs() {}, busy() {}, acting() {}, endCards() {}, context: () => ({}), tools: {}, remember: async () => {},
    confirm: async () => "", askSecret: () => new Promise((r) => { release = r; }), chat: async () => ({ status: 200, body: {} }), tracePost: (e) => events.push(e) });
  h.hear("sign up", "typed"); await tick();
  const el = { tagName: "INPUT", type: "password", name: "pw", id: "pw", innerText: "", value: "", getAttribute: () => null, matches: () => true };
  agents[0].pageController.selectorMap.set(3, { ref: el });
  const p = agents[0].cfg.customTools.fill_secret.execute({ index: 3 }, { signal: new AbortController().signal });
  await tick();
  h.hear("my password is hunter22!", "typed");
  release("hunter22!"); await p;
  assert.equal(kinds(events, "turn_open").at(-1).text, "[hidden]");
});

test("a never-resolving tracePost does not delay hear() returning", async () => {
  stored.clear(); agents.length = 0;
  const h = SBLHarness.create({ cursor: () => null, say() {}, note() {}, needs() {}, busy() {}, acting() {}, endCards() {}, context: () => ({}), tools: {}, remember: async () => {},
    confirm: async () => "", askSecret: async () => "", chat: async () => ({ status: 200, body: {} }), tracePost: () => new Promise(() => {}) });
  const p = h.hear("hello", "typed");
  assert.ok(p && typeof p.then === "function");
  await tick();
  agents[0].end({ success: true, data: "Hi.", history: [{ type: "step" }] });
  assert.equal((await Promise.race([p, tick(500).then(() => "slow")])).status, "done");
});

// ---- server side ----
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sbl-trace-"));

test("appendTrace adds ts and appends JSON lines (one event or an array)", async () => {
  const { appendTrace } = await import("../trace-log.mjs");
  const dir = tmpDir();
  assert.equal(appendTrace({ k: "nav", url: "u" }, { dir, ts: Date.UTC(2026, 9, 13, 12) }), true);
  appendTrace([{ k: "line", text: "a" }, { k: "line", text: "b" }, "junk"], { dir, ts: Date.UTC(2026, 9, 13, 13) });
  const lines = fs.readFileSync(path.join(dir, "2026-10-13.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.k, l.ts]), [["nav", Date.UTC(2026, 9, 13, 12)], ["line", Date.UTC(2026, 9, 13, 13)], ["line", Date.UTC(2026, 9, 13, 13)]]);
});

test("an unwritable trace dir does not throw", async () => {
  const { appendTrace } = await import("../trace-log.mjs");
  const file = path.join(tmpDir(), "a-file");
  fs.writeFileSync(file, "x"); // a file where the directory should be
  assert.equal(appendTrace({ k: "nav" }, { dir: path.join(file, "trace") }), false);
});

test("the server: POST /trace answers 204 (even unwritable), 403 for a foreign origin; /agent/chat writes a model event with ms", async (t) => {
  const dir = tmpDir();
  Object.assign(process.env, { PORT: "8793", OPENAI_API_KEY: "test-key", TRACE_DIR: dir });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.openai.com")) {
      await new Promise((r) => setTimeout(r, 15));
      return new Response(JSON.stringify({ id: "r1", model: "m", status: "completed", output: [{ type: "function_call", call_id: "c1", name: "AgentOutput", arguments: "{}" }], usage: { input_tokens: 120, output_tokens: 7, input_tokens_details: { cached_tokens: 100 } } }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const { server } = await import("../server.mjs");
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  t.after(() => { globalThis.fetch = realFetch; server.close(); });
  const base = "http://127.0.0.1:8793", headers = { "Content-Type": "application/json", Origin: "https://sbl.so" };

  const ok = await realFetch(`${base}/trace`, { method: "POST", headers, body: JSON.stringify({ t: 1, v: "test", turn: "test-1", k: "turn_open", text: "hi", mode: "typed", url: "https://sbl.so/" }) });
  assert.equal(ok.status, 204);
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  const first = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n")[0]);
  assert.equal(first.k, "turn_open");
  assert.equal(typeof first.ts, "number");
  assert.equal((await realFetch(`${base}/trace`, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status, 403);

  const chat = await realFetch(`${base}/agent/chat`, { method: "POST", headers: { ...headers, "X-SBL-V": "vis-1", "X-SBL-Turn": "vis-1-4" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "AgentOutput", description: "", parameters: {} } }], tool_choice: "required" }) });
  assert.equal(chat.status, 200);
  const model = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.k === "model");
  assert.equal(model.turn, "vis-1-4");
  assert.equal(model.v, "vis-1");
  assert.equal(model.path, "/agent/chat");
  assert.equal(model.status, 200);
  assert.ok(model.ms >= 10, `ms measured (${model.ms})`);
  assert.deepEqual([model.prompt, model.completion, model.cached], [120, 7, 100]);

  process.env.TRACE_DIR = path.join(dir, file, "nope"); // unwritable now: still 204
  assert.equal((await realFetch(`${base}/trace`, { method: "POST", headers, body: JSON.stringify({ k: "nav" }) })).status, 204);
});

test("the server: malformed /trace JSON is 400, an oversized body is rejected without a write, null upstream passes through, a failed upstream still writes a model event", async (t) => {
  const dir = tmpDir();
  Object.assign(process.env, { PORT: "8794", OPENAI_API_KEY: "test-key", TRACE_DIR: dir });
  const realFetch = globalThis.fetch;
  let mode = "null";
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.openai.com")) return realFetch(url, init);
    if (mode === "null") return new Response("null", { status: 200 });
    if (mode === "timeout") throw Object.assign(new Error("t"), { name: "TimeoutError" });
    throw new TypeError("fetch failed");
  };
  const { server } = await import("../server.mjs?second");
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  t.after(() => { globalThis.fetch = realFetch; server.close(); });
  const base = "http://127.0.0.1:8794", headers = { "Content-Type": "application/json", Origin: "https://sbl.so" };
  assert.equal((await realFetch(`${base}/trace`, { method: "POST", headers, body: "{nope" })).status, 400);
  assert.equal((await realFetch(`${base}/trace`, { method: "POST", headers, body: JSON.stringify({ k: "line", text: "x".repeat(70_000) }) })).status, 400);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was written");
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "AgentOutput", description: "", parameters: {} } }], tool_choice: "required" });
  const chatHeaders = { ...headers, "X-SBL-V": "vis-9", "X-SBL-Turn": "vis-9-x-1" };
  const nul = await realFetch(`${base}/agent/chat`, { method: "POST", headers: chatHeaders, body });
  assert.equal(nul.status, 200);
  assert.equal(await nul.text(), "null");
  mode = "timeout"; await realFetch(`${base}/agent/chat`, { method: "POST", headers: chatHeaders, body });
  mode = "error"; await realFetch(`${base}/agent/chat`, { method: "POST", headers: chatHeaders, body });
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl"));
  const models = fs.readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.k === "model");
  assert.deepEqual(models.map((m) => m.status), [200, "timeout", "error"]);
  assert.ok(models.every((m) => typeof m.ms === "number" && m.turn === "vis-9-x-1"));
  assert.equal(models[1].prompt, undefined);
});
