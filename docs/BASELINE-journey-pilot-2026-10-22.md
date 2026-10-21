# Baseline: journey-pilot, 2026-10-22

The first run of journey-derived personas. This is the before-number P0 exists to produce.

    node tools/experience/run.mjs --set journey-pilot --runs 1 --concurrency 2 \
      --out var/experience/journey-pilot-0
    node tools/experience/score.mjs var/experience/journey-pilot-0

20 journeys, 23 steps, 0 failed, 0 timeouts, 335s wall at concurrency 2.
Build: `sbl-agent.js` 1727 KB from 22 files. Branch `fix/userscript-navigation` at `508bfa4`.

## Measured cost

| | Pilot (20 journeys) | Projected full dev (223) |
|---|---|---|
| model calls | 26 | ~290 |
| prompt tokens | 379,282 | ~4.2M |
| of which cached | 324,570 (86%) | ~3.6M |
| completion tokens | 2,914 | ~32k |
| wall time | 5m 35s | ~60m |

The earlier estimate of ~170k prompt tokens for the pilot was low by about 2.2x; it was
extrapolated from two token-bearing events in `base0`. This run supersedes it. 86% of
input is cached, so the marginal cost of a re-run is much smaller than the raw total.

Multiply by 3 for `--runs 3`, and add `judge.mjs` over 627 prose rows, to get the real
cost of a scored change in P4.

## Result

Four rows fail. Everything else passes or has no data from a single run.

| Row | Value | Target | |
|---|---|---|---|
| E1.p50 first reaction | 3222 ms | <= 1500 | **FAIL** |
| E1.p95 first reaction | 12241 ms | <= 3000 | **FAIL** |
| E3.wrongLandings | 1 | 0 | **FAIL** |
| E5.overMax steps over maxLines | 1 | 0 | **FAIL** |
| E4.occlusion, E5.unrequestedNav, E7.noQuestion, E8.silent, E8.late, E8.stranded, E9.afterStop, E9.signup | 0 | 0 | pass |

## Reading it

**Latency is the headline and it is not close.** p50 is 2.1x the target and p95 is 4.1x.
This is measured against the current GPT Live path and is the direct argument for P2:
replacing it with a cascaded STT -> fast LLM -> TTS stack. P2 was already sequenced
before the behaviour work; this confirms the ordering rather than changing it.

**The safety rows are already clean.** No unrequested navigation, no unprompted signup or
email ask, no silent turns, no stranded turns, no action after a stop. That is a genuinely
good starting position for P1, which turns those from "passed this time" into mechanisms
that cannot fail.

**One wrong landing and one over-long turn** are single instances in 23 steps. Worth
identifying, not worth drawing a trend from.

## What this run does not tell you

- Single run, so every noise column reads "noise unknown". Nothing here is a trend.
- Rows needing multiple turns or multiple runs are `n/a`: E2 busy/calls, E6 consistency,
  E7 recall. Most pilot journeys are one turn, so these need the full set.
- E4.match and the prose rows are judged, and `judge.mjs` has not been run.
- 20 of 300 journeys, dev only. The holdout stays sealed.
