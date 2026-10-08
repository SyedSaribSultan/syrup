/**
 * Drives real agent turns through a running syrup (the local proxy at /api/oc, the router's
 * answers at /api/router/answers) and times them the way a user feels them. Shared by
 * scripts/bench-agent.mjs and scripts/eval.mjs (`pnpm eval` runs it against its own isolated
 * syrup, scripts/eval/host.ts).
 *
 *   const d = driver({ base, dir })
 *   const session = await d.createSession()
 *   const marks = await d.runTurn(session.id, "hello", { model, timeoutMs })
 *   const answers = await d.answers(session.id)
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** A fresh git-initialised scratch folder, so snapshots and the Changes panel are exercised too. */
export function scratchDir(prefix = "syrup-bench", root = os.tmpdir()) {
  const dir = path.join(root, `${prefix}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: dir })
  return dir
}

export const ms = (a, b) => (a && b ? b - a : null)
export const fmt = (n) => (n == null ? "—" : n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`)

/** Router answers that belong to the chat's own turns: OpenCode's title calls ride on Fast and are small. */
export const realAnswers = (ans) => ans.filter((a) => a.alias !== "fast" || (a.inputTokens ?? 0) > 4000)

export function driver({ base, dir }) {
  const BASE = base.replace(/\/$/, "")
  const q = `directory=${encodeURIComponent(dir)}`
  const oc = (p, init) => fetch(`${BASE}/api/oc/${p}${p.includes("?") ? "&" : "?"}${q}`, init)
  const post = (p, body) => oc(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  /**
   * Opens the engine's event stream and fills `marks` for one session as events arrive:
   * assistant, textParts, firstText, firstReasoning, firstTool, tools, steps, idle, error, retry.
   */
  function watch(sessionID, marks) {
    const ctrl = new AbortController()
    const done = (async () => {
      const res = await oc("event", { signal: ctrl.signal })
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split("\n").find((l) => l.startsWith("data:"))
          if (!line) continue
          let ev
          try {
            ev = JSON.parse(line.slice(5))
          } catch {
            continue
          }
          const p = ev.properties ?? {}
          const now = Date.now()
          // The user's own prompt arrives as a text part too; only the assistant's messages count.
          if (ev.type === "message.updated" && p.info?.sessionID === sessionID && p.info.role === "assistant") (marks.assistant ??= new Set()).add(p.info.id)
          // OpenCode 1.18 streams text as message.part.delta events (field "text") after a part's empty opening update;
          // the first one is the first text a user sees. Reasoning parts stream the same field, so the part's type decides.
          if (ev.type === "message.part.delta" && p.sessionID === sessionID && p.field === "text" && p.delta && marks.assistant?.has(p.messageID)) {
            if (marks.textParts?.has(p.partID) && !marks.firstText) marks.firstText = now
          }
          if (ev.type === "message.part.updated" && p.part?.sessionID === sessionID && marks.assistant?.has(p.part.messageID)) {
            const part = p.part
            if (part.type === "text") (marks.textParts ??= new Set()).add(part.id)
            // A part that arrives whole (no deltas) still counts when its final update lands.
            if (part.type === "text" && (p.delta || part.text) && !marks.firstText) marks.firstText = now
            if (part.type === "reasoning" && !marks.firstReasoning) marks.firstReasoning = now
            if (part.type === "tool") {
              if (!marks.firstTool) marks.firstTool = now
              marks.tools = (marks.toolIds ??= new Set()).add(part.id).size
            }
            if (part.type === "step-finish") marks.steps = (marks.steps ?? 0) + 1
          }
          // OpenCode retrying a failed model request (rate limits, cooling backends): the eval treats it as quota.
          if (ev.type === "session.status" && p.sessionID === sessionID && p.status?.type === "retry") marks.retry = { attempt: p.status.attempt, message: p.status.message ?? "" }
          if ((ev.type === "session.status" && p.sessionID === sessionID && p.status?.type === "idle") || (ev.type === "session.idle" && p.sessionID === sessionID)) {
            if (marks.sent && !marks.idle) marks.idle = now
          }
          if (ev.type === "session.error" && p.sessionID === sessionID) marks.error = p.error?.data?.message ?? p.error?.name ?? "error"
        }
      }
    })().catch(() => {})
    return { stop: () => ctrl.abort(), done }
  }

  async function answers(sessionID) {
    const r = await fetch(`${BASE}/api/router/answers?session=${encodeURIComponent(sessionID)}`)
    if (!r.ok) return []
    return ((await r.json()).answers ?? []).sort((a, b) => a.ts - a.latencyMs - (b.ts - b.latencyMs))
  }

  async function createSession() {
    const create = await post("session", {})
    const session = await create.json()
    if (!create.ok) throw new Error(`session create failed: ${JSON.stringify(session).slice(0, 200)}`)
    return session
  }

  /**
   * Sends one user turn and waits until the session is idle, errors, or `timeoutMs` passes.
   * `stopOn(marks)` returning a reason aborts the turn early (the eval stops on a quota retry);
   * `abortOnTimeout` stops a turn that ran out of time (the bench leaves it running, as before).
   */
  async function runTurn(sessionID, text, { model, timeoutMs = 240_000, stopOn, abortOnTimeout = false } = {}) {
    const marks = {}
    const w = watch(sessionID, marks)
    await new Promise((r) => setTimeout(r, 150))
    marks.sent = Date.now()
    const sent = await post(`session/${sessionID}/prompt_async`, { parts: [{ type: "text", text }], model })
    if (!sent.ok) marks.error = `prompt refused (${sent.status})`
    const limit = Date.now() + timeoutMs
    while (!marks.idle && !marks.error && Date.now() < limit) {
      const why = stopOn?.(marks)
      if (why) {
        marks.stopped = why
        await post(`session/${sessionID}/abort`, {}).catch(() => {})
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!marks.idle && !marks.error && !marks.stopped) {
      marks.timedOut = true
      if (abortOnTimeout) await post(`session/${sessionID}/abort`, {}).catch(() => {})
    }
    w.stop()
    // The router writes its row when the request ends; give it a moment.
    await new Promise((r) => setTimeout(r, 800))
    return marks
  }

  async function messages(sessionID) {
    const r = await oc(`session/${sessionID}/message`)
    return r.ok ? r.json() : []
  }

  return { base: BASE, dir, oc, post, watch, answers, createSession, runTurn, messages }
}
