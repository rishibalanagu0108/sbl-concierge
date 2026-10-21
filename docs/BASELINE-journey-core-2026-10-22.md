# Baseline: journey-core, 2026-10-22 (Finding 1 corrected)

The 32 journeys worth making work first. Selection and reasons:
`tools/experience/core-journeys.txt`.

    node tools/experience/run.mjs --set journey-core --runs 1 --concurrency 2 \
      --out var/experience/journey-core-0

32 journeys, 39 steps, 0 failed, 0 timeouts, 7m 23s at concurrency 2.
Build `sbl-agent.js` 1727 KB from 22 files, branch `fix/userscript-navigation` at `9fe18f8`.

Cost: 41 model calls, 761,968 prompt tokens (654,044 cached, 86%), 5,931 completion.

## Finding 1 (CORRECTED): the harness could not see the agent speak

**The first version of this document said the agent never speaks first. That was wrong,
and the correction is the finding.**

What was reported: six wait steps across five journeys ended in total silence, "verified
against the screenshot". The screenshot check was too weak - the dock was closed in its
resting state, and a closed dock was read as nothing said. The greeting had already been
delivered and collapsed into the pill.

What is actually true: the agent greets on first visit with

    Hey, what are you looking to improve: finding leads, getting replies, or booking more meetings?

Proved by driving the page with the suite's own `Visitor` class
(`tools/proof/welcome-probe.mjs`): the line is in `.messages .msg` while the step record
reports zero lines. So this was J-292, the known tracer-visibility defect, which the
first version of this document explicitly claimed to have ruled out.

### Root cause

`driver.mjs` `#watch` took `seen = before0.lines.length` at the start of every step and
treated those lines as history. The welcome fires on a timer during page load, so it
lands before the first step's baseline is taken, is counted as pre-existing, and is then
sliced away by `agentLines` on that step and every step after it.

### The fix, stated as a principle

At the start of a visit there is no history. On the first step only lines the dock marks
`restored` are history; anything else already on screen is something the agent said on
its own. That is a property of what a visit is, not a rule about welcomes, so it also
covers any future unprompted line that lands during load.

### Measured before and after

| Journey | before | after |
|---|---|---|
| J-001 silent arrival | 0 agent lines | 1 |
| J-019 refuses signup at pricing | 3 | 4 |
| J-025 lands cold on a case study | 0 | 1 |
| J-152 offers too early | 0 | 1 |
| J-263 offers the same thing twice | 0 | 1 |

J-019 also shows the refusal being honoured in the agent's own words - "No problem, take
your time exploring the plans and customer results" - and no signup re-raised afterwards.
It did not offer the nearest real proof story, which the journey expects, so J-019 is
closer to passing than the first run suggested but is not passing.

### Consequence for the latency numbers

The welcome now reports around 412 ms because it was already on screen when the step's
baseline was taken. That is not a page-load-to-greeting measurement and must not be
presented as one. Measuring the welcome's true latency needs a timer from navigation
start, which does not exist yet.

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

1. **Re-run the core set on the fixed harness.** Every number above was measured with a
   blind spot. The run is cheap; the numbers are not trustworthy until it is repeated.
2. **Run the judge** so per-journey verdicts exist. Until then we know the agent is safe
   and slow, not whether it is any good.
3. **Measure the welcome honestly.** A timer from navigation start, so "how long until
   the visitor is greeted" is a real number rather than an artefact of the baseline.
4. **Latency.** Finding 2, and P2 in the plan. Architectural, not behavioural. Parked at
   the maintainer's request while the useful journeys are made to work.

## The lesson worth keeping

The first run of a new measuring instrument tells you as much about the instrument as
about the thing measured. A result that says the product is catastrophically broken in
its headline feature deserves a second look at the ruler before it is written down - and
certainly before it is shown to anyone.
