import { z } from "zod"
import { handler } from "@/server/cloud/session"
import { sessionRatings, setRating } from "@/server/feedback"
import { currentOwner } from "@/server/share-owner"

export const dynamic = "force-dynamic"

/** `?session=<id>` → the ratings the owner gave in that chat. */
export const GET = handler(async (req: Request) => {
  const owner = await currentOwner()
  const sessionId = new URL(req.url).searchParams.get("session")
  if (!sessionId || sessionId.length > 200) return Response.json({ error: "session is required" }, { status: 400 })
  return Response.json({ ratings: await sessionRatings(owner, sessionId) }, { headers: { "cache-control": "no-store" } })
})

const id = z.string().min(1).max(200)
const Body = z.object({
  sessionId: id,
  messageId: id,
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  alias: z.string().max(40).nullish(),
  providerId: z.string().max(100).nullish(),
  modelId: z.string().max(200).nullish(),
})

/** Rate one agent reply (1 good, -1 bad) or clear the rating (0). */
export const POST = handler(async (req: Request) => {
  const owner = await currentOwner()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "sessionId, messageId and rating (1, -1 or 0) are required" }, { status: 400 })
  await setRating(owner, parsed.data)
  return Response.json({ ok: true })
})
