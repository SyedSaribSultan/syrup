"use client"

import { useEffect, useState } from "react"
import type { MessageEntry } from "@/lib/engine-store"
import type { Part } from "@/lib/oc"
import { fmtCost, fmtTokens } from "@/lib/format"
import { modelLabel, switchNote } from "@/lib/model-label"
import { providerName } from "@/lib/model-registry"
import type { RatedModel, Rating } from "@/lib/use-feedback"
import { answersFor, useSessionAnswers } from "@/lib/use-session-answers"
import { Brew } from "./brew"
import { RouterProgress } from "./router-progress"
import { PartView } from "./parts"
import { useReadOnly } from "./read-only"

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/** A finished step with nothing streaming after it yet: the agent is between steps, so the wait needs a face. */
function settled(p: Part | undefined): boolean {
  if (!p) return false
  if (p.type === "tool") return p.state.status === "completed" || p.state.status === "error"
  if (p.type === "reasoning") return !!p.time.end
  return p.type === "patch"
}

type Props = {
  entry: MessageEntry
  streaming: boolean
  /** The thumb given to this reply, if any. */
  rating?: Rating | null
  /** Set only on the last reply of a turn, which is the one that gets thumbs. */
  onRate?: (rating: Rating | 0, model: RatedModel) => void
}

export function MessageView({ entry, streaming, rating = null, onRate }: Props) {
  const { info, parts } = entry
  // A shared snapshot: its router answers come with it, nothing is fetched and no timer runs.
  const ro = useReadOnly()

  // Auto/Fast: ask the router which real model(s) answered. Cloud and local share this path.
  const routed = info.role === "assistant" && info.providerID === "syrup"
  const completed = info.role === "assistant" ? info.time.completed : undefined
  // The router's row can land a moment after the engine marks the message done (cloud posts it via ingest), so retry briefly.
  const [retry, setRetry] = useState(0)
  const fetched = useSessionAnswers(routed && !ro ? info.sessionID : undefined, `${completed ?? ""}:${retry}`)
  const all = ro ? ro.answers : fetched
  const mine = routed && info.role === "assistant" && (completed || streaming) ? answersFor(all, info.modelID, info.time.created, completed ?? Number.POSITIVE_INFINITY) : []
  const missing = routed && !!completed && all !== null && mine.length === 0
  useEffect(() => {
    if (ro || !missing || retry >= 2 || !completed || Date.now() - completed > 60_000) return
    const t = setTimeout(() => setRetry((n) => n + 1), 2_500)
    return () => clearTimeout(t)
  }, [ro, missing, retry, completed])

  if (info.role === "user") {
    // The engine adds synthetic text parts carrying attachment contents; show only what the user typed.
    const text = parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
    const files = parts.filter((p) => p.type === "file")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-ink-2 whitespace-pre-wrap">
          {text}
          {files.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${text ? "mt-2" : ""}`}>
              {files.map((f) =>
                f.type === "file" && f.mime.startsWith("image/") && f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={f.id} src={f.url} alt={f.filename ?? "image"} className="max-h-48 rounded-lg border border-line" />
                ) : (
                  <span key={f.id} className="rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-ink-2">
                    📎 {f.type === "file" ? f.filename ?? f.mime : "file"}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const visible = parts.filter((p) => p.type !== "step-start" && p.type !== "step-finish" && p.type !== "snapshot")
  const tokens = info.tokens ? info.tokens.input + info.tokens.output + info.tokens.reasoning : 0
  const err = info.error

  const final = mine.length > 0 ? mine[mine.length - 1] : null
  const note = final && all ? switchNote(mine, all, info.time.created) : null
  const ttft = final?.ttftMs ?? null
  const routedLine = final
    ? [
        `${info.modelID === "fast" ? "Fast" : "Auto"} → ${modelLabel(final.modelId)}`,
        providerName(final.providerId),
        ttft != null ? `${seconds(ttft)} to first token` : null,
        tokens > 0 ? `${fmtTokens(tokens)} tokens` : null,
        info.cost > 0 ? fmtCost(info.cost) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null

  const meta = routedLine ?? (tokens > 0 || info.cost > 0 ? `${info.modelID} · ${fmtTokens(tokens)} tokens · ${fmtCost(info.cost)}` : null)
  const rateable = !!onRate && !ro && !streaming
  const answeredBy: RatedModel = routed
    ? { alias: info.modelID, providerId: final?.providerId ?? null, modelId: final?.modelId ?? null }
    : { alias: null, providerId: info.providerID, modelId: info.modelID }

  return (
    <div className="group relative">
      <div className="space-y-1">
        {visible.map((p) => (
          <PartView key={p.id} part={p} streaming={streaming} />
        ))}
        {streaming && visible.length === 0 && (
          <div className="py-2">
            <Brew mood="think" since={info.time.created} size="md" />
            {routed && !ro && <RouterProgress sessionID={info.sessionID} since={info.time.created} active />}
          </div>
        )}
        {streaming && settled(visible[visible.length - 1]) && (
          <div className="py-1.5">
            <Brew mood="work" />
          </div>
        )}
        {err && (
          <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err">
            {"data" in err && err.data && typeof err.data === "object" && "message" in err.data ? String(err.data.message) : err.name}
          </div>
        )}
      </div>
      {note && <div className="mt-1.5 text-[11px] text-muted">{note}</div>}
      {!streaming && (meta || rateable) && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
          {rateable && <Thumbs value={rating} onRate={(r) => onRate(r, answeredBy)} />}
          {/* Hover-only with a mouse; a touch screen shows it under each turn's last reply, a shared snapshot always. */}
          {meta && <span className={`min-w-0 truncate ${ro ? "" : `opacity-0 transition group-hover:opacity-100 ${onRate ? "pointer-coarse:opacity-100" : ""}`}`}>{meta}</span>}
        </div>
      )}
    </div>
  )
}

// Lucide thumbs-up / thumbs-down (ISC).
const THUMB_UP = "M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
const THUMB_DOWN = "M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"

/** Thumbs on a finished reply. Hover-only until one is chosen; clicking the chosen thumb again clears it. */
function Thumbs({ value, onRate }: { value: Rating | null; onRate: (r: Rating | 0) => void }) {
  const thumb = (r: Rating, label: string, d: string) => (
    <button type="button" title={label} aria-label={label} aria-pressed={value === r} onClick={() => onRate(value === r ? 0 : r)} className={`rounded p-0.5 transition hover:text-ink pointer-coarse:p-2.5 ${value === r ? "text-ink" : ""}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill={value === r ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    </button>
  )
  return (
    <span className={`flex items-center gap-0.5 pointer-coarse:-my-2 pointer-coarse:-ml-2.5 ${value ? "" : "opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"}`}>
      {thumb(1, "Good reply", THUMB_UP)}
      {thumb(-1, "Bad reply", THUMB_DOWN)}
    </span>
  )
}
