const test = require("node:test");
const assert = require("node:assert/strict");
// bg() must pick its transport from chrome.runtime.id, not from chrome.runtime.sendMessage.
//
// Chrome exposes chrome.runtime.sendMessage to an ORDINARY PAGE whenever any installed extension declares
// externally_connectable for that origin (seen live: "Antigravity Browser Extension", matches <all_urls>),
// while leaving chrome.runtime.id undefined. Guarding on sendMessage made the script-tag build call the
// extension transport with no extension; Chrome threw "must specify an Extension ID" SYNCHRONOUSLY, so the
// .catch() could not absorb it. The throw escaped save(), and navigate() never reached its location.assign():
// the agent announced the move, emitted the navigate trace event, and left the visitor on the same page.
const { build, tick, say, act, scripts, stored, assigned, cleanup } = require("./fake-engine.cjs");

// fake-engine's stub is the extension context (runtime.id set). A page context is the same object without id:
// bg() reads globalThis.chrome?.runtime?.id per call, so flipping it here is enough.
function asPage() {
  const id = globalThis.chrome.runtime.id;
  delete globalThis.chrome.runtime.id;
  // What Chrome really does when a webpage calls sendMessage without an extension id: throw, not reject.
  const orig = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = () => { throw new TypeError("Error in invocation of runtime.sendMessage(...): chrome.runtime.sendMessage() called from a webpage must specify an Extension ID"); };
  const session = new Map();
  globalThis.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  return { session, restore: () => { globalThis.chrome.runtime.id = id; globalThis.chrome.runtime.sendMessage = orig; delete globalThis.sessionStorage; } };
}
const navTo = (url) => { const orig = location.assign; location.assign = (h) => { assigned.push(h); }; return () => { location.assign = orig; }; };

test.after(cleanup);

// The regression. Before the fix this left `assigned` empty: the page never moved.
test("page context (sendMessage exists, runtime.id does not): navigate still reaches location.assign", async () => {
  const page = asPage(), undo = navTo();
  try {
    const a = build();
    scripts.push([say("I'll show you pricing.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" })]);
    a.h.hear("show me the pricing page"); await tick(120);
    assert.deepEqual(assigned, ["https://sbl.so/whatsapp/"], "the page must actually move, not just emit a navigate event");
  } finally { undo(); page.restore(); }
});

test("page context: the task rides sessionStorage, and the extension transport is never called", async () => {
  const page = asPage(), undo = navTo();
  try {
    const a = build();
    scripts.push([say("I'll show you pricing.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" })]);
    a.h.hear("show me the pricing page"); await tick(120);
    assert.equal(stored.has("t"), false, "nothing may reach the extension store from a page");
    const saved = JSON.parse(page.session.get("sbl_task_v1") || "null");
    assert.equal(saved?.goal, "show me the pricing page", "the task must survive the page load via sessionStorage");
  } finally { undo(); page.restore(); }
});

// Ayush asked for the real extension path too: the fix must not quietly send every build down the local store.
test("extension context (runtime.id set): the task goes through the extension transport", async () => {
  const undo = navTo();
  try {
    const a = build();
    scripts.push([say("I'll show you pricing.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" })]);
    a.h.hear("show me the pricing page"); await tick(120);
    assert.deepEqual(assigned, ["https://sbl.so/whatsapp/"], "the page moves in the extension path as well");
    assert.equal(stored.get("t")?.goal, "show me the pricing page", "the extension store is what holds the task here");
  } finally { undo(); }
});

// A real extension throws this synchronously after its context is invalidated by a reload; bg() must degrade, not die.
test("extension context that throws synchronously falls through to the local store instead of killing the turn", async () => {
  const undo = navTo();
  const orig = globalThis.chrome.runtime.sendMessage;
  const session = new Map();
  globalThis.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  globalThis.chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated."); };
  try {
    const a = build();
    scripts.push([say("I'll show you pricing.", "show"), act("navigate", { url: "https://sbl.so/whatsapp/" })]);
    a.h.hear("show me the pricing page"); await tick(120);
    assert.deepEqual(assigned, ["https://sbl.so/whatsapp/"], "a dead extension context must not strand the visitor");
    assert.equal(JSON.parse(session.get("sbl_task_v1") || "null")?.goal, "show me the pricing page");
  } finally { undo(); globalThis.chrome.runtime.sendMessage = orig; delete globalThis.sessionStorage; }
});
