/**
 * Secret redaction and path normalization for anything syrup publishes or
 * exports (shared chats, transcripts, debug bundles). Pure and dependency
 * free, so the server, the browser and the CLI (scripts/chat-export.mjs,
 * bundled with esbuild) all run the same rules.
 *
 * Redaction is deliberately greedy: a shared chat that loses a placeholder
 * value is fine, a shared chat that leaks a key is not. Every replacement is
 * counted so the Share dialog can say "N secrets redacted".
 */

export const REDACTED = "[redacted]"

type Rule = { name: string; re: RegExp; replace: (m: string, ...g: string[]) => string }

/** Values that are clearly not real secrets (docs, templates, env references). */
const PLACEHOLDER = /^(?:\*+|x{3,}|\.{3,}|…|\[redacted\]|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_]+%|changeme|password|passwd|pass|secret|token|your[-_ ]?\w*|example\w*|placeholder|dummy|test|null|undefined|none|true|false|string)$/i

const RULES: Rule[] = [
  // PEM private keys, including a block cut off by truncated output.
  {
    name: "private-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[\s\S]*?-----END \1PRIVATE KEY-----|[\s\S]*$)/g,
    replace: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----\n${REDACTED}\n-----END ${kind}PRIVATE KEY-----`,
  },
  // user:password@ in any URL (postgres, mysql, mongodb, redis, amqp, https basic auth…).
  {
    name: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:/@'"`<>]{1,128}):([^\s@/'"`<>]{1,256})@/gi,
    replace: (m, scheme, user, pass) => (PLACEHOLDER.test(pass) ? m : `${scheme}://${user}:${REDACTED}@`),
  },
  // Provider and platform tokens with a recognizable prefix.
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: () => `sk-ant-${REDACTED}` },
  { name: "openrouter", re: /\bsk-or-[A-Za-z0-9_-]{16,}/g, replace: () => `sk-or-${REDACTED}` },
  { name: "openai-like", re: /\bsk-(?!ant-|or-)[A-Za-z0-9_-]{16,}/g, replace: () => `sk-${REDACTED}` },
  { name: "google", re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: () => `AIza${REDACTED}` },
  { name: "google-oauth", re: /\bya29\.[0-9A-Za-z_-]{20,}/g, replace: () => `ya29.${REDACTED}` },
  { name: "groq", re: /\bgsk_[A-Za-z0-9]{16,}/g, replace: () => `gsk_${REDACTED}` },
  { name: "nvidia", re: /\bnvapi-[A-Za-z0-9_-]{16,}/g, replace: () => `nvapi-${REDACTED}` },
  { name: "cerebras", re: /\bcsk-[A-Za-z0-9]{16,}/g, replace: () => `csk-${REDACTED}` },
  { name: "xai", re: /\bxai-[A-Za-z0-9]{16,}/g, replace: () => `xai-${REDACTED}` },
  { name: "huggingface", re: /\bhf_[A-Za-z0-9]{24,}/g, replace: () => `hf_${REDACTED}` },
  { name: "github", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: (_m, p) => `${p}_${REDACTED}` },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => `github_pat_${REDACTED}` },
  { name: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: () => `glpat-${REDACTED}` },
  { name: "slack", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: (m) => `${m.slice(0, 5)}${REDACTED}` },
  { name: "stripe", re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g, replace: (_m, a, b) => `${a}_${b}_${REDACTED}` },
  { name: "npm", re: /\bnpm_[A-Za-z0-9]{30,}/g, replace: () => `npm_${REDACTED}` },
  { name: "sendgrid", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replace: () => `SG.${REDACTED}` },
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: (_m, p) => `${p}${REDACTED}` },
  // JSON Web Tokens.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => `[redacted-jwt]` },
  // Authorization header values. The value must look like a token (a digit or token punctuation), so prose like "Basic authentication" stays.
  { name: "bearer", re: /\b(Bearer|Token)(\s+)((?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{20,})/g, replace: (_m, k, sp) => `${k}${sp}${REDACTED}` },
  { name: "basic-auth", re: /\b(Basic)(\s+)((?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/=]{12,})/g, replace: (_m, k, sp) => `${k}${sp}${REDACTED}` },
  // Env-style assignments: OPENAI_API_KEY=…, export DB_PASSWORD="…", SYRUP_MASTER_KEY: …
  {
    name: "env-assignment",
    // Bounded name length: an unbounded run here backtracks quadratically on long uppercase text.
    re: /\b([A-Z][A-Z0-9_]{0,60}?(?:API_?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|_PASS|_PWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|_KEY|_DSN)[A-Z0-9_]{0,40})(\s{0,4}[=:]\s{0,4})(["']?)([^\s"'`#,;]{4,512})\3/g,
    replace: (m, k, sep, q, v) => (PLACEHOLDER.test(v) || v.startsWith(REDACTED) || v.includes("[redacted") ? m : `${k}${sep}${q}${REDACTED}${q}`),
  },
  // Quoted values under keys that end in a secret word, in JSON, YAML, code: "apiKey": "…", password: '…'
  // ("max_tokens" and "tokenizer" do not end in one, so they stay.)
  {
    name: "keyed-literal",
    // Starts only at a word start and bounds every run, so megabytes of text stay linear.
    re: /(?<![A-Za-z0-9_-])(["']?)([A-Za-z0-9_-]{0,40}?(?:api[_-]?key|apikey|secret|secret[_-]?key|token|password|passwd|private[_-]?key|access[_-]?key|client[_-]?secret))\1(\s{0,4}[:=]\s{0,4})(["'])([^"'\s]{8,512})\4/gi,
    replace: (m, q1, k, sep, q, v) => (PLACEHOLDER.test(v) || v.includes("[redacted") ? m : `${q1}${k}${q1}${sep}${q}${REDACTED}${q}`),
  },
]

export type RedactOptions = {
  /** Exact secret values known to the server (the user's provider keys, router secrets). Replaced wherever they appear. */
  secrets?: readonly string[]
  /** Exact strings to hide that are not secrets but must not be published (the owner's email). */
  hide?: readonly { value: string; as: string }[]
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Returns the text with secrets replaced and how many replacements were made. */
export function redactText(text: string, opts: RedactOptions = {}): { text: string; count: number } {
  if (!text) return { text, count: 0 }
  let out = text
  let count = 0
  for (const s of opts.secrets ?? []) {
    if (!s || s.length < 8 || !out.includes(s)) continue
    const parts = out.split(s)
    count += parts.length - 1
    out = parts.join(REDACTED)
  }
  for (const h of opts.hide ?? []) {
    if (!h.value || h.value.length < 3) continue
    const re = new RegExp(escapeRe(h.value), "gi")
    out = out.replace(re, () => {
      count++
      return h.as
    })
  }
  for (const r of RULES) {
    r.re.lastIndex = 0
    out = out.replace(r.re, (...args) => {
      const m = args[0] as string
      const groups = args.slice(1, -2).map((g) => (g === undefined ? "" : String(g)))
      const next = r.replace(m, ...groups)
      if (next !== m) count++
      return next
    })
  }
  return { text: out, count }
}

// ------------------------------------------------------------------ paths

/** A Windows drive path ("C:\x", "c:/x"). */
function isWindowsRoot(p: string): boolean {
  return /^[a-z]:[\\/]/i.test(p)
}

/** Every spelling of one root path we may meet in text: slash styles, JSON-escaped backslashes, file:// URLs. */
function spellings(root: string): string[] {
  const clean = root.replace(/[\\/]+$/, "")
  if (!clean || clean === "/" || /^[a-z]:$/i.test(clean)) return []
  const fwd = clean.replace(/\\/g, "/")
  const back = clean.replace(/\//g, "\\")
  const out = new Set([clean, fwd])
  if (isWindowsRoot(clean)) {
    out.add(back)
    out.add(back.replace(/\\/g, "\\\\"))
    out.add(`file:///${fwd}`)
    out.add(`/${fwd}`)
  } else {
    out.add(`file://${fwd}`)
  }
  // Longest first so "file:///C:/x" wins over "C:/x".
  return [...out].sort((a, b) => b.length - a.length)
}

export type PathOptions = {
  /** Absolute workspace roots; paths under them become workspace-relative. */
  roots?: readonly string[]
  /** Absolute home folders; paths under them become "~/…". Detected OS home folders are always folded too. */
  homes?: readonly string[]
}

/**
 * Makes absolute paths workspace-relative ("C:\Users\me\syrup\src\a.ts" → "src\a.ts",
 * "/vercel/workspace/x" → "x") and folds home folders to "~", so shared text
 * does not reveal the owner's user name or folder layout.
 */
export function normalizePaths(text: string, opts: PathOptions = {}): string {
  if (!text) return text
  let out = text
  const roots = [...new Set((opts.roots ?? []).filter(Boolean))].sort((a, b) => b.length - a.length)
  for (const root of roots) {
    for (const sp of spellings(root)) {
      const flags = isWindowsRoot(root) || /^file:\/\/\/[a-z]:/i.test(sp) || /^\/[a-z]:/i.test(sp) ? "gi" : "g"
      // Root followed by a separator: drop the root and the separator.
      out = out.replace(new RegExp(`${escapeRe(sp)}(?:\\\\\\\\|[\\\\/])`, flags), "")
      // The root itself: "." (only at a boundary, so "/vercel/workspace2" is left alone).
      out = out.replace(new RegExp(`${escapeRe(sp)}(?=$|[\\s"'\`),:;\\]}>])`, flags), ".")
    }
  }
  for (const home of [...new Set((opts.homes ?? []).filter(Boolean))].sort((a, b) => b.length - a.length)) {
    for (const sp of spellings(home)) {
      const flags = isWindowsRoot(home) ? "gi" : "g"
      out = out.replace(new RegExp(`${escapeRe(sp)}(?=$|[\\\\/\\s"'\`),:;\\]}>])`, flags), "~")
    }
  }
  // Any other Windows profile folder: C:\Users\<name> → ~ (also JSON-escaped and forward-slash forms).
  out = out.replace(/(?:file:\/\/\/)?\b[a-z]:(\\\\|\\|\/)Users\1[^\\/\s"'`<>:|*?]+/gi, "~")
  // macOS and Linux home folders, when they start a path (not inside a URL like https://x.com/Users/list).
  out = out.replace(/(?<![\w.~-])(?:file:\/\/)?\/(?:Users|home)\/[^/\s"'`<>:]+/g, "~")
  return out
}

/** normalizePaths, then redactText. */
export function sanitizeText(text: string, paths: PathOptions, secrets: RedactOptions): { text: string; count: number } {
  return redactText(normalizePaths(text, paths), secrets)
}
