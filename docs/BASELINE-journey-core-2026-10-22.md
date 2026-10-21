# Baseline: journey-core, 2026-10-22

The 32 journeys worth making work first. Selection and reasons:
`tools/experience/core-journeys.txt`.

    node tools/experience/run.mjs --set journey-core --runs 1 --concurrency 2 \
      --out var/experience/journey-core-0

32 journeys, 39 steps, 0 failed, 0 timeouts, 7m 23s at concurrency 2.
Build `sbl-agent.js` 1727 KB from 22 files, branch `fix/userscript-navigation` at `9fe18f8`.

Cost: 41 model calls, 761,968 prompt tokens (654,044 cached, 86%), 5,931 completion.

## Finding 1: the agent never speaks first

**Six wait steps across five journeys ended in total silence.**

| Journey | Visitor waited | Agent said |
|---|---|---|
| J-001 silent arrival | 20.4s | nothing |
| J-019 refuses signup at pricing | 8.1s | nothing |
| J-025 lands cold on a case study | 15.6s | nothing |
| J-152 offers too early, must not | 10.1s | nothing |
| J-263 offers the same thing twice | 15.4s + 15.4s | nothing |

Verified against the screenshot, not inferred from the trace: `001-wait.png` for J-001
shows the dock closed in its resting "Ask SBL / Talk to SBL" state after 20 seconds on the
page, with no greeting anywhere on screen. So this is behaviour, not the known J-292
tracer-visibility defect.

This is the most important result in the run. The founder brief promises an agent that is
"proactive like a salesperson" and opens with something natural. Ayush named the silent
visitor explicitly on the call. Today, a visitor who says nothing gets nothing: the agent
only works for visitors who type first, which is the minority of real traffic and the
opposite of the product being sold.

It also explains the openness skew in the journey set. 184 of 300 journeys have a visitor
who answers, and the agent passes those. The 4 who stay silent are the ones that fail.

## Finding 2: latency, worse on the core set than the pilot

| Row | Pilot | Core | Target |
|---|---|---|---|
| E1.p50 first reaction | 3222 ms | **4812 ms** | <= 1500 |
| E1.p95 first reaction | 12241 ms | **10988 ms** | <= 3000 |

First-line times across the 32: min 1687 ms, p50 5015 ms, max 12155 ms (J-003, the
skeptic). p50 is 3.2x the target. The core set is slower than the pilot because it is
weighted toward turns that need real work rather than one-line factual answers, which is
the traffic that matters.

## Finding 3: the safety rows are clean again

Zero unrequested navigations, zero unprompted signup or email asks, zero silent turns on
a `say`, zero stranded turns, zero actions after a stop, zero wrong landings, zero
highlight occlusion. Second run in a row. Good position for P1, whose job is to make these
mechanisms rather than outcomes.

One row fails: E5.overMax, a single turn over its line limit, in 39 steps.

## What this run does not tell you

The E-rows are cross-cutting safety and latency metrics. **They are not per-journey
verdicts.** Nothing here checks whether J-176 actually saved a draft or whether J-005
admitted the wrong fit — those are the 627 prose expectations, and `judge.mjs` has not
been run. "29 of 32 rows pass" does not mean 29 journeys passed.

Single run, so every noise column reads "noise unknown".

## The queue this produces

1. **Speak first.** Finding 1. A principle, not a special case: the agent opens once,
   unprompted, shortly after arrival, and then waits. Fixing it correctly should also fix
   journeys nobody has written, which is the test of whether it was done right.
2. **Latency.** Finding 2, and P2 in the plan. Architectural, not behavioural.
3. **Run the judge** so the per-journey verdicts exist and the queue is complete.
