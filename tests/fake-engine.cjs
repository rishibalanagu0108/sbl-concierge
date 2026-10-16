// A fake page-agent engine that behaves like the real one where the turn contract depends on it (spike S5):
// onBeforeStep is awaited before each step and agent.tools is re-read every step; stop() aborts and resolves when execute() has finished;
// the abort signal is checked before a tool starts and after it returns, but a running tool is not interrupted; a tool that is not on offer
// cannot be called; maxSteps allows maxSteps+1 iterations. The "model" is a script: a list of { name, args } actions (or hang / fail / crash).
const stored = new Map(), built = [];
// id: this stub IS the extension context (bg() keys on runtime.id, not on sendMessage, which a plain page also exposes).
globalThis.chrome = { runtime: { id: "fake-extension", sendMessage: async (m) => {
  if (m.op === "put") { stored.set("t", JSON.parse(JSON.stringify(m.task))); return { ok: true }; }
  if (m.op === "clear") { stored.delete("t"); return { ok: true }; }
  return { ok: true, task: stored.get("t") ? JSON.parse(JSON.stringify(stored.get("t"))) : null };
} } };
const assigned = [];
Object.assign(globalThis, { document: Object.assign(new EventTarget(), { readyState: "complete", body: { innerText: "" }, getElementsByTagName: () => [], querySelectorAll: () => [],
  defaultView: { scrollY: 0, innerHeight: 800 }, scrollingElement: { scrollHeight: 2000, scrollBy() {} }, documentElement: { scrollBy() {} } }),
  location: { href: "https://sbl.so/pricing/", pathname: "/pricing/", assign: (h) => { assigned.push(h); throw new Error("no real navigation in a unit test"); } }, addEventListener() {}, MutationObserver: class { observe() {} disconnect() {} } });

const agents = [], scripts = [], elements = new Map(); // elements: index -> fake DOM element every new agent can see
class FakeAgent {
  constructor(cfg) {
    this.cfg = cfg; this.tasks = []; this.observed = []; this.seen = []; this.ran = []; this.bad = [];
    this.pageController = { selectorMap: new Map(), inputText: async () => {}, scroll: async () => ({ message: "ok" }) };
    this.tools = new Map([...Object.entries(cfg.customTools).filter(([, v]) => v), ["done", { execute: async () => "" }]]);
    for (const [i, el] of elements) this.pageController.selectorMap.set(i, { ref: el });
    this.script = scripts.shift() || [];
    agents.push(this);
  }
  addEventListener() {}
  pushObservation(t) { this.observed.push(t); }
  stop() { this.ac?.abort(); return this.finished || Promise.resolve(); }
  async execute(task) {
    this.tasks.push(task);
    this.ac = new AbortController();
    const { signal } = this.ac;
    const abortP = new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    abortP.catch(() => {});
    let finish; this.finished = new Promise((r) => { finish = r; });
    const run = async () => {
      for (let step = 0; ; step++) {
        await this.cfg.onBeforeStep?.(this, step);
        if (step > this.cfg.maxSteps) return { success: false, data: "Step count exceeded maximum limit", history: [] };
        signal.throwIfAborted();
        this.seen.push({ tools: [...this.tools.keys()], page: this.cfg.instructions?.getPageInstructions?.("https://sbl.so/pricing/") });
        const act = this.script.shift();
        if (!act || act.hang) await abortP; // the model call is in flight until the run is stopped
        if (act.crash) throw new TypeError("boom: model exploded");
        if (act.fail) return { success: false, data: act.fail, history: [{ type: "error" }] };
        signal.throwIfAborted();
        if (!this.tools.has(act.name)) { this.bad.push(act.name); return { success: false, data: `tool not offered: ${act.name}`, history: [] }; }
        if (act.name === "done") return { success: act.args?.success !== false, data: act.args?.text || "no text provided", history: [{ type: "step" }] };
        signal.throwIfAborted(); // before a tool starts
        this.ran.push(act.name);
        try { await this.tools.get(act.name).execute.call(this, act.args, { signal }); } catch (e) { if (e?.name === "AbortError") throw e; }
        signal.throwIfAborted(); // after it returns
      }
    };
    try { return await run(); } catch (e) { if (e?.name === "AbortError") return { success: false, data: "Task aborted", history: [] }; throw e; } finally { finish(); }
  }
}
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
globalThis.SBLEngine = { PageAgentCore: FakeAgent, PageController: class {}, tool: (t) => t, z: new Proxy({}, { get: () => chain }) };
for (const m of ["record", "site-map", "task", "turn", "trace", "guard", "constitution", "sbl-knowledge", "screens"]) require(`../core/${m}.js`);
require("../harness.js");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const say = (text, then = "show", extra = {}) => ({ name: "say", args: { text, then, ...extra } });
const act = (name, args = {}) => ({ name, args });
const scr = (i = 0) => act("scroll", { index: 1, pixels: i + 1 }); // a real, quick, distinct action (the repeat guard keys on its arguments)
const done = (text = "", success = true) => ({ name: "done", args: { text, success } });
function build(over = {}) {
  stored.clear(); agents.length = 0; scripts.length = 0; assigned.length = 0; elements.clear();
  const said = [], events = [], calls = { endCards: 0, secrets: [], campaigns: 0 };
  const h = SBLHarness.create({ cursor: () => null, say: (t) => said.push(t), note() {}, needs() {}, busy() {}, acting() {}, endCards: () => calls.endCards++, context: () => ({}),
    tools: { read_campaigns: async () => { calls.campaigns++; return []; }, read_account: async () => ({}), request_human_call: async () => ({ ok: true }) }, remember: async () => {},
    confirm: async () => "", askSecret: async () => "", chat: async () => ({ status: 200, body: {} }), tracePost: (e) => events.push(e), ...over });
  built.push(h);
  return { h, said, events, calls };
}
const cleanup = () => { for (const h of built.splice(0)) { try { h.stop(); } catch {} } }; // a leftover run must not keep the process alive
const ends = (events) => events.filter((e) => e.k === "turn_end").map((e) => e.status);
module.exports = { cleanup, elements, agents, scripts, stored, assigned, build, tick, say, act, done, scr, FakeAgent };
