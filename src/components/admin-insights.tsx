"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { fmtRelative } from "@/lib/format"
import { modelLabel } from "@/lib/model-label"
import { providerName } from "@/lib/model-registry"

type ModelRow = { provider: string; model: string; requests: number; viaAuto: number; failed: number; busy: number; ttftMs: number | null; up: number; down: number }
type Data = {
  generatedAt: number
  growth: { users: number; new7: number; newPrev7: number; active7: number; activePrev7: number }
  funnel: { step: string; users: number }[]
  quality: { turns: number; up: number; down: number; stopped: number; errors: number; denied: number }
  models: ModelRow[]
  research: { consenting: number; users: number; chats: number; messages: number; rated: number }
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—")

/**
 * The admin's decision view (/api/admin/insights): each block answers one
 * question and says in a line what to do with the answer. Counts only.
 */
export function Insights() {
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/insights", { cache: "no-store" }).catch(() => null)
    if (r?.ok) {
      setData(await r.json())
      setFailed(false)
    } else setFailed(true)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  return (
    <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-ink">Insights</h2>
        {data && <span className="text-xs text-muted">updated {fmtRelative(data.generatedAt)}</span>}
        <button type="button" onClick={() => void load()} className="ml-auto text-xs text-muted hover:text-ink">
          Refresh
        </button>
      </div>
      {failed && !data && <p className="mt-3 text-sm text-err">Couldn&apos;t load insights.</p>}
      {!data && !failed && <p className="mt-3 text-sm text-muted">Loading…</p>}
      {data && (
        <div className="mt-4 space-y-6">
          <Block title="Is it growing?" hint="Active means sent at least one message that week.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="People" value={data.growth.users} />
              <Stat label="New this week" value={data.growth.new7} sub={`last week ${data.growth.newPrev7}`} />
              <Stat label="Active this week" value={data.growth.active7} sub={`last week ${data.growth.activePrev7}`} />
            </div>
          </Block>

          <Block title="Where do people drop off?" hint="Fix the step with the biggest drop first.">
            <Funnel steps={data.funnel} />
          </Block>

          <Block title="Are the answers good?" hint="Last 30 days. More stops or thumbs-down than usual means replies are missing the mark.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Thumbs up" value={data.quality.up} sub={data.quality.up + data.quality.down > 0 ? `${pct(data.quality.up, data.quality.up + data.quality.down)} of ratings` : "no ratings yet"} />
              <Stat label="Thumbs down" value={data.quality.down} />
              <Stat label="Stopped by the user" value={data.quality.stopped} sub={`${pct(data.quality.stopped, data.quality.turns)} of ${data.quality.turns} messages`} />
              <Stat label="Permission denied" value={data.quality.denied} sub={`${data.quality.errors} replies ended in an error`} />
            </div>
          </Block>

          <Block title="Which models work?" hint="Last 30 days. Auto should lean on models with few failures, a quick first token and good ratings.">
            <Models rows={data.models} />
          </Block>

          <Block title="Research data" hint="Only people who opted in. Keys, secrets, emails and paths are scrubbed; attachments are left out.">
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-2">
              <span>
                <b className="font-medium text-ink">{data.research.consenting}</b> of {data.research.users} people opted in · {data.research.chats} chats · {data.research.messages} messages · {data.research.rated} rated replies
              </span>
              {data.research.consenting > 0 ? (
                <a href="/api/admin/research-export" className="ml-auto rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-line-2 hover:text-ink">
                  Download dataset (.jsonl)
                </a>
              ) : null}
            </div>
          </Block>
        </div>
      )}
    </section>
  )
}

function Block({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] font-medium text-ink">{title}</h3>
      <p className="mb-2 text-xs text-muted">{hint}</p>
      {children}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="font-serif text-[1.35rem] font-medium tracking-tight text-ink tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  )
}

function Funnel({ steps }: { steps: Data["funnel"] }) {
  const top = steps[0]?.users ?? 0
  // The step that loses the largest share of the people who reached the step before it.
  let worst = -1
  let worstLoss = 0
  steps.forEach((s, i) => {
    const prev = steps[i - 1]?.users ?? 0
    const loss = i > 0 && prev > 0 ? (prev - s.users) / prev : 0
    if (loss > worstLoss) {
      worstLoss = loss
      worst = i
    }
  })
  return (
    <ul className="space-y-1.5">
      {steps.map((s, i) => (
        <li key={s.step} className="grid grid-cols-[170px_1fr_90px] items-center gap-3 text-[13px]">
          <span className="text-ink-2">{s.step}</span>
          <span className="h-2 overflow-hidden rounded bg-surface-2">
            <span className={`block h-full rounded ${i === worst ? "bg-warn" : "bg-accent"}`} style={{ width: top > 0 ? `${(s.users / top) * 100}%` : "0%" }} />
          </span>
          <span className="text-right tabular-nums text-ink-2">
            {s.users} <span className="text-muted">{i > 0 ? pct(s.users, top) : ""}</span>
          </span>
        </li>
      ))}
      {worst > 0 && (
        <li className="pt-1 text-xs text-warn">
          Biggest drop: {steps[worst - 1].step.toLowerCase()} → {steps[worst].step.toLowerCase()} ({Math.round(worstLoss * 100)}% lost)
        </li>
      )}
    </ul>
  )
}

function Models({ rows }: { rows: ModelRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No Auto or Fast traffic and no ratings yet.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th className="py-1 font-medium">Model</th>
            <th className="py-1 text-right font-medium">Requests</th>
            <th className="py-1 text-right font-medium">Picked by Auto</th>
            <th className="py-1 text-right font-medium">Failed</th>
            <th className="py-1 text-right font-medium">Busy</th>
            <th className="py-1 text-right font-medium">First token</th>
            <th className="py-1 text-right font-medium">👍 / 👎</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={`${r.provider}/${r.model}`}>
              <td className="py-2 text-ink">
                {modelLabel(r.model)} <span className="text-muted">· {providerName(r.provider)}</span>
              </td>
              <td className="py-2 text-right tabular-nums text-ink-2">{r.requests || "—"}</td>
              <td className="py-2 text-right tabular-nums text-ink-2">{r.requests ? r.viaAuto : "—"}</td>
              <td className={`py-2 text-right tabular-nums ${r.requests && r.failed / r.requests > 0.1 ? "text-err" : "text-ink-2"}`}>{r.requests ? pct(r.failed, r.requests) : "—"}</td>
              <td className="py-2 text-right tabular-nums text-ink-2">{r.requests ? pct(r.busy, r.requests) : "—"}</td>
              <td className="py-2 text-right tabular-nums text-ink-2">{r.ttftMs != null ? `${(r.ttftMs / 1000).toFixed(1)} s` : "—"}</td>
              <td className="py-2 text-right tabular-nums text-ink-2">
                {r.up} / {r.down}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
