import { listProviders } from "@/server/providers"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json(await listProviders())
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
