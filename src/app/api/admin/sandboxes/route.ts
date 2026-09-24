import { desc, eq } from "drizzle-orm"
import { handler, requireAdmin } from "@/server/cloud/session"
import { pgAdmin, pgReady, pgSchema } from "@/server/db/pg"

export const dynamic = "force-dynamic"

/** Hobby sandbox budget: 5 active-CPU hours per month. Informational only; nothing is enforced. */
const CPU_BUDGET_MS = 5 * 60 * 60_000

/** Every sandbox across users, with its cost so far. Admin only; owner connection on purpose. */
export const GET = handler(async () => {
  await requireAdmin()
  await pgReady()
  const rows = await pgAdmin()
    .select({
      workspaceId: pgSchema.sandboxes.workspaceId,
      workspace: pgSchema.workspaces.name,
      email: pgSchema.users.email,
      status: pgSchema.sandboxes.status,
      region: pgSchema.sandboxes.region,
      engineVersion: pgSchema.sandboxes.engineVersion,
      lastSessionStartedAt: pgSchema.sandboxes.lastSessionStartedAt,
      lastSessionEndedAt: pgSchema.sandboxes.lastSessionEndedAt,
      totalSessionSeconds: pgSchema.sandboxes.totalSessionSeconds,
      totalCpuMs: pgSchema.sandboxes.totalCpuMs,
      lastError: pgSchema.sandboxes.lastError,
      deletedAt: pgSchema.workspaces.deletedAt,
    })
    .from(pgSchema.sandboxes)
    .innerJoin(pgSchema.workspaces, eq(pgSchema.workspaces.id, pgSchema.sandboxes.workspaceId))
    .innerJoin(pgSchema.users, eq(pgSchema.users.id, pgSchema.sandboxes.userId))
    .orderBy(desc(pgSchema.sandboxes.updatedAt))
    .limit(500)
  const live = rows.filter((r) => !r.deletedAt)
  const totalCpuMs = live.reduce((n, r) => n + r.totalCpuMs, 0)
  return Response.json({
    sandboxes: live,
    running: live.filter((r) => r.status === "running").length,
    totalCpuMs,
    totalSessionSeconds: live.reduce((n, r) => n + r.totalSessionSeconds, 0),
    cpuBudgetMs: CPU_BUDGET_MS,
  })
})
