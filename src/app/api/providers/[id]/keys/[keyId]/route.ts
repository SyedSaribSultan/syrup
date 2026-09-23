import { activateKey, removeKey } from "@/server/providers"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string; keyId: string }> }

/** Make this key the one the engine uses for the provider. */
export async function PATCH(_req: Request, ctx: Ctx) {
  const { id, keyId } = await ctx.params
  try {
    await activateKey(id, keyId)
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, keyId } = await ctx.params
  try {
    await removeKey(id, keyId)
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
