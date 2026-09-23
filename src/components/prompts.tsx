"use client"

import { useState } from "react"
import { useEngine, type PermissionReq, type QuestionReq } from "@/lib/engine-store"

/** Pending permission and question requests for one session. */
export function Prompts({ sessionID }: { sessionID: string }) {
  const { permissions, questions } = useEngine()
  const perms = permissions.filter((p) => p.sessionID === sessionID)
  const qs = questions.filter((q) => q.sessionID === sessionID)
  if (perms.length === 0 && qs.length === 0) return null
  return (
    <div className="space-y-2">
      {perms.map((p) => (
        <PermissionCard key={p.id} req={p} />
      ))}
      {qs.map((q) => (
        <QuestionCard key={q.id} req={q} />
      ))}
    </div>
  )
}

function PermissionCard({ req }: { req: PermissionReq }) {
  const { replyPermission } = useEngine()
  const detail = req.patterns.join("\n") || (typeof req.metadata.command === "string" ? req.metadata.command : "")
  return (
    <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
      <div className="text-[13px] font-medium text-ink">Allow {req.title}?</div>
      {detail && <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-code-bg p-2 font-mono text-[12px] text-ink-2 whitespace-pre-wrap">{detail}</pre>}
      <div className="mt-2 flex gap-2">
        <Btn primary onClick={() => replyPermission(req, "once")}>
          Allow once
        </Btn>
        <Btn onClick={() => replyPermission(req, "always")}>Always allow</Btn>
        <Btn onClick={() => replyPermission(req, "reject")}>Deny</Btn>
      </div>
    </div>
  )
}

function QuestionCard({ req }: { req: QuestionReq }) {
  const { replyQuestion, rejectQuestion } = useEngine()
  const [answers, setAnswers] = useState<string[][]>(() => req.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""))

  function toggle(qi: number, label: string, multiple?: boolean) {
    setAnswers((prev) => {
      const next = prev.map((a) => [...a])
      const cur = next[qi]
      if (multiple) next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
      else next[qi] = [label]
      return next
    })
  }

  const complete = req.questions.every((_, i) => answers[i].length > 0 || custom[i].trim())

  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      {req.questions.map((q, qi) => (
        <div key={qi} className={qi > 0 ? "mt-3 border-t border-line pt-3" : ""}>
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{q.header}</div>
          <div className="mt-0.5 text-[14px] text-ink">{q.question}</div>
          <div className="mt-2 grid gap-1.5">
            {q.options.map((o) => {
              const on = answers[qi].includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => toggle(qi, o.label, q.multiple)}
                  className={`rounded-lg border px-3 py-2 text-left transition ${on ? "border-accent bg-accent-soft/60" : "border-line hover:border-line-2"}`}
                >
                  <div className="text-[13px] font-medium text-ink">{o.label}</div>
                  {o.description && <div className="text-[12px] text-muted">{o.description}</div>}
                </button>
              )
            })}
            {q.custom !== false && (
              <input
                value={custom[qi]}
                onChange={(e) => setCustom((c) => c.map((v, i) => (i === qi ? e.target.value : v)))}
                placeholder="Or type your own…"
                className="rounded-lg border border-line bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-muted focus:border-line-2"
              />
            )}
          </div>
        </div>
      ))}
      <div className="mt-3 flex gap-2">
        <Btn
          primary
          disabled={!complete}
          onClick={() => replyQuestion(req, req.questions.map((_, i) => (custom[i].trim() ? [custom[i].trim()] : answers[i])))}
        >
          Answer
        </Btn>
        <Btn onClick={() => rejectQuestion(req)}>Skip</Btn>
      </div>
    </div>
  )
}

function Btn({ children, onClick, primary, disabled }: { children: React.ReactNode; onClick(): void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
        primary ? "bg-accent text-accent-ink" : "border border-line text-ink-2 hover:border-line-2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  )
}
