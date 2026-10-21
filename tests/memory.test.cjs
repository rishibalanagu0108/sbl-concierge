const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemory } = require("../core/memory.js");
const Task = require("../core/task.js");

function clock(start = 1000) {
  let value = start;
  return { now: () => (value += 1000), set: (v) => { value = v; } };
}

test("a conversation survives a reload with its transcript and facts intact", () => {
  const time = clock();
  const first = createMemory({ now: time.now });
  first.append("assistant", "What does your business sell?");
  first.append("user", "We sell a CRM for logistics firms.");
  first.remember({ business: "a CRM for logistics firms" });
  first.setStage("audience");
  const stored = JSON.parse(JSON.stringify(first.serialize()));

  // A new page load builds a new instance from storage.
  const second = createMemory({ now: time.now });
  second.hydrate(stored);
  assert.equal(second.transcript().length, 2);
  assert.equal(second.facts().business, "a CRM for logistics firms");
  assert.equal(second.stage(), "audience");
  assert.equal(second.contextForModel().conversationId, stored.conversationId);
});

test("nothing is deleted as the conversation grows long", () => {
  const memory = createMemory({ now: clock().now });
  for (let index = 0; index < 500; index++) memory.append("user", `message number ${index}`);
  assert.equal(memory.transcript().length, 500);
  assert.equal(memory.contextForModel().totalTurns, 500);
});

test("what is sent to the model is bounded, and marked as a continuation", () => {
  const memory = createMemory({ now: clock().now });
  for (let index = 0; index < 200; index++) memory.append("user", `a fairly wordy message number ${index} about the campaign`);
  const context = memory.contextForModel();
  assert.ok(context.recentConversation.length <= 40, "turn count is capped");
  const characters = context.recentConversation.reduce((sum, turn) => sum + turn.text.length, 0);
  assert.ok(characters <= 4000, `sent ${characters} characters`);
  assert.equal(context.resumed, true, "the model is told there is earlier history");
  assert.equal(context.totalTurns, 200);
  // The most recent turn must be included, or the model answers the wrong question.
  assert.match(context.recentConversation[context.recentConversation.length - 1].text, /number 199/);
});

test("facts are never trimmed, however long the conversation runs", () => {
  const memory = createMemory({ now: clock().now });
  memory.remember({ business: "a CRM", audience: "logistics founders", goal: "book demos" });
  for (let index = 0; index < 1000; index++) memory.append("user", `filler ${index}`);
  const context = memory.contextForModel();
  assert.deepEqual(context.knownFacts, { business: "a CRM", audience: "logistics founders", goal: "book demos" });
});

test("re-rendering after navigation does not duplicate the last line", () => {
  const time = clock();
  const memory = createMemory({ now: time.now });
  memory.append("assistant", "Which lead source would you like?");
  memory.append("assistant", "Which lead source would you like?");
  assert.equal(memory.transcript().length, 1, "an immediate repeat is treated as a re-render");
});

test("the same line is allowed again later in the conversation", () => {
  let value = 0;
  const memory = createMemory({ now: () => (value += 60000) });
  memory.append("assistant", "Shall I continue?");
  memory.append("user", "yes");
  memory.append("assistant", "Shall I continue?");
  assert.equal(memory.transcript().length, 3);
});

test("facts accumulate rather than overwrite, and empty values are ignored", () => {
  const memory = createMemory({ now: clock().now });
  memory.remember({ business: "a CRM" });
  memory.remember({ audience: "founders", business: "" });
  memory.remember({ goal: null });
  assert.deepEqual(memory.facts(), { business: "a CRM", audience: "founders" });
});

test("the resume line reminds the person what is already known", () => {
  const memory = createMemory({ now: clock().now });
  assert.equal(memory.resumeLine(), null, "nothing to resume on a first visit");
  memory.append("user", "we sell a CRM");
  memory.remember({ business: "a CRM", audience: "logistics founders", goal: "book demos" });
  assert.equal(memory.resumeLine(), "Picking up where we left off — you sell a CRM, targeting logistics founders, to book demos.");
});

test("the resume line reads naturally when facts were captured as the person phrased them", () => {
  const memory = createMemory({ now: clock().now });
  memory.append("user", "We sell a CRM for logistics companies");
  memory.remember({
    business: "We sell a CRM for logistics companies",
    audience: "Operations heads at mid-size logistics firms",
    goal: "we want to book demos",
  });
  assert.equal(
    memory.resumeLine(),
    "Picking up where we left off — you sell a CRM for logistics companies, "
      + "targeting Operations heads at mid-size logistics firms, to book demos.",
  );
});

test("milestones record what actually happened on the dashboard", () => {
  const memory = createMemory({ now: clock().now });
  memory.milestone("campaign_created", { campaignId: "8404" });
  memory.milestone("leads_added", { source: "icpLeads", count: 80 });
  const context = memory.contextForModel();
  assert.equal(context.milestones.length, 2);
    assert.equal(context.milestones[0].detail.campaignId, "8404");
});

test("events are kept in the transcript but not replayed to the model", () => {
  const memory = createMemory({ now: clock().now });
  memory.append("assistant", "Opening the campaign builder.");
  memory.append("", "Working: prepare campaign", "event");
  memory.append("user", "go ahead");
  assert.equal(memory.transcript().length, 3);
  const sent = memory.contextForModel().recentConversation;
  assert.equal(sent.length, 2);
  assert.ok(!sent.some((turn) => turn.text.startsWith("Working:")));
});

test("a reset is the only thing that clears memory", () => {
  const memory = createMemory({ now: clock().now });
  memory.append("user", "hello");
  memory.remember({ business: "a CRM" });
  const conversationId = memory.contextForModel().conversationId;
  memory.reset();
  assert.equal(memory.transcript().length, 0);
  assert.deepEqual(memory.facts(), {});
  memory.append("user", "starting over");
  assert.notEqual(memory.contextForModel().conversationId, conversationId, "a reset starts a new conversation");
});

test("corrupt or partial stored data does not lose the conversation", () => {
  const memory = createMemory({ now: clock().now });
  memory.hydrate({ messages: [{ role: "user", text: "kept" }, null, { role: "user" }], facts: null });
  assert.equal(memory.transcript().length, 1);
  assert.deepEqual(memory.facts(), {});
  assert.equal(memory.stage(), "business");
});

const roundTrip = (memory) => JSON.parse(JSON.stringify(memory.serialize()));
const accountTrip = (memory) => JSON.parse(JSON.stringify(memory.serializeAccount()));

test("website facts, goal and conversation carry from sbl.so into the app", () => {
  const time = clock();
  const site = createMemory({ now: time.now });
  site.append("user", "We sell a CRM for logistics firms.");
  site.remember({ business: "a CRM", audience: "logistics founders", goal: "book demos" });
  const app = createMemory({ now: time.now });
  app.hydrate(roundTrip(site));
  app.bindWorkspace("w-1", "Acme");
  const context = app.contextForModel();
  assert.deepEqual(context.knownFacts, { business: "a CRM", audience: "logistics founders", goal: "book demos" });
  assert.equal(context.recentConversation.length, 1);
  assert.equal(context.fromWebsite, true);
  assert.deepEqual(context.workspace, { id: "w-1", label: "Acme" });
});

test("workspace A is invisible after binding to workspace B, and returns when rebound", () => {
  const memory = createMemory({ now: clock().now });
  memory.remember({ business: "a CRM" });
  memory.bindWorkspace("a", "Second Brain Labs");
  memory.append("user", "prepare the agency campaign");
  memory.remember({ campaignName: "agency" });
  memory.milestone("campaign_created", { campaignId: "8404" });
  memory.bindWorkspace("b", "Second Brain Labs"); // same display name, different id
  const context = memory.contextForModel();
  assert.deepEqual(context.knownFacts, { business: "a CRM" });
  assert.equal(context.recentConversation.length, 0);
  assert.equal(context.milestones.length, 0);
  assert.equal(context.workspace.id, "b");
  memory.bindWorkspace("a");
  assert.equal(memory.contextForModel().knownFacts.campaignName, "agency");
  assert.equal(memory.contextForModel().milestones[0].detail.campaignId, "8404");
});

test("clearAccount drops workspace data but keeps website facts and conversation", () => {
  const memory = createMemory({ now: clock().now });
  memory.append("user", "we sell a CRM");
  memory.remember({ business: "a CRM", goal: "book demos" });
  memory.bindWorkspace("a", "Acme");
  memory.append("user", "in-app turn");
  memory.remember({ campaignName: "agency" });
  memory.clearAccount();
  assert.deepEqual(memory.serializeAccount(), {});
  const after = createMemory({ now: clock().now });
  after.hydrate(roundTrip(memory));
  assert.equal(after.workspace(), null);
  assert.deepEqual(after.facts(), { business: "a CRM", goal: "book demos" });
  assert.deepEqual(after.transcript().map((m) => m.text), ["we sell a CRM"]);
});

test("account data never enters the website blob, and a load starts unbound", () => {
  const memory = createMemory({ now: clock().now });
  memory.append("user", "site turn");
  memory.bindWorkspace("a", "Acme");
  memory.append("user", "secret in-app turn");
  assert.ok(!JSON.stringify(memory.serialize()).includes("secret"));
  const page = createMemory({ now: clock().now });
  page.hydrate(roundTrip(memory));
  page.hydrateAccount(accountTrip(memory));
  assert.equal(page.workspace(), null);
  assert.deepEqual(page.transcript().map((m) => m.text), ["site turn"], "nothing shown until detection binds");
  page.bindWorkspace("a");
  assert.deepEqual(page.transcript().map((m) => m.text), ["site turn", "secret in-app turn"]);
});

test("why on an entry survives serialize and hydrate, in both scopes", () => {
  const memory = createMemory({ now: clock().now });
  Object.assign(memory.append("assistant", "Saw you on pricing"), { why: "pricing dwell" });
  memory.bindWorkspace("a", "Acme");
  Object.assign(memory.append("assistant", "Your campaign is ready"), { why: "campaign ready" });
  const again = createMemory({ now: clock().now });
  again.hydrate(roundTrip(memory));
  again.hydrateAccount(accountTrip(memory));
  again.bindWorkspace("a");
  assert.deepEqual(again.transcript().map((m) => m.why), ["pricing dwell", "campaign ready"]);
});

test("merging a stored copy keeps turns written by another tab", () => {
  const a = createMemory({ now: clock(1000).now });
  a.bindWorkspace("w", "Acme");
  a.append("user", "from tab A");
  const b = createMemory({ now: clock(500000).now });
  b.bindWorkspace("w", "Acme");
  b.append("user", "from tab B");
  b.hydrateAccount(accountTrip(a));
  assert.deepEqual(b.transcript().map((m) => m.text), ["from tab A", "from tab B"]);
});

test("label-only scopes are never persisted and vanish on a label change", () => {
  const memory = createMemory({ now: clock().now });
  memory.bindWorkspace("label-acme", "Acme", { ephemeral: true });
  memory.append("user", "hello");
  assert.deepEqual(memory.serializeAccount(), {});
  memory.bindWorkspace("label-other", "Other", { ephemeral: true });
  memory.bindWorkspace("label-acme", "Acme", { ephemeral: true });
  assert.equal(memory.transcript().length, 0, "the earlier label scope was dropped");
});

test("hostile workspace ids are rejected and nothing throws or pollutes", () => {
  const memory = createMemory({ now: clock().now });
  for (const bad of ["__proto__", "constructor", "prototype", "a b", "x".repeat(65), "", null]) {
    assert.equal(memory.bindWorkspace(bad, "x"), null);
  }
  memory.hydrateAccount(JSON.parse('{"__proto__":{"messages":[{"text":"x","at":1}]},"constructor":{}}'));
  memory.append("user", "still fine");
  assert.equal(memory.workspace(), null);
  assert.equal({}.messages, undefined);
  assert.equal(memory.transcript().length, 1);
});

test("a return after ten days is flagged with a note saying when they were last seen", () => {
  const first = createMemory({ now: () => 1_000_000 });
  first.append("user", "hello");
  const stored = roundTrip(first);
  const day = 86_400_000;
  const later = createMemory({ now: () => 1_000_000 + 10 * day });
  later.hydrate(stored);
  assert.match(later.contextForModel().returning, /Returning after 10 day\(s\), last seen 1970-01-01/);
  assert.equal(later.pending(), true, "the return is persisted so the next page knows too");
  const soon = createMemory({ now: () => 1_000_000 + 60_000 });
  soon.hydrate(stored);
  assert.equal(soon.contextForModel().returning, null, "a reload in the same sitting is not a return");
});

test("a visitor reply clears the asked-question memory, so the follow-up is not a re-ask", () => {
  // Live (trace def8b81f-yzcx-20, 2026-10-21): the agent asked one compound question -
  // "What offer should this WhatsApp campaign promote, what should interested agents do,
  // and what campaign name would you like?" - the visitor answered only the offer, and the
  // correct follow-up for the remaining two overlapped the original by more than 0.6. The
  // ask-once guard refused it twice and the turn ended "failed" on "Sorry, I lost my thread
  // there." Campaign creation died on a partial answer, which is how people actually answer.
  const compound = "What offer should this promote, what should agents do, and what name?";
  const task = Task.newTask("create a whatsapp campaign");
  Task.said(task, compound);
  Task.said(task, "I am opening a new WhatsApp campaign.");
  task.question = compound;

  Task.answered(task);

  assert.strictEqual(task.question, null, "the answered question is forgotten");
  assert.deepStrictEqual(task.said, ["I am opening a new WhatsApp campaign."],
    "questions drop out, plain statements stay so the agent still does not repeat itself");
});

test("answered() does not excuse repeating a question the visitor never replied to", () => {
  // The case the guard exists for: the same question over and over with the visitor silent.
  // Nothing calls answered() in that stretch, so the question stays in memory and stays blocked.
  const q = "What is your company website?";
  const task = Task.newTask("collect the website");
  Task.said(task, q);
  task.question = q;
  assert.strictEqual(task.question, q);
  assert.ok(task.said.includes(q));
  assert.strictEqual(Task.answered(undefined), undefined, "no task is not an error");
});
