"use client"

import { useCallback, useEffect, useState } from "react"

type Skill = { name: string; description: string; location: string; managed: boolean; content: string }

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [dir, setDir] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [mode, setMode] = useState<"git" | "paste">("git")
  const [content, setContent] = useState("")

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
      setMsg(`Installed: ${j.installed.join(", ")}`)
      setSource("")
      setContent("")
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Skills</h1>
        <p className="mt-1 max-w-[640px] text-sm text-muted">
          Skills are folders with a <code className="rounded bg-code-bg px-1 font-mono text-[12px]">SKILL.md</code> that teach the agent a repeatable task. It loads them on demand. Installed skills work in every project.
        </p>

        <div className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <div className="mb-3 flex gap-1 text-xs">
            {(["git", "paste"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-md px-2.5 py-1 transition ${mode === m ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {m === "git" ? "From GitHub" : "Paste SKILL.md"}
              </button>
            ))}
          </div>
          {mode === "git" ? (
            <div className="flex gap-2">
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void install()}
                placeholder="owner/repo, owner/repo/path/to/skill, or a full URL"
                className="flex-1 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted focus:border-line-2"
              />
              <button type="button" onClick={() => void install()} disabled={busy || source.trim().length < 3} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40">
                {busy ? "Installing…" : "Install"}
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
                <button type="button" onClick={() => void install()} disabled={busy || content.trim().length < 10} className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-accent-ink disabled:opacity-40">
                  {busy ? "Saving…" : "Create skill"}
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

        <h2 className="mt-8 mb-3 text-sm font-medium text-ink">
          Installed <span className="font-normal text-muted">· {skills?.length ?? "…"}</span>
        </h2>
        {skills && skills.length === 0 && <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">No skills yet.</div>}
        <ul className="space-y-2">
          {skills?.map((s) => (
            <SkillCard key={s.location} s={s} onChange={load} />
          ))}
        </ul>
      </div>
    </div>
  )
}

function SkillCard({ s, onChange }: { s: Skill; onChange(): Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <li className="rounded-xl border border-line bg-surface shadow-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium text-ink">{s.name}</span>
            {!s.managed && <span className="rounded bg-surface-2 px-1 text-[10px] text-ink-2">project / external</span>}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-2">{s.description || <span className="text-muted">No description</span>}</div>
        </div>
        <svg width="10" height="10" viewBox="0 0 10 10" className={`mt-1.5 shrink-0 opacity-60 transition ${open ? "rotate-180" : ""}`}>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-line px-4 py-3">
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
                className="text-muted hover:text-err disabled:opacity-40"
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
