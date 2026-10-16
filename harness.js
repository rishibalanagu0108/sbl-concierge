// The acting loop. One engine (page-agent core, vendor/engine.js) reads the page and picks the next action; the hands and eyes
// below are ours (our cursor, our dock, our confirmation card). One task survives page loads: it is stored per tab by the
// background worker and resumed by whichever page loads next. Pure decisions live in core/task.js and core/guard.js.
(function attachHarness(root) {
  function create(deps) {
    const { PageAgentCore, PageController, tool, z } = root.SBLEngine;
    const Task = root.SBLTask, Guard = root.SBLGuard, Turn = root.SBLTurn, Router = root.SBLRouter, Rec = root.SBLRecord;
    if (!deps.proof) for (const m of ["log", "group", "groupEnd", "debug", "info"]) console[m] = () => {}; // the engine narrates every step; only proof runs want that
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    const clip = (v, n) => clean(v).slice(0, n);
    let gone = false; // this document is being unloaded (or sits in the back/forward cache): it must not write the task or speak
    // The running task: as the extension it is stored per tab by the background worker; as a script tag
    // the tab was the unit (sessionStorage, per-origin) — but the app hop crosses origins, so the task
    // also rides the server store (keyed by sblv) and the next origin resumes from it. sessionStorage
    // is only a fallback; the hydrated store knows when the other origin has finished.
    const bg = (msg) => {
      if (gone && msg.op !== "get") return Promise.resolve(null);
      // `.id`, never `.sendMessage`: Chrome exposes chrome.runtime.sendMessage to an ORDINARY PAGE whenever any installed
      // extension declares externally_connectable for that origin, while leaving runtime.id undefined. The script-tag build
      // then took the extension path, and sendMessage threw "must specify an Extension ID" — synchronously, so the .catch()
      // below could not absorb it. That throw escaped save(), and navigate() never reached its location.assign(): the agent
      // said it was moving the page and never did. Every other guard in the bundle (content.js, core/trace.js) tests .id.
      if (globalThis.chrome?.runtime?.id) {
        try { return chrome.runtime.sendMessage({ type: "task", ...msg }).catch(() => null); }
        catch { /* "Extension context invalidated" after a reload throws here too: fall through to the local store */ }
      }
      const store = globalThis.SBLStore?.local;
      try {
        if (msg.op === "put") {
          sessionStorage.setItem("sbl_task_v1", JSON.stringify(msg.task));
          store?.set?.({ sbl_task_v1: msg.task })?.catch?.(() => {});
        } else if (msg.op === "clear") {
          sessionStorage.removeItem("sbl_task_v1");
          store?.remove?.("sbl_task_v1")?.catch?.(() => {});
        } else {
          const local = (() => { try { return JSON.parse(sessionStorage.getItem("sbl_task_v1") || "null"); } catch { return null; } })();
          // The other origin may have finished it; a tab's old copy must not resurrect that task.
          if (!store?.get) return Promise.resolve({ ok: true, task: local });
          return store.get("sbl_task_v1").then((r) => ({ ok: true, task: r?.sbl_task_v1 || null })).catch(() => ({ ok: true, task: null }));
        }
      } catch { /* storage blocked: the task just does not survive the load */ }
      return Promise.resolve({ ok: true });
    };

    let task = null; // the task of this tab (also stored by the background worker)
    let agent = null;
    let running = null; // promise of the current run
    let waiter = null; // resolves the visitor's next message (ask_user)
    let halt = null; // why the run is being ended from outside: { line, status ("done"/"clear" end the task, "preempted"/"stopped"/"waiting_user" keep it), kind (the trace status), question, awaiting }
    let run = { said: [], did: [] }; // what this run said and did
    // The turn (docs/TURN-CONTRACT.md): one per visitor message. `turn` is the live one; a tool or line that belongs to an older turn is dropped (generation check).
    let turn = null, gen = 0, runSeq = 0, turnRun = 0; // turnRun: the run that owns the live turn (an old run settling must not end the new turn's trace)
    let fullTools = null; // the agent's complete tool map, narrowed per step
    const timers = { watch: null, dead: null };
    let routeAc = null; // aborts the fast path's in-flight route call (a newer message, Stop, a page leaving)
    const FALLBACK = Turn.FALLBACK;
    const UNAVAILABLE = "My assistant is temporarily unavailable, so I cannot do this right now. Please try again in a little while.";
    let failures = 0; // consecutive failed model calls (the engine's backoff reads it; a watchdog that fires after one says the assistant is unavailable)
    const CAPPED = "I am getting a lot of questions at once. Give me a few seconds and ask again.";
    const STUCK = "Sorry, I got stuck partway through that. Ask me again and I will pick it up.";
    const NOT_OPENED = "That page did not open as expected. Ask me again and I will take another route.";
    const BUDGET_LINE = "I have used all the steps I get for one request and did not finish. Tell me if you want me to keep going.";
    let lastStamp = 0;
    const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1)); // strictly increasing: "later than the refusal" is never a tie
    // The visit: what the visitor said and when they last declined something. Lives for the visit (SBLStore.local, not per tab) and rides the task record.
    let visit = Turn.newVisit();
    const loadVisit = async () => { try { const r = await globalThis.SBLStore?.local?.get?.("sbl_visit_v1"); if (r?.sbl_visit_v1) visit = Turn.mergeVisit(visit, Turn.reviveVisit(r.sbl_visit_v1)); } catch { /* none */ } };
    // Merge what is stored before writing: a message arriving before the first load on a new page must not overwrite an earlier refusal.
    const keepVisit = () => { loadVisit().then(() => globalThis.SBLStore?.local?.set?.({ sbl_visit_v1: visit })).catch(() => {}); };
    const abortError = () => new DOMException("Aborted", "AbortError");
    const live = (t) => Boolean(t && t === turn && !t.ended);
    const secrets = []; // typed via fill_secret on this page: only ever held here, never logged

    // In shell mode (step 2/3) the pages the visitor sees are the shell frame's document: the brain
    // loop runs in the top page and its engine reads that document through the walker (which starts
    // at document.body, where the frame lives), and our hands, settle and progress read the frame.
    const shellDoc = () => {
      try {
        if (!globalThis.SBLSHELL?.active?.()) return null;
        const f = document.getElementById("sbl-shell-frame");
        return f?.contentDocument?.body ? f.contentDocument : null;
      } catch { return null; }
    };
    const doc = () => shellDoc() || document;

    // ---- the action log the proof harness reads (tools/proof/scenarios.mjs). Only when the proof flag is set in the extension's own storage,
    // which page scripts cannot reach; and only type, target label, path and time: never text, inputs, goals or customer notes.
    // Every action also goes to the turn trace (always, not only in proof mode; masked, label only, never a typed value).
    let emits = 0, askingSecret = false; // askingSecret: a secret is being asked for, so a visitor message traced meanwhile is hidden
    function emit(type, target, el) {
      if (turn?.ended && !["error", "resume", "answer"].includes(type)) return; // a finished or pre-empted turn does nothing visible
      emits++;
      if (!["point-align", "error", "answer"].includes(type)) trace.action(type, el && editable(el) ? tname(el) : target); // the proof's alignment note is not a tool call; errors and answers have their own events
      if (!deps.proof) return;
      const entry = { type, target: clip(target, 120), path: location.pathname, ts: Date.now() };
      document.dispatchEvent(new CustomEvent("sbl-agent-action", { detail: JSON.stringify(entry) })); // on document: a DOM node both worlds share
    }

    // rid: the run asking. A dead turn's run (pre-empted, stopped) saves nothing, so it can never overwrite the stored task with stale state.
    const save = (rid) => { if (task && !gone && rid === turnRun && turn?.kind !== "stopped") { task.trace = trace.state(); if (turn) { task.turn = Turn.snap(turn); task.noteHeard = turn.heard || ""; } task.visit = visit; return bg({ op: "put", task }); } return null; }; // task.trace/turn: the turn rides the task across the cross-origin hop
    // What "the page changed" means: the frame's URL/content/scroll in shell mode, the top document otherwise.
    // Defensive on document.location/defaultView: the node test fakes lack them.
    const pageSig = () => { const d = doc(); return `${d.location?.href || location.href}|${d.body?.innerText.length}|${d.getElementsByTagName("*").length}|${Math.round(d.defaultView?.scrollY || 0)}`; };
    const mask = (text) => Guard.maskSecrets(text, [...secrets, ...Guard.passwordValues(document)]);
    const maskOut = (text) => (Rec?.maskContacts || ((s) => s))(root.SBLTrace.maskNumbers(mask(text))); // outgoing router/note text: secrets, card-like numbers and contact details
    const trace = root.SBLTrace.create({ v: globalThis.SBLStore?.sblv?.() || null, send: deps.tracePost, mask }); // fire-and-forget; never awaited (NFR-11)
    // Every line the visitor sees goes through here: traced where it is drawn, counted against its turn, dropped when its turn is dead (a newer message replaced it).
    const speak = (text, asked, t = turn, ended = false) => {
      if (t !== turn || (t?.ended && !ended)) return; // `ended`: the exit itself speaking its line
      trace.line(text);
      if (t) { Turn.lineSaid(t, text); clearTimeout(timers.watch); }
      run.said.push(text);
      if (task) Task.said(task, text);
      if (!t?.system) { visit.lastLine = clip(text, 300); keepVisit(); } // what a bare "yes" next would be answering
      return deps.say(text, asked);
    };
    const nowUrl = () => { try { return doc().location?.href || location.href; } catch { return location.href; } };
    // Visitor memory (docs/MEMORY.md): when a visitor turn ends, the current record, the visitor's masked words and the lines actually spoken go to the note call.
    // Fire and forget: nothing awaits the chain, so a turn's end is never delayed. Notes run one after another and each payload is built inside the chain,
    // so it carries the record the previous note stored. A note that is lost is owed: its turn rides on the next note (at most 2 earlier turns; kept in storage across a page load).
    const OWED = "sbl_note_owed_v1";
    let noteChain = Promise.resolve(), owed = [], owedLoaded = false, noteN = 0;
    const keepOwed = () => { try { globalThis.SBLStore?.local?.set?.({ [OWED]: owed }); } catch { /* none */ } };
    async function loadOwed() {
      if (owedLoaded) return; owedLoaded = true;
      try {
        const r = (await globalThis.SBLStore?.local?.get?.(OWED))?.[OWED];
        const mine = new Set(owed.map((e) => JSON.stringify(e)));
        if (Array.isArray(r)) owed = [...r.filter((e) => e && typeof e.message === "string" && Array.isArray(e.said)).map((e) => ({ message: clip(e.message, 800), said: e.said.slice(-4).map((l) => clip(l, 300)) })).filter((e) => !mine.has(JSON.stringify(e))), ...owed].slice(-3);
      } catch { /* none */ }
    }
    function noteTurn(t, fallback) {
      try {
        if (!Rec || typeof deps.recordNote !== "function" || !t || t.system || t.noted || !t.heard || deps.context?.()?.surface === "dashboard") return; // the dashboard's turns are an account's data: never noted into the visitor's record
        const lines = t.said || [];
        if ((t.kind || fallback) === "preempted" && !lines.length) return;
        t.noted = true;
        const seq = stamp(), id = String(++noteN), turnId = trace.turn(), headers = trace.headers(); // the turn that SENT it, not whichever is open when it returns
        const mine = { message: maskOut(t.heard), said: lines.slice(-4).map((l) => maskOut(l)) };
        owed = [...owed.slice(-2), mine]; keepOwed();
        trace.action("note", id, turnId);
        noteChain = noteChain.then(async () => {
          await loadOwed();
          const earlier = owed.slice(0, Math.max(0, owed.indexOf(mine))).slice(-2), base = Rec.validate(deps.getRecord?.());
          const sent = [...earlier, mine];
          let next = null;
          try { next = Rec.accept(await deps.recordNote({ ...mine, ...(earlier.length ? { earlier: earlier.map((e) => ({ message: maskOut(e.message), said: e.said.map(maskOut) })) } : {}), record: base, seq }, { headers }), seq); } catch { /* dropped below */ }
          const cur = Rec.validate(deps.getRecord?.());
          if (next && Rec.merge(cur, next) === next) {
            deps.setRecord(Rec.keepDecisions(cur, Rec.keepLocalFacts(base, cur, next)));
            owed = owed.filter((e) => !sent.includes(e)); keepOwed();
            trace.action("note-saved", id, turnId);
          } else trace.action("note-dropped", id, turnId); // its turn stays in `owed`
        }).catch(() => { try { trace.action("note-dropped", id, turnId); } catch { /* none */ } });
      } catch { /* memory never breaks a turn */ }
    }
    const closeTurn = (p, id) => { p.then((r) => { if (r?.status !== "paused" && id === turnRun) { trace.end(r?.kind || { done: "answered", waiting_user: "asked", waiting_human: "asked", stopped: "stopped", out_of_steps: "failed", failed: "failed", error: "failed" }[r?.status] || "failed", nowUrl()); noteTurn(turn); } }, () => {}); return p; };

    // ---- the turn's exits ----
    const clearTimers = () => { clearTimeout(timers.watch); clearTimeout(timers.dead); timers.watch = timers.dead = null; };
    const unref = (id) => { id?.unref?.(); return id; };
    const STATUS = { answered: "done", handed_off: "done", cannot: "done", asked: "waiting_user", failed: "stopped", preempted: "preempted", stopped: "clear" };
    // THE exit: ends the live turn and the run behind it. `line` is spoken (by finish) only when this turn said nothing (force: always).
    // o.stuck: a failure after the first line is not silent: one apology line (and a question the visitor never saw is not stored).
    function endTurn(kind, line, o = {}) {
      const t = turn;
      if (!t || (t.ended && !o.force)) return false;
      t.ended = true; t.kind = kind || (t.lines ? "answered" : "failed");
      if (!t.system) { try { const u = new URL(nowUrl()); visit.lastUrl = u.origin + u.pathname; keepVisit(); } catch { /* no page */ } } // where this turn left the visitor
      clearTimers(); routeAc?.abort();
      const own = line && (o.force || (!t.lines && !t.system)), stuck = !own && o.stuck && t.lines > 0 && !t.system;
      halt = { line: own ? line : stuck ? STUCK : null, status: o.status || STATUS[t.kind], kind: t.kind, question: stuck ? null : o.question || null, awaiting: stuck ? null : o.awaiting || null };
      Promise.resolve(agent?.stop?.()).catch(() => {});
      return true;
    }
    const refuseEnd = () => { endTurn(null, FALLBACK); return "Stopped."; }; // a consent gate refused an action: the turn ends, the model does not retry unseen
    // A refused LINE: the first time in a turn the model is told once (it can act, or say something different); the second ends the turn.
    function refused(t, shown, why) {
      if (shown) trace.line(shown, true); // the visitor never sees it
      t.refused = (t.refused || 0) + 1;
      if (t.refused < 2) return `⚠️ That was not said: ${why || "it repeats what the visitor already heard"}. Answer the visitor's latest message${task?.goal ? ` ("${clip(task.goal, 120)}")` : ""}: act, or say something different.`;
      endTurn(null, FALLBACK, { stuck: t.actions === 0 }); // it showed something: just end; it did nothing it promised: one apology
      return "Stopped.";
    }
    let confirming = 0; // a confirmation card is waiting on the visitor
    const waitOn = async (p) => { const t = turn, from = Date.now(); try { return await p; } finally { t.waited = (t.waited || 0) + Date.now() - from; } }; // the visitor's time is not the turn's time
    // No watchdog until the first line; no deadline until the first line has declared the turn's shape.
    function armDeadline(t) {
      clearTimeout(timers.dead); timers.dead = null;
      const lim = t.then && Turn.limit(t); if (!lim) return;
      const left = () => (deps.limits?.[t.then] ?? lim.ms) - (Date.now() - t.startedAt - (t.waited || 0)); // time spent waiting on the visitor is not counted
      timers.dead = unref(setTimeout(function fire() {
        if (!live(t)) return;
        if (waiter || askingSecret || confirming || task?.status === "waiting_human") { timers.dead = unref(setTimeout(fire, 2000)); return; } // waiting on the visitor is not the agent's time
        const l = left();
        if (l > 0) { timers.dead = unref(setTimeout(fire, l)); return; }
        endTurn(null, BUDGET_LINE, { stuck: !(t.then === "show" && t.actions > 0) }); // a show turn that showed something is simply over; unfinished multi-step work says so
      }, Math.max(0, left())));
    }
    function armWatch(t, engine, down) { // engine: the engine opens this turn (its first line is slow: p50 4.8 s, max 8.1 s), not the router
      clearTimeout(timers.watch); timers.watch = null;
      const ms = down ? deps.limits?.downWatchdog ?? 9000 /* a healthy engine's first line has measured up to 8.1 s: 4 s cut it off as 'unavailable' */ : (engine ? deps.limits?.engineWatchdog ?? deps.limits?.watchdog ?? Turn.ENGINE_WATCHDOG_MS : deps.limits?.watchdog ?? Turn.WATCHDOG_MS);
      if (!t.lines && !t.system) timers.watch = unref(setTimeout(() => { if (live(t) && !t.lines) endTurn("failed", down || failures ? UNAVAILABLE : FALLBACK); }, ms)); // the model failed (or the router could not reach the server) on this turn: say so rather than the generic line
    }
    function armTimers(t, engine) {
      clearTimers();
      if (!t || t.ended) return;
      armWatch(t, engine);
      armDeadline(t);
    }
    // Only the tools this turn's phase allows are offered to the model (the engine re-reads agent.tools every step).
    function narrow(a) {
      fullTools ||= new Map(a.tools);
      const want = turn && !turn.ended ? Turn.allowed(turn) : ["done"];
      a.tools.clear();
      for (const [k, v] of fullTools) if (!want || want.includes(k)) a.tools.set(k, v);
      // Dashboard work stalled on repeated promises, both before opening and before saving a draft.
      if (deps.context?.()?.surface === "dashboard" && turn?.then === "do" && turn.lines > 0 && turn.actions === turn.lineAt) a.tools.delete("say");
    }

    // ---- looking ----
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    const labelsOf = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.type === "submit" || el.type === "button" ? el.value : ""].map((t) => String(t || "").trim()).filter(Boolean);
    const nameOf = (el) => clip(labelsOf(el)[0] || el.getAttribute("placeholder") || el.getAttribute("name") || `<${el.tagName.toLowerCase()}>`, 60);
    // Trace-only labels: an editable element's innerText/value IS what the visitor typed, so the trace uses a field-safe name (NFR-12).
    const editable = (el) => (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/^(submit|button|reset|image)$/i.test(el.type || "")) || el.isContentEditable === true || /^(|true|plaintext-only)$/i.test(String(el.getAttribute("contenteditable") ?? "x"));
    const tname = (el) => clip(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || `<${el.tagName.toLowerCase()}>`, 60);
    const ref = (index) => agent?.pageController.selectorMap.get(index)?.ref || null;
    // The same action on the same target: identified by what the element is called, not its index (indices change every step).
    const onEl = (name) => ({ index }) => { const el = ref(index); return el ? `${name}|${el.tagName}|${nameOf(el)}|${location.pathname}` : `${name}|missing`; };
    const noElement = (index) => `❌ There is no element [${index}] on the page now. Read the browser state again and use an index listed there.`;

    // Point ≠ narration (the founder's main complaint: results narrated while the page sat at the
    // top, the cursor on an author byline). After a scroll, if what the agent JUST said is not on
    // screen, bring the part of the page that covers it into view. Returns the label brought in, or null.
    async function alignToSaid() {
      const said = task?.said.at(-1) || "";
      const topic = Guard.topicWords(said);
      if (topic.length < 2) return null;
      const d = doc(), w = d.defaultView;
      const saysIt = (n) => { const t = (n.innerText || "").toLowerCase(); return topic.filter((word) => t.includes(word)).length >= 2; };
      const cands = () => [...d.querySelectorAll("h1, h2, h3, h4, strong, b, th, td, li, p")].filter((n) => {
        if (n.closest("#sbl-sales-concierge-root, #sbl-agent-cursor-layer")) return false;
        const r = n.getBoundingClientRect();
        return r.width > 60 && r.height > 10 && (n.innerText || "").trim().length > 3;
      });
      if (cands().some((n) => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= w.innerHeight && saysIt(n); })) return null; // already on screen
      const scored = cands()
        .map((n) => {
          const t = (n.innerText || "").toLowerCase();
          const hits = topic.filter((word) => t.includes(word)).length;
          return hits >= 2 ? { n, hits, len: (n.innerText || "").length } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (b.hits - a.hits) || (a.len - b.len));
      const hit = scored[0]?.n;
      if (!hit) return null;
      hit.scrollIntoView({ block: "center", behavior: "instant" });
      await sleep(700);
      return nameOf(hit);
    }

    // Wait until the page stops changing (or the cap): the engine reads the DOM right after an action and read stale pages before this.
    // In shell mode the page is the frame's document (top-document mutations are the dock's own).
    function settle(quiet = 450, max = 4000) {
      return new Promise((resolve) => {
        let timer;
        const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); };
        const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
        observer.observe(doc(), { subtree: true, childList: true, attributes: true, characterData: true });
        timer = setTimeout(done, quiet);
        const cap = setTimeout(done, max);
      });
    }
    // Resolves early (false) when turn t dies: a newer message must not wait behind a page load, or a glide that never ends.
    function survive(t, p) {
      let iv;
      const dead = new Promise((r) => { iv = unref(setInterval(() => { if (!live(t)) r(false); }, 100)); });
      return Promise.race([p, dead]).finally(() => clearInterval(iv));
    }
    async function loaded(t) {
      let cap;
      try {
        await survive(t, (async () => {
          if (document.readyState !== "complete") await new Promise((resolve) => { addEventListener("load", resolve, { once: true }); cap = setTimeout(resolve, 15_000); });
          await settle(600, 6000);
        })());
      } finally { clearTimeout(cap); }
    }

    // ---- doing ----
    // The cursor goes to an element, outlines it and holds there (point_at and the fast path's routed highlight).
    async function glideTo(target, note) {
      const driver = deps.cursor();
      deps.acting(true);
      try {
        if (driver) {
          await driver.ensureVisible(target);
          driver.spotlight(target);
          await driver.moveTo(driver.pointFor(target));
          driver.narrate(clip(Guard.plain(note), 80));
          // assert what is outlined is really on screen; retry once deeper if not
          const inView = () => { const r = target.getBoundingClientRect(); const h = doc().defaultView.innerHeight; return r.height > 0 && r.top < h * 0.9 && r.bottom > h * 0.1; };
          if (!inView()) { target.scrollIntoView({ block: "center", behavior: "instant" }); await sleep(700); driver.spotlight(target); await driver.moveTo(driver.pointFor(target)); }
        } else { target.scrollIntoView({ block: "center" }); }
        await sleep(deps.limits?.hold ?? 1800); // held until the next action starts, so what you say next lands on it
      } finally { deps.acting(false); }
    }

    async function glideClick(el) {
      Guard.sameTab(el);
      const driver = deps.cursor();
      deps.acting(true);
      try {
        const outcome = driver ? await driver.clickElement(el) : (el.click(), { ok: true });
        return outcome;
      } finally { deps.acting(false); }
    }

    async function typeInto(el, index, text) {
      const driver = deps.cursor();
      deps.acting(true);
      try {
        if (driver) await driver.typeInto(el, text, { maxChars: 40 });
        const now = el.isContentEditable ? el.textContent : el.value;
        if (clean(now) !== clean(text)) await agent.pageController.inputText(index, text); // the engine's typer, when ours did not take
      } finally { deps.acting(false); }
    }

    const passwordLike = (el) => el.type === "password" || Guard.isPasswordField(el);
    const CONFIRM_FIELD = /confirm|repeat|again|re-?enter|verify/i;

    // Every own tool goes through hand(): action log, the step counted and the task saved BEFORE it runs (a navigation kills the page),
    // loop guard, no throwing into the engine.
    function hand(name, description, inputSchema, fn, keyFn = () => name) {
      return tool({ description, inputSchema, async execute(args, ctx) {
        ctx?.signal?.throwIfAborted?.(); // the engine's own abort: nothing starts after a stop
        const mine = turn;
        if (!live(mine)) throw abortError(); // a tool of a dead turn never starts (the visitor spoke, or the turn ended)
        if (!TALKING.has(name)) { deps.cursor()?.clearSpotlight(); deps.cursor()?.narrate(""); } // what you pointed at stays lit while you talk about it
        const key = keyFn(args);
        const verdict = Task.loopVerdict(task, name, key);
        const tried = Task.repeats(task, key) + 1;
        const entry = Task.record(task, name, args, key, mask);
        if (Task.step(task) > Task.BUDGET) { entry.result = "stopped: step budget"; endTurn(null, BUDGET_LINE, { status: "stopped" }); return "Stopped."; }
        const rid = turnRun;
        await save(rid);
        if (!live(mine)) { entry.result = "dropped: the turn ended"; throw abortError(); } // the visitor may have spoken while the task was being saved
        if (verdict === "stop") { entry.result = "stopped: same action five times"; endTurn("failed", `I keep hitting the same wall on "${key.split("|")[2] || name}". Can you show me what to do here, or tell me another way?`, { status: "waiting_user", question: "How should I get past this?", stuck: true }); return "Stopped."; }
        if (verdict === "warn") { entry.result = "refused: repeated"; entry.progress = false; await save(rid); return `⚠️ You have done this exact thing on this same target ${tried} times and it is not working. Do it differently: another element, scroll to look for a better control, navigate straight to the page, ask the visitor, or, if you have shown and said enough, call done.`; }
        if (!TALKING.has(name)) { // an action: counted against the turn's budget before it starts
          const lim = Turn.limit(mine);
          if (lim && mine.actions >= lim.actions) { entry.result = "refused: turn budget"; endTurn(null, BUDGET_LINE); return "Stopped."; }
          mine.actions++;
        }
        run.did.push(`${name} ${clip(entry.args, 50)}`);
        const before = pageSig(), emitted = emits;
        let out;
        try { out = String(await fn.call(this, args, ctx, rid)); }
        catch (error) { if (error?.name === "AbortError") throw error; out = `❌ ${name} failed: ${clip(error?.message || error, 200)}`; }
        if (emits === emitted) trace.action(name, ""); // a tool that returned before its own emit (refused, no such element) is still a tool call
        entry.result = clip(mask(out), 100);
        entry.progress = !/^(❌|⚠️)/.test(out) && pageSig() !== before; // a repeat only counts when it failed or changed nothing
        save(rid);
        return mask(out);
      } });
    }

    // Why a control is consequential, from its own label, the dialog it sits in, or (for an unnamed icon button) where it sits.
    function riskOf(el) {
      const own = Guard.consequential(labelsOf(el));
      if (own) return own;
      const dialog = el.closest('[role="dialog"],[role="alertdialog"]');
      const inDialog = dialog && Guard.inDialog(dialog.innerText.split("\n").slice(0, 4), labelsOf(el));
      if (inDialog) return inDialog;
      return Guard.unlabeled(labelsOf(el), Boolean(el.closest('form:has(textarea,[contenteditable]), [class*="composer" i], [class*="chat" i], [class*="action" i], [class*="toolbar" i]')));
    }

    // A DOM link proves a destination exists, not that the dock can follow it.
    function refuseDestination(url, onPage = false) {
      const map = root.SBLSiteMap;
      const canonical = (value) => { if (!value) return null; try { const u = new URL(value, nowUrl()); return u.origin + u.pathname.replace(/\/$/, ""); } catch { return null; } };
      let target; try { target = new URL(url, nowUrl()); } catch { /* refused below */ }
      const knownOffsite = map?.offsite?.some((l) => canonical(l.href) === canonical(url));
      const booking = canonical(map?.handoff?.href) === canonical(url);
      const safe = target && Guard.isSblUrl(target.href) && !target.username && !target.password && !target.port;
      const app = safe && target.hostname === "app.secondbrainlabs.com";
      const listed = safe && map?.pages?.some((p) => canonical(p.url) === canonical(target.href));
      const linked = safe && (onPage || [...doc().querySelectorAll("a[href]")].some((a) => !a.closest?.("#sbl-sales-concierge-root") && canonical(a.href) === canonical(target.href)));
      if (safe && !knownOffsite && !booking && (app || listed || linked)) return false;
      const line = booking ? "I cannot open that booking page here; you can open the Talk to an SDR expert link yourself."
        : !safe || knownOffsite ? "I cannot open that link because it leaves the site where I can help you."
        : "I cannot open that page because it is not in the site index or linked on this page.";
      endTurn("cannot", line, { force: true });
      return true;
    }

    const TALKING = new Set(["say", "ask_user", "remember", "read_campaigns", "read_campaign_stats", "read_conversations", "read_leads_status", "read_account", "research", "request_human_call"]);
    const idx = z.int().min(0);
    const tools = {
      click_element_by_index: null,
      // The built-in select is replaced so an option like "Delete" goes through the same guard as a click.
      select_dropdown_option: hand("select_dropdown_option", "Select an option of the dropdown with this index, by the option's text.", z.object({ index: idx, text: z.string() }), async function ({ index, text }) {
        const el = ref(index); if (!el) return noElement(index);
        if (Guard.consequential([text, ...labelsOf(el)])) return "❌ That option is consequential (money, sending, deleting, launching). It is the visitor's choice: ask them to pick it themselves.";
        emit("select", nameOf(el), el);
        return (await this.pageController.selectOption(index, text)).message;
      }, onEl("select_dropdown_option")),
      ask_user: hand("ask_user", "Ask the visitor a question and wait for their reply. Use it for anything about them you do not know (name, email, phone, company, website, a choice). Never guess it. Asking for an email or phone number needs `because`: a short quote of what the visitor said that asks for it (signing up, being contacted).", z.object({ question: z.string(), because: z.string().optional() }), async ({ question, because }, ctx, rid) => {
        const mine = turn, tk = task;
        const text = Guard.plain(question);
        if (Turn.asksContact(text) && !Turn.evidence(because, visit, Guard.words)) return refused(mine, text, "asking for an email or phone number needs `because`, a quote of the visitor asking for it. If they want a person or a call, do not collect a number: point_at the \"Talk to an SDR expert\" link on the site and let them open it"); // consent: their own words, since their last refusal
        // Ask-once (the founder session: the same question eight times, ~2.4 s apart): a question the
        // visitor has not answered is never re-asked near-verbatim, whether it was asked with ask_user
        // or said aloud. The turn ends instead of the model retrying unseen.
        const priorQuestion = task.question && Guard.overlap(text, task.question) >= 0.6
          || task.said.find((s) => /\?\s*$/.test(s) && Guard.overlap(text, s) >= 0.6);
        if (priorQuestion) return refused(mine, text);
        task.status = "waiting_user"; task.awaiting = "answer"; task.question = clip(text, 300); await save(rid);
        ctx.signal?.throwIfAborted?.(); // a message that came during the save: nothing is opened for a dead turn
        speak(text, true, mine);
        emit("ask_user", "");
        deps.needs(true);
        try { return `The visitor answered: ${await waitOn(ask(ctx.signal))}. Use what they gave you right now (input_text into the fields it answers, in the order the form asks); do not ask for it again.`; }
        catch (error) {
          if (!error?.timeout) throw error;
          endTurn("asked", "I will wait here. Reply whenever you are ready and I will carry on.", { status: "waiting_user", question: text, awaiting: "answer" });
          return "No answer.";
        } finally { deps.needs(false); tk.status = "active"; tk.awaiting = null; save(rid); }
      }, ({ question }) => `ask_user|${clip(question, 60)}`),

      say: hand("say", "Say something to the visitor, in the dock (and aloud if they are on voice). Short spoken sentences, plain text. Your reflection is private; only say reaches them. `then` is required and declares what follows this line: end (this line is the whole answer, the turn is over), show (you will now show it: up to 3 of navigate, scroll, point_at, click on a link, then one closing say), do (multi-step work the visitor asked for). Set declined: true when the visitor's message declined or stopped something. `because` (a short quote of what the visitor said) is required for then: do.", z.object({ text: z.string(), then: z.enum(["end", "show", "do"]), declined: z.boolean().optional(), because: z.string().optional() }), async ({ text, then, declined, because }) => {
        const mine = turn;
        const line = Guard.plain(text);
        if (!line) return "❌ Nothing to say.";
        if (declined && mine.lines === 0) { Turn.declined(visit, stamp()); keepVisit(); } // binding for the rest of the visit
        // A guard that refuses a line ends the turn (the model used to retry unseen): the visitor gets the fallback only if nothing was said.
        // Bars calibrated on the founder's own line pairs: within one turn the loop pairs score 0.29-0.91 and legitimate
        // consecutive lines 0.00-0.09; across turns only a true re-statement (>=0.6) is refused, so a new request about the same topic is never blocked.
        const refuse = (why) => refused(mine, line, why);
        if (Turn.asksContactLine(line) && !Turn.evidence(because, visit, Guard.words)) return refuse("asking for an email or phone number needs `because`, a quote of the visitor asking for it. If they want a person or a call, do not collect a number: point_at the \"Talk to an SDR expert\" link on the site and let them open it"); // a line asking for their email or phone is gated like the question
        const recent = mine.said.slice(-4); // THIS turn only
        const saidQuestion = [...recent, task.question ? task.question : ""].find((s) => /\?\s*$/.test(s));
        if (/\?\s*$/.test(line) && saidQuestion && Guard.overlap(line, saidQuestion) >= 0.5) return refuse(); // re-asking an unanswered question
        if (recent.find((s) => Guard.overlap(line, s) >= (mine.actions > mine.lineAt ? 0.6 : 0.25))) return refuse(); // the same line, re-worded (after an action only a near-verbatim repeat)
        const declare = mine.then ? null : Turn.THENS.includes(then) ? then : "show"; // the schema requires `then`; a missing one is the neutral shape
        if (declare === "do" && !Turn.evidence(because, visit, Guard.words)) return refuse("multi-step work needs `because`: quote the visitor's request for this work, not a paraphrase or your own plan"); // multi-step work needs the visitor's own words
        speak(line, false, mine);
        emit("say", "");
        if (declare) { mine.then = declare; armDeadline(mine); }
        if (Turn.closes(mine)) { endTurn("answered"); return `Said to the visitor: "${line}"`; }
        // Steering, not the loop guard: the model promises to show something and then only talks (seen live).
        const lastNav = [...task.log].reverse().find((e) => e.name === "navigate" || e.name === "click");
        const lastPoint = [...task.log].reverse().find((e) => e.name === "point_at");
        let out = `Said to the visitor: "${line}"`;
        if (lastNav && (!lastPoint || lastNav.at > lastPoint.at)) out += " You have moved the page since you last pointed: point_at what you just mentioned (the browser state lists the elements with their indices).";
        return out;
      }, ({ text }) => `say|${clip(text, 60)}`),

      click: hand("click", "Click the element with this index with the visitor's own cursor, then wait for the page to settle. Controls that launch, pay, delete, send, import or invite are answered by the visitor on a confirmation card instead. A link to signup or login needs `because`: a short quote of what the visitor said that asks for it.", z.object({ index: idx, because: z.string().optional() }), async ({ index, because }, _c, rid) => {
        const el = ref(index); if (!el) return noElement(index);
        const rec = task.log.at(-1); // this call's entry: a pre-emption swaps `task` under a click in flight
        const anchor = el.closest?.("a[href]");
        if (turn.then === "show" && !anchor) return "❌ In this turn you may only click links. Anything else needs the visitor to ask for it."; // a show turn shows; it does not operate the page
        if (anchor && refuseDestination(anchor.href, true)) return "Stopped.";
        if (anchor && Turn.gatedUrl(anchor.href, location.href) && !Turn.evidence(because, visit, Guard.words)) return refuseEnd(); // signup/login: the visitor's own words first
        const why = riskOf(el);
        if (why) return confirm(el, { why });
        const label = nameOf(el), before = location.href;
        emit("click", label, el);
        const outcome = await glideClick(el);
        // The click's result is written onto the entry hand() just recorded BEFORE the settle: a click
        // that moves the page top-level (the app hop) kills this document mid-tool, and a result-less
        // entry made the next page's model redo it (the /signup <-> /pricing bounce, seen live in run-2).
        rec.result = outcome?.ok === false ? `❌ ${outcome.message}` : `✅ Clicked "${label}".`; rec.progress = outcome?.ok !== false; save(rid);
        if (outcome?.ok === false) return `❌ ${outcome.message}`;
        await sleep(350); await settle();
        rec.result = `✅ Clicked "${label}".${location.href !== before ? ` The page is now ${location.pathname}.` : ""}`;
        save(rid);
        return `✅ Clicked "${label}".${location.href !== before ? ` The page is now ${location.pathname}.` : ""}`;
      }, onEl("click")),

      input_text: hand("input_text", "Type text into the input, textarea or editor with this index. Only text the visitor gave you or that is public. Never a password (fill_secret) and never anything you made up about the visitor. An email or phone field needs `because`: a short quote of what the visitor said that asks for it.", z.object({ index: idx, text: z.string(), because: z.string().optional() }), async ({ index, text, because }) => {
        const el = ref(index); if (!el) return noElement(index);
        if (passwordLike(el)) return "❌ That is a password field. Use fill_secret; never type a password yourself.";
        if (/^(email|tel)$/i.test(el.type || "") && !Turn.evidence(because, visit, Guard.words)) return refused(turn); // their contact detail: their own words first, in any turn shape
        emit("fill", nameOf(el), el);
        await typeInto(el, index, text);
        await settle(300, 1500);
        return `✅ Typed into "${nameOf(el)}".`;
      }, onEl("input_text")),

      fill_secret: hand("fill_secret", "Have the visitor type a secret (a password) into the field with this index. The dock asks them in a masked box and types it for them; you never see it. Use it for every password field.", z.object({ index: idx }), async ({ index }, ctx, rid) => {
        const el = ref(index); if (!el) return noElement(index);
        const label = nameOf(el);
        emit("fill", label, el);
        let value = secrets.length && CONFIRM_FIELD.test(`${label} ${el.name} ${el.id}`) ? secrets.at(-1) : null; // a confirm-password box takes the same one
        if (!value) {
          task.status = "waiting_user"; await save(rid);
          ctx.signal?.throwIfAborted?.(); // pre-empted during the save: no box is opened
          deps.needs(true);
          askingSecret = true; try { value = await waitOn(deps.askSecret(label, ctx.signal)); } finally { askingSecret = false; deps.needs(false); task.status = "active"; save(rid); }
        }
        if (!value) return "The visitor did not give it. Leave the field and ask them how they want to proceed.";
        secrets.push(value);
        await typeInto(el, index, value);
        return `✅ The visitor's secret was typed into "${label}" (value hidden). The field is filled; move on and do not fill it again.`;
      }, onEl("fill_secret")),

      scroll: hand("scroll", "Scroll the page (or the container with this index) up or down with the visitor's cursor. Use it to bring the part you want to show into view.", z.object({ down: z.boolean().default(true), num_pages: z.number().min(0).max(10).optional(), pixels: z.number().int().min(0).optional(), index: z.number().int().min(0).optional() }), async function ({ down, num_pages, pixels, index }) {
        if (index != null) return (await this.pageController.scroll({ down, numPages: num_pages ?? 0.8, pixels, index })).message;
        const amount = (pixels ?? Math.round(innerHeight * (num_pages ?? 0.8))) * (down ? 1 : -1);
        emit("scroll", down ? "down" : "up");
        deps.acting(true);
        try {
          // In shell mode the page is the frame's document; the engine's own scroller cannot reach it
          // from the top document (the engine-frame check: both variants report "already at the
          // bottom"), so the scroll drives the frame's scroller directly, through the cursor.
          const fdoc = shellDoc();
          const container = fdoc ? (fdoc.scrollingElement || fdoc.documentElement) : document.scrollingElement || document.documentElement;
          await (deps.cursor()?.scrollBy(amount, fdoc ? { container } : {}) ?? container.scrollBy({ top: amount, behavior: "instant" }));
        } finally { deps.acting(false); }
        await sleep(250);
        // Point ≠ narration (the founder's complaint): if what was just said is not on screen after
        // the scroll, bring that part in too and say so.
        const aligned = await alignToSaid();
        const d = doc(), w = d.defaultView;
        const room = d.scrollingElement.scrollHeight - w.scrollY - w.innerHeight;
        return `✅ Scrolled ${down ? "down" : "up"}. ${Math.max(0, Math.round(room))}px below the view, ${Math.round(w.scrollY)}px above.${aligned ? ` Also brought "${aligned}" into view — it is what you just told them about; point_at it now.` : ""}`;
      }, ({ down, pixels }) => `scroll|${down}|${pixels ?? ""}|${Math.round((doc().defaultView.scrollY || 0) / 100)}`),

      navigate: hand("navigate", "Take the visitor to another SBL page in this tab (sbl.so or app.secondbrainlabs.com only). Give a full URL or a path. The page loads and you continue there. Going to signup or login needs `because`: a short quote of what the visitor said that asks for it.", z.object({ url: z.string(), because: z.string().optional() }), async ({ url, because }, _c, rid) => {
        let target;
        try { target = new URL(url, location.href); } catch { return "❌ That is not a URL."; }
        if (refuseDestination(target.href)) return "Stopped.";
        if (Turn.gatedUrl(target.href, location.href) && !Turn.evidence(because, visit, Guard.words)) return refuseEnd(); // signup/login: the visitor's own words first
        // The visitor id rides to the app domain so the store there keeps this conversation (script-tag mode; URL API only, never string concat).
        const sblv = globalThis.SBLStore?.sblv?.();
        if (target.hostname === "app.secondbrainlabs.com" && sblv && !target.searchParams.has("sblv")) target.searchParams.set("sblv", sblv);
        if (target.href === location.href) return "You are already on that page.";
        // Inside the shell (step 2), an sbl.so destination moves the frame and the voice session stays up;
        // a full-page navigation here would kill both. The app hop below keeps its step-1 top-level behavior.
        if (target.hostname === "sbl.so" && globalThis.SBLSHELL?.active?.()) {
          emit("navigate", target.pathname);
          const entry = task.log.at(-1); entry.result = "navigating"; await save(rid);
          const ok = await globalThis.SBLSHELL.go(target.href);
          if (!ok) return "❌ The page did not change.";
          await sleep(350); await settle();
          return `✅ Opened ${target.pathname}. The visitor is looking at it.`;
        }
        emit("navigate", target.pathname);
        // An on-page link to the same place keeps the app's state and lets the visitor see the cursor go there.
        const link = [...document.querySelectorAll("a[href]")].find((a) => !a.closest("#sbl-sales-concierge-root") && visible(a) && new URL(a.href, location.href).href === target.href);
        const linkRisk = link && riskOf(link);
        if (linkRisk) return confirm(link, { why: linkRisk });
        if (link && (await glideClick(link)).ok !== false) { await sleep(350); await settle(); return `✅ Opened ${target.pathname}.`; }
        const entry = task.log.at(-1); entry.result = "navigating"; await save(rid);
        location.assign(target.href);
        await sleep(10_000); // the page unloads and the next one resumes this task; only a blocked navigation gets here
        return "❌ The page did not change.";
      }, ({ url }) => `navigate|${clip(url, 80)}`),

      point_at: hand("point_at", "Show the visitor something: glide the cursor to the element with this index and highlight it, without clicking. Use it for a plan, a proof point, a button you are about to explain. The note is a very short label beside the cursor.", z.object({ index: idx, note: z.string() }), async ({ index, note }) => {
        const el = ref(index); if (!el) return noElement(index);
        // Point what the line is ABOUT (the founder's main complaint: results narrated while the cursor
        // sat on an author byline and the page never left the top). If the asked element carries none of
        // what was just said, find the section that does (headings, metrics, list items) and point THERE.
        const said = task.said.at(-1) || "";
        const topic = Guard.topicWords(said);
        const saysIt = (n) => { const t = (n.innerText || "").toLowerCase(); return topic.filter((w) => t.includes(w)).length >= 2; };
        let target = el, corrected = null;
        if (topic.length >= 2 && !saysIt(el)) {
          const d = doc();
          // rank by how much of the narrated topic the candidate carries (the founder's session pointed
          // at bylines; a naive first-match correction once picked the breadcrumb over the section)
          const scored = [...d.querySelectorAll("h1, h2, h3, h4, strong, b, th, td, li, p")]
            .map((n) => {
              if (n.closest("#sbl-sales-concierge-root, #sbl-agent-cursor-layer")) return null;
              const r = n.getBoundingClientRect();
              const t = (n.innerText || "").trim();
              if (!(r.width > 60) || !(r.height > 10) || t.length < 4 || t.length > 1200) return null;
              const hits = topic.filter((w) => t.toLowerCase().includes(w)).length;
              return hits >= 2 ? { n, hits, len: t.length, heading: /^h[1-4]$/i.test(n.tagName) } : null;
            })
            .filter(Boolean)
            .sort((a, b) => (b.hits - a.hits) || (a.len - b.len) || ((b.heading ? 1 : 0) - (a.heading ? 1 : 0)));
          if (scored[0]) { target = scored[0].n; corrected = nameOf(target); }
        }
        emit("point", nameOf(target), target);
        // The action log scores point-target vs narrated-topic (proof-only; a label string, no visitor text).
        const aligned = `${clip(nameOf(target), 40)} <- ${clip(topic.slice(0, 4).join(" "), 60)}${corrected ? " (corrected from " + clip(nameOf(el), 30) + ")" : ""}`;
        emit("point-align", aligned);
        if (deps.proof) document.dispatchEvent(new CustomEvent("sbl-point", { detail: JSON.stringify({ label: nameOf(target), text: clip((target.innerText || "").replace(/\s+/g, " "), 200), topic: topic.slice(0, 6), corrected: corrected ? nameOf(el) : null, path: doc().location?.pathname || location.pathname, ts: Date.now() }) }));
        await glideTo(target, note);
        // Steering, not the loop guard (pointing is never a "failure"): the model otherwise points at
        // the same things forever (seen live, step 3 run-1: 20+ points cycling four targets).
        const same = task.log.filter((e) => e.name === "point_at" && e.key === `point_at|${nameOf(el)}`).length;
        const total = task.log.filter((e) => e.name === "point_at").length;
        if (same >= 2) return `⚠️ You have already pointed at "${nameOf(el)}" ${same} times. Pointing again shows nothing new. Say your line about it, take the next real action (click, scroll, navigate), or call done if the request is answered.`;
        if (total >= 4) return `✅ Pointing at "${nameOf(target)}". That is ${total} things pointed at in this request — two or three is the norm. Finish: say what remains in one line and call done.`;
        return `✅ Pointing at "${nameOf(target)}". The visitor is looking at it.${corrected ? ` (You asked for "${nameOf(el)}", but your line was about ${topic.slice(0, 3).join(", ")} — pointed at the part of the page that covers it.)` : ""}`;
      }, onEl("point_at")),

      request_confirmation: hand("request_confirmation", "Ask the visitor to approve a consequential control (with a Yes button on a card) and wait for their answer. index is the control on the page; effect says in one sentence what will happen; cost says what it costs, if anything. It clicks only after their Yes.", z.object({ index: idx, action: z.string(), effect: z.string(), cost: z.string().optional() }), async ({ index, action, effect, cost }) => {
        const el = ref(index); if (!el) return noElement(index);
        return confirm(el, { why: riskOf(el), action, effect, cost });
      }),

      human_step: hand("human_step", "Only a human can do this (captcha, email verification link or code, two-factor). Say what is needed, spotlight the control (index, optional) and wait until it is done. Then read the page again and carry on.", z.object({ what: z.string(), index: z.number().int().min(0).optional() }), async ({ what, index }, ctx, rid) => {
        const mine = turn, from = Date.now();
        const el = index != null ? ref(index) : null;
        if (el && passwordLike(el)) return "❌ A password is the visitor's secret: use fill_secret (the dock asks them in a masked box), never human_step.";
        const text = Guard.plain(what);
        speak(text);
        emit("human-step", el ? nameOf(el) : "", el);
        const driver = deps.cursor();
        if (el && driver) { await driver.ensureVisible(el); driver.spotlight(el); }
        task.status = "waiting_human"; await save(rid); deps.needs(true);
        const before = { url: location.href, value: el?.value ?? "", text: document.body.innerText.length };
        let returned = false;
        const onVisible = () => { if (!document.hidden) returned = true; };
        document.addEventListener("visibilitychange", onVisible);
        try {
          for (let t = 0; t < 300; t++) { // up to 5 minutes
            ctx.signal.throwIfAborted();
            await sleep(1000);
            const value = el?.value ?? "";
            if (location.href !== before.url) return "✅ The page changed: the visitor did it. Read the page and continue.";
            if (el && !el.isConnected) return "✅ The control is gone: the visitor did it. Read the page and continue.";
            if (el && value && value !== before.value) { await sleep(1500); return "✅ The visitor filled it in. Read the page and continue (press the submit control if there is one)."; }
            if (returned || Math.abs(document.body.innerText.length - before.text) > 200) return "✅ The visitor is back and the page changed. Read the page and continue.";
          }
          return "The visitor has not done it yet (5 minutes). Ask them if they need help.";
        } finally { document.removeEventListener("visibilitychange", onVisible); driver?.clearSpotlight(); deps.needs(false); task.status = "active"; mine.waited = (mine.waited || 0) + Date.now() - from; save(rid); }
      }, ({ what }) => `human_step|${clip(what, 60)}`),

      remember: hand("remember", "Write one durable fact about this customer to their customer file (who they are, what they sell, what they want, an objection, a decision). It is given back to you every run. Never a secret.", z.object({ note: z.string() }), async ({ note }) => {
        const line = clip(Guard.plain(note), 300);
        await deps.remember(line);
        deps.note(`Noted: ${line}`); // the visitor sees everything written about them, as it is written
        emit("remember", "");
        return "✅ Saved to the customer file.";
      }),
    };
    // The read-only account reads, research and the human call: same behaviour as before, now tools of the engine.
    const plainTools = [
      ["read_campaigns", "Read-only: list this workspace's newest campaigns (id, name, state, created). Use it to see what the customer really has.", z.object({})],
      ["read_campaign_stats", "Read-only: the analytics numbers for one campaign (reachouts, connections, accepted invitations, replies, opportunities, pipeline value) over the last N days (default 30).", z.object({ campaignId: z.string().optional(), days: z.number().optional() })],
      ["read_conversations", "Read-only: the newest chats (contact name, last message snippet, needs-intervention flag), at most 20.", z.object({ limit: z.number().optional() })],
      ["read_leads_status", "Read-only: the ICP Leads state (is a prompt written, which lists exist, how many leads each extracted, whether anything is still generating).", z.object({})],
      ["read_account", "Read-only: the workspace's plan, latest invoice status and campaign count, as the dashboard loads them. Unknown values are null; never guess them.", z.object({})],
      ["research", "Bounded public-web research (about a minute, cited). Use it when the visitor asks about a competitor, the market or an event. Shows them a card with sources.", z.object({ question: z.string(), why: z.string() })],
      ["request_human_call", "Show the visitor a card with a summary and a button to book a call with a human SBL expert. Sends nothing. Offer it first; call it when they agree or ask for a person.", z.object({ summary: z.string() })],
    ];
    for (const [name, description, schema] of plainTools) {
      tools[name] = hand(name, description, schema, async (args) => {
        emit("read", name);
        const out = JSON.stringify(await deps.tools[name](args)).slice(0, 8000);
        if (name === "request_human_call") endTurn("handed_off"); // the card is the answer: the turn is over
        return out;
      });
    }

    // ---- the visitor's answers ----
    const ask = (signal, ms = 180_000) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError()); // already dead: never leave a waiter behind
      const timer = setTimeout(() => { waiter = null; reject(Object.assign(new Error("no answer"), { timeout: true })); }, ms);
      waiter = (answer) => { clearTimeout(timer); resolve(answer); };
      signal?.addEventListener("abort", () => { clearTimeout(timer); waiter = null; reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
    const confirm = async (el, { why, action, effect, cost }) => {
      const label = nameOf(el);
      emit("confirmation", label, el);
      confirming++;
      try { return await waitOn(deps.confirm({ element: el, label, labelOf: nameOf, why, action: action || label, effect: effect || `Presses "${label}" (${why}).`, cost })); } finally { confirming--; }
    };

    // ---- the model, through the background worker and the local server ----
    // The engine retries after a fixed 100 ms; a failing model needs breathing room, so the wait grows here (1 s, 2 s, 4 s ... up to 8 s).
    async function customFetch(url, init) {
      if (init.signal?.aborted) throw abortError();
      if (failures) await new Promise((resolve, reject) => { // abortable: a pre-empted turn does not sleep out its backoff
        const timer = setTimeout(resolve, Math.min(8000, 1000 * 2 ** (failures - 1)));
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
      });
      const call = deps.chat(JSON.parse(init.body), trace.headers()).then(({ status, body }) => {
        failures = status === 200 ? 0 : failures + 1;
        return new Response(JSON.stringify(body), { status: status >= 200 && status < 600 ? status : 502, headers: { "content-type": "application/json" } });
      });
      const aborted = new Promise((resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      return Promise.race([call, aborted]);
    }

    function makeAgent(system, id) {
      const a = new PageAgentCore({
        baseURL: "sbl://agent", model: "concierge", apiKey: "none", customFetch, maxRetries: 2, maxSteps: Math.max(0, Task.BUDGET - task.steps - 1), language: "en-US", stepDelay: 0.3,
        customSystemPrompt: system,
        instructions: { system: root.SBLConstitution.context(deps.context()), getPageInstructions: () => (turn ? Turn.guide(turn) : "") }, // the turn's shape and what is left of it, every step
        onBeforeStep: (a) => narrow(a),
        customTools: tools,
        transformPageContent: (content) => mask(content),
        pageController: new PageController({ enableMask: false }),
        onAfterStep: () => save(id),
      });
      a.onAskUser = async () => ""; // the engine drops ask_user without one; ours does not use it
      fullTools = null;
      // Built-in tools we did not override (select, wait, horizontal scroll, done) still land in the log and the task record.
      a.addEventListener("activity", ({ detail }) => {
        if (detail.type !== "executing" || tools[detail.tool] || detail.tool === "done") return;
        if (detail.tool === "wait") return;
        Task.record(task, detail.tool, detail.input, undefined, mask);
        Task.step(task);
        emit(detail.tool, "");
        run.did.push(detail.tool);
        save(id);
      });
      return a;
    }

    // ---- one run: from a goal (or a resumed task) until the engine calls done ----
    const failedBecause = (text) => /assistant_unavailable|Authentication failed|Rate limit|Server error|Network request failed|HTTP 50\d/.test(String(text)); // the model itself could not be reached
    const outcome = (extra) => ({ said: run.said, did: run.did, ...extra });
    // A run that ends by itself (a crash, a failed model, the engine's own limit) still ends its turn with exactly one line when nothing was said.
    function closeOut(t, kind, line) { // not `settle`: that is the DOM-settle helper above, and a second declaration shadowed it
      if (t !== turn) return;
      if (line && !t.lines && !t.system) speak(line, false, t);
      else if (t.lines && !t.system && !t.ended) speak(STUCK, false, t); // it had begun: a failure now is not silent
      t.ended = true; t.kind = t.kind || kind;
    }
    async function go(resumed, extra, t, id) {
      run = { said: [], did: [] };
      const cur = () => (turnRun === id ? turn : t); // the turn this run is in NOW: an answered question moves a run on to a new turn
      const dead = () => (halt ? finish(null, t, id) : outcome({ status: "preempted", kind: "preempted" })); // a newer message (or Stop) got in before this run began
      if (!live(t)) return dead();
      halt = null;
      deps.busy(true);
      let mine = null;
      try {
        if (resumed) await loaded(t);
        if (gone) return outcome({ status: "paused" });
        if (!live(t)) return dead();
        mine = agent = makeAgent(root.SBLConstitution.system({ knowledge: root.SBLKnowledge.full(), screens: root.SBLScreens.reference(), siteMap: root.SBLSiteMap }), id);
        const first = resumed ? Task.preface(task) : `Goal: ${task.goal}`;
        const result = await agent.execute([first, extra].filter(Boolean).join("\n\n"));
        return await finish(result, cur(), id);
      } catch (error) {
        if (gone) return outcome({ status: "paused" });
        if (id === turnRun) { emit("error", "run crashed"); trace.error(error?.stack ? `${error.name}: ${error.message}` : error?.message || error); } // the cause stays in the trace
        if (task && cur() === turn) { task.status = "stopped"; task.awaiting = null; await save(id); }
        closeOut(cur(), "failed", FALLBACK); // never silent: one honest line when nothing was said
        return outcome({ status: "error", kind: "failed", error: clip(error?.message || error, 200) });
      } finally {
        if (mine && agent === mine) agent = null;
        if (id === turnRun) { clearTimers(); deps.endCards(); deps.busy(false); deps.cursor()?.clearSpotlight(); deps.cursor()?.narrate(""); } // a run that was replaced (the 8 s cap) must not tear down the new turn's UI
      }
    }

    async function finish(result, t, id) {
      if (gone) return outcome({ status: "paused" }); // the page is leaving: the next one carries on
      if (halt) {
        const { line, status, question, awaiting, kind } = halt;
        if (line) speak(line, false, t, true); // already gated by endTurn: said only when this turn had said nothing (or the visitor's own Stop)
        if (status === "clear" || status === "done") { if (t === turn) { task = null; await bg({ op: "clear" }); } }
        else if (task && t === turn) { task.status = status === "preempted" ? "stopped" : status; task.awaiting = awaiting || null; task.question = question || null; await save(id); }
        return outcome({ status: status === "clear" ? "stopped" : status, kind });
      }
      let line = Guard.plain(result.data);
      if (line === "no text provided") line = ""; // the engine's own stand-in for an empty done
      if (!result.success) {
        if (id === turnRun) { emit("error", "run failed"); trace.error(result.data); }
        const budget = /Step count exceeded/.test(result.data);
        const explained = result.history?.at(-1)?.type === "step" && line; // the model ended with done(success:false) and said why: its own words, spoken
        let kind = "failed";
        if (failedBecause(result.data)) speak(UNAVAILABLE, false, t);
        else if (explained) { speak(line, false, t); kind = "cannot"; }
        else closeOut(t, kind, budget ? BUDGET_LINE : FALLBACK); // a crash or the engine's own limit: one line if nothing was said
        if (t === turn) { t.ended = true; t.kind = kind; }
        if (task && t === turn) { task.status = "stopped"; task.awaiting = null; await save(id); }
        return outcome({ status: budget ? "out_of_steps" : "failed", kind });
      }
      // done: its text is the closing line when this turn has said nothing; a turn never ends without a visible line.
      if (line && Turn.asksContactLine(line) && !Turn.evidence(undefined, visit, Guard.words)) { trace.line(line, true); line = ""; } // done may not ask for their email or phone either
      if (!t.lines && !t.system) speak(line || FALLBACK, false, t);
      if (t === turn) { t.ended = true; t.kind = "answered"; }
      if (t === turn) { task = null; await bg({ op: "clear" }); }
      return outcome({ status: "done", kind: "answered", final: line });
    }

    // ---- the fast path (docs/FAST-PATH.md) ----
    // Every visitor message on the website goes first to the router: a small streamed call that writes the first line and picks the route. end / ask / a routed show
    // are finished HERE, with no engine; a do, a show without a usable target, and any failure are handed to the engine (a line already said stays said).
    const said = (a) => clean(a).toLowerCase();
    const conversationLines = () => { // the last 6 lines before this message, from the visit record
      const out = []; let last = "";
      for (const m of visit.said.slice(0, -1).slice(-3)) { if (m.after && m.after !== last) out.push(`Agent: ${m.after}`); out.push(`Visitor: ${m.text}`); last = m.after || last; }
      if (visit.lastLine && visit.lastLine !== last) out.push(`Agent: ${visit.lastLine}`);
      return out.slice(-6);
    };
    // The routed navigation: the same machinery as the navigate tool (shell go(), or location.assign with the turn riding the task across the load). "went" / "left" (page unloading) / "refused" / "failed" / "dead".
    async function routedGo(t, id, href, r) {
      const target = new URL(href, "https://sbl.so");
      if (!Guard.isSblUrl(target.href)) return "failed";
      if (Turn.gatedUrl(target.href, nowUrl()) && !Turn.evidence(r.because, visit, Guard.words)) { endTurn(null, FALLBACK); return "refused"; } // signup/login: the visitor's own words first
      const sblv = globalThis.SBLStore?.sblv?.();
      if (target.hostname === "app.secondbrainlabs.com" && sblv && !target.searchParams.has("sblv")) target.searchParams.set("sblv", sblv);
      const entry = Task.record(task, "navigate", target.pathname, `navigate|${clip(target.href, 80)}`, mask); entry.result = "navigating";
      t.then = "show"; t.actions = Math.max(t.actions, 1); armDeadline(t);
      task.routed = { section: r.section, anchor: r.anchor, target: Router.canonPath(target.href), ...(r.rest ? { rest: r.rest } : {}), ...(r.booking ? { booking: true } : {}) }; // the next page's boot() finishes this turn with it (no engine)
      emit("navigate", target.pathname);
      await save(id);
      if (!live(t)) return "dead"; // the visitor spoke while the task was being saved: the navigation never starts
      if (target.hostname === "sbl.so" && globalThis.SBLSHELL?.active?.()) {
        task.routed = null;
        if (!(await globalThis.SBLSHELL.go(target.href))) return "failed";
        await sleep(350); await settle();
        return live(t) ? "went" : "dead";
      }
      try { location.assign(target.href); } catch { task.routed = null; return "failed"; }
      for (let i = 0; i < 100 && live(t) && !gone; i++) await sleep(100); // the page unloads and the next one resumes this turn; only a blocked navigation (or a Stop) gets past 10 s
      if (gone) return "left";
      if (task) task.routed = null;
      return live(t) ? "failed" : "dead";
    }
    // Highlight the section on the page: the element carrying the index's anchor id, else the first heading with that text (Router.findSection). False: not found.
    const drawn = (e) => { try { const b = e.getBoundingClientRect?.(); return !b || (b.width > 0 && b.height > 0); } catch { return true; } }; // has a box on the page (a hidden tab or collapsed block has none)
    async function pointSection(t, r) {
      if (!live(t)) return false;
      // A person, a call, a demo: the router's booking flag says the line names the booking link, so that link is what gets lit (it leaves the site: the visitor opens it, never the agent).
      // The link with the shortest text that is drawn (a wrapping card has more text), preferring one in the page over one in a nav or menu.
      if (!r?.section && r?.booking) {
        const menu = (e) => Boolean(e.closest?.('nav, header, aside, [class*="menu" i], [class*="off-canvas" i], [class*="offcanvas" i], [id*="menu" i]'));
        const link = [...doc().querySelectorAll("a[href]")].filter((e) => /talk to (an )?sdr expert|book a (call|demo)/i.test(e.innerText || "") && drawn(e) && !e.closest?.("#sbl-sales-concierge-root"))
          .sort((x, y) => menu(x) - menu(y) || (x.innerText || "").length - (y.innerText || "").length)[0];
        if (!link) return false;
        emit("point", nameOf(link), link);
        await glideTo(link, "Book a call");
        return true;
      }
      if (!r?.section) return false;
      const els = [...doc().querySelectorAll("[id], h1, h2, h3, h4")].filter((e) => !e.closest?.("#sbl-sales-concierge-root, #sbl-agent-cursor-layer"));
      const i = Router.findSection(els.map((e) => ({ id: e.id || "", tag: String(e.tagName).toLowerCase(), text: e.innerText ?? e.textContent ?? "" })), { heading: r.section, anchor: r.anchor });
      if (i < 0) return false;
      let el = els[i];
      if (!/^H[1-4]$/.test(el.tagName)) el = el.querySelector?.("h1, h2, h3, h4") || el; // an anchor on a wrapper: its heading is what to point at
      if (!drawn(el)) return false; // a heading that is not drawn (a hidden tab, a collapsed block) is not shown to anyone: no highlight is better than a wrong one
      emit("point", nameOf(el), el);
      await glideTo(el, r.section);
      return true;
    }
    const deadOutcome = (t, id) => (halt ? finish(null, t, id) : outcome({ status: "preempted", kind: "preempted" }));
    const cleanup = (id) => { if (id === turnRun) { clearTimers(); deps.endCards(); deps.busy(false); } };
    // -> { done: outcome } when the router finished the turn, or { line } when the engine takes over ("" when nothing was said yet).
    async function fastPath(t, id, message) {
      if (!live(t)) return { done: await deadOutcome(t, id) };
      halt = null;
      deps.busy(true);
      deps.cursor()?.clearSpotlight(); deps.cursor()?.narrate("");
      let handed = false, spoken = "";
      const handoff = (then, down) => { handed = true; if (spoken) { t.opened = spoken; t.then = then || "show"; armDeadline(t); } else { deps.dropPreview?.(); armWatch(t, true, down); } return { line: spoken }; }; // down: the router's server did not answer, so the engine's model is probably dead too: it gets 9 s to speak, not 25 s, then the UNAVAILABLE line // a router line already said: the engine's first step is no longer narrowed to say/ask/done
      try {
        const ac = routeAc = new AbortController();
        const cap = setTimeout(() => ac.abort(), deps.limits?.route ?? 7000);
        const url = nowUrl();
        const payload = { message: maskOut(message), url, title: clip(doc().title, 150), conversation: conversationLines().map(maskOut), customerFile: maskOut(clip(deps.context?.()?.customerFile, 1500)), refusedRecently: Date.now() - visit.refusedAt < 180_000, moved: (() => { try { const u = new URL(url); return Boolean(visit.lastUrl) && visit.lastUrl !== u.origin + u.pathname; } catch { return false; } })(), lastAgentLine: maskOut(visit.lastLine) };
        let previewed = false;
        const onLine = (text) => { // the first complete sentence is the turn's first line (a line asking for contact details waits for the route's evidence)
          if (!live(t) || spoken) return;
          const sofar = Guard.plain(text);
          if (sofar.split(/\s+/).length >= 3 && !Turn.asksContact(sofar)) { if (!previewed) { previewed = true; trace.action("first-words", ""); } deps.preview?.(sofar); } // visible within about a second; the line itself is spoken when complete
          const first = Router.firstSentence(sofar);
          if (first && !Turn.asksContactLine(first)) { spoken = first; speak(first, false, t); }
        };
        let raw = null;
        try { raw = await deps.route(payload, { onLine, signal: ac.signal, headers: trace.headers() }); } catch { raw = null; } finally { clearTimeout(cap); if (routeAc === ac) routeAc = null; }
        if (!live(t)) { if (!spoken) deps.dropPreview?.(); return { done: await deadOutcome(t, id) }; } // a dead turn's half-written line goes; otherwise the next real line finishes the same element
        if (raw?.failed === "unavailable" || raw?.failed === "capped") { // the engine would fail the same way after its retries: one fixed line now
          if (id === turnRun) trace.error(raw.failed);
          endTurn("failed", raw.failed === "capped" ? CAPPED : UNAVAILABLE);
          return { done: await finish(null, t, id) };
        }
        const r = raw && !raw.failed ? Router.validate(raw, root.SBLSiteMap, url) : null;
        if (!r) return handoff(undefined, raw?.failed === "down"); // failed, timed out or unusable: the engine runs the turn as before
        if (r.declined || Turn.bareRefusal(message)) r.then = "end"; // a refusal: the line is spoken and nothing moves
        if (r.then === "do" && !Turn.evidence(r.because, visit, Guard.words)) return handoff(); // multi-step work needs the visitor's own words: the engine runs the turn and its consent gate governs; the router's promise is not spoken
        let rest = "";
        const line = Guard.plain(r.line);
        if (!spoken) {
          if (!line) return handoff();
          if (Turn.asksContactLine(line) && !Turn.evidence(r.because, visit, Guard.words)) { trace.line(line, true); return handoff(); } // the visitor never sees it
          spoken = line; speak(line, false, t);
        } else if (line.length > spoken.length && said(line).startsWith(said(spoken))) {
          rest = line.slice(spoken.length).trim();
          if (Turn.asksContactLine(rest) && !Turn.evidence(r.because, visit, Guard.words)) rest = "";
        }
        t.opened = spoken;
        if (r.declined) { Turn.declined(visit, stamp()); keepVisit(); }
        const secondLine = () => { if (rest && live(t)) speak(rest, false, t); }; // a long line: its tail is the turn's second line
        const over = (kind) => { endTurn(kind); return finish(null, t, id).then((done) => ({ done })); };
        if (r.then === "end" || r.then === "ask") { secondLine(); t.then = "end"; return await over(r.then === "ask" ? "asked" : "answered"); } // an ask opens no engine question: the answer is simply the next turn
        if (r.then === "do") {
          return handoff("do");
        }
        const here = Router.canonPath(url), dest = (r.booking && (!r.target || r.target === here)) ? here : r.target || (r.section ? here : null); // a booking line points at the link on this page: no engine
        if (!dest) return handoff("show"); // show without a usable target
        t.then = "show"; armDeadline(t); // the deadline covers a glide that never ends
        if (dest !== here) {
          r.rest = rest; // spoken on the page it finishes on
          const went = await routedGo(t, id, dest, r);
          if (went === "dead") return { done: await deadOutcome(t, id) };
          if (went === "left") return { done: outcome({ status: "paused" }) };
          if (went === "refused") return { done: await finish(null, t, id) };
          if (went === "failed") return handoff("show");
        }
        await survive(t, pointSection(t, r)); // not found: the visitor is on the right page
        if (!live(t)) return { done: await deadOutcome(t, id) };
        secondLine();
        return await over("answered");
      } catch (error) {
        if (gone) return { done: outcome({ status: "paused" }) };
        if (id === turnRun) trace.error(error?.stack ? `${error.name}: ${error.message}` : error?.message || error);
        return live(t) ? handoff() : { done: await deadOutcome(t, id) };
      } finally { if (!handed) cleanup(id); }
    }
    // The next page of a routed show: highlight the section and end the turn as answered. No engine.
    async function resumeRouted(t, id) {
      if (!live(t)) return deadOutcome(t, id);
      halt = null;
      deps.busy(true);
      try {
        await loaded(t);
        if (gone) return outcome({ status: "paused" });
        if (!live(t)) return deadOutcome(t, id);
        const r = task?.routed; task.routed = null; await save(id);
        if (r?.target && Router.canonPath(nowUrl()) !== r.target) { endTurn("answered", NOT_OPENED, { force: true }); return await finish(null, t, id); } // a redirect or an error page: no highlight
        for (let k = 0; k < 4 && live(t) && !(await survive(t, pointSection(t, r))); k++) await sleep(600); // the section may render late
        if (gone) return outcome({ status: "paused" });
        if (!live(t)) return deadOutcome(t, id);
        if (r?.rest) speak(r.rest, false, t);
        endTurn("answered");
        return await finish(null, t, id);
      } catch (error) {
        if (gone) return outcome({ status: "paused" });
        if (id === turnRun) trace.error(error?.message || error);
        endTurn(t.lines ? "answered" : "failed", FALLBACK);
        return await finish(null, t, id);
      } finally { cleanup(id); }
    }

    // ---- the ways in ----
    // One turn per visitor message (typed, or spoken: the voice forwards the transcript). The answer to a question the agent asked
    // resolves it and continues the task as a NEW turn; any other message cancels the turn in progress, waits for that run to settle,
    // and starts a new one. A task halted at a wall, the step budget or the visitor taking over is over: their next words start a NEW task.
    const launch = (t, start) => {
      const id = ++runSeq; turnRun = id;
      const p = closeTurn((async () => { await null; return start(id); })(), id); // never settles before `running` is set below
      running = p;
      const clear = () => { if (running === p) running = null; }; // the only place `running` is cleared
      p.then(clear, clear);
      return p;
    };
    // raw: what the visitor actually said, when `text` is the model-facing wrapper around it (a reply to an offer): only the visitor's words count as theirs.
    function hear(text, mode, raw) {
      const system = /^\[A (system note|proactive)/.test(text);
      if (!system && !askingSecret) { // the evidence consent is checked against
        Turn.visitorSaid(visit, raw ?? text, stamp());
        if (Turn.bareRefusal(raw ?? text)) Turn.declined(visit, stamp()); // a bare "no" / "stop" / "not yet" is a refusal whatever the model marks
        keepVisit();
      }
      if (waiter) trace.end("asked", nowUrl()); else if (running) trace.end(turn?.ended ? turn.kind || "failed" : "preempted", nowUrl());
      noteTurn(turn, waiter ? "asked" : "preempted");
      trace.open(askingSecret ? "[hidden]" : text, mode || (system ? "system" : "typed"), nowUrl());
      const prev = turn, wasEnded = Boolean(prev?.ended);
      if (prev) { prev.ended = true; prev.kind ||= waiter ? "asked" : "preempted"; }
      routeAc?.abort(); // a route call of the old turn is dropped
      const mine = turn = Turn.create(++gen, Date.now(), { system }); failures = 0; // a new turn does not inherit an old turn's failed calls
      const message = clip(raw ?? text, 800);
      if (!system && !askingSecret) mine.heard = message;
      const routing = !system && !askingSecret && typeof deps.route === "function" && Boolean(Router && root.SBLSiteMap?.pages) && (deps.context?.()?.surface || "website") === "website" && (raw == null || raw === text); // a reply to an offer (raw !== text) carries the offer in its wrapper: the engine sees it, the router would not
      armTimers(mine, !routing || Boolean(waiter) || (!running && task?.status === "waiting_user" && Task.awaitingAnswer(task) && !Task.expired(task))); // only a turn the router opens gets the short watchdog; when the engine opens it (an answer, a resume, a wrapped reply) it gets the long one
      const start = async (id, extra) => { // the router first; the engine only when the router hands the turn on
        const via = routing ? await fastPath(mine, id, message) : null;
        return via?.done || go(false, extra, mine, id);
      };
      if (waiter) { const resolve = waiter; waiter = null; Task.heard(task, text); task.question = null; mine.answered = true; emit("answer", ""); resolve(text); return running; } // whichever way the answer arrives
      if (running) {
        // Pre-emption: no new action starts for the old turn. Its run is stopped and awaited, and only then does the new turn begin.
        // But the new message is stored AT ONCE: a navigation in flight unloads the page before the old run settles, and the next page must resume THIS message.
        const before = running;
        if (!wasEnded) { halt = { line: null, status: "preempted", kind: "preempted" }; Promise.resolve(agent?.stop?.()).catch(() => {}); }
        deps.endCards(); // a pending card or private box of the old turn goes with it
        const was = task && prev?.kind !== "stopped" ? { goal: task.goal, did: run.did.slice(-6), said: run.said.slice(-2) } : null; // after a Stop there is nothing to carry on
        task = Task.newTask(text); Task.heard(task, text);
        const p = launch(mine, async (id) => {
          let nap; await Promise.race([before.catch(() => {}), new Promise((r) => { nap = setTimeout(r, deps.limits?.preempt ?? 8000); })]); clearTimeout(nap); // ponytail: a tool that ignores the abort (a hung read) must not freeze the concierge; its late result is dropped by the generation check
          const prior = was ? mask(`The visitor interrupted you. Before this message you were working on "${was.goal}" (done so far: ${was.did.join("; ") || "nothing"}${was.said.length ? `; you had said: ${was.said.map((s) => `"${s}"`).join(" | ")}` : ""}). If this message corrects or adds to that work, carry on with the change; otherwise answer only this message and stop.`) : "";
          return start(id, prior);
        });
        save(turnRun);
        return p;
      }
      if (task && task.status === "waiting_user" && Task.awaitingAnswer(task) && !Task.expired(task)) {
        const extra = `You had asked or were waiting on the visitor (${task.question || "their input"}). They replied: "${clip(text, 400)}"`;
        task.status = "active"; task.awaiting = null; task.question = null; Task.heard(task, text);
        return launch(mine, (id) => go(true, extra, mine, id));
      }
      task = Task.newTask(text);
      Task.heard(task, text);
      return launch(mine, (id) => start(id));
    }

    async function boot() {
      await loadVisit();
      const stored = (await bg({ op: "get" }))?.task;
      if (running || !stored) return; // a visitor message may have started a run while storage answered
      if (Task.expired(stored)) { bg({ op: "clear" }); return; }
      task = stored;
      trace.seed(task.trace); // same turn id on the resumed page, even across the origin hop
      visit = Turn.mergeVisit(visit, Turn.reviveVisit(task.visit));
      if (!Task.shouldResume(task)) return; // waiting on the visitor, out of steps or resumes: it waits
      // Neither the page load nor the visitor's own step is the turn's time. Turn.revive keeps startedAt, so
      // without this a show turn spends its 20 s unloading, fetching, parsing and booting the next page --
      // none of it work the agent can do -- and the deadline fires on arrival, which the visitor sees as
      // "Sorry, I got stuck partway through that." right after the page moved. task.updatedAt is the last
      // write before location.assign, so the gap to now is exactly that dead time. Credited like the
      // visitor's time already is (waitOn); the waiting_human case is the same expression, so it is covered.
      const awaySince = Number(task.updatedAt) || 0;
      Task.resumed(task); task.status = "active"; await save(turnRun);
      if (running) return;
      emit("resume", location.pathname);
      const mine = turn = Turn.revive(task.turn) || Turn.create(++gen, Date.now()); // the SAME turn, with what it has left
      if (awaySince) mine.waited = (mine.waited || 0) + Math.max(0, Date.now() - awaySince);
      gen = Math.max(gen, mine.id);
      if (typeof task.noteHeard === "string" && task.noteHeard) mine.heard = clip(task.noteHeard, 800); // the words and lines of this turn survive the load, so it is noted where it ends
      armTimers(mine, !task.routed);
      if (task.routed) { clearTimeout(timers.watch); timers.watch = null; } // a routed turn spoke on the page it left; a slow load is not silence
      launch(mine, task.routed ? (id) => resumeRouted(mine, id) : (id) => go(true, undefined, mine, id)); // a routed show finishes without an engine
    }

    // The visitor ends the task for good: no resume, the card and the secret box go with it.
    function stop() {
      Turn.declined(visit, stamp()); keepVisit(); // Stop is a refusal: nothing it was doing is licensed any more
      bg({ op: "clear" }); // at once: a page that unloads before the run settles must not resume the stopped task
      if (running) endTurn("stopped", "Okay, I have stopped.", { status: "clear", force: true });
      else {
        if (task) speak("Okay, I have stopped.", false, turn, true);
        if (turn && !turn.ended) { turn.ended = true; turn.kind = "stopped"; trace.end("stopped", nowUrl()); }
        clearTimers(); task = null; bg({ op: "clear" }); deps.endCards();
      }
    }

    // A back/forward-cache page keeps its state but must not act: it stops on the way out and boots again when it is shown.
    addEventListener("pagehide", () => { gone = true; clearTimers(); routeAc?.abort(); agent?.stop(); });
    addEventListener("pageshow", (e) => { if (e.persisted) { gone = false; boot(); } });
    // The visitor's own click or key on the page (not the dock) pauses the agent and asks; Escape stops it.
    const inDock = (e) => e.composedPath().some((n) => n.id === "sbl-sales-concierge-root");
    for (const type of ["pointerdown", "keydown"]) {
      addEventListener(type, (e) => {
        if (!running || !e.isTrusted || inDock(e)) return;
        if (e.type === "keydown" && e.key === "Escape") return stop();
        if (task?.status !== "active" || waiter) return; // answering, or a human step: the visitor is meant to act
        Turn.declined(visit, stamp()); keepVisit(); // taking over is a refusal too
        endTurn("asked", "I paused because you took over the page. Want me to keep going?", { status: "waiting_user", question: "Keep going?", awaiting: "answer", force: true });
      }, true);
    }

    // Untrusted (agent) clicks and submits keep the visitor in this tab.
    document.addEventListener("click", (e) => { if (!e.isTrusted) Guard.sameTab(e.target); }, true);
    document.addEventListener("submit", (e) => { if (!e.isTrusted) Guard.sameTab(e.target); }, true);

    return { hear, boot, stop, headers: trace.headers, nav: trace.nav, isRunning: () => Boolean(running), isWaiting: () => Boolean(waiter) };
  }
  root.SBLHarness = { create };
})(globalThis);
