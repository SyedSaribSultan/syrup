import type { AnswersResponse } from "@/lib/router-status"
import { handler, requireUser } from "@/server/cloud/session"
import { env } from "@/server/env"
import { cloudSessionAnswers, localSessionAnswers } from "@/server/router-status"

export const dynamic = "force-dynamic"

/** Which real models answered in one chat session: router_events rows whose content reached the chat, oldest first. */
export const GET = handler(async (req: Request) => {
  const session = new URL(req.url).searchParams.get("session") ?? ""
  if (!session || session.length > 200) return Response.json({ error: "session must be a non-empty id of at most 200 characters" }, { status: 400 })
  let body: AnswersResponse
  if (env.isCloud) {
    const me = await requireUser()
    body = { answers: await cloudSessionAnswers(me.id, session) }
  } else {
    body = { answers: await localSessionAnswers(session) }
  }
  return Response.json(body, { headers: { "cache-control": "no-store" } })
})
