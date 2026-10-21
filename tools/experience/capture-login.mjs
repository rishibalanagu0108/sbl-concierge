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
console.log("This browser is EMPTY - being signed in elsewhere in Chrome does not count.");
console.log("Waiting for real credentials (up to 5 minutes)...\n");

// A URL match is not proof: the app can show a public shell before auth lands. Wait for an
// actual credential - a cookie on the SBL domain, or a token in the app origin's storage.
const credentialed = async () => {
  const cookies = await ctx.cookies();
  if (cookies.some((c) => /secondbrainlabs/.test(c.domain))) return "cookie";
  const st = await ctx.storageState();
  const origin = (st.origins || []).find((o) => /secondbrainlabs/.test(o.origin || ""));
  if (origin && (origin.localStorage || []).some((i) => /token|auth|session|jwt|supabase|sb-/i.test(i.name))) return "storage";
  return null;
};

const deadline = Date.now() + 5 * 60_000;
let how = null;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  try { how = await credentialed(); } catch { /* page navigating */ }
  if (how) break;
}

if (!how) {
  console.error("No SBL credential appeared, so nothing was saved.");
  console.error("Make sure you completed sign-in IN THAT WINDOW and reached the dashboard.");
  await browser.close();
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
await ctx.storageState({ path: out });
const saved = JSON.parse(fs.readFileSync(out, "utf8"));
const sbl = (saved.cookies || []).filter((c) => /secondbrainlabs/.test(c.domain)).length;
const origins = (saved.origins || []).filter((o) => /secondbrainlabs/.test(o.origin || "")).length;
console.log(`Saved to ${out}`);
console.log(`  credential found via: ${how}`);
console.log(`  SBL cookies: ${sbl}   SBL storage origins: ${origins}`);
console.log("This is a live session. It is gitignored. Delete it when you are done.");
await browser.close();
