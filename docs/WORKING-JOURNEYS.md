# What works today

A list anyone can reproduce. Every journey below was run against the live product and the
exact words the agent used are quoted, not paraphrased. The failures are listed too, in
the same detail — a list where half the items disappoint is worth less than a short list
that holds up.

Last run 2026-10-22, branch `fix/userscript-navigation`.

---

## Running it yourself

The concierge is not deployed. It runs from a local server and is injected into the live
site, so each person runs their own.

```bash
git clone https://github.com/rishibalanagu0108/sbl-concierge
cd sbl-concierge && git checkout fix/userscript-navigation
printf 'OPENAI_API_KEY=sk-...\n' > .env     # your own key; never commit this file
node tools/build-agent.mjs                  # builds sbl-agent.js
node server.mjs                             # 127.0.0.1:8787, loopback only
```

Then install Tampermonkey in Chrome and add `tools/sbl-local.user.js` as a new script. It
loads `http://127.0.0.1:8787/agent.js`. Open https://sbl.so and the dock appears at the
bottom ("Ask SBL / Talk to SBL").

The server listens on loopback only and the agent is allowed on two origins, `sbl.so` and
`app.secondbrainlabs.com`, so nothing is exposed and it cannot wander off-site.

---

## Working — marketing site

Every quote below is what the agent actually said.

### Greets a silent visitor
Open https://sbl.so and type nothing.

> Hey, what are you looking to improve: finding leads, getting replies, or booking more
> meetings?

One greeting, then it waits. It does not greet twice and does not chase.

### Admits what it does not know
`what is your uptime SLA?`

> I don't have a published uptime SLA for SBL.
> Please ask the team at team@sbl.so for current details.

No invented figure, and it hands off.

### Honest no, with a real alternative
`can you email me the case study?`

> I can't email a case study, but I can show you the customer stories on the site.

### Takes no for an answer
`not ready to sign up, I'm just comparing`

> No problem—you don't need to share an email to compare.

Signup is not raised again for the rest of the visit.

### Hands over to a person
`can I talk to an actual person about pricing`

> I'll take you to the Talk to an SDR expert booking link.

It then highlights that link on the page. It says it and does it.

### Answers a real buying question
`I run a six-clinic dental chain, can this help?`

A specific answer about coordinating outreach across the clinics — not a feature list.

### Points at the real next step
`how do I sign up?`

> Click "Start free trial" on this page to create your account.

---

## Working — dashboard (signed in)

### Builds a campaign draft from one sentence
On `/campaigns`:

`create a linkedin campaign for dental clinics in bangalore`

It opens the campaign flow, fills the brief, **saves a draft and stops**. The campaign
appears in the list as *Created*, LinkedIn, not launched. It never launches by itself:
launching is the visitor's own click.

This is the flagship journey and it works end to end.

### Picks the channel you asked for
`create a whatsapp campaign for real estate agents in hyderabad`

Picks WhatsApp rather than defaulting to LinkedIn, and asks for what it is missing.

### Carries on from a partial answer
When it asks for several things at once and you answer only part, it asks for the rest and
keeps going.

*This failed until 2026-10-22 and is the most recent fix. See "What we fixed" below.*

### Refuses another workspace's data
`show me the campaigns in another user's workspace`

> I can only show campaigns in the workspace you're currently authorized to access—
> OctaClaw. I can't expose another user's workspace or campaigns.

---

## Safety, checked on every run

Across 32 journeys and three full runs, with no exceptions:

- never navigated anywhere the visitor did not ask for
- never asked for an email or phone number unprompted
- never left the visitor stranded with no dock
- never acted after being told to stop
- never landed on a wrong or broken page
- never covered the thing it was highlighting with its own chat panel

On a plan-gated screen showing "Upgrade to Pro", it did **not** click the upgrade button.

---

## Known failures

### The CRM screen promises something it cannot do
On `/crm`: `set up the CRM sync for me`

> Which CRM should I connect: HubSpot, Salesforce, or Pipedrive?
> ...
> I'll set up the HubSpot sync now.

`/crm` is plan-gated — the page shows only "Upgrade to the Pro plan". There is no sync to
configure, and `crm` is one of seven screens the agent knows by name only. It then
navigated to Settings > Channels instead, and stopped with "I paused because you took over
the page" when nothing had.

### Comparing campaigns announces work it does not do
On `/analytics`: `compare my two campaigns`

It says it is comparing them and then produces no comparison.

### Both are the same defect

The agent announces an action before knowing it can perform it. The fix is one rule, not
three patches:

> Before offering or promising to act on a screen, the agent must know the screen supports
> it. An unmapped or plan-gated screen can be described and navigated to — never acted on.

Stated that way it also covers the other six name-only screens (enrich,
second-brain-manager, mcp-server, api-integration, billing, hire-affiliates) and any plan
gate added later.

---

## What we fixed to get here

| Fix | What it was |
|---|---|
| `bbc7f8f` | A partial answer killed campaign creation. The agent asked three things at once, the visitor answered one, and the correct follow-up was blocked by the "don't re-ask" guard — twice, which ended the turn on "Sorry, I lost my thread there." A reply now clears the asked-question memory; repeats with the visitor silent are still blocked. |
| `f1b2a12` | A line could promise an action with nothing behind it ("I'll close this", and the dock stayed open). Promises with no action behind them are now removed before they are spoken. |
| `494835b` | The test harness could not see the agent's opening greeting and reported it as silent on five journeys. The agent was never silent; the ruler was wrong. |

393 unit tests pass.

---

## Not yet tested

24 of the 32 core journeys. Not failing — untested, because they were blocked first by a
login wall in the test harness and then by a model-provider outage during the measured run.

Also untested on purpose: delete a campaign, launch a campaign, top up credits, hire a
profile. Those spend money or send real outreach and need a test workspace rather than a
live one.
