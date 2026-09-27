"use client"

import { useEffect, useState } from "react"
import type { MessageEntry } from "@/lib/engine-store"
import { fmtCost, fmtTokens } from "@/lib/format"
import { displayName, providerName } from "@/lib/model-registry"
import type { Answer } from "@/lib/router-status"
import { answersFor, routerSwitch, useSessionAnswers } from "@/lib/use-session-answers"
import { PartView } from "./parts"

/** "kimi-k3" → "Kimi K3" when the id is all we have. */
function modelLabel(id: string): string {
  const bare = id.replace(/[:-]free$/i, "")
  const name = displayName({ id: bare })
  if (name !== bare.split("/").pop()) return name
  return name
    .split("-")
    .map((t) => (/^(gpt|glm|oss|llm)$/i.test(t) ? t.toUpperCase() : /^\d+[bk]$/i.test(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(" ")
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function backendLabel(a: Answer): string {
  return `${modelLabel(a.modelId)} (${providerName(a.providerId)})`
}

/** A visible line when the router changed models or retried for this message, so switches are never silent. */
function switchNote(mine: Answer[], all: Answer[], created: number): string | null {
  const s = routerSwitch(mine, all, created)
  if (!s) return null
  if (s.kind === "stopped") return `Switched to ${backendLabel(s.to)} — ${listNames([...new Set(s.from.map((a) => modelLabel(a.modelId)))])} stopped mid-answer`
  if (s.kind === "escalated") return `Escalated from ${modelLabel(s.from.modelId)} to ${backendLabel(s.to)} for a harder step`
  if (s.kind === "unavailable") return `Switched to ${backendLabel(s.to)} — ${modelLabel(s.from.modelId)} was busy`
  return `${backendLabel(s.to)} answered after ${s.to.attempts} tries — the first pick was busy`
}

export function MessageView({ entry, streaming }: { entry: MessageEntry; streaming: boolean }) {
  const { info, parts } = entry

  // Auto/Fast: ask the router which real model(s) answered. Cloud and local share this path.
  const routed = info.role === "assistant" && info.providerID === "syrup"
  const completed = info.role === "assistant" ? info.time.completed : undefined
  // The router's row can land a moment after the engine marks the message done (cloud posts it via ingest), so retry briefly.
  const [retry, setRetry] = useState(0)
  const all = useSessionAnswers(routed ? info.sessionID : undefined, `${completed ?? ""}:${retry}`)
  const mine = routed && info.role === "assistant" && (completed || streaming) ? answersFor(all, info.modelID, info.time.created, completed ?? Number.POSITIVE_INFINITY) : []
  const missing = routed && !!completed && all !== null && mine.length === 0
  useEffect(() => {
    if (!missing || retry >= 2 || !completed || Date.now() - completed > 60_000) return
    const t = setTimeout(() => setRetry((n) => n + 1), 2_500)
    return () => clearTimeout(t)
  }, [missing, retry, completed])

  if (info.role === "user") {
    // The engine adds synthetic text parts carrying attachment contents; show only what the user typed.
    const text = parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
    const files = parts.filter((p) => p.type === "file")
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-6 text-ink whitespace-pre-wrap">
          {text}
          {files.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${text ? "mt-2" : ""}`}>
              {files.map((f) =>
                f.type === "file" && f.mime.startsWith("image/") ? (
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
    <div className="group">
      <div className="space-y-1">
        {visible.map((p) => (
          <PartView key={p.id} part={p} streaming={streaming} />
        ))}
        {streaming && visible.length === 0 && (
          <div className="flex items-center gap-1.5 py-2 text-sm text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent pulse" /> Working…
          </div>
        )}
        {err && (
          <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err">
            {"data" in err && err.data && typeof err.data === "object" && "message" in err.data ? String(err.data.message) : err.name}
          </div>
        )}
      </div>
      {note && <div className="mt-1.5 text-[11px] text-muted">{note}</div>}
      {!streaming && routedLine && <div className="mt-1.5 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">{routedLine}</div>}
      {!streaming && !routedLine && (tokens > 0 || info.cost > 0) && (
        <div className="mt-1.5 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">
          {info.modelID} · {fmtTokens(tokens)} tokens · {fmtCost(info.cost)}
        </div>
      )}
    </div>
  )
}
