import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { and, eq, isNull } from "drizzle-orm"
import NextAuth from "next-auth"
import { headers } from "next/headers"
import { authConfig, isAdmin } from "./auth.config"
import { track } from "./server/analytics"
import { audit } from "./server/cloud/audit"
import { ipHash } from "./server/cloud/crypto"
import { recordConsent } from "./server/cloud/legal"
import { pg, pgReady, pgSchema } from "./server/db/pg"
import { env } from "./server/env"

/**
 * Cloud sign-in: Google only, invite-only (docs/PLAN.md §0). Users and
 * accounts live in Postgres through the Drizzle adapter; the session itself
 * is a JWT cookie so the proxy can check it without touching the database.
 */

async function invited(email: string): Promise<boolean> {
  if (isAdmin(email) || env.invites.includes(email)) return true
  const db = pg()
  const [user] = await db.select({ id: pgSchema.users.id }).from(pgSchema.users).where(eq(pgSchema.users.email, email))
  if (user) return true
  const [inv] = await db.select({ id: pgSchema.invites.id }).from(pgSchema.invites).where(and(eq(pgSchema.invites.email, email), isNull(pgSchema.invites.revokedAt)))
  return !!inv
}

async function requestMeta() {
  try {
    const h = await headers()
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")
    return { ipHash: ipHash(ip), userAgent: h.get("user-agent")?.slice(0, 300) ?? null }
  } catch {
    return { ipHash: null, userAgent: null }
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  await pgReady()
  return {
    ...authConfig,
    adapter: DrizzleAdapter(pg(), {
      usersTable: pgSchema.users,
      accountsTable: pgSchema.accounts,
      sessionsTable: pgSchema.sessions,
      verificationTokensTable: pgSchema.verificationTokens,
    }),
    callbacks: {
      ...authConfig.callbacks,
      async signIn({ user, profile }) {
        const email = user.email?.toLowerCase()
        if (!email) return "/signin?error=email"
        // Google reports whether it verified the address; refuse unverified ones.
        if (profile && "email_verified" in profile && profile.email_verified === false) return "/signin?error=unverified"
        if (!(await invited(email))) {
          const meta = await requestMeta()
          await audit(null, { actor: "system", action: "signin.denied", target: email, ipHash: meta.ipHash })
          return "/signin?error=invite"
        }
        return true
      },
    },
    events: {
      async createUser({ user }) {
        if (!user.id) return
        const meta = await requestMeta()
        // Clicking "Continue with Google" under the notice is acceptance of the current Terms and Privacy Policy.
        await recordConsent(user.id, ["terms", "privacy"], meta)
        await audit(null, { userId: user.id, actor: "user", action: "account.create", ipHash: meta.ipHash })
        await track(user.id, "user_signed_up", { method: "google" })
      },
      async signIn({ user, isNewUser }) {
        if (!user.id || !user.email) return
        const email = user.email.toLowerCase()
        const meta = await requestMeta()
        const db = pg()
        await db.update(pgSchema.users).set({ lastSeenAt: new Date() }).where(eq(pgSchema.users.id, user.id))
        await db.update(pgSchema.invites).set({ acceptedAt: new Date() }).where(and(eq(pgSchema.invites.email, email), isNull(pgSchema.invites.acceptedAt)))
        await audit(null, { userId: user.id, actor: "user", action: "signin", ipHash: meta.ipHash })
        if (!isNewUser) await track(user.id, "user_signed_in", { method: "google" })
      },
      async signOut(message) {
        const uid = "token" in message ? (message.token?.uid as string | undefined) : undefined
        if (uid) await audit(null, { userId: uid, actor: "user", action: "signout" })
      },
    },
  }
})
