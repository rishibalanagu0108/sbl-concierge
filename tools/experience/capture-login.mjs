// Sign in once into a browser profile the suite reuses.
//   node tools/experience/capture-login.mjs            # opens the profile to sign in
//   node tools/experience/capture-login.mjs --check     # reports whether it is still signed in
//
// Opens a VISIBLE browser on a dedicated profile directory and waits while you sign in.
// This script never reads, types or stores a password - it only keeps the browser profile
// the login leaves behind.
//
// Why a profile rather than a saved cookie file: the app keeps its credential in web
// storage, which playwright's storageState does not fully capture (it never saves
// sessionStorage). A persistent profile keeps cookies and storage together, which is what
// actually signs you in.
//
// The profile is a live session. .browser-profile/ is gitignored. Delete it when you are
// done: rm -rf .browser-profile/suite
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PROFILE_DIR = path.join(REPO, ".browser-profile/suite");
const { chromium } = createRequire(path.join(REPO, "tools/capture/package.json"))("playwright");

const check = process.argv.includes("--check");
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: check,
  viewport: { width: 1440, height: 900 },
  args: check ? ["--headless=new"] : [],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const signedIn = async () => {
  await page.goto("https://app.secondbrainlabs.com/campaigns", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(6000);
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  return !/\/login|unauthorized|sign in to/i.test(page.url() + " " + text.slice(0, 400));
};

if (check) {
  const ok = await signedIn();
  console.log(ok ? "SIGNED IN - the suite can run the dashboard journeys." : "SIGNED OUT - run this without --check and sign in.");
  await ctx.close();
  process.exit(ok ? 0 : 1);
}

if (await signedIn()) {
  console.log("Already signed in. Nothing to do.");
  await ctx.close();
  process.exit(0);
}

console.log("\nA browser window is open on the SBL login page. Sign in THERE.");
console.log("That window is the one the tests will use, so being signed in elsewhere does not count.");
console.log("Waiting up to 5 minutes...\n");

const deadline = Date.now() + 5 * 60_000;
let ok = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  const url = page.url();
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  if (/app\.secondbrainlabs\.com\/(campaigns|leads|signals|chat|analytics|settings|users)/.test(url)
      && !/unauthorized|sign in to/i.test(text.slice(0, 400))) { ok = true; break; }
}

console.log(ok
  ? `Signed in. The profile is kept at ${PROFILE_DIR}\nRun the suite with SBL_PROFILE=1, or just tell Claude it is done.`
  : "No signed-in dashboard appeared, so nothing was kept.");
await ctx.close();
process.exit(ok ? 0 : 1);
