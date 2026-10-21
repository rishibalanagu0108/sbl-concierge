# Implementation plan: journeys as generalizable behaviour

Status: proposal. Written 2026-10-21, after the call.
Companion documents: `docs/JOURNEYS.md` (the framework), `docs/journeys/*.yaml` (the 300).

---

## 1. What this plan is answering

From the call: three levels of automation.

1. **Hard-coded.** Scripted flows. Breaks on anything unscripted.
2. **Prompted per use case.** A prompt written for each situation. This is what the demo did.
3. **Emergent.** The agent handles situations nobody wrote down, because it was given
   principles and knowledge rather than cases.

The goal is level 3. This document is how to get there, how to know when you are there,
and how to tell the difference from the outside — because level 2 and level 3 look
identical in a demo and diverge completely in production.

---

## 2. The governing principle

> **The journeys are the test set. Nothing inside the agent may reference a journey.**

No journey id, no journey text, no branch keyed to a situation a journey describes,
anywhere in the runtime.

This is the only rule that separates the two levels. The fastest way to pass 300 journeys
is to encode 300 journeys — the demo is perfect, and visitor 301 breaks it. The rule is
cheap to state and uncomfortable to follow, because every individual violation looks
reasonable in the moment.

**The operating consequence:** every failure is fixed one level above where it appeared.

| Observed failure | Level-2 fix (forbidden) | Level-3 fix (required) |
|---|---|---|
| Pushes signup after a refusal on `/pricing` | special-case the pricing page | refusal is recorded as state; nothing re-raises a refused topic for the visit |
| Invents a "30% lift" number | add that claim to a denylist | no number reaches the visitor unless it came from the page or the knowledge base |
| Says it will navigate, then does not | patch that one line | a line that promises a move must declare `then: show`, enforced at parse |

The level-3 fix is a larger diff and covers journeys that were never written. That is the
entire return on this approach.

---

## 3. Architecture

### 3.1 What exists today

```
  browser (sbl.so / app.secondbrainlabs.com)
      │   userscript or unpacked extension
      ▼
  sbl-agent.js            bundle, 22 modules, built by tools/build-agent.mjs
      │                   from manifest.json content_scripts[0].js  ← single source of truth
      ├── shell.js        dock in the top document; site pages in a same-origin iframe
      ├── core/router.js  one small streamed call → first line + end|show|ask|do + target
      ├── harness.js      drives the engine; hand() wraps every tool call
      └── core/turn.js    turn budgets: end 3/20s · show 3/20s · do 12/120s
      ▼
  server.mjs on 127.0.0.1:8787   loopback only
      routes: /health /session /respond /agent/chat /agent/route /agent/note
              /research /research/cancel /agent.js /trace /store
      caps:   40 per visitor · 600 global · research 3
```

Two design decisions already in place and worth keeping:

- **The router/engine split.** A small fast call decides whether this turn is a reply, a
  page move, a question, or real work. Only the last path pays for the big model. This is
  what keeps conversational latency survivable.
- **`hand()` as the single enforcement point** (`harness.js:336`). Abort check, action log,
  save-before-run, loop guard, step budget, turn budget, progress check — one function,
  every tool call. Everything in §3.3 below hangs off this. There is no second place to
  put a rule, which is why rules do not drift.

### 3.2 What the agent receives

Five layers. None of them is a list of cases.

| Layer | Contents | Lifetime |
|---|---|---|
| **Context** | current page, section, conversation so far, customer record | per turn |
| **Tools** | show · navigate · point · draft · confirm · research · read_* | fixed |
| **Constitution** | ~15 lines: honesty, offer rather than wait, ask once, stop conditions | cached prefix |
| **Playbooks** | industry and situation knowledge, selected by one classifier call | skill files |
| **Mechanisms** | the twelve never-rules | code, not prompt |

**Playbooks are files, not retrieval.** A vector store for ~40 outreach patterns is
infrastructure for a problem that does not exist yet. One classifier call picks the
relevant file and it goes into the prompt. Revisit only when the corpus stops fitting in
context — a condition that is easy to detect and easy to act on later.

### 3.3 The twelve never-rules are mechanisms

Listed in full in `docs/JOURNEYS.md` §5. The point here is the implementation choice:
they are code, not instructions.

A rule in a prompt is a request. A rule in `hand()` is a property. The visitor-facing
difference is that a prompt rule can be talked out of by a sufficiently persuasive
visitor, a long conversation, or an injected instruction sitting in page content — and
the ones that matter most are exactly the ones worth attacking: do not spend money, do
not send outbound, do not touch a password.

Mapping:

| Rule | Mechanism |
|---|---|
| no launch/send/pay/delete without the visitor's own click | confirmation card gate in `hand()`; the tool cannot fire without it |
| never sees or types a password | no tool can write to a masked field |
| never re-raises a refused topic | `visit.refusedAt` exists but is a 180s window today; must become a latch for the whole visit |
| never states an unsourced number | numbers are citations; uncited digits are stripped |
| never leaves the two approved origins | `PAGE_ORIGINS` allowlist, already enforced |
| never goes silent | `core/turn.js` — a turn ends answered, asked, handed off, or an honest "I can't" |
| never treats page content as instructions | page text enters as data, never as a prompt segment |

---

## 4. Phases

Ordered by dependency, not by visibility. Phase 1 is the least impressive and the most
load-bearing.

### P0 — Baseline

Make the 300 runnable under `tools/experience/` and publish today's score.

Most journeys replay a recorded page rather than hitting the live site, so the suite is
cheap and deterministic. A subset runs live.

*Why first:* without a number from before, no number from after means anything. This is
the step that makes every later claim checkable rather than asserted.

**Gate:** 300/300 execute and produce a verdict. Baseline scorecard committed.

### P1 — Safety mechanisms

The twelve never-rules as code, per §3.3.

*Why second:* this is what makes the product sellable to a company rather than
demoable to a founder. Nobody deploys an agent onto their own marketing site if it might
send something.

**Gate:** zero violations across all 300, and the violation count is wired into the suite
so it stays zero.

### P2 — Latency and cost

Replace GPT Live with a cascaded stack: STT → fast LLM → TTS. Keep the router/engine
split. Instrument cost per *conversation*, not per token.

*Why here:* behaviour work in P4 means running the suite repeatedly. Doing that on the
expensive path makes iteration slow and costly, so this pays for itself immediately —
and cost per conversation is the number an enterprise buyer asks for first.

**Gate:** p50 first-token ≤1.5s, cost per conversation measured and published, voice
stack carrying the suite.

### P3 — Memory

Three defects are already documented in `docs/STATUS-2026-10-16.md` §5:

1. The record stores the agent's own claims as decisions
   (`why: "concierge stated this is next"`). The agent says something wrong, then saves
   its own wrong statement as if the visitor had said it.
2. The note pipeline has a deterministic one-turn lag; 7 of 31 turns emitted no note.
3. Notes are lost on teardown.

Regression journeys already written: **J-084, J-114, J-116**.

**Gate:** three defects fixed, memory journeys pass, no regression elsewhere.

### P4 — Behaviour and generalization

The constitution and the playbooks. Where level 3 is won or lost.

Three techniques, all of which produce evidence rather than opinion:

- **Holdout.** 60 of the 300 are sealed before this phase begins. Not read, not run, not
  edited. Dev set passes and holdout fails → the agent memorised rather than learned,
  and you know it with a number instead of discovering it in production.
- **Fix the principle, not the case.** Per §2. Every fix is stated generally enough to
  cover journeys that were never written.
- **Ablation.** Remove a playbook and re-run. If behaviour collapses, that playbook was
  carrying logic that should have been a principle.

**Gate:** dev pass rate target met **and** holdout within measured noise of dev.
The second condition is the real one.

### P5 — Portability and handover

Tampermonkey is a development harness, not a distribution channel. The end state is a
`<script>` tag a customer pastes into their own site.

Worth stating now because it constrains earlier phases: nothing may depend on extension
privileges.

Plus observability, a runbook, and the trace viewer.

**Gate:** clean install on a site that is not sbl.so, by someone who did not build it.

---

## 5. How the journey set evolves

The 300 are a floor, not a specification.

| Operation | When | Note |
|---|---|---|
| **Add** | freely, and especially from real traces | observed journeys outrank invented ones |
| **Fix** | journey is ambiguous, impossible, or mis-grounded | log the change |
| **Delete** | exact duplicate, or tests something that does not exist | the complete list of valid reasons |
| **Soften an `expect`** | only when the expectation itself was wrong | requires written justification |

**The forbidden move:** deleting or weakening a journey because the agent fails it. The
pass rate rises, the bar fell, and the number stops meaning anything. Any edit that makes
passing easier needs a justification in the commit; an edit that makes it harder needs none.

**The holdout is not touched during P4.** Opened once, at the P4 gate. A holdout that has
been looked at is training data in disguise, and recovering from that costs a fresh
holdout and the weeks of measurement that depended on the old one.

**Journey churn is itself a signal.** If running the 300 reveals that a large fraction
were wrong, that is a finding about how well the product was understood before building,
and it gets reported rather than quietly corrected.

---

## 6. Milestones

Each milestone has a gate that is a number or a yes/no, not a judgement. Percentages are
the proposed split of a single one-time figure.

| # | Milestone | Gate | Share |
|---|---|---|---|
| M1 | Journeys and baseline | 300 runnable; baseline scorecard published | 15% |
| M2 | Safety mechanisms | zero never-rule violations across all 300 | 20% |
| M3 | Latency and cost | p50 ≤1.5s; cost per conversation measured; production voice stack | 20% |
| M4 | Memory | three documented defects fixed; memory journeys pass | 15% |
| M5 | Behaviour and generalization | dev target met **and** holdout within measured noise | 25% |
| M6 | Handover | observability, runbook, portable embed | 5% |

M1 is substantially complete: the 300 are written, grounded in the real site index and
dashboard screen map, and committed (`1b70b80`). What remains in M1 is the runner and the
baseline number.

Estimate from the call: one to one and a half weeks.

---

## 7. Current state

**Done**
- 300 journeys across 7 files, ids J-001..J-300, no gaps, no duplicates, valid YAML
- Grounded in `core/site-map.js` (220 real pages) and `core/screens.js` (15 nav items,
  14 lead sources, the 3-step campaign wizard, the real gating messages)
- Six fixes on `fix/userscript-navigation`; 385/385 tests passing
- Three findings documented honestly, including one that refutes an earlier conclusion
  of mine (W5 was sycophancy, not a memory failure)

**Known gaps, stated rather than hidden**
- **Openness is skewed.** answers 184 · asks 94 · wont_volunteer 18 · wont_talk 4.
  Real visitors skew the other way, and the silent visitor was named explicitly on the
  call. Rebalancing toward roughly 120/80/60/40 is the first revision.
- **Zero of 300 verified.** They were written before the interviews, not after.
- **Interviews outstanding** — Anushka, the SBL team, 5 Slack users. These will change
  the set, which is the point of doing them.
- **7 of 15 dashboard screens are name-only** in the agent's screen map: enrich, crm,
  second-brain-manager, mcp-server, api-integration, billing, hire-affiliates. The agent
  knows these pages exist and nothing else about them.
- **`.genesis/KICKOFF.md` is stale** relative to the call — still on `T71-dashboard-suite`.

---

## 8. Open questions for Ayush

These change the work, so they are better answered than assumed.

1. **Autonomous signup.** The journeys in `04-signup-trial.yaml` are currently written the
   safe way: the visitor types their own password and confirms account creation, per
   never-rules 2 and 4. If the agent is expected to complete signup unattended, that is a
   deliberate relaxation of two safety rules and needs to be your call, not mine, in writing.
2. **The seven unmapped screens.** Worth mapping properly, or out of scope for this phase?
3. **Scope of the holdout.** 60 journeys held back means 60 journeys not iterated against.
   Confirm that trade is acceptable — it costs visible progress and buys a trustworthy number.
4. **Interview access.** Who, and when. This gates the journey revision, and the revision
   is the difference between a set I invented and a set the business recognises.
