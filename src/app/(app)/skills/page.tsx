"use client"

import { useCallback, useEffect, useState } from "react"
import { Brew, Skel } from "@/components/brew"
import { RowMenu } from "@/components/pages/row-menu"

type Source = "syrup" | "claude" | "agents" | "project" | "builtin"
type Skill = { name: string; description: string; location: string; managed: boolean; source: Source; enabled: boolean; tokens: number; content: string; duplicates: string[] }

const GROUPS: { source: Source; label: string; hint: string }[] = [
  { source: "syrup", label: "Installed in syrup", hint: "On when installed" },
  { source: "claude", label: "Claude Code", hint: "From ~/.claude/skills · new ones start off" },
  { source: "agents", label: "Other agents", hint: "From ~/.agents/skills · new ones start off" },
  { source: "project", label: "Project", hint: "From this workspace · new ones start off" },
  { source: "builtin", label: "Built into the engine", hint: "Off by default" },
]

const fmt = (n: number) => n.toLocaleString("en-US")

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [dir, setDir] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<"git" | "paste">("git")
  const [content, setContent] = useState("")
  const [q, setQ] = useState("")

  const load = useCallback(async () => {
    const r = await fetch("/api/skills", { cache: "no-store" })
    const j = await r.json()
    if (!r.ok) setError(j.error ?? "Could not load skills")
    else {
      setSkills(j.skills)
      setDir(j.dir)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function install() {
    setBusy(true)
    setMsg(null)
    setError(null)
    try {
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "git" ? { source } : { content }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? "Install failed")
      setMsg(`Installed: ${j.installed.join(", ")}${j.skipped?.length ? `. Skipped: ${j.skipped.join(", ")}` : ""}`)
      setSource("")
      setContent("")
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function toggle(names: string[], enabled: boolean) {
    const set = new Set(names)
    setError(null)
    setSkills((prev) => prev?.map((s) => (set.has(s.name) ? { ...s, enabled } : s)) ?? prev)
    const r = await fetch("/api/skills", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: Object.fromEntries(names.map((n) => [n, enabled])) }),
    })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      setError(j.error ?? "Could not save")
      await load()
    }
  }

  const on = skills?.filter((s) => s.enabled) ?? []
  const duplicated = skills?.filter((s) => s.duplicates.length > 0) ?? []
  const needle = q.trim().toLowerCase()
  const shown = skills?.filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)) ?? []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-4 py-8 medium:px-6">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Skills</h1>
        <p className="mt-1 max-w-[640px] text-sm text-muted">
          Skills are folders with a <code className="rounded bg-code-bg px-1 font-mono text-[12px]">SKILL.md</code> that teach the agent a repeatable task. It loads them on demand. Installed skills work in every project.
        </p>

        <div className="@container mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="mb-3 flex gap-1 text-xs">
            {(["git", "paste"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-md px-2.5 py-1 transition pointer-coarse:min-h-10 ${mode === m ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {m === "git" ? "From GitHub" : "Paste SKILL.md"}
              </button>
            ))}
          </div>
          {mode === "git" ? (
            // Narrow: the Install button goes full width under the field.
            <div className="flex flex-col gap-2 @[480px]:flex-row">
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void install()}
                placeholder="owner/repo, owner/repo/path/to/skill, or a full URL"
                className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2 pointer-coarse:min-h-11"
              />
              <button type="button" onClick={() => void install()} disabled={busy || source.trim().length < 3} className={`rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink pointer-coarse:min-h-11 ${busy ? "" : "disabled:opacity-40"}`}>
                {busy ? <Brew label="Installing" tone="inherit" /> : "Install"}
              </button>
            </div>
          ) : (
            <div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder={"---\nname: my-skill\ndescription: When to use this skill and what it does.\n---\n\nStep-by-step instructions for the agent…"}
                className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted focus:border-line-2"
              />
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={() => void install()} disabled={busy || content.trim().length < 10} className={`w-full rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink pointer-coarse:min-h-11 @[480px]:w-auto ${busy ? "" : "disabled:opacity-40"}`}>
                  {busy ? <Brew mood="save" tone="inherit" timerAfter={0} /> : "Create skill"}
                </button>
              </div>
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted">
            Skill packs work too: every folder with a SKILL.md under the path is installed. Installs into <span className="font-mono">{dir || "~/.config/opencode/skills"}</span>.
          </div>
          {msg && <div className="mt-2 text-xs text-ok">{msg}</div>}
          {error && <div className="mt-2 text-xs text-err">{error}</div>}
        </div>

        <SaribCard />

        <div className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-medium text-ink">In the agent&apos;s prompt</h2>
          <span className="text-sm text-muted">
            {skills ? (
              <>
                <span className="text-ink-2">
                  {on.length} of {skills.length} on
                </span>{" "}
                · ~{fmt(on.reduce((n, s) => n + s.tokens, 0))} tokens per request
              </>
            ) : (
              <Skel className="inline-block h-3 w-44 align-middle" />
            )}
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[13px] text-muted">Every request lists the skills that are on, so each one costs tokens even when unused. Changes apply from the next message; running chats finish first.</p>

        {duplicated.length > 0 && (
          <div className="mt-4 rounded-xl border border-warn/40 bg-warn/5 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">
              {duplicated.length} skill{duplicated.length === 1 ? " exists" : "s exist"} in more than one folder.
            </span>{" "}
            The engine loads one copy per name and may switch to the other after a reload, which makes a skill seem to vanish. Keep one copy of each; the rows below say where the others are.
          </div>
        )}

        {skills && skills.length > 0 && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search skills…"
            className="mt-4 w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-muted focus:border-line-2"
          />
        )}
        {!skills && !error && <SkillsSkeleton />}
        {skills && skills.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">No skills yet.</div>}
        {skills && skills.length > 0 && shown.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">Nothing matches.</div>}

        {GROUPS.map((grp) => {
          const all = skills?.filter((s) => s.source === grp.source) ?? []
          const rows = shown.filter((s) => s.source === grp.source)
          if (rows.length === 0) return null
          const groupOn = all.filter((s) => s.enabled)
          return (
            <section key={grp.source} className="@container mt-6">
              {/* Wraps on phones; "Turn all off" folds into a ⋯ when the column is narrow. */}
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h3 className="text-[13px] font-medium text-ink">{grp.label}</h3>
                <span className="text-[12px] text-muted">
                  {groupOn.length}/{all.length} on · ~{fmt(groupOn.reduce((n, s) => n + s.tokens, 0))} tokens
                </span>
                <span className="hidden text-[11px] text-muted medium:inline">{grp.hint}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={groupOn.length === 0}
                  onClick={() => void toggle(groupOn.map((s) => s.name), false)}
                  className="hidden text-[12px] text-muted hover:text-ink disabled:opacity-40 disabled:hover:text-muted items-center @[480px]:inline-flex pointer-coarse:min-h-11"
                >
                  Turn all off
                </button>
                <RowMenu
                  className="-my-2 self-center @[480px]:hidden"
                  label={`${grp.label} actions`}
                  title={grp.label}
                  items={[{ label: "Turn all off", onSelect: () => void toggle(groupOn.map((s) => s.name), false), disabled: groupOn.length === 0 }]}
                />
              </div>
              <ul className="space-y-2">
                {rows.map((s) => (
                  <SkillCard key={s.location} s={s} onChange={load} onToggle={(v) => void toggle([s.name], v)} />
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

type SaribStatus = { python: string[] | null; command: string[] | null; installing: boolean; log: string; error: string | null }

/** Optional .sarib tools: status and a one-click install. Shown once the server answers, so it stays hidden where there is no .sarib support (the hosted version). */
function SaribCard() {
  const [st, setSt] = useState<SaribStatus | null>(null)
  const [showLog, setShowLog] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch("/api/sarib", { cache: "no-store" })
    if (r.ok) setSt(await r.json())
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  // Poll while pip runs.
  useEffect(() => {
    if (!st?.installing) return
    const t = setInterval(() => void load(), 1500)
    return () => clearInterval(t)
  }, [st?.installing, load])

  async function install() {
    const r = await fetch("/api/sarib", { method: "POST" })
    if (r.ok) setSt(await r.json())
  }

  const installed = !!st?.command
  if (!st) return null
  return (
    <div className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-ink">.sarib tools</span>
            {st && !st.installing && <span className={`rounded px-1 text-[10px] ${installed ? "bg-surface-2 text-ok" : "bg-surface-2 text-ink-2"}`}>{installed ? "installed" : "not installed"}</span>}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-2">
            Lets the agent query and edit{" "}
            <a href="https://github.com/SyedSaribSultan/sarib-lang" target="_blank" rel="noreferrer" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
              .sarib
            </a>{" "}
            files by id instead of rewriting them. Turns on only in workspaces that contain .sarib files, so other chats pay nothing for it.
          </div>
        </div>
        {st && !installed && (
          <button type="button" onClick={() => void install()} disabled={st.installing || !st.python} className={`shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink pointer-coarse:min-h-11 ${st.installing ? "" : "disabled:opacity-40"}`}>
            {st.installing ? <Brew label="Installing" tone="inherit" /> : "Enable"}
          </button>
        )}
      </div>
      {st && !installed && !st.python && (
        <div className="mt-2 text-[11px] text-muted">
          Needs Python 3.10+.{" "}
          <a href="https://www.python.org/downloads/" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
            Install Python
          </a>
          , then reload this page.
        </div>
      )}
      {st?.error && <div className="mt-2 text-xs text-err">{st.error}</div>}
      {st?.log && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowLog((v) => !v)} className="text-[11px] text-muted hover:text-ink pointer-coarse:min-h-11">
            {showLog ? "Hide" : "Show"} install log
          </button>
          {showLog && <pre className="mt-1 max-h-[240px] overflow-auto rounded-lg bg-code-bg p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{st.log}</pre>}
        </div>
      )}
    </div>
  )
}

function SkillCard({ s, onChange, onToggle }: { s: Skill; onChange(): Promise<void>; onToggle(enabled: boolean): void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <li className="rounded-xl border border-line bg-surface shadow-card transition-colors hover:border-line-2">
      <div className="flex items-start gap-3 pr-4">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`font-mono text-[13px] font-medium ${s.enabled ? "text-ink" : "text-ink-2"}`}>{s.name}</span>
              <span className="text-[11px] text-muted">~{fmt(s.tokens)} tokens</span>
              {s.duplicates.length > 0 && (
                <span className="rounded bg-warn/15 px-1 py-px text-[10px] font-medium text-warn" title={s.duplicates.join("\n")}>
                  {s.duplicates.length + 1} copies
                </span>
              )}
            </div>
            <div className={`mt-0.5 line-clamp-2 text-[13px] ${s.enabled ? "text-ink-2" : "text-muted"}`}>{s.description || "No description"}</div>
          </div>
          <svg width="10" height="10" viewBox="0 0 10 10" className={`mt-1.5 shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`}>
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`}
          onClick={() => onToggle(!s.enabled)}
          className={`relative mt-3 h-5 w-9 shrink-0 rounded-full transition pointer-coarse:after:absolute pointer-coarse:after:-inset-3 ${s.enabled ? "bg-accent" : "bg-line-2"}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition ${s.enabled ? "translate-x-4" : "translate-x-0"}`} />
        </button>
      </div>
      {open && (
        <div className="border-t border-line px-4 py-3">
          {s.duplicates.length > 0 && (
            <div className="mb-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12px] leading-relaxed text-ink-2">
              <span className="font-medium text-warn">Also found at</span>
              {s.duplicates.map((d) => (
                <div key={d} className="mt-0.5 truncate font-mono text-[11px]" title={d}>
                  {d}
                </div>
              ))}
              <div className="mt-1 text-[11px] text-muted">The engine shows one of these at a time. Delete the copies you don&apos;t want so it stays put.</div>
            </div>
          )}
          <div className="mb-2 flex items-center gap-3 text-[11px] text-muted">
            <span className="truncate font-mono">{s.location}</span>
            <span className="flex-1" />
            {s.managed && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await fetch(`/api/skills/${s.name}`, { method: "DELETE" })
                  await onChange()
                  setBusy(false)
                }}
                className="text-muted hover:text-err disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:px-2"
              >
                Remove
              </button>
            )}
          </div>
          <pre className="max-h-[400px] overflow-auto rounded-lg bg-code-bg p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">{s.content}</pre>
        </div>
      )}
    </li>
  )
}

/** A group header and a few skill rows at their real height. */
function SkillsSkeleton() {
  return (
    <div aria-busy className="skel-in">
      <Skel className="mt-4 h-[42px] w-full rounded-xl" />
      <section className="mt-6">
        <div className="mb-2 flex items-center gap-3">
          <Skel className="h-3.5 w-32" />
          <Skel className="h-3 w-24" />
        </div>
        <ul className="space-y-2">
          {["w-28", "w-40", "w-24", "w-36"].map((w) => (
            <li key={w} className="flex items-start gap-3 rounded-xl border border-line bg-surface py-3 pr-4 pl-4 shadow-card">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Skel className={`h-3.5 ${w}`} />
                  <Skel className="h-3 w-16" />
                </div>
                <Skel className="mt-2 h-3.5 w-[94%]" />
                <Skel className="mt-1.5 h-3.5 w-[64%]" />
              </div>
              <Skel className="mt-0.5 h-5 w-9 rounded-full" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
