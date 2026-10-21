// Does the first-visit welcome fire, and does the harness suppress it?
//   node tools/proof/welcome-probe.mjs
// Loads sbl.so twice: once exactly as tools/experience/driver.mjs does (it clicks the
// launcher on open), and once without that click. Reports the dock lines and the gate
// values after 12s. Read-only; the server must be up.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(REPO, "tools/capture/package.json"))("playwright");
const bundle = fs.readFileSync(path.join(REPO, "sbl-agent.js"), "utf8");
const ROOT = "#sbl-sales-concierge-root";

async function probe({ clickLauncher }) {
  const browser = await chromium.launch({ headless: true, args: ["--headless=new"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["local-network-access"]).catch(() => {});
  await ctx.addInitScript(() => {
    const K = "sbl_store_v1"; if (!sessionStorage.getItem(K)) sessionStorage.setItem(K, JSON.stringify({ sbl_proof: 1 }));
  });
  await ctx.addInitScript(bundle);
  const page = await ctx.newPage();
  const welcomeEvents = [];
  await ctx.exposeBinding("__probeAct", (_s, d) => welcomeEvents.push(d));
  await page.addInitScript(() => {
    addEventListener("sbl-agent-action", (e) => {
      const d = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
      if (/welcome|opener/.test(d)) window.__probeAct?.(d);
    }, true);
  });

  await page.goto("https://sbl.so/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.locator(`${ROOT} .launcher`).first().waitFor({ state: "attached", timeout: 25_000 }).catch(() => {});
  if (clickLauncher) await page.locator(`${ROOT} .launcher`).first().evaluate((el) => el.click()).catch(() => {});

  await page.waitForTimeout(12_000);

  const seen = await page.evaluate((root) => {
    const host = document.querySelector(root);
    const sr = host?.shadowRoot || host;
    const txt = (sel) => [...(sr?.querySelectorAll(sel) || [])].map((n) => n.textContent.trim()).filter(Boolean);
    return {
      dockState: host?.dataset?.state || sr?.querySelector(".dock")?.dataset?.state || null,
      live: host?.dataset?.live ?? null,
      lines: txt(".line, .msg, .message, .bubble").slice(0, 6),
      inviteShown: Boolean(sr?.querySelector(".invite.show")),
      panelOpen: Boolean(sr?.querySelector(".panel.open, .dock.open")),
      msgs: [...(sr?.querySelectorAll(".messages .msg") || [])].map((m) => m.textContent.trim()),
      where: (() => {
        const out = [];
        const walk = (n) => {
          for (const el of n.querySelectorAll("*")) {
            const own = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join(" ");
            if (own.includes("what are you looking to improve")) {
              out.push({ tag: el.tagName.toLowerCase(), cls: el.className?.baseVal ?? el.className ?? "",
                         attrs: [...el.attributes].map((a) => a.name + "=" + a.value).join(" ").slice(0, 120) });
            }
          }
        };
        if (sr) walk(sr);
        return out;
      })(),
    };
  }, ROOT).catch((e) => ({ error: String(e) }));

  await browser.close();
  return { clickLauncher, welcomeEvents, ...seen };
}

for (const clickLauncher of [true, false]) {
  const r = await probe({ clickLauncher });
  console.log(`\n=== launcher clicked: ${clickLauncher} (true = what the suite does) ===`);
  console.log("  live(dataset):", r.live, " dockState:", r.dockState, " panelOpen:", r.panelOpen, " inviteShown:", r.inviteShown);
  console.log("  welcome/opener events:", r.welcomeEvents.length ? r.welcomeEvents : "NONE");
  console.log("  lines:", r.lines?.length ? r.lines : "none");
  console.log("  text:", r.all?.slice(0, 200));
  if (r.error) console.log("  error:", r.error);
}
