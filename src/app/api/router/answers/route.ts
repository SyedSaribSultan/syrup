import type { AnswersResponse } from "@/lib/router-status"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { cloudSessionAnswers, cloudSessionAttempts, localSessionAnswers, localSessionAttempts } from "@/server/router-status"

export const dynamic = "force-dynamic"

/**
 * Which real models answered in one chat session: router_events rows whose content reached the chat, oldest first.
 * With `live=1`, also every attempt of the last few minutes (failures included), for the "waiting" line.
 */
export const GET = handler(async (req: Request) => {
  const url = new URL(req.url)
  const session = url.searchParams.get("session") ?? ""
  if (!session || session.length > 200) return Response.json({ error: "session must be a non-empty id of at most 200 characters" }, { status: 400 })
  const live = url.searchParams.get("live") === "1"
  let body: AnswersResponse
  if (env.isCloud) {
    const me = await requireUser()
    const [answers, attempts] = await Promise.all([cloudSessionAnswers(me.id, session), live ? cloudSessionAttempts(me.id, session) : undefined])
    body = attempts ? { answers, attempts } : { answers }
  } else {
    const [answers, attempts] = await Promise.all([localSessionAnswers(session), live ? localSessionAttempts(session) : undefined])
    body = attempts ? { answers, attempts } : { answers }
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } })
})
