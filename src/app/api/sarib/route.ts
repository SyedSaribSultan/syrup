import { installSarib, saribStatus } from "@/server/sarib"

export const dynamic = "force-dynamic"

/** Whether the optional .sarib tools are installed, and whether an install is running. */
export async function GET() {
  return Response.json(await saribStatus())
}

/** Installs the .sarib tools in the background (`pip install --user "sarib[mcp]"`). Poll GET for progress. */
export async function POST() {
  return Response.json(await installSarib())
}
