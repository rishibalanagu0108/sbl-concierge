# Journey 1 — Discovery to a personalized product demonstration

Plan and executable test script. Branch `fix/userscript-navigation`.
State and blockers: [STATUS-2026-10-16.md](STATUS-2026-10-16.md).

## Definition of done

The founder's wording: *"a respectful opener, understanding the visitor's goal, answering
follow-ups, navigating and showing relevant features, pricing and real customer examples, and
adapting when the visitor changes direction."*

It counts as complete only when all of these hold:

1. All seven checkpoints below pass for **three different visitor profiles**, phrased naturally and
   differently each time — not one script run three times.
2. Each profile is run **twice**, from a fresh visit. A checkpoint that passes once and fails once is
   a fail.
3. **No mid-flow correction.** If the agent has to be re-prompted or rephrased at, the run is a
   failure and is recorded as one.
4. Verified on the **resulting page**, not the trace event: URL changed, the right section visible,
   the highlight on the thing the line is about, the dock not covering it.
5. Captured with **Antigravity enabled** (the extension that supplies the navigation trigger), with
   browser version and load method recorded.
6. Each retained candidate evidenced separately: holdout x3 plus dev, replay and faults, compared
   against `base0` **and** the previous candidate, with gates, provisional judging, real-browser
   proof, and per-set token totals. No row worse beyond the noise floor.

Partial completion is reportable. Staged completion is not.

## Checkpoints

| # | Step | Passes when | Dimension |
|---|---|---|---|
| C1 | Opener | One greeting, no navigation, no signup push. Nothing repeated on reload or in a new tab. Suppressed while typing. | E5, E9 |
| C2 | Goal understood | It reflects the stated business back in its own words, does not re-ask, does not pitch a plan unasked. | E7 |
| C3 | Follow-up answered | Answers the question actually asked, one or two lines, no unrequested navigation. | E5 |
| C4 | Features shown | URL changes to the feature page/section; the relevant block is highlighted; the line matches what is lit. | E3, E4 |
| C5 | Pricing shown | URL changes to `/pricing/`; the plan or comparison the line names is highlighted. | E3, E4 |
| C6 | Proof shown | Lands on a real `customer story`, **not** `/agency/`. If nothing matches the visitor's industry, it says so honestly rather than presenting a near-miss as a match. | E3, E4 |
| C7 | Direction change | The new request is answered; the previous task stops; no answer arrives for the abandoned one. | E9 |

C6 is the one with a known defect, and the honest-miss half matters as much as the landing: none of
the 22 case studies is about recruitment.

## The script — three profiles

Run each **twice**, fresh visit each time. Never paste these verbatim into the dock as a block; type
them one at a time and wait for each to finish.

### Profile A — recruitment agency

```
C2  I run a recruitment agency. Can SBL help me book more meetings?
C3  How does it actually find the right people to contact?
C4  Show me the features
C5  What does it cost?
C6  Can I see a real example from a customer like me?
C7  Actually forget pricing — how does the WhatsApp side work?
```

### Profile B — fintech consultancy (different words, same shape)

```
C2  We're a small fintech compliance consultancy, about 8 people. We want more demos booked.
C3  Does it write the messages itself or do I have to?
C4  Take me to what the product actually does
C5  Show me your plans
C6  Have you worked with anyone in financial services?
C7  Hold on, before pricing — can it handle replies automatically?
```

### Profile C — solo consultant (terse, lower context)

```
C2  solo consultant, b2b. need leads.
C3  how fast does it work
C4  show features
C5  pricing
C6  any proof this works
C7  wait, show me the comparison with Expandi instead
```

Record per step: URL before, URL after, what was highlighted, number of visible lines, whether a
correction was needed. A `NO` in the correction column voids the run.

## Work items

| # | Item | State |
|---|---|---|
| W1 | Navigation executes under the userscript build | **done** `267f53d`, browser-unverified |
| W2 | Index shows page kind so proof can find a customer story | **done** `52ea3ef`, behaviour-unverified |
| W3 | Verify C4/C5/C6 in the browser with Antigravity on | blocked — needs key |
| W4 | C6 honest-miss: no recruitment case study exists; confirm it says so rather than near-missing | blocked — needs key |
| W5 | C2 memory miss: it answered "I don't know" and then recalled the same fact a turn later | **not diagnosed** |
| W6 | C1 welcome across reload / return / typing / active turn | not started |
| W7 | C7 direction change: old task stops, no late answer | not started |
| W8 | Full suite vs `base0`, no row worse beyond noise | blocked — needs key |

### W5 is the one real unknown

Observed live: asked whether it knew the business, it denied, then a turn later produced the fact and
admitted the inconsistency ("You're right — that was inconsistent"). The customer file is assembled
in `content.js:1273` and reaches the router at `harness.js:865`; notes are written after a turn
completes (`note` / `note-saved` in the trace). A fast follow-up may therefore read a file that has
not been written yet. **This is a hypothesis, not a diagnosis** — confirm against the trace before
changing anything, because an E7 regression is worse than an occasional miss.

## Order of work

1. W5 diagnosis — trace-only, no key needed, and it is the last unknown in the journey.
2. W6 and W7 scripted as browser checks, ready to execute.
3. The moment a key lands: W3, W4 across all three profiles, twice each.
4. W8 full suite, compare against `base0`.
5. Record the Loom.

Steps 1-2 are useful without a key. Steps 3-5 are not startable without one.

## Measurement

Two behaviour-changing commits are retained on this branch, so they are **two candidates, evidenced
separately** — not one combined run. Maintainer instruction: where a task requires changes to be
tested separately, preserve that separation, and cost control must not remove checks or let the old
baseline stand in as post-fix evidence.

| Candidate | Contains | Compare against |
|---|---|---|
| `j1a` | `267f53d` guard fix only | `base0` |
| `j1b` | `267f53d` + `52ea3ef` index kind | `base0` **and** `j1a` |

Each candidate needs the full set, not just holdout:

```bash
C=j1a   # then repeat for j1b
node tools/experience/run.mjs --set holdout --runs 3 --concurrency 2 --out var/experience/$C
cp var/experience/$C/summary.json var/experience/$C/summary-holdout.json
node tools/experience/run.mjs --set dev    --runs 1 --out var/experience/$C
cp var/experience/$C/summary.json var/experience/$C/summary-dev.json
node tools/experience/run.mjs --set replay --runs 1 --out var/experience/$C
cp var/experience/$C/summary.json var/experience/$C/summary-replay.json
node tools/experience/run.mjs --set faults --runs 1 --out var/experience/$C
cp var/experience/$C/summary.json var/experience/$C/summary-faults.json

node tools/experience/score.mjs var/experience/$C/holdout --compare var/experience/base0/holdout
# j1b additionally:
node tools/experience/score.mjs var/experience/j1b/holdout --compare var/experience/j1a/holdout

ln -sfn $PWD/var/experience/$C var/experience/latest
node tools/experience/gate.mjs <name>          # inspect gate.mjs for supported names
node tools/experience/judge.mjs var/experience/$C --set holdout
```

Report for each candidate: every scorecard row (not only the failing ones), the gate output, the
provisional judge rows, and the per-set **prompt / cached / completion** totals read from each
`summary-<set>.json`. Zero failed jobs is not a pass. Provisional judge labels are not a gate.

`base0` is the unchanged-checkout reference and stays filed separately from anything post-fix. Raw
tc9/tc24 inputs are not in the snapshot, so no tc9 comparison may be claimed.

**Cost, to flag before running.** One full set pass measured 2,119,471 prompt tokens (1,835,600
cached) and 15,786 completion, taking 22 minutes. Two candidates is roughly **4.2M prompt tokens and
~45 minutes**, plus judge calls on top (`base0` judging was not run). The maintainer asked for
unusually costly work to be flagged in advance — send that number before starting, not after.

Targeted local runs (a single persona, `--set dev --persona <id>`) are fine while developing and do
not substitute for the evidence above on a retained candidate.

`E1.p50` will miss its 1500 ms target on this hardware (`base0` measured 1820 across all four sets).
Pre-existing, not journey 1's to fix; report it, do not chase it.

## Loom outline

1. The failure, with Antigravity enabled: ask for pricing, show the page not moving, show the
   `navigate` event in the trace and the `chrome.runtime.sendMessage` throw beside it.
2. The cause in one screen: the three guards side by side, `.id` against `.sendMessage`.
3. The same request after the fix: the page moves, the section highlights.
4. Journey 1 end to end on Profile A, uncut.
5. A second profile, to show it is not tuned to one prompt.
6. What is still not working, said plainly.

Point 6 is not a disclaimer to rush. The brief asks for an honest account of what does not work, and
the recorded demo is where that is most credible.
