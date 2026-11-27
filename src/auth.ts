import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { eq } from "drizzle-orm"
import type { Adapter } from "next-auth/adapters"
import NextAuth from "next-auth"
import { headers } from "next/headers"
import { authConfig } from "./auth.config"
import { track } from "./server/analytics"
import { audit } from "./server/cloud/audit"
import { ipHash } from "./server/cloud/crypto"
import { consentAtSignIn, recordConsent } from "./server/cloud/legal"
import { pg, pgReady, pgSchema } from "./server/db/pg"

/**
 * Cloud sign-in: Google only, open to anyone with a verified Google address. Users and
 * accounts live in Postgres through the Drizzle adapter; the session itself
 * is a JWT cookie so the proxy can check it without touching the database.
 */

async function requestMeta() {
  try {
    const h = await headers()
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")
    return { ipHash: ipHash(ip), userAgent: h.get("user-agent")?.slice(0, 300) ?? null }
  } catch {
    return { ipHash: null, userAgent: null }
  }
}

/** Sign-in is all syrup uses Google for, so the provider's tokens are never stored (audit 2026-11-17 F3). */
function sanitizedAdapter(base: Adapter): Adapter {
  return {
    ...base,
    linkAccount: (account) =>
      base.linkAccount!({ ...account, access_token: undefined, refresh_token: undefined, id_token: undefined, expires_at: undefined, session_state: undefined }),
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  await pgReady()
  return {
    ...authConfig,
    adapter: sanitizedAdapter(
      DrizzleAdapter(pg(), {
        usersTable: pgSchema.users,
        accountsTable: pgSchema.accounts,
        sessionsTable: pgSchema.sessions,
        verificationTokensTable: pgSchema.verificationTokens,
      }),
    ),
    callbacks: {
      ...authConfig.callbacks,
      async signIn({ user, profile }) {
        const email = user.email?.toLowerCase()
        if (!email) return "/signin?error=email"
        // Google reports whether it verified the address; refuse unverified ones.
        if (profile && "email_verified" in profile && profile.email_verified === false) return "/signin?error=unverified"
        const [existing] = await pg().select({ blockedAt: pgSchema.users.blockedAt, deletedAt: pgSchema.users.deletedAt }).from(pgSchema.users).where(eq(pgSchema.users.email, email))
        if (existing?.blockedAt) return "/signin?error=blocked"
        if (existing?.deletedAt) return "/signin?error=deleted"
        // Syrup is closing (11 Dec 2026): existing accounts can still sign in to export, no new ones.
        if (!existing) return "/signin?error=closing"
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
        if (!user.id) return
        const meta = await requestMeta()
        await pg().update(pgSchema.users).set({ lastSeenAt: new Date() }).where(eq(pgSchema.users.id, user.id))
        await audit(null, { userId: user.id, actor: "user", action: "signin", ipHash: meta.ipHash })
        if (isNewUser) return
        // Signing in under the notice accepts the current Terms and Privacy Policy, as at sign-up: a person on an older
        // version moves to the current one here.
        await consentAtSignIn(user.id, meta)
        await track(user.id, "user_signed_in", { method: "google" })
      },
      async signOut(message) {
        const uid = "token" in message ? (message.token?.uid as string | undefined) : undefined
        if (uid) await audit(null, { userId: uid, actor: "user", action: "signout" })
      },
    },
  }
})
