"use client"

import type { MessageEntry } from "@/lib/engine-store"
import { fmtCost, fmtTokens } from "@/lib/format"
import { PartView } from "./parts"

export function MessageView({ entry, streaming }: { entry: MessageEntry; streaming: boolean }) {
  const { info, parts } = entry

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
      {!streaming && (tokens > 0 || info.cost > 0) && (
        <div className="mt-1.5 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">
          {info.modelID} · {fmtTokens(tokens)} tokens · {fmtCost(info.cost)}
        </div>
      )}
    </div>
  )
}
