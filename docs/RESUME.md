# Resume here

Written 2026-10-21. This is the first file to read in a new session. It exists because a
new session starts with no memory of the last one — only what is on disk.

## Where things stand

Branch `fix/userscript-navigation`, pushed to the fork
`github.com/rishibalanagu0108/sbl-concierge` (upstream access is READ-only, so `origin`
is fetch-only and `fork` is the push remote). 387/387 unit tests pass.

Work is driven by Ayush's call on 2026-10-20, not by `.genesis/KICKOFF.md`, which is
stale — it still names `T71-dashboard-suite`.

## Read in this order

1. `docs/PLAN.md` — the implementation plan. The governing principle and the six phases.
2. `docs/JOURNEYS.md` — what a journey is, the six axes, the twelve never-rules.
3. `docs/journeys/*.yaml` — the 300 journeys. The source of truth.
4. `docs/STATUS-2026-10-16.md` §5 — the three documented memory defects.

## The one rule that governs everything

**The journeys are the test set. Nothing in the agent may reference a journey.**

Encoding cases passes the suite and fails real visitors. Every failure is fixed one level
above where it appeared, so the fix also covers journeys nobody wrote. `docs/PLAN.md` §2
has the worked examples.

## How journeys become runnable

The runner already existed (`tools/experience/`). Journeys are converted into personas it
can execute:

    python3 tools/experience/from-journeys.py          # report only
    python3 tools/experience/from-journeys.py --write  # regenerate the personas

Generated into `tools/experience/personas/journey-dev` (223) and `journey-holdout` (56).
**Never hand-edit those files** — edit the YAML and regenerate.

Honest numbers from the conversion:

- 279 of 300 convert; 21 are blocked, listed with reasons in
  `tools/experience/personas/journey-dev/BLOCKED.md`. Eight need a real campaign record
  (the entry path has a `{id}` placeholder); the rest need driver features that do not
  exist yet (browser back, second tab, file upload, viewport control, barge-in).
- Only 12 of 684 `expect` lines are deterministic machine checks. The other 627 are prose
  and go to `judge.mjs`. This is not a defect in the journeys — it is why the twelve
  never-rules must become suite-wide code invariants in P1 rather than per-journey
  expectations. Checking them in code moves the safety-critical assertions off the judge.

`probe:` on a journey is a written justification for a step containing wording the
validator otherwise bans (a visitor offering a password, a mistyped email), because the
step exists to prove the agent *refuses*. It exempts that one `say` step's wording and
email checks and nothing else. Four journeys use it: J-077, J-094, J-162, J-163.

## The holdout

56 journeys in `journey-holdout`, chosen deterministically and stratified by slice.
`tools/experience/personas/journey-holdout/SEALED.md` lists them.

Do not read, run or edit them during behaviour work. They are opened once, at the P4 gate.
A holdout that has been looked at is training data in disguise, and recovering costs a
fresh holdout plus the weeks of measurement that depended on the old one.

## Running the suite (costs real money — confirm a budget first)

The runner spends model credits and needs the server up:

    node tools/build-agent.mjs
    node server.mjs                      # 127.0.0.1:8787, loopback only
    node tools/experience/run.mjs --set journey-dev --runs 1 --concurrency 2

`--set all` deliberately excludes faults. Faults need `ALLOW_FAULTS=1` on the server.
Scoring is `score.mjs`, prose rows are `judge.mjs`, gates are `gate.mjs`.

## Next step

P0 is not finished: the personas exist and validate, but **no baseline run has happened**,
so there is still no before-number. That run is the next thing, once the budget is agreed.

## Standing constraints

- Only the maintainer-approved CX-TEST workspace for live writes. Workspace 706 access must
  be verified before any dashboard writes; 126 is out of scope.
- Stop before real signup submission, payment, hiring, launch or outbound sending.
  Passwords stay human-entered through the masked field. Consequential actions need the
  visitor's own visible confirmation. Do not weaken these to make a demo pass.
- Never commit, upload, screenshot or forward the `.env` or any key.
- Open questions for Ayush are listed in `docs/PLAN.md` §8. The autonomous-signup one
  blocks `04-signup-trial.yaml`, which is currently written the safe way.
