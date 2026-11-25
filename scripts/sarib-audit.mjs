#!/usr/bin/env node
// App-layer design audit. Measures how faithfully an app applies its design system.
// A token kit can be strict while the app that consumes it is loose. This script measures the app.
//
//   node audit-app.mjs <app-root> [--src src] [--ignore dir] [--wrappers src/components/ui]
//                      [--kit-prefix s-] [--allow file] [--baseline file] [--update-baseline]
//                      [--json | --quiet | --all]
//
// --ignore    vendored design-system folders (repeatable). Never audited.
// --wrappers  folders allowed to use raw <button>, <input>, <dialog> (repeatable). They are the wrappers.
// --kit-prefix class prefix of the design system. A raw element that carries a kit class is correct use.
// --allow     defaults to <app>/sarib.allow.json. This audit reads its top-level "audit" list:
//             [{ "file", "rule", "pattern"?, "reason" }], reason of 12+ characters. check.mjs reads
//             "entries" and ignores "audit", so an audit exception never loosens the check.
// --baseline  a ratchet file. Exit 1 only when a count rises above the recorded one.
//
// Zero dependencies. Reads files only.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const many = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const one = (flag, fallback) => many(flag)[0] ?? fallback;
const norm = (p) => p.split(path.sep).join("/");
const srcDir = one("--src", "src");
const wrappers = many("--wrappers").map(norm);
// In an app that vendors sarib-design, the lock file names the vendor folder. Use it as the defaults.
const lockPath = path.join(root, "sarib-design.lock.json");
const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : null;
const ignore = [...many("--ignore"), ...(lock ? [lock.target, lock.flutter].filter(Boolean) : [])].map(norm);

const kitPrefix = one("--kit-prefix", lock ? "s-" : undefined);
const kitClass = kitPrefix ? new RegExp(`(?<![\\w-])${kitPrefix}[a-z]`) : null;
const allowPath = one("--allow", path.join(root, "sarib.allow.json"));
const allow = allowPath && fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, "utf8")).audit ?? [] : [];
for (const a of allow)
  if (!a.reason || a.reason.length < 12) {
    console.error(`Allow entry for ${a.file} needs a reason of 12+ characters.`);
    process.exit(2);
  }
const allowed = (rule, file, detail) =>
  allow.some((a) => a.rule === rule && (file === a.file || file.startsWith(`${a.file}/`)) && (!a.pattern || detail.includes(a.pattern)));

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".git", "coverage"]);
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = norm(path.relative(root, abs));
    if (ignore.some((i) => rel === i || rel.startsWith(`${i}/`))) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(abs, out);
    } else if (/\.(tsx|jsx|ts|js|mjs|css)$/.test(e.name)) out.push({ abs, rel });
  }
  return out;
}

const files = walk(path.join(root, srcDir));
const code = files.filter((f) => !f.rel.endsWith(".css"));
const css = files.filter((f) => f.rel.endsWith(".css"));

// Theme keys the app defines. A utility whose key is missing here falls back to the framework default,
// which means the value does not come from the design system.
const defined = { radius: new Set(), shadow: new Set(), container: new Set() };
for (const f of css) {
  const text = fs.readFileSync(f.abs, "utf8");
  for (const m of text.matchAll(/--(radius|shadow|container)-([a-z0-9]+)\s*:/g)) defined[m[1]].add(m[2]);
}

const STATIC = { radius: new Set(["none", "full"]), shadow: new Set(["none"]) };
const SIDES = "t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee";
const RE = {
  radius: new RegExp(`^rounded(?:-(?:${SIDES}))?(?:-([a-z0-9]+))?$`),
  shadow: /^shadow(?:-([a-z0-9]+))?$/,
  spacing: /^-?(?:p[xytblrse]?|m[xytblrse]?|gap(?:-[xy])?|space-[xy])-(\d+(?:\.\d+)?|px)$/,
  maxW: /^max-w-(.+)$/,
  arbitrary: /^(-?[a-z][a-z0-9-]*?)-\[(.+)\]$/,
};

function strings(text) {
  // String and template literal bodies. Class names live in these.
  const out = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g))
    out.push({ body: m[1] ?? m[2] ?? m[3] ?? "", index: m.index });
  return out;
}
function utility(token) {
  // Strip variants ("hover:", "medium:", "[&>*]:"), keeping colons inside brackets.
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!|!$/g, "");
}
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const findings = []; // { rule, file, line, detail }
const spread = { spacing: new Map(), maxW: new Map(), radius: new Map() };
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const add = (rule, file, line, detail) => {
  if (!allowed(rule, file, detail)) findings.push({ rule, file, line, detail });
};
function openingTag(text, start) {
  // The opening tag from "<" to its closing ">", skipping ">" inside {expressions} and strings.
  let depth = 0;
  let quote = "";
  for (let i = start; i < Math.min(text.length, start + 4000); i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start, start + 400);
}
const inWrappers = (rel) => wrappers.some((w) => rel === w || rel.startsWith(`${w}/`));

for (const f of code) {
  const text = fs.readFileSync(f.abs, "utf8");
  for (const s of strings(text)) {
    const line = lineOf(text, s.index);
    for (const m of s.body.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|oklch|oklab)\(\s*[\d.]/g))
      add("raw-color", f.rel, line, m[0].replace(/\($/, "("));
    for (const raw of s.body.split(/\s+/)) {
      if (!raw || raw.length > 80) continue;
      const u = utility(raw);
      let m;
      if ((m = RE.arbitrary.exec(u))) {
        // A token reference or a device inset (safe areas) is not a typed design value.
        const tokenised = /var\(--|^--|env\(/.test(m[2]);
        if (!tokenised) add("arbitrary-value", f.rel, line, u);
        if (m[1] === "max-w") bump(spread.maxW, m[2]);
      } else if ((m = RE.radius.exec(u))) {
        const key = m[1] ?? "(bare)";
        bump(spread.radius, key);
        if (!STATIC.radius.has(key) && !defined.radius.has(key)) add("unmapped-scale", f.rel, line, u);
      } else if ((m = RE.shadow.exec(u))) {
        const key = m[1] ?? "(bare)";
        if (!STATIC.shadow.has(key) && !defined.shadow.has(key)) add("unmapped-scale", f.rel, line, u);
      } else if ((m = RE.spacing.exec(u))) bump(spread.spacing, m[1]);
      else if ((m = RE.maxW.exec(u))) bump(spread.maxW, m[1]);
    }
  }
  if (/\.(tsx|jsx)$/.test(f.rel)) {
    if (!inWrappers(f.rel))
      for (const m of text.matchAll(/<(button|input|select|textarea|dialog)\b/g)) {
        const tag = openingTag(text, m.index);
        if (m[1] === "input" && /type=["'](hidden|file)["']/.test(tag)) continue;
        if (kitClass && kitClass.test(tag)) continue;
        add("raw-element", f.rel, lineOf(text, m.index), `<${m[1]}>`);
      }
    for (const m of text.matchAll(/\bstyle=\{\{/g)) add("inline-style", f.rel, lineOf(text, m.index), "style={{}}");
  }
}
for (const f of css) {
  const text = fs.readFileSync(f.abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  for (const m of text.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\(\s*[\d.]/g))
    add("raw-color", f.rel, lineOf(text, m.index), m[0]);
}

const RULES = {
  "raw-color": "Colour literal outside the design system",
  "arbitrary-value": "Arbitrary utility value with a typed literal",
  "unmapped-scale": "Utility falls back to a framework default",
  "raw-element": "Raw interactive element with no wrapper and no kit class",
  "inline-style": "Inline style object",
};
const counts = Object.fromEntries(Object.keys(RULES).map((r) => [r, findings.filter((f) => f.rule === r).length]));
const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
const report = {
  root: norm(root),
  files: files.length,
  counts,
  spread: {
    spacingSteps: spread.spacing.size,
    maxWidths: spread.maxW.size,
    radiusKeys: spread.radius.size,
  },
  maxWidths: top(spread.maxW),
  radiusKeys: top(spread.radius),
  findings,
};

const baselinePath = one("--baseline");
let regressions = [];
if (baselinePath && fs.existsSync(baselinePath) && !args.includes("--update-baseline")) {
  const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  regressions = Object.keys(RULES).filter((r) => counts[r] > (base.counts?.[r] ?? 0)).map((r) => `${r}: ${base.counts?.[r] ?? 0} -> ${counts[r]}`);
}
if (baselinePath && args.includes("--update-baseline"))
  fs.writeFileSync(baselinePath, `${JSON.stringify({ counts, spread: report.spread }, null, 2)}\n`);

if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else if (args.includes("--quiet") && !regressions.length)
  console.log(`design audit: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}${baselinePath ? " (no rise against baseline)" : ""}`);
else {
  console.log(`App design audit: ${report.root} (${files.length} files)\n`);
  for (const [rule, label] of Object.entries(RULES)) console.log(`${String(counts[rule]).padStart(5)}  ${rule.padEnd(16)} ${label}`);
  console.log(`\nSpread (fewer is more consistent)`);
  console.log(`${String(spread.spacing.size).padStart(5)}  distinct spacing steps`);
  console.log(`${String(spread.maxW.size).padStart(5)}  distinct max-widths: ${top(spread.maxW).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  console.log(`${String(spread.radius.size).padStart(5)}  distinct radius keys: ${top(spread.radius).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  for (const rule of Object.keys(RULES)) {
    const list = findings.filter((f) => f.rule === rule);
    if (!list.length) continue;
    console.log(`\n${rule} (${list.length})`);
    for (const f of list.slice(0, args.includes("--all") ? Infinity : 12)) console.log(`  ${f.file}:${f.line}  ${f.detail}`);
    if (list.length > 12 && !args.includes("--all")) console.log(`  ... ${list.length - 12} more (--all)`);
  }
  if (regressions.length) console.log(`\nRegressions against baseline:\n  ${regressions.join("\n  ")}`);
}
process.exit(regressions.length ? 1 : 0);
