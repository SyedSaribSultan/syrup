"use client"

import Link from "next/link"
import { useEffect, useState, type ReactNode } from "react"
import { useOptionalEngine } from "@/lib/engine-store"
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
type RSums = { requests: number; ok: number; rateLimited: number; errors: number; timeouts: number; input: number; output: number; cost: number; avgLatency: number; avgTtft: number | null }
type Usage = {
  days: number
  totals: Sums
  byModel: (Sums & { providerId: string; modelId: string; free: number })[]
  byDay: (Sums & { day: string })[]
  /** Cloud rows carry the workspace (chat URLs are per workspace) and the stored title. */
  bySession: (Sums & { sessionId: string; last: number; workspaceId?: string; title?: string | null })[]
  routed: { totals: RSums; byBackend: (RSums & { alias: string; providerId: string; modelId: string; tier: string })[] }
}

export default function UsagePage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<Usage | null>(null)
  // The bar tapped last: touch screens have no hover, so a tap shows the day's numbers.
  const [picked, setPicked] = useState<string | null>(null)
  const sessions = useOptionalEngine()?.sessions

  useEffect(() => {
    let alive = true
    void fetch(`/api/usage?days=${days}`)
      .then((r) => (r.ok ? (r.json() as Promise<Usage>) : null))
      .then((d) => {
        if (alive && d) setData(d)
      })
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
  const loading = !data
  // Switching the window keeps the old numbers on screen, dimmed, until the new ones land.
  const stale = !!data && data.days !== days
  const pickedDay = data?.byDay.find((d) => d.day === picked)
  const dayCount = data?.byDay.length ?? 0

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-4 py-8 medium:px-6">
        {/* On phones the range control sits under the title. */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="w-full medium:w-auto medium:min-w-0 medium:flex-1">
            <h1 className="font-display text-heading text-ink">Usage & cost</h1>
            <p className="mt-2 text-base text-ink-2">Every token the agent used, as reported by the engine. Free-tier usage is shown separately from paid spend.</p>
          </div>
          <div role="group" aria-label="Window" className="s-seg">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className="s-seg__item">
                {d}d
              </button>
            ))}
          </div>
        </div>

        <div className={`motion-fade ${stale ? "opacity-50" : ""}`}>
          <div className="grid grid-cols-2 gap-3 expanded:grid-cols-4">
            <Stat loading={loading} label="Spent" value={fmtCost(spent)} hint={data && spent === 0 ? "All free so far" : rt && rt.cost > 0 ? `${fmtCost(rt.cost)} via router` : undefined} />
            <Stat loading={loading} label="Tokens" value={fmtTokens(allTokens)} hint={t ? `${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out` : undefined} />
            <Stat loading={loading} label="Free tokens" value={fmtTokens(t?.freeTokens)} hint={allTokens ? `${Math.round(((t?.freeTokens ?? 0) / allTokens) * 100)}% of total` : undefined} />
            <Stat loading={loading} label="Messages" value={String(t?.messages ?? 0)} hint={t ? `${fmtTokens(t.cacheRead)} cached reads` : undefined} />
          </div>

          <Section title="By day">
            {data && data.byDay.length === 0 && <Empty />}
            {/* Touch: the tapped bar's numbers, in a line of their own (a floating tip would run off a phone's edge). */}
            {dayCount > 0 && (
              <div className="s-meta mb-2 truncate tabular-nums pointer-fine:hidden">
                {pickedDay ? (
                  <span className="text-ink">
                    {pickedDay.day} · {fmtTokens(pickedDay.input + pickedDay.output + pickedDay.reasoning)} · {fmtCost(pickedDay.cost)}
                  </span>
                ) : (
                  "Tap a bar to see its day."
                )}
              </div>
            )}
            <div className={`flex h-28 items-end ${dayCount > 40 ? "gap-px" : "gap-0.5 medium:gap-1"}`}>
              {loading && <DaySkeleton />}
              {data?.byDay.map((d, i) => {
                const v = d.input + d.output + d.reasoning
                const on = picked === d.day
                // Keep the hover tip inside the card at either end of the chart.
                const edge = i < dayCount * 0.15 ? "left-0" : i >= dayCount * 0.85 ? "right-0" : "left-1/2 -translate-x-1/2"
                return (
                  <button
                    key={d.day}
                    type="button"
                    aria-label={`${d.day}: ${fmtTokens(v)} tokens, ${fmtCost(d.cost)}`}
                    aria-pressed={on}
                    onClick={() => setPicked(on ? null : d.day)}
                    className="group relative flex h-full min-w-0 flex-1 items-end"
                  >
                    {/* Chart rules (03 B21): one ink series; brand only for the one highlighted bar (hover or picked). */}
                    <div className={`w-full rounded-t-sm transition group-hover:bg-accent-fill ${on ? "bg-accent-fill" : "bg-ink"}`} style={{ height: `${Math.max(3, (v / maxDay) * 100)}%` }} />
                    <div className={`s-chart-tip absolute bottom-full z-tooltip mb-2 hidden whitespace-nowrap opacity-0 transition pointer-fine:flex pointer-fine:group-hover:opacity-100 ${edge}`}>
                      <span className="s-chart-tip__label">{d.day}</span>
                      <span className="s-chart-tip__value">
                        {fmtTokens(v)} · {fmtCost(d.cost)}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section title="By model">
            {loading && <TableSkeleton />}
            {data && data.byModel.length === 0 && <Empty />}
            <Table
              head={["Model", "Provider", "Messages", "In", "Out", "Cost"]}
              rows={(data?.byModel ?? []).map((m) => [
                <span key="m" className="flex items-center gap-1.5">
                  {m.modelId}
                  {m.free === 1 && <span className="s-badge">Free</span>}
                </span>,
                m.providerId,
                String(m.messages),
                fmtTokens(m.input),
                fmtTokens(m.output),
                fmtCost(m.cost),
              ])}
              cards={(data?.byModel ?? []).map((m) => ({
                title: (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{m.modelId}</span>
                    {m.free === 1 && <span className="s-badge shrink-0">Free</span>}
                  </span>
                ),
                sub: m.providerId,
                value: fmtCost(m.cost),
                fields: [
                  ["Messages", String(m.messages)],
                  ["In", fmtTokens(m.input)],
                  ["Out", fmtTokens(m.output)],
                ],
              }))}
            />
          </Section>

          <Section title="Routed via syrup">
            {loading && <TableSkeleton />}
            {data && data.routed.byBackend.length === 0 && <Empty />}
            {rt && rt.requests > 0 && (
              <div className="s-meta mb-3">
                {rt.requests} requests · {rt.ok} ok · {rt.rateLimited} rate limited · {rt.errors} errors{rt.timeouts > 0 ? ` · ${rt.timeouts} timeouts` : ""} · {Math.round(rt.avgLatency)}ms avg
                {rt.avgTtft != null ? ` · ${fmtSeconds(rt.avgTtft)} to first token` : ""}
              </div>
            )}
            <Table
              head={["Backend", "Alias", "Tier", "Requests", "Rate limited", "Timeouts", "First token", "In", "Out", "Cost"]}
              rows={(data?.routed.byBackend ?? []).map((b) => [
                <span key="b">
                  <span className="text-muted">{b.providerId}/</span>
                  {b.modelId}
                </span>,
                b.alias,
                <span key="t" className="s-badge">
                  {b.tier === "free" ? "Free" : "Paid"}
                </span>,
                String(b.requests),
                String(b.rateLimited),
                String(b.timeouts),
                b.avgTtft != null ? fmtSeconds(b.avgTtft) : <span key="f" className="text-muted">None</span>,
                fmtTokens(b.input),
                fmtTokens(b.output),
                fmtCost(b.cost),
              ])}
              cards={(data?.routed.byBackend ?? []).map((b) => ({
                title: (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">
                      <span className="text-muted">{b.providerId}/</span>
                      {b.modelId}
                    </span>
                    <span className="s-badge shrink-0">{b.tier === "free" ? "Free" : "Paid"}</span>
                  </span>
                ),
                value: fmtCost(b.cost),
                fields: [
                  ["Requests", String(b.requests)],
                  ["Rate limited", String(b.rateLimited)],
                  ["First token", b.avgTtft != null ? fmtSeconds(b.avgTtft) : "None"],
                ],
                more: [
                  ["Alias", b.alias],
                  ["Timeouts", String(b.timeouts)],
                  ["In", fmtTokens(b.input)],
                  ["Out", fmtTokens(b.output)],
                ],
              }))}
            />
          </Section>

          <Section title="By session">
            {loading && <TableSkeleton />}
            {data && data.bySession.length === 0 && <Empty />}
            <Table
              head={["Session", "Last active", "Messages", "Tokens", "Cost"]}
              rows={(data?.bySession ?? []).map((s) => [
                <Link key="s" href={s.workspaceId ? `/w/${s.workspaceId}/s/${s.sessionId}` : `/s/${s.sessionId}`} className="s-table__link">
                  {s.title || sessions?.[s.sessionId]?.title || s.sessionId}
                </Link>,
                fmtRelative(s.last),
                String(s.messages),
                fmtTokens(s.input + s.output + s.reasoning),
                fmtCost(s.cost),
              ])}
              cards={(data?.bySession ?? []).map((s) => ({
                title: (
                  <Link href={s.workspaceId ? `/w/${s.workspaceId}/s/${s.sessionId}` : `/s/${s.sessionId}`} className="block truncate text-ink">
                    {s.title || sessions?.[s.sessionId]?.title || s.sessionId}
                  </Link>
                ),
                value: fmtCost(s.cost),
                fields: [
                  ["Last active", fmtRelative(s.last)],
                  ["Messages", String(s.messages)],
                  ["Tokens", fmtTokens(s.input + s.output + s.reasoning)],
                ],
              }))}
            />
          </Section>
        </div>
      </div>
    </div>
  )
}

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** A KPI (s-kpi, 03 B21) in a P2 card: label, Code value, hint. */
function Stat({ label, value, hint, loading }: { label: string; value: string; hint?: string; loading?: boolean }) {
  return (
    <div className="s-card s-card--compact">
      <div className="s-kpi">
        <span className="s-kpi__label">{label}</span>
        {loading ? (
          <div aria-busy className="skel-in flex flex-col gap-2 py-1">
            <span className="s-skeleton s-skeleton--row w-20" />
            <span className="s-skeleton s-skeleton--line w-24" />
          </div>
        ) : (
          <>
            <span className="s-kpi__value">{value}</span>
            {hint && <span className="s-kpi__delta">{hint}</span>}
          </>
        )}
      </div>
    </div>
  )
}

/** Bars of made-up but fixed heights, so the chart has a shape while it loads. */
function DaySkeleton() {
  return (
    <div aria-busy className="skel-in flex h-full flex-1 items-end gap-1">
      {Array.from({ length: 30 }, (_, i) => (
        <span key={i} className="s-skeleton flex-1 rounded-b-none" style={{ height: `${22 + Math.round(38 * (0.5 + 0.5 * Math.sin(i * 0.7)) + 18 * (0.5 + 0.5 * Math.sin(i * 2.3)))}%` }} />
      ))}
    </div>
  )
}

function TableSkeleton() {
  return (
    <div aria-busy className="skel-in flex flex-col">
      <span className="s-skeleton s-skeleton--line mb-3 w-2/5" />
      {["w-44", "w-36", "w-52"].map((w) => (
        <div key={w} className="flex items-center gap-6 border-t border-line py-3">
          <span className={`s-skeleton s-skeleton--line ${w}`} />
          <span className="flex-1" />
          <span className="s-skeleton s-skeleton--line w-10" />
          <span className="s-skeleton s-skeleton--line w-12" />
        </div>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-lg text-ink">{title}</h2>
      {/* A P2 card and a container, so the tables can switch to cards by the card's own width (the sidebar changes it too). */}
      <div className="s-card @container">{children}</div>
    </section>
  )
}

function Empty() {
  return <p className="s-empty-line py-6 text-center">Nothing yet in this window. Pick a longer one above.</p>
}

type Card = { title: ReactNode; sub?: string; value: string; fields: [string, string][]; more?: [string, string][] }

/**
 * A table from a medium-sized card up, scrolling sideways inside the card if it
 * still doesn't fit; below that, one card per row: name and cost first, the
 * other numbers in a small grid, and the rest behind "More".
 */
function Table({ head, rows, cards }: { head: string[]; rows: ReactNode[][]; cards: Card[] }) {
  if (rows.length === 0) return null
  return (
    <>
      <ul className="divide-y divide-line @[500px]:hidden">
        {cards.map((c, i) => (
          <RowCard key={i} c={c} />
        ))}
      </ul>
      <div className="s-table s-table--dense hidden @[500px]:block">
        <TableView head={head} rows={rows} />
      </div>
    </>
  )
}

function RowCard({ c }: { c: Card }) {
  const cell = ([label, value]: [string, string]) => (
    <div key={label} className="min-w-0">
      <dt className="s-meta truncate">{label}</dt>
      <dd className="truncate tabular-nums text-ink-2">{value}</dd>
    </div>
  )
  return (
    <li className="py-2.5 text-sm first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 text-ink">{c.title}</div>
        <div className="shrink-0 tabular-nums text-ink">{c.value}</div>
      </div>
      {c.sub && <div className="s-meta truncate">{c.sub}</div>}
      <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1.5">{c.fields.map(cell)}</dl>
      {c.more && (
        <details className="group mt-1">
          <summary className="s-btn s-btn--link-neutral s-btn--sm list-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">More</span>
            <span className="hidden group-open:inline">Less</span>
          </summary>
          <dl className="mt-1 grid grid-cols-3 gap-x-3 gap-y-1.5">{c.more.map(cell)}</dl>
        </details>
      )}
    </li>
  )
}

/** s-table (03 A15, B7): bottom hairlines only, 500 ink head, muted cells; numbers right-aligned in Code. */
function TableView({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  const numeric = head.map((_, j) => j > 0 && rows.every((r) => typeof r[j] === "string" && /^[\d$.,<~]/.test(r[j] as string)))
  return (
    <table>
      <thead>
        <tr>
          {head.map((h, j) => (
            <th key={h} className={`whitespace-nowrap ${numeric[j] ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={`${j === 0 ? "text-ink" : "whitespace-nowrap"} ${numeric[j] ? "s-col-num" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
