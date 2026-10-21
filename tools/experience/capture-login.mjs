// Save an authenticated browser session for the suite to reuse.
//   node tools/experience/capture-login.mjs [--out var/auth-state.json]
//
// Opens a VISIBLE browser on the SBL login page and waits. You sign in yourself; this
// script never reads, types or stores a password. When it sees you land on the app it
// saves the session cookies to a local file and exits.
//
// The file is a live session. var/ is gitignored - keep it there, never commit it, never
// paste it anywhere. Delete it when you are done: rm var/auth-state.json
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const out = path.resolve(arg("out", path.join(REPO, "var/auth-state.json")));
const { chromium } = createRequire(path.join(REPO, "tools/capture/package.json"))("playwright");

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto("https://app.secondbrainlabs.com/", { waitUntil: "domcontentloaded" });

console.log("\nA browser window is open. Sign in there yourself.");
console.log("Waiting for you to reach the app (up to 5 minutes)...\n");

const deadline = Date.now() + 5 * 60_000;
let ok = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(1500);
  const url = page.url();
  if (/app\.secondbrainlabs\.com\/(campaigns|leads|signals|chat|analytics|settings|users)/.test(url)) { ok = true; break; }
}

if (!ok) {
  console.error("Did not reach a signed-in page in time. Nothing saved.");
  await browser.close();
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
await ctx.storageState({ path: out });
const n = JSON.parse(fs.readFileSync(out, "utf8")).cookies?.length ?? 0;
console.log(`Saved a session with ${n} cookies to ${out}`);
console.log("This is a live session. It is gitignored. Delete it when you are done.");
await browser.close();
