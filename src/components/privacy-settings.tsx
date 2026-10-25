"use client"

import Link from "next/link"
import posthog from "posthog-js"
import { useCallback, useEffect, useState } from "react"
import { Button } from "./ui/s"
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
        ? { title: "Delete your account and all data?", body: "Your account is deactivated immediately and everything is erased within 30 days. You can't undo this.", confirmLabel: "Delete account", danger: true }
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
      {/* Settings pattern (03 B19): each group a P2 card on the canvas; label and help left, control right. */}
      <section className="s-settings__group mt-6">
        <h2 className="s-settings__title">Account</h2>
        {/* Label above value on phones, side by side from medium up. */}
        <dl className="grid grid-cols-1 text-sm medium:grid-cols-[140px_1fr] medium:gap-y-2">
          <dt className="text-ink-2">Email</dt>
          <dd className="font-mono break-all text-ink">{me.email}</dd>
          <dt className="mt-2 text-ink-2 medium:mt-0">Member since</dt>
          <dd className="text-ink">{new Date(me.createdAt).toLocaleDateString()}</dd>
          <dt className="mt-2 text-ink-2 medium:mt-0">Terms accepted</dt>
          <dd className="text-ink">
            {me.consents.terms.at ? new Date(me.consents.terms.at).toLocaleDateString() : "Not yet"}{" "}
            <Link href="/legal/terms" className="s-link">
              Read them
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
        <Link href="/legal/privacy" className="s-link">
          Details
        </Link>
        .
      </Toggle>

      <Toggle title="Research data consent" on={research.granted} busy={busy === "research"} onChange={(v) => void patch({ research: v }, "research")} onLabel="Consented" offLabel="Off">
        Allow the <em>content</em> of your conversations with the agent to be used to improve syrup and for anonymized research. Off by default, never required, revocable here at any time.{" "}
        <Link href="/legal/research" className="s-link">
          Exactly what this means
        </Link>
        .{research.granted && research.at && <span> Granted {new Date(research.at).toLocaleDateString()}.</span>}
      </Toggle>

      <section className="s-settings__group mt-6">
        <div className="s-settings__head">
          <h2 className="s-settings__title">Your data</h2>
          <p className="s-settings__desc">Export everything we hold about you, or delete your account. Requests are recorded with a timestamp and handled within the times published in the Privacy Policy.</p>
        </div>
        {/* The danger zone (03 B19): export is secondary; delete is the error variant and opens a confirm. */}
        <div className="flex flex-col gap-2 medium:flex-row">
          <Button variant="secondary" disabled={!!busy} onClick={() => void request("export")}>
            Request export
          </Button>
          <Button variant="error" disabled={!!busy} onClick={() => void request("delete")}>
            Delete account…
          </Button>
        </div>
        {msg && <p className="text-sm text-ok">{msg}</p>}
        {me.requests.length > 0 && (
          <ul className="s-rows s-rows--divided">
            {me.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2 text-sm">
                <span className="s-badge">{r.type}</span>
                <span className="text-ink-2">{r.status}</span>
                <span className="s-meta">{new Date(r.requestedAt).toLocaleString()}</span>
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
  return (
    <div aria-busy className="skel-in">
      <section className="s-settings__group mt-6">
        <span className="s-skeleton s-skeleton--row w-20" />
        <div className="flex flex-col gap-2">
          {["w-56", "w-28", "w-32"].map((w) => (
            <div key={w} className="flex gap-4">
              <span className="s-skeleton s-skeleton--line w-[104px]" />
              <span className={`s-skeleton s-skeleton--line ${w}`} />
            </div>
          ))}
        </div>
      </section>
      {[0, 1].map((i) => (
        <section key={i} className="s-settings__group mt-6">
          <div className="flex items-start gap-4">
            <div className="s-skeleton-stack min-w-0 flex-1">
              <span className="s-skeleton s-skeleton--row w-40" />
              <span className="s-skeleton s-skeleton--line" />
              <span className="s-skeleton s-skeleton--line" />
            </div>
            <span className="s-skeleton s-skeleton--circle h-6 w-10" />
          </div>
        </section>
      ))}
    </div>
  )
}

/** A consent as a settings group with one s-switch row: the title and help left, the switch and its state right. */
function Toggle({ title, on, busy, onChange, onLabel, offLabel, children }: { title: string; on: boolean; busy: boolean; onChange(v: boolean): void; onLabel: string; offLabel: string; children: React.ReactNode }) {
  return (
    <section className="s-settings__group mt-6">
      <div className="s-setting">
        <div className="s-setting__label">
          <h2 className="s-settings__title">{title}</h2>
          <p className="s-setting__help mt-1">{children}</p>
        </div>
        <div className="s-setting__control">
          <label className="s-switch">
            <span className="s-meta">{on ? onLabel : offLabel}</span>
            <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={() => onChange(!on)} aria-label={title} />
          </label>
        </div>
      </div>
    </section>
  )
}
