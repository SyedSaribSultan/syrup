"use client"

import { useCallback, useEffect, useState } from "react"
import { Button, Icon } from "@/components/ui/s"
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
        <h1 className="font-display text-heading text-ink">Skills</h1>
        <p className="mt-2 max-w-[640px] text-base text-ink-2">
          Skills are folders with a <code className="s-code">SKILL.md</code> that teach the agent a repeatable task. It loads them on demand. Installed skills work in every project.
        </p>

        {/* Install: a P2 card on the canvas; GitHub or paste is an s-seg switch. */}
        <div className="s-card @container mt-6">
          <div role="group" aria-label="Install from" className="s-seg self-start">
            {(["git", "paste"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className="s-seg__item">
                {m === "git" ? "From GitHub" : "Paste SKILL.md"}
              </button>
            ))}
          </div>
          {mode === "git" ? (
            // Narrow: the Install button goes full width under the field.
            <div className="flex flex-col gap-3 @[480px]:flex-row">
              <div className="s-field min-w-0 flex-1">
                <input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void install()}
                  placeholder="owner/repo, owner/repo/path/to/skill, or a full URL"
                  aria-label="Skill source"
                  className="s-field__input"
                />
              </div>
              <Button variant="brand" busy={busy} disabled={source.trim().length < 3} onClick={() => void install()}>
                Install
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="s-field s-field--multi" data-grown="">
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={8}
                  aria-label="SKILL.md"
                  placeholder={"---\nname: my-skill\ndescription: When to use this skill and what it does.\n---\n\nStep-by-step instructions for the agent…"}
                  className="s-field__input font-mono"
                />
              </div>
              <div className="flex justify-end">
                <Button variant="brand" busy={busy} disabled={content.trim().length < 10} onClick={() => void install()} className="w-full @[480px]:w-auto">
                  Create skill
                </Button>
              </div>
            </div>
          )}
          <p className="s-help">
            Skill packs work too: every folder with a SKILL.md under the path is installed. Installs into <span className="font-mono">{dir || "~/.config/opencode/skills"}</span>.
          </p>
          {msg && <p className="text-sm text-ok">{msg}</p>}
          {error && <p className="s-field-error">{error}</p>}
        </div>

        <SaribCard />

        <div className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg text-ink">In the agent&apos;s prompt</h2>
          <span className="s-meta">
            {skills ? (
              <>
                {on.length} of {skills.length} on · ~{fmt(on.reduce((n, s) => n + s.tokens, 0))} tokens per request
              </>
            ) : (
              <span className="s-skeleton s-skeleton--line inline-block w-44 align-middle" />
            )}
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-sm text-ink-2">Every request lists the skills that are on, so each one costs tokens even when unused. Changes apply from the next message; running chats finish first.</p>

        {duplicated.length > 0 && (
          <div className="s-alert s-alert--warning mt-4">
            <Icon name="triangle-alert" />
            <div className="s-alert__body">
              <p className="s-alert__title">
                {duplicated.length} skill{duplicated.length === 1 ? " exists" : "s exist"} in more than one folder.
              </p>
              <p className="s-alert__desc">The engine loads one copy per name and may switch to the other after a reload, which makes a skill seem to vanish. Keep one copy of each; the rows below say where the others are.</p>
            </div>
          </div>
        )}

        {skills && skills.length > 0 && (
          <div className="s-field mt-4">
            <Icon name="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" className="s-field__input" />
          </div>
        )}
        {!skills && !error && <SkillsSkeleton />}
        {skills && skills.length === 0 && <p className="s-empty-line mt-4 px-2 py-8 text-center">No skills yet. Install one above.</p>}
        {skills && skills.length > 0 && shown.length === 0 && <p className="s-empty-line mt-4 px-2 py-8 text-center">Nothing matches. Try another word.</p>}

        {GROUPS.map((grp) => {
          const all = skills?.filter((s) => s.source === grp.source) ?? []
          const rows = shown.filter((s) => s.source === grp.source)
          if (rows.length === 0) return null
          const groupOn = all.filter((s) => s.enabled)
          return (
            <section key={grp.source} className="@container mt-6">
              {/* Wraps on phones; "Turn all off" folds into a ⋯ when the column is narrow. */}
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <h3 className="text-base text-ink">{grp.label}</h3>
                <span className="s-meta">
                  {groupOn.length}/{all.length} on · ~{fmt(groupOn.reduce((n, s) => n + s.tokens, 0))} tokens
                </span>
                <span className="s-help hidden medium:inline">{grp.hint}</span>
                <span className="flex-1" />
                <Button variant="ghost" size="sm" disabled={groupOn.length === 0} onClick={() => void toggle(groupOn.map((s) => s.name), false)} className="hidden @[480px]:inline-flex">
                  Turn all off
                </Button>
                <RowMenu
                  className="-my-2 self-center @[480px]:hidden"
                  label={`${grp.label} actions`}
                  title={grp.label}
                  items={[{ label: "Turn all off", onSelect: () => void toggle(groupOn.map((s) => s.name), false), disabled: groupOn.length === 0 }]}
                />
              </div>
              <ul className="flex flex-col gap-3">
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
    <div className="s-card mt-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-base text-ink">.sarib tools</span>
            {!st.installing && <span className={`s-badge ${installed ? "s-badge--success" : ""}`}>{installed ? "Installed" : "Not installed"}</span>}
          </div>
          <p className="mt-1 text-sm text-ink-2">
            Lets the agent query and edit{" "}
            <a href="https://github.com/SyedSaribSultan/sarib-lang" target="_blank" rel="noreferrer" className="s-link">
              .sarib
            </a>{" "}
            files by id instead of rewriting them. Turns on only in workspaces that contain .sarib files, so other chats pay nothing for it.
          </p>
        </div>
        {!installed && (
          <Button size="sm" busy={st.installing} disabled={!st.python} onClick={() => void install()}>
            Enable
          </Button>
        )}
      </div>
      {!installed && !st.python && (
        <p className="s-help">
          Needs Python 3.10+.{" "}
          <a href="https://www.python.org/downloads/" target="_blank" rel="noreferrer" className="s-link">
            Install Python
          </a>
          , then reload this page.
        </p>
      )}
      {st.error && <p className="s-error-line">{st.error}</p>}
      {st.log && (
        <div>
          <Button variant="link-neutral" size="sm" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide install log" : "Show install log"}
          </Button>
          {showLog && <pre className="s-codeblock mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap">{st.log}</pre>}
        </div>
      )}
    </div>
  )
}

/** One skill: a P2 card; the head toggles the SKILL.md below, the s-switch turns it on or off. */
function SkillCard({ s, onChange, onToggle }: { s: Skill; onChange(): Promise<void>; onToggle(enabled: boolean): void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // p-0: the whole card head is the expand button, so the card's padding moves onto it (a hit-area reason).
  return (
    <li className="s-card s-card--compact p-0">
      <div className="flex items-center gap-3 pr-5">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-start gap-3 rounded-l-xl py-4 pl-5 text-left">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`font-mono text-sm ${s.enabled ? "text-ink" : "text-ink-2"}`}>{s.name}</span>
              <span className="s-meta">~{fmt(s.tokens)} tokens</span>
              {s.duplicates.length > 0 && (
                <span className="s-badge s-badge--warning" title={s.duplicates.join("\n")}>
                  {s.duplicates.length + 1} copies
                </span>
              )}
            </div>
            <p className={`mt-1 line-clamp-2 text-sm ${s.enabled ? "text-ink-2" : "text-muted"}`}>{s.description || "No description"}</p>
          </div>
          <Icon name="chevron-down" size={16} className={`mt-1 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <label className="s-switch">
          <input type="checkbox" role="switch" checked={s.enabled} aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`} onChange={() => onToggle(!s.enabled)} />
        </label>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
          {s.duplicates.length > 0 && (
            <div className="s-alert s-alert--warning">
              <Icon name="triangle-alert" />
              <div className="s-alert__body">
                <p className="s-alert__title">Also found at</p>
                {s.duplicates.map((d) => (
                  <p key={d} className="s-alert__desc w-full truncate font-mono" title={d}>
                    {d}
                  </p>
                ))}
                <p className="s-alert__desc">The engine shows one of these at a time. Delete the copies you don&apos;t want so it stays put.</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span className="s-meta min-w-0 truncate">{s.location}</span>
            <span className="flex-1" />
            {s.managed && (
              <Button
                variant="ghost"
                size="sm"
                busy={busy}
                onClick={async () => {
                  setBusy(true)
                  await fetch(`/api/skills/${s.name}`, { method: "DELETE" })
                  await onChange()
                  setBusy(false)
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <pre className="s-codeblock max-h-[400px] overflow-auto whitespace-pre-wrap">{s.content}</pre>
        </div>
      )}
    </li>
  )
}

/** A group header and a few skill rows at their real height. */
function SkillsSkeleton() {
  return (
    <div aria-busy className="skel-in">
      <span className="s-skeleton s-skeleton--row mt-4 block w-full" />
      <section className="mt-6">
        <div className="mb-3 flex items-center gap-3">
          <span className="s-skeleton s-skeleton--line w-32" />
          <span className="s-skeleton s-skeleton--line w-24" />
        </div>
        <ul className="flex flex-col gap-3">
          {["w-28", "w-40", "w-24", "w-36"].map((w) => (
            <li key={w} className="s-card s-card--compact">
              <span className={`s-skeleton s-skeleton--line ${w}`} />
              <div className="s-skeleton-stack">
                <span className="s-skeleton s-skeleton--line" />
                <span className="s-skeleton s-skeleton--line" />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
