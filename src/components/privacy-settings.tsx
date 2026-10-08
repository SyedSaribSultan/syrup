"use client"

import Link from "next/link"
import posthog from "posthog-js"
import { useCallback, useEffect, useState } from "react"
import { Skel } from "./brew"
import { confirmDialog } from "./ui/dialog"

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
    const ok = await confirmDialog(
      type === "delete"
        ? { title: "Delete your account and all data?", body: "Your account is deactivated immediately and everything is erased within 30 days. This cannot be undone.", confirmLabel: "Delete account", danger: true }
        : { title: "Request a full export of your data?", body: "You'll get a download link by email.", confirmLabel: "Request export" },
    )
    if (!ok) return
    setBusy(type)
    const r = await fetch("/api/data-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) })
    const j = await r.json()
    setMsg(j.duplicate ? "That request is already open." : type === "delete" ? "Deletion requested. We'll confirm by email." : "Export requested. We'll email a download link.")
    await load()
    setBusy(null)
  }

  if (!me) return <PrivacySkeleton />
  const research = me.consents.research
  return (
    <>
      <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
        <h2 className="text-sm font-medium text-ink">Account</h2>
        {/* Label above value on phones, side by side from medium up. */}
        <dl className="mt-2 grid grid-cols-1 text-[13px] medium:grid-cols-[120px_1fr] medium:gap-y-1">
          <dt className="text-muted">Email</dt>
          <dd className="font-mono break-all text-ink">{me.email}</dd>
          <dt className="mt-2 text-muted medium:mt-0">Member since</dt>
          <dd className="text-ink-2">{new Date(me.createdAt).toLocaleDateString()}</dd>
          <dt className="mt-2 text-muted medium:mt-0">Terms accepted</dt>
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
        <div className="mt-3 flex flex-col gap-2 medium:flex-row">
          <button type="button" disabled={!!busy} onClick={() => void request("export")} className="rounded-lg border border-line bg-bg px-3 py-2 text-xs font-medium text-ink transition hover:border-line-2 disabled:opacity-40 pointer-coarse:min-h-11">
            Request export
          </button>
          <button type="button" disabled={!!busy} onClick={() => void request("delete")} className="rounded-lg border border-err/30 bg-bg px-3 py-2 text-xs font-medium text-err transition hover:border-err/60 disabled:opacity-40 pointer-coarse:min-h-11">
            Delete account…
          </button>
        </div>
        {msg && <div className="mt-2 text-xs text-ok">{msg}</div>}
        {me.requests.length > 0 && (
          <ul className="mt-3 divide-y divide-line text-[12px]">
            {me.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-3 gap-y-0.5 py-1.5">
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

/** The account card and two switch cards, at their real heights. */
function PrivacySkeleton() {
  const card = "mt-6 rounded-xl border border-line bg-surface p-4 shadow-card"
  return (
    <div aria-busy className="skel-in">
      <section className={card}>
        <Skel className="h-4 w-20" />
        <div className="mt-3 space-y-2">
          {["w-56", "w-28", "w-32"].map((w) => (
            <div key={w} className="flex gap-4">
              <Skel className="h-3.5 w-[104px]" />
              <Skel className={`h-3.5 ${w}`} />
            </div>
          ))}
        </div>
      </section>
      {[0, 1].map((i) => (
        <section key={i} className={card}>
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skel className="h-4 w-40" />
              <Skel className="h-3.5 w-full" />
              <Skel className="h-3.5 w-[70%]" />
            </div>
            <Skel className="mt-0.5 h-6 w-11 rounded-full" />
          </div>
          <Skel className="mt-3 h-3 w-10" />
        </section>
      ))}
    </div>
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
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 ${on ? "bg-accent" : "bg-line-2"}`}
          title={on ? onLabel : offLabel}
        >
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>
      <div className="mt-2 text-[11px] text-muted">{on ? onLabel : offLabel}</div>
    </section>
  )
}
