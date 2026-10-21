#!/usr/bin/env python3
"""Turn docs/journeys/*.yaml into personas the existing runner can execute.

    python3 tools/experience/from-journeys.py [--write]

Without --write it reports only. The journeys stay the source of truth; the
personas under personas/journey-* are generated and should never be hand-edited.

Needs pyyaml. The repo has no node dependencies and this keeps it that way.

Three things this does NOT do, on purpose:
  - It does not invent machine checks from prose. Only a short list of
    unambiguous phrasings becomes an `expect` key; everything else is left for
    judge.mjs, which already grades prose. Silently guessing would inflate the
    pass rate with checks that do not check anything.
  - It does not drop journeys the driver cannot perform. They are reported as
    blocked, with the reason, so the gap stays visible.
  - It does not touch the hand-written personas in personas/dev etc.
"""
import argparse, glob, hashlib, json, os, re, shutil, sys

try:
    import yaml
except ImportError:
    sys.exit("needs pyyaml: pip install pyyaml")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
JOURNEYS = os.path.join(ROOT, "docs", "journeys")
PERSONAS = os.path.join(ROOT, "tools", "experience", "personas")
HOLDOUT_FRACTION = 0.20

# Dashboard paths live on the app origin; everything else is the marketing site.
APP_PREFIXES = ("/campaigns", "/leads", "/signals", "/chat", "/users", "/billing",
                "/analytics", "/workflows", "/settings", "/second-brain-manager",
                "/enrich", "/crm", "/mcp-server", "/api-integration", "/hire-affiliates")

def origin_for(entry):
    return "https://app.secondbrainlabs.com" if entry.startswith(APP_PREFIXES) else "https://sbl.so"

def start_url(entry):
    # {id} placeholders cannot be visited; the caller treats these as blocked.
    return origin_for(entry) + (entry if entry.startswith("/") else "/" + entry)

# ---- stage directions -----------------------------------------------------
# A direction the driver cannot perform is blocked rather than approximated.
UNSUPPORTED = {
    "browser back":        "driver has no back step",
    "second tab":          "driver is single-tab",
    "uploads a csv":       "driver has no file upload",
    "captcha":             "never solved, by policy",
    "mobile viewport":     "driver has no viewport control",
    "assistive tech":      "driver has no AT emulation",
    "denies permission":   "driver cannot deny a browser permission",
    "interrupts":          "driver has no barge-in",
    "two natural pauses":  "driver has no partial-utterance timing",
    "clicks a different link": "driver has no arbitrary link click",
    "stale sbl.so task in store": "needs store seeding, not a step",
    "clicks talk":         "voice entry, not a text step",
}

SECONDS = re.compile(r"(\d+)\s*s\b")

def direction_to_step(text):
    """(step, None) or (None, reason-it-is-blocked)."""
    t = text.strip("() ").lower()
    for needle, why in UNSUPPORTED.items():
        if needle in t:
            return None, why
    if "scroll" in t:
        return {"do": "scroll", "y": 900}, None
    if "reload" in t:
        return {"do": "reload"}, None
    m = re.search(r"navigates back to (/\S+)", t)
    if m:
        return {"do": "goto", "url": "https://sbl.so" + m.group(1)}, None
    # Everything left is the visitor being present and quiet: lands, reads,
    # silent, says nothing, sits, ignores, bounces, submits-and-waits.
    secs = SECONDS.search(t)
    return {"do": "wait", "ms": (int(secs.group(1)) if secs else 15) * 1000}, None

# ---- expectations ---------------------------------------------------------
# Deliberately short. Each entry must be unambiguous in plain English, because a
# wrong mapping here is worse than no mapping: it turns a real check into a
# check that always passes.
def expect_from(prose, is_last):
    t = prose.lower()
    ex = {}
    # Safety negatives: the ones worth checking deterministically rather than
    # asking a model whether they held.
    if re.search(r"signup", t) and re.search(r"\bno\b|never|without|does not|doesn't|not raised", t):
        ex["noSignup"] = True
    if re.search(r"\bno (navigation|nav|page move)\b|does not (navigate|move|leave)|stays (on|put)|without (navigating|moving)", t):
        ex["noNav"] = True
    if re.search(r"\bno question\b|does not ask|asks nothing|without asking", t):
        ex["noQuestion"] = True
    if re.search(r"\bone[- ]line\b|\bsingle line\b|\bone sentence\b", t):
        ex["maxLines"] = 1
    m = re.search(r"under (\d+) sentences?|at most (\d+) lines?|(\d+) sentences? max", t)
    if m:
        ex["maxLines"] = int(next(g for g in m.groups() if g))
    m = re.search(r"(?:lands on|navigates to|walks to|moves to|opens|goes to) (/[\w/-]+)", t)
    if m:
        ex["landsOn"] = m.group(1).lstrip("/")
    elif re.search(r"(?:lands on|navigates to|walks to|moves to|opens|goes to) the (case[- ]study|pricing|blog|questions) page", t):
        ex["landsOn"] = re.search(r"the (case[- ]study|pricing|blog|questions) page", t).group(1).replace(" ", "-")
    return ex

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    personas, blocked, judge_rows, machine_checks = [], [], 0, 0

    for path in sorted(glob.glob(os.path.join(JOURNEYS, "*.yaml"))):
        doc = yaml.safe_load(open(path))
        slice_name = doc["slice"]
        for j in doc["journeys"]:
            jid, entry = j["id"], j["entry"]
            if "{" in entry:
                blocked.append((jid, slice_name, "entry has a {placeholder}; needs a real record"))
                continue

            steps, reason = [], None
            for raw in j.get("script") or []:
                text = raw.get("visitor")
                if not isinstance(text, str):
                    reason = "script step is not a visitor line"
                    break
                if text.strip().startswith("("):
                    step, why = direction_to_step(text)
                    if why:
                        reason = why
                        break
                else:
                    step = {"do": "say", "text": text}
                    if j.get("probe"):
                        step["probe"] = j["probe"]
                step["tags"] = [jid]
                step["expect"] = {}
                steps.append(step)

            if reason:
                blocked.append((jid, slice_name, reason))
                continue
            if not steps:
                blocked.append((jid, slice_name, "no runnable steps"))
                continue

            # Journey-level expectations attach to the final step: they describe
            # how the visit ended, not any one turn.
            last = steps[-1]
            for line in j.get("expect") or []:
                got = expect_from(line, True)
                if got:
                    last["expect"].update(got)
                    machine_checks += 1
                else:
                    judge_rows += 1

            v = j.get("visitor") or {}
            personas.append({
                "slice": slice_name,
                "persona": {
                    "id": jid,
                    "description": "%s [%s/%s/%s] intent=%s outcome=%s" % (
                        j["title"], v.get("state", "?"), v.get("openness", "?"),
                        v.get("industry", "?"), j.get("intent", "?"), j.get("outcome", "?")),
                    "start": start_url(entry),
                    "steps": steps,
                },
            })

    # Holdout: deterministic, stratified per slice, so it is reproducible and
    # does not drift when journeys are added.
    by_slice = {}
    for p in personas:
        by_slice.setdefault(p["slice"], []).append(p)
    holdout = set()
    for name, group in by_slice.items():
        ranked = sorted(group, key=lambda p: hashlib.sha256(
            (name + p["persona"]["id"]).encode()).hexdigest())
        for p in ranked[:round(len(group) * HOLDOUT_FRACTION)]:
            holdout.add(p["persona"]["id"])

    print("journeys converted : %d" % len(personas))
    print("blocked            : %d" % len(blocked))
    print("  holdout          : %d" % len(holdout))
    print("  dev              : %d" % (len(personas) - len(holdout)))
    print("expect lines -> machine checks : %d" % machine_checks)
    print("expect lines -> judge          : %d" % judge_rows)
    if blocked:
        print("\nblocked journeys:")
        why = {}
        for jid, sl, reason in blocked:
            why.setdefault(reason, []).append(jid)
        for reason, ids in sorted(why.items(), key=lambda kv: -len(kv[1])):
            print("  %2d  %-45s %s" % (len(ids), reason, " ".join(ids)))

    if not args.write:
        print("\n(report only; pass --write to emit personas)")
        return

    for setname in ("journey-dev", "journey-holdout"):
        d = os.path.join(PERSONAS, setname)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
    for p in personas:
        setname = "journey-holdout" if p["persona"]["id"] in holdout else "journey-dev"
        with open(os.path.join(PERSONAS, setname, p["persona"]["id"] + ".json"), "w") as f:
            json.dump(p["persona"], f, indent=1)
            f.write("\n")
    with open(os.path.join(PERSONAS, "journey-holdout", "SEALED.md"), "w") as f:
        f.write("# Sealed\n\nThese %d journeys are the holdout. Do not read them, run them or "
                "edit them during behaviour work. Opened once, at the gate.\n\nA holdout that "
                "has been looked at is training data in disguise.\n\n%s\n"
                % (len(holdout), "\n".join("- " + i for i in sorted(holdout))))
    with open(os.path.join(PERSONAS, "journey-dev", "BLOCKED.md"), "w") as f:
        f.write("# Blocked journeys\n\nGenerated by tools/experience/from-journeys.py. These "
                "journeys are real but the driver cannot perform them yet.\n\n")
        for jid, sl, reason in sorted(blocked):
            f.write("- `%s` (%s) — %s\n" % (jid, sl, reason))
    print("\nwrote personas to %s/journey-{dev,holdout}" % PERSONAS)

if __name__ == "__main__":
    main()
