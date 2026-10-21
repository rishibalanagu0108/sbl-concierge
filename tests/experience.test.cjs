// Persona files, schema, hard limits, dev/holdout separation, and the driver's pure pieces (no browser).
const test = require("node:test");
const assert = require("node:assert");
const P = () => import("../tools/experience/personas.mjs");
const D = () => import("../tools/experience/driver.mjs");

test("every persona file validates (known keys, regexes compile, hard limits)", async () => {
  const { SETS, loadPersonas, validatePersona } = await P();
  let n = 0;
  for (const set of SETS) for (const p of loadPersonas(set)) {
    n++;
    assert.deepStrictEqual(validatePersona(p), [], `${set}/${p.file}`);
    // The hand-written personas are long visits (6-10 turns). The generated journey
    // personas are short, single-situation scenarios, so the length rule does not apply.
    if (set === "replay" || set.startsWith("journey-")) assert.ok(p.steps.length >= 1, `${p.id}: no steps`);
    else assert.ok(p.steps.length >= 6 && p.steps.length <= 10, `${p.id}: ${p.steps.length} steps`);
  }
  assert.strictEqual(loadPersonas("dev").length, 6);
  assert.strictEqual(loadPersonas("holdout").length, 4);
  assert.strictEqual(loadPersonas("replay").length, 1);
  assert.ok(n >= 11);
});

test("generated journey personas: ids are J-NNN, unique, and dev/holdout do not overlap", async () => {
  const { loadPersonas } = await P();
  const dev = loadPersonas("journey-dev"), hold = loadPersonas("journey-holdout");
  assert.ok(dev.length > 0 && hold.length > 0);
  const ids = [...dev, ...hold].map((p) => p.id);
  for (const id of ids) assert.match(id, /^J-\d{3}$/);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate journey id");
  const devIds = new Set(dev.map((p) => p.id));
  for (const p of hold) assert.ok(!devIds.has(p.id), `${p.id} is in both sets`);
});

test("probe exempts only its own step, and only a say step", async () => {
  const { validatePersona } = await P();
  const mk = (step) => ({ id: "x", description: "d", start: "https://sbl.so/", steps: [{ do: "say", text: "hi", tags: [], expect: {}, ...step }] });
  // a declared probe allows the banned wording ...
  assert.deepStrictEqual(validatePersona(mk({ text: "my password is hunter2", probe: "proves refusal" })), []);
  // ... but an empty or non-string reason is not a probe
  assert.ok(validatePersona(mk({ text: "my password is hunter2", probe: "  " })).some((m) => /non-empty reason/.test(m)));
  assert.ok(validatePersona(mk({ text: "my password is hunter2", probe: true })).some((m) => /non-empty reason/.test(m)));
  // ... and it never applies to a non-say step, nor excuses a signup goto
  assert.ok(validatePersona(mk({ do: "goto", url: "https://sbl.so/signup", probe: "x" })).some((m) => /probe only on say/.test(m)));
  assert.ok(validatePersona(mk({ do: "goto", url: "https://sbl.so/signup", probe: "x" })).some((m) => /signup/.test(m)));
});

test("validator rejects unknown keys, bad regexes, hard-limit wording, foreign emails", async () => {
  const { validatePersona } = await P();
  const mk = (step) => ({ id: "x", description: "d", start: "https://sbl.so/", steps: [{ do: "say", text: "hi", tags: [], expect: {}, ...step }] });
  assert.ok(validatePersona(mk({ expect: { bogus: 1 } })).some((m) => /unknown key bogus/.test(m)));
  assert.ok(validatePersona(mk({ expect: { landsOn: "(" } })).some((m) => /does not compile/.test(m)));
  assert.ok(validatePersona(mk({ text: "my password is hunter2" })).some((m) => /hard limit/.test(m)));
  assert.ok(validatePersona(mk({ text: "email me at a@b.com" })).some((m) => /email other than/.test(m)));
  assert.deepStrictEqual(validatePersona(mk({ text: "use proof.test@uberip.com" })), []);
  assert.ok(validatePersona(mk({ do: "goto", url: "https://sbl.so/signup" })).some((m) => /signup/.test(m)));
  assert.ok(validatePersona(mk({ expect: { decisionGroup: "g", decisionPattern: "a|b" } })).some((m) => /one capture group/.test(m)));
});

test("dev and holdout share no identical say text", async () => {
  const { loadPersonas } = await P();
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const say = (set) => new Set(loadPersonas(set).flatMap((p) => p.steps.filter((s) => s.do === "say").map((s) => norm(s.text))));
  const dev = say("dev");
  for (const t of say("holdout")) assert.ok(!dev.has(t), `shared: ${t}`);
});

test("replay persona is the founder's visitor lines in order, every one must be answered in at most 2 lines", async () => {
  const { loadPersonas } = await P();
  const [r] = loadPersonas("replay");
  assert.strictEqual(r.steps[0].text, "hey");
  assert.strictEqual(r.steps.at(-1).text.startsWith("okay can u show me proicing"), true);
  for (const s of r.steps) { assert.strictEqual(s.expect.mustReply, true); assert.strictEqual(s.expect.maxLines, 2); }
  const guarded = r.steps.filter((s) => s.expect.noNav && s.expect.noSignup);
  assert.ok(guarded.length >= 1 && /Don't take me to the campaign/.test(guarded[0].text));
});

test("isQuiet: needs 5 s with no line, no call in flight, dock not busy", async () => {
  const { isQuiet } = await D();
  const base = { now: 10_000, lastLineAt: 4_000, lastBusyAt: 0, inflight: 0, dockState: "conversation" };
  assert.strictEqual(isQuiet(base), true);
  assert.strictEqual(isQuiet({ ...base, lastLineAt: 6_000 }), false);        // only 4 s since the line
  assert.strictEqual(isQuiet({ ...base, inflight: 1 }), false);
  assert.strictEqual(isQuiet({ ...base, dockState: "thinking" }), false);
  assert.strictEqual(isQuiet({ ...base, dockState: "acting" }), false);
  assert.strictEqual(isQuiet({ ...base, lastBusyAt: 7_000 }), false);        // dock was busy 3 s ago
  assert.strictEqual(isQuiet({ ...base, dockState: "needs-user" }), true);   // waiting on the visitor is not busy
});

test("expireInflight drops requests at the 60 s cap only", async () => {
  const { expireInflight } = await D();
  const m = new Map([["old", { start: 0 }], ["new", { start: 50_000 }]]);
  const dropped = expireInflight(m, 60_000);
  assert.deepStrictEqual(dropped.map(([k]) => k), ["old"]);
  assert.deepStrictEqual([...m.keys()], ["new"]);
});

test("rect overlap and union geometry", async () => {
  const { rectsOverlap, unionRect } = await D();
  const r = (x, y, width, height) => ({ x, y, width, height });
  assert.strictEqual(rectsOverlap(r(0, 0, 10, 10), r(5, 5, 10, 10)), true);
  assert.strictEqual(rectsOverlap(r(0, 0, 10, 10), r(10, 0, 10, 10)), false);   // touching edges only
  assert.strictEqual(rectsOverlap(r(0, 0, 10, 10), null), false);
  assert.strictEqual(rectsOverlap(r(0, 0, 0, 10), r(0, 0, 10, 10)), false);     // empty rect
  assert.deepStrictEqual(unionRect([r(0, 0, 10, 10), null, r(20, 5, 10, 10)]), r(0, 0, 30, 15));
  assert.strictEqual(unionRect([null]), null);
});

test("historyCount: the visit's first step has no history but restored lines", async () => {
  const { historyCount } = await D();
  const welcome = { who: "agent", text: "Hey, what are you looking to improve?", restored: false };
  const replayed = { who: "agent", text: "earlier line", restored: true };

  // The bug this encodes: the first-visit welcome fires during page load, so it is already
  // on screen when the first step takes its baseline. Counting it as history sliced it away
  // from every step and made the agent look silent on every wait-only journey.
  assert.strictEqual(historyCount([welcome], { first: true }), 0, "welcome is not history");
  assert.strictEqual(historyCount([welcome], { first: false }), 1, "later steps: already shown is history");

  // A returning visitor's replayed transcript IS history, even on the first step.
  assert.strictEqual(historyCount([replayed, welcome], { first: true }), 1);

  // A page load rebuilds the transcript, so nothing counts as history.
  assert.strictEqual(historyCount([replayed, welcome], { first: true, fresh: true }), 0);
  assert.strictEqual(historyCount([replayed, welcome], { first: false, fresh: true }), 0);

  assert.strictEqual(historyCount([], { first: true }), 0);
  assert.strictEqual(historyCount(undefined, { first: true }), 0);
});

test("agentLines keeps an unrestored line the first step saw, and drops replayed history", async () => {
  const { agentLines, historyCount } = await D();
  const lines = [
    { who: "agent", text: "replayed", restored: true, preview: false },
    { who: "agent", text: "welcome", restored: false, preview: false },
  ];
  const seen = historyCount(lines, { first: true });
  const { real, any } = agentLines(lines, seen);
  assert.strictEqual(any, true);
  assert.deepStrictEqual(real.map((l) => l.text), ["welcome"]);
});
