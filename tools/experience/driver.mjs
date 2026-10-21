// Experience-suite driver: one visitor in one headless browser. Library, not a server.
//   const v = await Visitor.start({ repo, start, outDir }); const step = await v.say("hi"); await v.close();
// Test rig, not product code. Pure helpers (isQuiet, rectsOverlap, ...) are exported for tests.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const DEFAULT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVER = "http://127.0.0.1:8787/";
export const REQ_CAP_MS = 60_000;
export const QUIET_MS = 5_000;
export const MAX_WAIT_MS = 120_000;
const ROOT = "#sbl-sales-concierge-root";
const BUSY_STATES = new Set(["thinking", "acting"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure pieces --------------------------------------------------------
/** Quiet = no model call in flight, dock not busy, and nothing happened (new line / busy) for quietMs. */
export function isQuiet({ now, lastLineAt, lastBusyAt = 0, inflight = 0, dockState = null }, quietMs = QUIET_MS) {
  if (inflight > 0 || BUSY_STATES.has(dockState)) return false;
  return now - Math.max(lastLineAt, lastBusyAt) >= quietMs;
}
/** Drop in-flight requests older than capMs; returns the dropped entries. `map`: key -> { start }. */
export function expireInflight(map, now, capMs = REQ_CAP_MS) {
  const dropped = [];
  for (const [k, v] of map) if (now - v.start >= capMs) { map.delete(k); dropped.push([k, v]); }
  return dropped;
}
export const rectsOverlap = (a, b) => Boolean(a && b) && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
  && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const unionRect = (rects) => {
  const r = rects.filter((x) => x && x.width > 0 && x.height > 0);
  if (!r.length) return null;
  const x = Math.min(...r.map((q) => q.x)), y = Math.min(...r.map((q) => q.y));
  return { x, y, width: Math.max(...r.map((q) => q.x + q.width)) - x, height: Math.max(...r.map((q) => q.y + q.height)) - y };
};
/** The server calls that are model calls (the router's /agent/route counts). */
export const isModelPath = (p) => p === "/agent/chat" || p === "/respond" || p === "/agent/route";
/** Agent lines shown after `seen`: `real` without the streaming preview, `any` true when anything (preview included) is there. */
export function agentLines(lines, seen = 0) {
  // A restored line is history, not a reply — except a line of THIS step that a page load redrew: with a known count of earlier lines
  // (seen > 0) everything after it belongs to the step, restored mark or not; on a fresh page (reload, the visitor's own goto) restored lines are skipped.
  const a = lines.slice(seen).filter((l) => l.who === "agent" && (seen > 0 || !l.restored));
  return { real: a.filter((l) => !l.preview), any: a.length > 0 };
}
export async function httpStatus(url, timeoutMs = 10_000) {
  if (!url || !/^https?:/.test(url)) return null;
  for (const method of ["HEAD", "GET"]) {
    try {
      const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "sbl-experience-suite" } });
      if (method === "HEAD" && r.status >= 400) continue; // some origins reject HEAD
      return r.status;
    } catch { /* try GET */ }
  }
  return null;
}

// ---- the visitor --------------------------------------------------------
export class Visitor {
  static async start({ repo = DEFAULT_REPO, headed = false, start = "https://sbl.so/", outDir, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS } = {}) {
    const v = new Visitor({ repo, headed, start, outDir, quietMs, maxWaitMs });
    await v.#launch();
    return v;
  }
  constructor(o) { Object.assign(this, o); this.events = []; this.inflight = new Map(); this.shotN = 0; this.log = null; this.stepsRun = 0; }
  #ev(kind, d = {}) { this.events.push({ t: Date.now(), kind, ...d }); }

  async #launch() {
    const { repo } = this;
    fs.mkdirSync(this.outDir, { recursive: true });
    // playwright lives in tools/capture of the repo under test, falling back to this repo's
    const dirs = [repo, DEFAULT_REPO].map((r) => path.join(r, "tools/capture/package.json")).filter((p) => fs.existsSync(p));
    const { chromium } = createRequire(dirs[0])("playwright");
    const bundle = fs.readFileSync(path.join(repo, "sbl-agent.js"), "utf8");
    this.browser = await chromium.launch({ headless: !this.headed, args: this.headed ? [] : ["--headless=new"] });
    const ctx = this.ctx = await this.browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.grantPermissions(["local-network-access"]).catch(async () => {
      for (const origin of ["https://sbl.so", "https://app.secondbrainlabs.com"]) await ctx.grantPermissions(["local-network-access"], { origin }).catch(() => {});
    });
    await ctx.exposeBinding("__sblAct", (_s, detail) => { try { this.#ev("action", JSON.parse(detail)); } catch { /* not json */ } });
    await ctx.addInitScript(() => {
      const K = "sbl_store_v1"; if (!sessionStorage.getItem(K)) sessionStorage.setItem(K, JSON.stringify({ sbl_proof: 1 }));
      addEventListener("sbl-agent-action", (e) => window.__sblAct?.(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)), true);
    });
    await ctx.addInitScript(bundle);

    // In-flight model calls: finished on requestfinished / requestfailed / the page navigating / the 60 s cap.
    const isModel = (r) => { const u = r.url(); if (!u.startsWith(SERVER)) return false; const p = new URL(u).pathname; return isModelPath(p); };
    const done = async (r, how) => {
      const e = this.inflight.get(r); if (!e) return; this.inflight.delete(r);
      let status = how;
      if (how === "ok") { try { status = (await r.response())?.status() ?? "ok"; } catch { status = "ok"; } }
      this.#ev("model", { path: new URL(r.url()).pathname, ms: Date.now() - e.start, status });
    };
    ctx.on("request", (r) => { if (isModel(r)) this.inflight.set(r, { start: Date.now(), frame: (() => { try { return r.frame(); } catch { return null; } })() }); });
    ctx.on("requestfinished", (r) => done(r, "ok"));
    ctx.on("requestfailed", (r) => done(r, "failed"));

    const page = this.page = await ctx.newPage();
    page.on("pageerror", (e) => this.#ev("pageerror", { text: String(e).slice(0, 300) }));
    page.on("console", (m) => { if (m.type() === "error" && /sbl-agent/.test(m.text())) this.#ev("pageerror", { text: m.text().slice(0, 300) }); });
    page.on("framenavigated", (f) => {
      this.#ev("nav", { url: f.url(), main: f === page.mainFrame() });
      for (const [r, e] of [...this.inflight]) if (e.frame === f) done(r, "navigated");
    });
    await this.#open(this.start);
  }
  async #open(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    await this.page.locator(`${ROOT} .launcher`).first().waitFor({ state: "attached", timeout: 25_000 }).catch(() => {});
    await this.page.locator(`${ROOT} .launcher`).first().evaluate((el) => el.click()).catch(() => {});
  }

  // what the page shows right now
  #read() {
    return this.page.evaluate((root) => {
      const host = document.querySelector(root), s = host?.shadowRoot;
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
      let inner = null; try { inner = document.querySelector("iframe")?.contentWindow?.location?.href || null; } catch { /* cross-origin */ }
      const lines = s ? [...s.querySelectorAll(".messages .msg")].map((m) => ({ who: m.classList.contains("user") ? "visitor" : "agent", text: m.textContent.trim(), preview: m.hasAttribute("data-preview"), restored: m.hasAttribute("data-restored") })) : [];
      // dock = the pill (.bar) plus the chat panel when open; spotlight = .spot.on inside the cursor layer's shadow root
      const panel = s?.querySelector(".panel.open");
      const spot = document.getElementById("sbl-agent-cursor-layer")?.shadowRoot?.querySelector(".spot.on");
      return { exists: Boolean(s), lines, state: s?.querySelector(".dock")?.dataset.state || null, dockRects: s ? [rect(s.querySelector(".bar")), rect(panel)] : [], spotRect: rect(spot), url: location.href, inner };
    }, ROOT).catch(() => null);
  }
  async #shot(label) {
    const f = path.join(this.outDir, `${String(++this.shotN).padStart(3, "0")}-${label}.png`);
    await this.page.screenshot({ path: f }).catch(() => {});
    return f;
  }
  async #sblv() { return (await this.ctx.cookies().catch(() => [])).find((c) => c.name === "sblv")?.value || null; }

  // Watch from now until quiet (and at least minMs), or maxMs.
  async #watch(kind, extra, { minMs = 0, maxMs = this.maxWaitMs } = {}) {
    const sentAt = Date.now(), evStart = this.events.length;
    const before0 = await this.#read();
    // After a page load the transcript is rebuilt: anything shown counts as new.
    // On the visit's FIRST step there is no history yet, so a line already on screen is
    // something the agent said on its own (the first-visit welcome, which fires on a timer
    // during page load). Counting it as history made the agent look silent on every
    // wait-only journey - it greeted, and the harness sliced the greeting away. Only lines
    // the dock marks as restored are real history at that point.
    const base = before0?.lines || [];
    const seen = extra.fresh ? 0
      : this.stepsRun === 0 ? base.filter((l) => l.restored).length
      : base.length;
    this.stepsRun++;
    if (extra.before) await extra.before();
    const lines = []; let wordsAt = null, lastLineAt = Date.now(), lastBusyAt = 0, s = null, timedOut = false;
    for (;;) {
      await sleep(400);
      const now = Date.now();
      for (const [r] of expireInflight(this.inflight, now)) { this.#ev("model", { path: new URL(r.url()).pathname, ms: REQ_CAP_MS, status: "capped" }); }
      s = await this.#read();
      if (s) {
        const { real: agent, any } = agentLines(s.lines, seen);
        if (wordsAt === null && any) wordsAt = now - sentAt; // the preview or the first real line, whichever shows first
        while (lines.length < agent.length) { lines.push({ atMs: now - sentAt, text: agent[lines.length].text }); lastLineAt = now; }
        for (let i = 0; i < lines.length && i < agent.length; i++) lines[i].text = agent[i].text; // a streamed line grows in place: keep when it first appeared, record what it ended as
        if (BUSY_STATES.has(s.state)) lastBusyAt = now;
      }
      if (this.inflight.size) lastBusyAt = now;
      if (now - sentAt >= minMs && isQuiet({ now, lastLineAt, lastBusyAt, inflight: this.inflight.size, dockState: s?.state }, this.quietMs)) break;
      if (now - sentAt >= maxMs) { timedOut = true; break; }
    }
    // a quiet cutoff is measured from the last activity; report time to activity, not the quiet tail
    const lastActivity = Math.max(lastLineAt, lastBusyAt);
    const ev = this.events.slice(evStart);
    const calls = ev.filter((e) => e.kind === "model");
    const url = s?.url || this.page.url();
    const dockRect = unionRect(s?.dockRects || []);
    return {
      do: kind, ...extra.meta, sentAt,
      firstLineMs: lines[0]?.atMs ?? null, firstWordsMs: wordsAt,
      busyMs: Math.max(0, Math.min(lastActivity, Date.now()) - sentAt),
      waitedMs: Date.now() - sentAt,
      timedOut, stillBusy: this.inflight.size > 0 || BUSY_STATES.has(s?.state),
      lines,
      modelCalls: calls.length, modelCallMs: calls.map((c) => c.ms), modelErrors: calls.filter((c) => c.status !== 200 && c.status !== "ok").map((c) => c.status),
      actions: ev.filter((e) => e.kind === "action").map((e) => ({ type: e.type, target: e.target ? String(e.target).slice(0, 120) : "" })),
      navigations: ev.filter((e) => e.kind === "nav").map((e) => e.url),
      urlBefore: before0?.url ?? null, shellUrlBefore: before0?.inner ?? null,
      url, shellUrl: s?.inner ?? null, urlStatus: await httpStatus(s?.inner || url),
      dockExists: Boolean(s?.exists), dockState: s?.state ?? null, dockRect,
      highlightRect: s?.spotRect ?? null, overlap: rectsOverlap(dockRect, s?.spotRect),
      screenshot: await this.#shot(kind),
      pageErrors: ev.filter((e) => e.kind === "pageerror").map((e) => e.text),
      sblv: await this.#sblv(),
    };
  }

  say(text, o = {}) {
    return this.#watch("say", {
      meta: { text },
      before: () => this.page.evaluate(({ root, text }) => {
        const s = document.querySelector(root).shadowRoot, i = s.querySelector(".input-row input");
        i.value = text; s.querySelector("form.input-row").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }, { root: ROOT, text }),
    }, o);
  }
  // Sets (or, with null, clears) the page's fault flag: the page then asks the server to fail its model calls that way (proof mode only; the server must run with ALLOW_FAULTS=1).
  async fault(code) {
    await this.page.evaluate((c) => (c ? sessionStorage.setItem("sbl_fault", c) : sessionStorage.removeItem("sbl_fault")), code ?? null);
    return { do: "fault", code: code ?? null, lines: [], actions: [], dockExists: true, sblv: await this.#sblv() };
  }
  wait(ms = 30_000) { return this.#watch("wait", { meta: { ms } }, { minMs: ms, maxMs: ms + this.maxWaitMs }); }
  goto(url) { return this.#watch("goto", { meta: { to: url }, fresh: true, before: () => this.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {}) }, { minMs: 6000 }); }
  reload() { return this.#watch("reload", { meta: {}, fresh: true, before: async () => { await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); await sleep(3000); } }, { minMs: 6000 }); }
  scroll(y = 600) { return this.#watch("scroll", { meta: { y }, before: async () => { await this.page.mouse.move(700, 450); await this.page.mouse.wheel(0, y); await sleep(1500); } }, { minMs: 2000 }); }
  async close() { await this.browser?.close().catch(() => {}); }
}
