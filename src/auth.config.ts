import type { NextAuthConfig } from "next-auth"
import Google from "next-auth/providers/google"

/**
 * The part of the Auth.js config that is safe to load in the request proxy:
 * no database adapter, no Node-only imports. auth.ts extends it.
 * Sessions are JWT cookies, so the proxy can verify them without a DB call.
 */
const SESSION_MAX_AGE = 180 * 24 * 60 * 60

export const authConfig = {
  providers: [Google({ allowDangerousEmailAccountLinking: false })],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    jwt({ token, user }) {
      // Absolute session lifetime: the cookie renews while in use, but never past 180 days from the sign-in.
      const now = Math.floor(Date.now() / 1000)
      if (user?.id) token.authAt = now
      else if (typeof token.authAt !== "number") token.authAt = now
      else if (now - token.authAt > SESSION_MAX_AGE) return null
      if (user?.id) token.uid = user.id
      if (user?.email) token.email = user.email
      return token
    },
    session({ session, token }) {
      session.user.id = (token.uid as string) ?? session.user.id
      session.user.admin = isAdmin(token.email)
      return session
    },
  },
} satisfies NextAuthConfig

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false
  return (process.env.SYRUP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase())
}

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      admin: boolean
      name?: string | null
      email?: string | null
      image?: string | null
    }
  }
}
