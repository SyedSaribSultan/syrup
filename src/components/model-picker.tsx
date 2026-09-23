"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useEngine } from "@/lib/engine-store"
import { fmtTokens } from "@/lib/format"

export function ModelPicker() {
  const { models, model, setModel } = useEngine()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const current = models.find((m) => m.providerID === model?.providerID && m.id === model?.modelID)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? models.filter((m) => `${m.providerID} ${m.name} ${m.id}`.toLowerCase().includes(s)) : models
  }, [models, q])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-2 transition hover:bg-surface-2 hover:text-ink"
      >
        <span className="max-w-[220px] truncate">{current ? current.name : model ? model.modelID : "Pick a model"}</span>
        {current?.free && <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">free</span>}
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-2 w-[360px] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search models…"
            className="w-full border-b border-line bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted"
          />
          <ul className="max-h-[320px] overflow-y-auto py-1">
            {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted">No models. Add a provider key.</li>}
            {filtered.map((m) => {
              const active = m.providerID === model?.providerID && m.id === model?.modelID
              return (
                <li key={`${m.providerID}/${m.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setModel({ providerID: m.providerID, modelID: m.id })
                      setOpen(false)
                    }}
                    className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-surface-2 ${active ? "bg-surface-2" : ""}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-ink">{m.name}</span>
                        {m.free && <span className="rounded bg-accent-soft px-1 text-[10px] font-medium text-accent">free</span>}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {m.providerID} · {fmtTokens(m.limit?.context)} ctx
                        {m.capabilities?.input?.image ? " · vision" : ""}
                        {m.capabilities?.reasoning ? " · reasoning" : ""}
                      </div>
                    </div>
                    {!m.free && m.cost && (
                      <span className="shrink-0 text-[11px] text-muted">
                        ${m.cost.input}/{m.cost.output}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
