"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useEngine } from "@/lib/engine-store"
import { fmtCost, fmtRelative, fmtTokens } from "@/lib/format"

type Sums = {
  messages: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  freeTokens: number
  paidTokens: number
}
type RSums = { requests: number; ok: number; rateLimited: number; errors: number; input: number; output: number; cost: number; avgLatency: number }
type Usage = {
  days: number
  totals: Sums
  byModel: (Sums & { providerId: string; modelId: string; free: number })[]
  byDay: (Sums & { day: string })[]
  bySession: (Sums & { sessionId: string; last: number })[]
  routed: { totals: RSums; byBackend: (RSums & { alias: string; providerId: string; modelId: string; tier: string })[] }
}

export default function UsagePage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Usage | null>(null)
  const { sessions } = useEngine()

  useEffect(() => {
    let alive = true
    void fetch(`/api/usage?days=${days}`)
      .then((r) => r.json())
      .then((d: Usage) => alive && setData(d))
    return () => {
      alive = false
    }
  }, [days])

  const t = data?.totals
  const rt = data?.routed.totals
  const allTokens = t ? t.input + t.output + t.reasoning : 0
  // Engine-reported cost plus what the router actually spent on syrup/* requests.
  const spent = (t?.cost ?? 0) + (rt?.cost ?? 0)
  const maxDay = data ? Math.max(1, ...data.byDay.map((d) => d.input + d.output + d.reasoning)) : 1

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Usage & cost</h1>
            <p className="mt-1 text-sm text-muted">Every token the agent used, as reported by the engine. Free-tier usage is shown separately from paid spend.</p>
          </div>
          <div className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" onClick={() => setDays(d)} className={`rounded-md px-2.5 py-1 transition ${days === d ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {d}d
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Spent" value={fmtCost(spent)} hint={data && spent === 0 ? "all free so far" : rt && rt.cost > 0 ? `${fmtCost(rt.cost)} via router` : undefined} accent />
          <Stat label="Tokens" value={fmtTokens(allTokens)} hint={t ? `${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out` : undefined} />
          <Stat label="Free tokens" value={fmtTokens(t?.freeTokens)} hint={allTokens ? `${Math.round(((t?.freeTokens ?? 0) / allTokens) * 100)}% of total` : undefined} />
          <Stat label="Messages" value={String(t?.messages ?? 0)} hint={t ? `${fmtTokens(t.cacheRead)} cached reads` : undefined} />
        </div>

        <Section title="By day">
          {data && data.byDay.length === 0 && <Empty />}
          <div className="flex h-28 items-end gap-1">
            {data?.byDay.map((d) => {
              const v = d.input + d.output + d.reasoning
              return (
                <div key={d.day} className="group relative flex h-full flex-1 items-end">
                  <div className="w-full rounded-t-sm bg-accent/70 transition group-hover:bg-accent" style={{ height: `${Math.max(3, (v / maxDay) * 100)}%` }} />
                  <div className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 text-[10px] whitespace-nowrap text-bg opacity-0 transition group-hover:opacity-100">
                    {d.day} · {fmtTokens(v)} · {fmtCost(d.cost)}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title="By model">
          {data && data.byModel.length === 0 && <Empty />}
          <Table
            head={["Model", "Provider", "Messages", "In", "Out", "Cost"]}
            rows={(data?.byModel ?? []).map((m) => [
              <span key="m" className="flex items-center gap-1.5">
                {m.modelId}
                {m.free === 1 && <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">free</span>}
              </span>,
              m.providerId,
              String(m.messages),
              fmtTokens(m.input),
              fmtTokens(m.output),
              fmtCost(m.cost),
            ])}
          />
        </Section>

        <Section title="Routed via syrup">
          {data && data.routed.byBackend.length === 0 && <Empty />}
          {rt && rt.requests > 0 && (
            <div className="mb-3 text-xs text-muted">
              {rt.requests} requests · {rt.ok} ok · {rt.rateLimited} rate limited · {rt.errors} errors · {Math.round(rt.avgLatency)}ms avg
            </div>
          )}
          <Table
            head={["Backend", "Alias", "Tier", "Requests", "Rate limited", "In", "Out", "Cost"]}
            rows={(data?.routed.byBackend ?? []).map((b) => [
              <span key="b">
                <span className="text-muted">{b.providerId}/</span>
                {b.modelId}
              </span>,
              b.alias,
              <span key="t" className={`rounded px-1 text-[10px] font-medium ${b.tier === "free" ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-2"}`}>
                {b.tier}
              </span>,
              String(b.requests),
              String(b.rateLimited),
              fmtTokens(b.input),
              fmtTokens(b.output),
              fmtCost(b.cost),
            ])}
          />
        </Section>

        <Section title="By session">
          {data && data.bySession.length === 0 && <Empty />}
          <Table
            head={["Session", "Last active", "Messages", "Tokens", "Cost"]}
            rows={(data?.bySession ?? []).map((s) => [
              <Link key="s" href={`/s/${s.sessionId}`} className="text-ink hover:underline">
                {sessions[s.sessionId]?.title || s.sessionId}
              </Link>,
              fmtRelative(s.last),
              String(s.messages),
              fmtTokens(s.input + s.output + s.reasoning),
              fmtCost(s.cost),
            ])}
          />
        </Section>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 font-serif text-[1.6rem] font-medium tracking-tight ${accent ? "text-accent" : "text-ink"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-medium text-ink">{title}</h2>
      <div className="rounded-xl border border-line bg-surface p-4 shadow-card">{children}</div>
    </section>
  )
}

function Empty() {
  return <div className="py-6 text-center text-sm text-muted">Nothing yet in this window.</div>
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return null
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] font-medium uppercase tracking-wider text-muted">
          {head.map((h) => (
            <th key={h} className="pb-2 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-line text-ink-2">
            {r.map((c, j) => (
              <td key={j} className={`py-2 ${j === 0 ? "text-ink" : ""} ${j >= 2 ? "tabular-nums" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
