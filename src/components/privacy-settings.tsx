"use client"

import Link from "next/link"
import posthog from "posthog-js"
import { useCallback, useEffect, useState } from "react"

type Consent = { granted: boolean; current: boolean; at: string | null }
type Me = {
  email: string
  name: string | null
  createdAt: string
  analyticsOptOut: boolean
  consents: Record<"terms" | "privacy" | "research" | "cookies", Consent>
  requests: { id: string; type: string; status: string; requestedAt: string }[]
}

export function PrivacySettings() {
  const [me, setMe] = useState<Me | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetch("/api/me", { cache: "no-store" })
    if (r.ok) setMe(await r.json())
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  async function patch(body: Record<string, boolean>, key: string) {
    setBusy(key)
    setMsg(null)
    await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    if ("analyticsOptOut" in body) {
      try {
        if (body.analyticsOptOut) posthog.opt_out_capturing()
        else posthog.opt_in_capturing()
      } catch {}
    }
    await load()
    setBusy(null)
  }

  async function request(type: "export" | "delete") {
    const text = type === "delete" ? "Delete your account and all data? Your account is deactivated immediately and everything is erased within 30 days. This cannot be undone." : "Request a full export of your data? You'll get a download link by email."
    if (!window.confirm(text)) return
    setBusy(type)
    const r = await fetch("/api/data-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) })
    const j = await r.json()
    setMsg(j.duplicate ? "That request is already open." : type === "delete" ? "Deletion requested. We'll confirm by email." : "Export requested. We'll email a download link.")
    await load()
    setBusy(null)
  }

  if (!me) return <div className="mt-6 text-sm text-muted">Loading…</div>
  const research = me.consents.research
  return (
    <>
      <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
        <h2 className="text-sm font-medium text-ink">Account</h2>
        <dl className="mt-2 grid grid-cols-[120px_1fr] gap-y-1 text-[13px]">
          <dt className="text-muted">Email</dt>
          <dd className="font-mono text-ink">{me.email}</dd>
          <dt className="text-muted">Member since</dt>
          <dd className="text-ink-2">{new Date(me.createdAt).toLocaleDateString()}</dd>
          <dt className="text-muted">Terms accepted</dt>
          <dd className="text-ink-2">
            {me.consents.terms.at ? new Date(me.consents.terms.at).toLocaleDateString() : "—"}{" "}
            <Link href="/legal/terms" className="text-muted underline underline-offset-2 hover:text-ink">
              read
            </Link>
          </dd>
        </dl>
      </section>

      <Toggle
        title="Product analytics"
        on={!me.analyticsOptOut}
        busy={busy === "analytics"}
        onChange={(v) => void patch({ analyticsOptOut: !v }, "analytics")}
        onLabel="On"
        offLabel="Off"
      >
        Anonymous usage events (which features, how often, which errors) and masked session replays. Never prompts, code or keys. Helps us see what breaks and what nobody uses.{" "}
        <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-ink">
          Details
        </Link>
        .
      </Toggle>

      <Toggle title="Research data consent" on={research.granted} busy={busy === "research"} onChange={(v) => void patch({ research: v }, "research")} onLabel="Consented" offLabel="Off">
        Allow the <em>content</em> of your conversations with the agent to be used to improve syrup and for anonymized research. Off by default, never required, revocable here at any time.{" "}
        <Link href="/legal/research" className="underline underline-offset-2 hover:text-ink">
          Exactly what this means
        </Link>
        .{research.granted && research.at && <span className="text-muted"> Granted {new Date(research.at).toLocaleDateString()}.</span>}
      </Toggle>

      <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
        <h2 className="text-sm font-medium text-ink">Your data</h2>
        <p className="mt-1 text-[13px] text-ink-2">Export everything we hold about you, or delete your account. Requests are recorded with a timestamp and handled within the times published in the Privacy Policy.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={!!busy} onClick={() => void request("export")} className="rounded-lg border border-line bg-bg px-3 py-2 text-xs font-medium text-ink transition hover:border-line-2 disabled:opacity-40">
            Request export
          </button>
          <button type="button" disabled={!!busy} onClick={() => void request("delete")} className="rounded-lg border border-err/30 bg-bg px-3 py-2 text-xs font-medium text-err transition hover:border-err/60 disabled:opacity-40">
            Delete account…
          </button>
        </div>
        {msg && <div className="mt-2 text-xs text-ok">{msg}</div>}
        {me.requests.length > 0 && (
          <ul className="mt-3 divide-y divide-line text-[12px]">
            {me.requests.map((r) => (
              <li key={r.id} className="flex gap-3 py-1.5">
                <span className="rounded bg-surface-2 px-1.5 text-[10px] uppercase text-ink-2">{r.type}</span>
                <span className="text-ink-2">{r.status}</span>
                <span className="text-muted">{new Date(r.requestedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Toggle({ title, on, busy, onChange, onLabel, offLabel, children }: { title: string; on: boolean; busy: boolean; onChange(v: boolean): void; onLabel: string; offLabel: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{children}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          disabled={busy}
          onClick={() => onChange(!on)}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${on ? "bg-accent" : "bg-line-2"}`}
          title={on ? onLabel : offLabel}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "left-[22px]" : "left-0.5"}`} />
        </button>
      </div>
      <div className="mt-2 text-[11px] text-muted">{on ? onLabel : offLabel}</div>
    </section>
  )
}
