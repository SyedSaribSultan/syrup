"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { fmtRelative } from "@/lib/format"
import { modelLabel } from "@/lib/model-label"
import { providerName } from "@/lib/model-registry"
import { Button } from "./ui/s"

type ModelRow = { provider: string; model: string; requests: number; viaAuto: number; failed: number; busy: number; ttftMs: number | null; up: number; down: number }
type Data = {
  generatedAt: number
  growth: { users: number; new7: number; newPrev7: number; active7: number; activePrev7: number }
  funnel: { step: string; users: number }[]
  quality: { turns: number; up: number; down: number; stopped: number; errors: number; denied: number }
  models: ModelRow[]
  research: { consenting: number; users: number; chats: number; messages: number; rated: number }
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "None")

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
    <section className="s-card mt-6">
      <div className="flex flex-wrap items-center gap-x-2">
        <h2 className="text-lg text-ink">Insights</h2>
        {data && <span className="s-meta">Updated {fmtRelative(data.generatedAt)}</span>}
        <Button variant="ghost" size="sm" icon="refresh-cw" onClick={() => void load()} className="ml-auto">
          Refresh
        </Button>
      </div>
      {failed && !data && <p className="s-error-line">Couldn&apos;t load insights. Refresh to try again.</p>}
      {!data && !failed && (
        <div aria-busy className="s-skeleton-stack">
          <span className="s-skeleton s-skeleton--line" />
          <span className="s-skeleton s-skeleton--line" />
          <span className="s-skeleton s-skeleton--line" />
        </div>
      )}
      {data && (
        <div className="flex flex-col gap-6">
          <Block title="Is it growing?" hint="Active means sent at least one message that week.">
            <div className="grid grid-cols-2 gap-2 medium:grid-cols-3">
              <Stat label="People" value={data.growth.users} />
              <Stat label="New this week" value={data.growth.new7} sub={`last week ${data.growth.newPrev7}`} />
              <Stat label="Active this week" value={data.growth.active7} sub={`last week ${data.growth.activePrev7}`} />
            </div>
          </Block>

          <Block title="Where do people drop off?" hint="Fix the step with the biggest drop first.">
            <Funnel steps={data.funnel} />
          </Block>

          <Block title="Are the answers good?" hint="Last 30 days. More stops or thumbs-down than usual means replies are missing the mark.">
            <div className="grid grid-cols-2 gap-2 medium:grid-cols-4">
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
            <div className="flex flex-wrap items-center gap-3 text-sm text-ink-2">
              <span>
                <strong className="font-medium text-ink">{data.research.consenting}</strong> of {data.research.users} people opted in · {data.research.chats} chats · {data.research.messages} messages · {data.research.rated} rated replies
              </span>
              {data.research.consenting > 0 ? (
                <a href="/api/admin/research-export" className="s-btn s-btn--secondary s-btn--sm ml-auto">
                  <span className="s-icon" data-icon="download" aria-hidden="true" />
                  <span className="s-btn__label">Download dataset (.jsonl)</span>
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
      <h3 className="text-base text-ink">{title}</h3>
      <p className="s-help mb-3">{hint}</p>
      {children}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="s-card s-card--compact s-kpi">
      <span className="s-kpi__label">{label}</span>
      <span className="s-kpi__value">{value}</span>
      {sub && <span className="s-kpi__delta">{sub}</span>}
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
        // Phones: step and count on one line, the bar full width under them.
        <li key={s.step} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm medium:grid-cols-[170px_1fr_90px] medium:gap-3">
          <span className="min-w-0 text-ink-2">{s.step}</span>
          {/* Progress track (s-progress geometry): ink bars, the worst step in the warning colour; never brand on repeated rows. */}
          <span className="order-last col-span-2 h-1 overflow-hidden rounded-full bg-surface-2 medium:order-none medium:col-span-1">
            <span className={`block h-full rounded-full ${i === worst ? "bg-warn" : "bg-ink"}`} style={{ width: top > 0 ? `${(s.users / top) * 100}%` : "0%" }} />
          </span>
          <span className="text-right tabular-nums text-ink-2">
            {s.users} <span className="text-muted">{i > 0 ? pct(s.users, top) : ""}</span>
          </span>
        </li>
      ))}
      {worst > 0 && (
        <li className="pt-1 text-sm text-warn">
          Biggest drop: {steps[worst - 1].step.toLowerCase()} → {steps[worst].step.toLowerCase()} ({Math.round(worstLoss * 100)}% lost)
        </li>
      )}
    </ul>
  )
}

function Models({ rows }: { rows: ModelRow[] }) {
  if (rows.length === 0) return <p className="s-empty-line">No Auto or Fast traffic and no ratings yet.</p>
  return (
    <div className="s-table s-table--dense">
      <table className="whitespace-nowrap">
        <thead>
          <tr>
            <th>Model</th>
            <th className="text-right">Requests</th>
            <th className="text-right">Picked by Auto</th>
            <th className="text-right">Failed</th>
            <th className="text-right">Busy</th>
            <th className="text-right">First token</th>
            <th className="text-right">Up / down</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.provider}/${r.model}`}>
              <td className="text-ink">
                {modelLabel(r.model)} <span className="text-muted">{providerName(r.provider)}</span>
              </td>
              <td className="s-col-num">{r.requests || "None"}</td>
              <td className="s-col-num">{r.requests ? r.viaAuto : "None"}</td>
              <td className={`s-col-num ${r.requests && r.failed / r.requests > 0.1 ? "text-err" : ""}`}>{r.requests ? pct(r.failed, r.requests) : "None"}</td>
              <td className="s-col-num">{r.requests ? pct(r.busy, r.requests) : "None"}</td>
              <td className="s-col-num">{r.ttftMs != null ? `${(r.ttftMs / 1000).toFixed(1)} s` : "None"}</td>
              <td className="s-col-num">
                {r.up} / {r.down}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
