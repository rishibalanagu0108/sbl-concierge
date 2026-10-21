// Persona loading and validation (shared by run.mjs and the tests). Personas are plain JSON data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "personas");
export const SETS = ["dev", "holdout", "replay", "faults", "journey-dev", "journey-holdout", "journey-pilot"];
const PERSONA_KEYS = ["id", "description", "start", "steps"];
const STEP_KEYS = ["do", "text", "ms", "url", "y", "code", "tags", "expect", "probe"];
const EXPECT_KEYS = ["mustReply", "landsOn", "noNav", "noSignup", "maxLines", "class", "recalls", "noQuestion", "decisionGroup", "decisionPattern", "stop", "honest", "replyWithinMs"];
const DOS = ["say", "wait", "goto", "reload", "scroll", "fault"];
export const FAULT_CODES = ["unavailable", "capped", "down", "slow"]; // server fault injection (ALLOW_FAULTS=1); null clears
const CLASSES = ["inform", "navigate", "do", "chitchat"];
export const TEST_EMAIL = "proof.test@uberip.com";
/** Expect regexes are compiled case-insensitively everywhere. */
export const rx = (s) => new RegExp(s, "i");

export function loadPersonas(set) {
  const dir = path.join(DIR, set);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, set, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

/** Returns a list of problems (empty = valid). */
export function validatePersona(p) {
  const bad = [];
  const unknown = (o, keys, where) => Object.keys(o).filter((k) => !keys.includes(k) && !(where === "persona" && (k === "file" || k === "set"))).forEach((k) => bad.push(`${where}: unknown key ${k}`));
  for (const k of ["id", "description", "start"]) if (typeof p[k] !== "string" || !p[k]) bad.push(`missing ${k}`);
  unknown(p, PERSONA_KEYS, "persona");
  if (!/^https:\/\/(sbl\.so|app\.secondbrainlabs\.com)\//.test(p.start || "")) bad.push("start must be on an SBL origin");
  if (!Array.isArray(p.steps) || !p.steps.length) return [...bad, "no steps"];
  const groups = {};
  p.steps.forEach((s, i) => {
    const w = `step ${i + 1}`;
    unknown(s, STEP_KEYS, w);
    if (!DOS.includes(s.do)) bad.push(`${w}: bad do ${s.do}`);
    if (s.do === "say" && !(typeof s.text === "string" && s.text.trim())) bad.push(`${w}: say needs text`);
    if (s.do === "wait" && !(s.ms > 0)) bad.push(`${w}: wait needs ms`);
    if (s.do === "goto" && !/^https:\/\/sbl\.so\//.test(s.url || "")) bad.push(`${w}: goto needs an https://sbl.so/ url`);
    if (s.do === "scroll" && typeof s.y !== "number") bad.push(`${w}: scroll needs y`);
    if (s.do === "fault" && !(s.code === null || FAULT_CODES.includes(s.code))) bad.push(`${w}: fault needs code ${FAULT_CODES.join("|")} or null`);
    if (!Array.isArray(s.tags)) bad.push(`${w}: tags must be an array`);
    // hard limits: never a password, never a form submit, never a purchase, only the test email
    const text = `${s.text || ""} ${s.url || ""}`;
    // `probe` is a written justification for a step that must contain wording the hard
    // limits otherwise ban, because the step exists to prove the agent REFUSES it (a
    // visitor offering a password in chat, a mistyped email). It exempts the wording and
    // email checks for that one step and nothing else: a probe still may not navigate to
    // signup/login, and the agent-side mechanisms are unaffected. Only `say` steps
    // qualify — the driver must never type banned wording into a page field.
    const probed = typeof s.probe === "string" && s.probe.trim().length > 0;
    if (s.probe !== undefined && !probed) bad.push(`${w}: probe must be a non-empty reason`);
    if (probed && s.do !== "say") bad.push(`${w}: probe only on say`);
    if (!probed && /pass(word|wd)|\bcvv\b|card number|credit card|\bpay\b|\bbuy\b|purchase|checkout|subscribe now/i.test(text)) bad.push(`${w}: hard limit (password/payment/purchase wording)`);
    if (/signup|sign-up|login/i.test(s.url || "")) bad.push(`${w}: goto to signup/login`);
    if (!probed) for (const e of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []) if (e !== TEST_EMAIL) bad.push(`${w}: email other than ${TEST_EMAIL}`);
    const ex = s.expect || {};
    unknown(ex, EXPECT_KEYS, `${w} expect`);
    if (ex.class && !CLASSES.includes(ex.class)) bad.push(`${w}: bad class`);
    if (ex.replyWithinMs !== undefined && !(Number.isInteger(ex.replyWithinMs) && ex.replyWithinMs > 0)) bad.push(`${w}: bad replyWithinMs`);
    if (ex.maxLines !== undefined && !(Number.isInteger(ex.maxLines) && ex.maxLines >= 0)) bad.push(`${w}: bad maxLines`);
    for (const k of ["landsOn", "honest", "decisionPattern"]) if (ex[k] !== undefined) { try { rx(ex[k]); } catch { bad.push(`${w}: ${k} does not compile`); } }
    if (ex.recalls !== undefined) { if (!Array.isArray(ex.recalls)) bad.push(`${w}: recalls must be an array`); else ex.recalls.forEach((r) => { try { rx(r); } catch { bad.push(`${w}: recall does not compile`); } }); }
    if (ex.decisionGroup) {
      try { if (new RegExp(`${ex.decisionPattern}|`).exec("").length !== 2) bad.push(`${w}: decisionPattern needs exactly one capture group`); } catch { bad.push(`${w}: decisionPattern missing/invalid`); }
      (groups[ex.decisionGroup] ||= []).push(ex.decisionPattern);
    }
    if (ex.decisionPattern && !ex.decisionGroup) bad.push(`${w}: decisionPattern without decisionGroup`);
    if (ex.stop && s.do !== "say") bad.push(`${w}: stop only on say`);
  });
  for (const [g, pats] of Object.entries(groups)) if (new Set(pats).size > 1) bad.push(`decisionGroup ${g}: patterns differ`);
  return bad;
}
