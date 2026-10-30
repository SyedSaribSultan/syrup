#!/usr/bin/env node
// Verify an app's vendored sarib-design copy. Run from the app's test script:
//   node <path>/sarib-design/scripts/check.mjs [app-dir]
// Copy this file into the app (e.g. scripts/sarib-check.mjs) if the sibling repo is not
// available in CI; it has no dependencies and reads only the app.
//
// Fails (exit 1) on:
//   1. integrity: a vendored file is missing or its sha256 differs from sarib-design.lock.json
//   2. restyling: app CSS defines a .s-* selector, a --s-* custom property, or .btn
//      (allowed only via sarib.allow.json entries that carry a written reason)
//   4. motion (v2.8, DESIGN.md §5 "Which motion for what"): app source (CSS, JS/TS, HTML, Dart) uses the
//      entrance (overshoot) curve or another overshooting curve: --s-motion-easing-entrance,
//      --s-motion-expressive-easing, --s-motion-spring-expressive, a cubic-bezier() whose y leaves 0..1,
//      SMotion.entrance / .expressiveCurve, Curves.*Back / elastic* / bounce*. Overshoot is reserved for
//      expressive arrivals (icon spin, quote pill); an app's own one needs a sarib.allow.json entry
//      { file, pattern, reason } whose pattern appears in the reported rule or line.
// Warns on:
//   3. freshness: the lock is older than the sibling sarib-design VERSION (if present)
//   5. motion: a literal duration or delay (150ms, .18s) in an app CSS transition / animation, or a
//      motion-named custom property (--motion-*, --ease-*, --*-duration) set to one. Use the
//      --s-motion-<pattern> tokens. 0s / 0ms are fine.
//   6. fonts: a fonts.googleapis.com / fonts.gstatic.com reference in app source. Load the vendored
//      fonts.css instead (fonts.md (c)).
// The motion and font rules honour sarib.allow.json entries the same way.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const LOCK = "sarib-design.lock.json";
const ALLOW = "sarib.allow.json";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".vercel", ".dart_tool", "coverage", "out", "vendor", "screenshots", "shots"]);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walk(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) walk(path.join(dir, d.name), out); }
    else out.push(path.join(dir, d.name));
  }
  return out;
}
/** App source for the motion and font rules: git's tracked + untracked-not-ignored files when the app dir is a
 *  repo root (skips build copies such as Slides' ignored public/), else the plain walk. */
function sourceFiles(app) {
  try {
    const git = (cmd) => execSync(cmd, { cwd: app, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).toString();
    if (path.resolve(git("git rev-parse --show-toplevel").trim()) !== path.resolve(app)) throw new Error("not the repo root");
    return git("git ls-files -co --exclude-standard").split("\n").filter(Boolean)
      .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg))).map((f) => path.join(app, f));
  } catch { return walk(app); }
}
const blankComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")); // keeps line numbers
const lineOf = (t, i) => t.slice(0, i).split("\n").length;
/** The selector of the CSS rule that position i sits in. */
function selectorAt(css, i) {
  const open = css.lastIndexOf("{", i);
  if (open < 0) return "";
  const start = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("{", open - 1), css.lastIndexOf(";", open)) + 1;
  return css.slice(start, open).trim().replace(/\s+/g, " ");
}
/** cubic-bezier(x1, y1, x2, y2) overshoots when a y leaves 0..1. */
const overshoots = (args) => {
  const n = args.split(",").map((x) => Number(x.trim()));
  return n.length === 4 && n.every((x) => !Number.isNaN(x)) && [n[1], n[3]].some((y) => y < 0 || y > 1);
};
const OVERSHOOT_TOKENS = /--s-motion-easing-entrance\b|--s-motion-expressive-easing\b|--s-motion-spring-expressive\b/g;
const DART_OVERSHOOT = /\bSMotion\.(?:entrance|expressiveCurve)\b|\bCurves\.(?:\w*Back|elastic\w*|bounce\w*)\b/g;
const SOURCE_RE = /\.(css|scss|js|mjs|cjs|jsx|ts|tsx|html|dart)$/;
const MOTION_DECL = /(?:^|[;{\s])((?:transition|animation)(?:-duration|-delay)?|--[\w-]*(?:motion|ease|easing|duration)[\w-]*)\s*:\s*([^;{}]+)/g;

const cmpVer =(a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

export function check(appDir = ".") {
  const app = path.resolve(appDir);
  const errors = [], warnings = [];
  const lockPath = path.join(app, LOCK);
  if (!fs.existsSync(lockPath)) return { errors: [`no ${LOCK} in ${app} (run sarib-design/scripts/sync.mjs)`], warnings };
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

  // 1. integrity
  for (const [rel, want] of Object.entries(lock.files)) {
    const p = path.join(app, rel);
    if (!fs.existsSync(p)) { errors.push(`missing vendored file: ${rel}`); continue; }
    const got = sha(fs.readFileSync(p));
    if (got !== want) errors.push(`drift: ${rel} was edited (sha256 ${got.slice(0, 12)} ≠ lock ${want.slice(0, 12)}). Change sarib-design instead, then sync.`);
  }

  // 2. restyling s- classes outside the vendor dirs
  const allow = fs.existsSync(path.join(app, ALLOW)) ? JSON.parse(fs.readFileSync(path.join(app, ALLOW), "utf8")).entries || [] : [];
  for (const a of allow) if (!a.reason || a.reason.trim().length < 12) errors.push(`${ALLOW}: entry for ${a.file} needs a written functional reason`);
  const managed = [lock.target, lock.flutter].filter(Boolean).map((d) => path.join(app, d));
  const cssFiles = walk(app).filter((f) => /\.(css|scss)$/.test(f) && !managed.some((m) => f.startsWith(m + path.sep)));
  const rules = [
    [/(^|[\s,>+~}(])\.s-[\w-]+[^{};]*\{/m, "defines an .s-* selector (restyles a shared component)"],
    [/(^|[;{\s])--s-[\w-]+\s*:/m, "redefines a --s-* token"],
    [/(^|[\s,>+~}(])\.btn(?![\w-])[^{};]*\{/m, "defines .btn (use .s-btn)"],
  ];
  for (const f of cssFiles) {
    const rel = path.relative(app, f).split(path.sep).join("/");
    const css = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [re, msg] of rules) {
      const m = re.exec(css);
      if (!m) continue;
      if (allow.some((a) => a.file === rel && (!a.pattern || m[0].includes(a.pattern)))) continue;
      const line = css.slice(0, m.index).split("\n").length;
      errors.push(`${rel}:${line} ${msg}: ${m[0].trim().slice(0, 60)}`);
    }
  }

  // 4–6. motion and fonts in the app's own source (vendored dirs excluded)
  const allowed = (rel, ctx) => allow.some((a) => a.file === rel && a.reason && (!a.pattern || ctx.includes(a.pattern)));
  const motionMsg = "overshoot curve outside an expressive arrival (DESIGN.md §5: drawers, panels, menus, popovers, dialogs, sheets and toasts use their --s-motion-<pattern> token)";
  for (const f of sourceFiles(app)) {
    if (!SOURCE_RE.test(f) || managed.some((m) => f.startsWith(m + path.sep)) || !fs.existsSync(f)) continue;
    const rel = path.relative(app, f).split(path.sep).join("/");
    const raw = fs.readFileSync(f, "utf8");
    if (/\.mjs$/.test(f) && raw.slice(0, 300).includes("Verify an app's vendored sarib-design copy")) continue; // a copy of this file
    const isCss = /\.s?css$/.test(f);
    const text = isCss ? blankComments(raw) : raw;
    const lines = raw.split("\n");
    const seen = new Set();
    const report = (i, list, msg) => {
      const line = lineOf(text, i);
      const sel = isCss ? selectorAt(text, i) : "";
      const src = lines[line - 1].trim();
      if (allowed(rel, `${sel} ${src}`) || seen.has(`${line} ${msg}`)) return;
      seen.add(`${line} ${msg}`);
      list.push(`${rel}:${line} ${msg}: ${(sel || src).slice(0, 70)}`);
    };
    for (const m of text.matchAll(OVERSHOOT_TOKENS)) report(m.index, errors, motionMsg);
    for (const m of text.matchAll(/cubic-bezier\(([^)]*)\)/g)) if (overshoots(m[1])) report(m.index, errors, motionMsg);
    if (f.endsWith(".dart")) for (const m of text.matchAll(DART_OVERSHOOT)) report(m.index, errors, motionMsg);
    if (isCss) {
      for (const m of text.matchAll(MOTION_DECL)) {
        if (/\binfinite\b/.test(m[2])) continue; // a loop's period is a rhythm, not a pattern (spinner, pulse, dots)
        const value = m[2].replace(/var\((?:[^()]|\([^()]*\))*\)/g, "");
        const lit = (value.match(/(?<![\w.-])\d*\.?\d+m?s\b/g) || []).filter((v) => parseFloat(v) !== 0);
        if (lit.length) report(m.index + m[0].indexOf(m[1]), warnings, `literal timing ${lit.join(", ")} (use a --s-motion-<pattern> token)`);
      }
    }
    for (const m of text.matchAll(/fonts\.(?:googleapis|gstatic)\.com/g)) report(m.index, warnings, "loads Google Fonts (use the vendored fonts.css, fonts.md (c))");
  }

  // 3. freshness
  const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "VERSION");
  if (fs.existsSync(sibling)) {
    const latest = fs.readFileSync(sibling, "utf8").trim();
    if (cmpVer(lock.version, latest) < 0) warnings.push(`vendored v${lock.version} is older than sarib-design v${latest} (run propagate)`);
  }
  return { errors, warnings, lock };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDir = process.argv[2] || ".";
  const { errors, warnings, lock } = check(appDir);
  for (const w of warnings) console.warn(`  ! ${w}`);
  if (errors.length) {
    console.error(errors.map((e) => `  ✗ ${e}`).join("\n"));
    console.error(`sarib-design check failed: ${errors.length} problem(s).`);
    process.exit(1);
  }
  console.log(`sarib-design check ok: v${lock.version}, ${Object.keys(lock.files).length} files match the lock, no restyled s- classes.`);
}
