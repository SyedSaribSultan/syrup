"use client"

import { useEffect, useState } from "react"
import type { MessageEntry } from "@/lib/engine-store"
import type { Part } from "@/lib/oc"
import { fmtCost, fmtTokens } from "@/lib/format"
import { modelLabel, switchNote } from "@/lib/model-label"
import { providerName } from "@/lib/model-registry"
import { answersFor, useSessionAnswers } from "@/lib/use-session-answers"
import { Brew } from "./brew"
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

export function MessageView({ entry, streaming }: { entry: MessageEntry; streaming: boolean }) {
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

  return (
    <div className="group relative">
      <div className="space-y-1">
        {visible.map((p) => (
          <PartView key={p.id} part={p} streaming={streaming} />
        ))}
        {streaming && visible.length === 0 && (
          <div className="py-2">
            <Brew mood="think" since={info.time.created} size="md" />
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
      {/* Hover-only in the app; a shared snapshot shows it always (touch screens have no hover). */}
      {!streaming && routedLine && <div className={`mt-1.5 text-[11px] text-muted ${ro ? "" : "opacity-0 transition group-hover:opacity-100"}`}>{routedLine}</div>}
      {!streaming && !routedLine && (tokens > 0 || info.cost > 0) && (
        <div className={`mt-1.5 text-[11px] text-muted ${ro ? "" : "opacity-0 transition group-hover:opacity-100"}`}>
          {info.modelID} · {fmtTokens(tokens)} tokens · {fmtCost(info.cost)}
        </div>
      )}
    </div>
  )
}
