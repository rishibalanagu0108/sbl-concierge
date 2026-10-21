// The running task, as data: what survives a page load. Pure: the background worker stores it, the harness feeds it.
(function attachTask(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SBLTask = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTask() {
  const TTL_MS = 10 * 60_000; // a task the visitor has not spoken to for this long is over, however busy the agent is
  const BUDGET = 40; // actions per task, across every page it crosses (counted when an action starts, so a page load cannot hide it)
  const MAX_RESUMES = 12; // page loads one task may resume across
  const LOG_KEEP = 60;
  const SAID_KEEP = 12;
  const SAME_WARN = 3; // the same action on the same target this many times: it is not working
  const SAME_STOP = 5; // ...and this many: stop and ask the visitor
  const NO_LOOP = new Set(["wait"]);
  // Pointing and talking are never page progress: their "page looked the same" is what they are FOR.
  // They must never climb the repeat counter (the "same wall" defect: point_at/say counted as failures).
  const NO_PROGRESS = new Set(["point_at", "say", "ask_user", "remember", "human_step", "request_confirmation", "request_human_call", "research", "read_campaigns", "read_campaign_stats", "read_conversations", "read_leads_status", "read_account"]);
  const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  const newTask = (goal, now = Date.now()) => ({ goal: clip(goal, 800), status: "active", steps: 0, resumes: 0, log: [], said: [], visitorSaid: [], question: null, awaiting: null, startedAt: now, visitorAt: now, updatedAt: now });
  // The visitor spoke: the clock restarts, and the repeat streak breaks. Nothing the agent does restarts it.
  // The barrier log entry is what resets it: repeats() counts consecutive same-key failures, and the
  // visitor's entry has a different key, so whatever the agent was stuck on starts from zero.
  // The words are kept (bounded) so a page move cannot lose them: the continuation preface carries
  /** The visitor has replied, so every question put to them has been answered - even if only
   *  in part. Asking for the REST of a partial answer is not a re-ask, and the ask-once guard
   *  must stop treating it as one. Repeats with no reply in between are still blocked, which is
   *  the case that guard was built for (the founder session: the same question eight times,
   *  ~2.4 s apart, with the visitor saying nothing). */
  function answered(task) {
    if (!task) return task;
    task.question = null;
    if (Array.isArray(task.said)) task.said = task.said.filter((s) => !/\?\s*$/.test(String(s).trim()));
    return task;
  }

  // what the visitor said since the last step (pushObservation dies with the page; this survives it).
  const heard = (task, text = "", now = Date.now()) => {
    if (!task) return;
    task.visitorAt = now;
    task.updatedAt = now;
    task.log.push({ name: "visitor_spoke", args: "", key: `visitor|${now}`, at: now, progress: null });
    if (task.log.length > LOG_KEEP) task.log.splice(0, task.log.length - LOG_KEEP);
    const line = clip(text, 240);
    if (line) {
      task.visitorSaid.push({ at: now, text: line });
      if (task.visitorSaid.length > 4) task.visitorSaid.splice(0, task.visitorSaid.length - 4);
    }
  };
  const step = (task) => ++task.steps;
  const resumed = (task) => ++task.resumes;

  // task.awaiting === "answer" while the agent's own ask_user waits on the visitor. Any other
  // waiting_user is a STOPPED conversation (a wall, the step budget, the visitor taking over):
  // the visitor's next words start a NEW task — they never resume the old goal with the old
  // repeat history (the second "same wall" defect).
  const awaitingAnswer = (task) => Boolean(task && task.status === "waiting_user" && task.awaiting === "answer");

  // Only an active task (or one waiting on a human step, which a page load usually means was done), still fresh and inside the step budget, resumes by itself. A task waiting on the visitor's answer waits for it.
  const shouldResume = (task, now = Date.now()) => Boolean(task && (task.status === "active" || task.status === "waiting_human") && now - task.visitorAt < TTL_MS && task.steps < BUDGET && task.resumes < MAX_RESUMES);
  const expired = (task, now = Date.now()) => !task || now - task.visitorAt >= TTL_MS;

  // Arguments are kept for the model's benefit after a page load, never a secret: mask() is the caller's masking of known secrets.
  function record(task, name, args, key, mask = (s) => s, now = Date.now()) {
    const entry = { name, args: clip(mask(typeof args === "string" ? args : JSON.stringify(args ?? {})), 160), key: key ?? name, at: now };
    task.log.push(entry);
    if (task.log.length > LOG_KEEP) task.log.splice(0, task.log.length - LOG_KEEP);
    task.updatedAt = now;
    return entry;
  }

  function said(task, text) {
    const line = clip(text, 300);
    if (line && task.said.at(-1) !== line) task.said.push(line);
    if (task.said.length > SAID_KEEP) task.said.splice(0, task.said.length - SAID_KEEP);
  }

  // How many times in a row this same action on this same target has already been tried WITHOUT effect (it failed, or the page
  // looked the same afterwards: progress === false). A "Continue" that moves a wizard on is progress, however often it is pressed.
  function repeats(task, key) {
    let n = 0;
    for (let i = task.log.length - 1; i >= 0 && task.log[i].key === key && task.log[i].progress === false; i--) n++;
    return n;
  }
  function loopVerdict(task, name, key) {
    if (NO_LOOP.has(name) || NO_PROGRESS.has(name)) return "ok";
    const n = repeats(task, key) + 1;
    return n >= SAME_STOP ? "stop" : n >= SAME_WARN ? "warn" : "ok";
  }

  function preface(task) {
    const done = task.log.slice(-25).map((e, i) => `${i + 1}. ${e.name} ${e.args}${e.result ? ` -> ${e.result}` : ""}`).join("\n") || "(nothing yet)";
    const said = task.visitorSaid?.length ? task.visitorSaid.map((s) => `"${s.text}"`).join(" | ") : "";
    return [
      "CONTINUATION: the page changed while you were working, so your memory of this task was lost. You are in the middle of it, not starting it.",
      `Goal: ${task.goal}`,
      `Done so far (oldest first):\n${done}`,
      said ? `What the visitor said since you started (already known — put it into the form or the answer where it belongs, never ask for it again): ${said}` : "",
      task.said.length ? `Already said to the visitor (do not repeat): ${task.said.map((s) => `"${s}"`).join(" | ")}` : "",
      task.question ? `You had asked the visitor: "${task.question}"` : "",
      `Steps used: ${task.steps} of ${BUDGET}. Continue from the current page. Do not redo finished work.`,
    ].filter(Boolean).join("\n");
  }

  return { newTask, heard, answered, step, resumed, awaitingAnswer, shouldResume, expired, record, said, repeats, loopVerdict, preface, TTL_MS, BUDGET, MAX_RESUMES, SAME_WARN, SAME_STOP, NO_PROGRESS };
});
