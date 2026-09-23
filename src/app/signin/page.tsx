import Link from "next/link"
import { redirect } from "next/navigation"
import { env } from "@/server/env"

const ERRORS: Record<string, string> = {
  invite: "This Google account isn't on the invite list yet. syrup is in early access; ask Sarib for an invite.",
  unverified: "Google reports this email as unverified. Verify it with Google and try again.",
  email: "Google did not share an email address for this account.",
  OAuthAccountNotLinked: "This email is already linked to another sign-in method.",
  AccessDenied: "Sign-in was refused.",
  Configuration: "Sign-in is misconfigured on the server. This is our fault, not yours.",
}

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  if (!env.isCloud) redirect("/")
  const sp = await searchParams
  const error = typeof sp.error === "string" ? sp.error : undefined
  const next = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/"
  const { auth, signIn } = await import("@/auth")
  const session = await auth()
  if (session?.user) redirect(next)

  async function google() {
    "use server"
    const { signIn: si } = await import("@/auth")
    await si("google", { redirectTo: next })
  }
  void signIn

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-[400px]">
        <div className="mb-8 text-center">
          <div className="font-serif text-[2.2rem] font-semibold tracking-tight text-ink">syrup</div>
          <p className="mt-2 text-[15px] text-ink-2">A coding agent powered by your own API keys.</p>
        </div>

        <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <form action={google}>
            <button type="submit" className="flex w-full items-center justify-center gap-3 rounded-xl border border-line-2 bg-bg px-4 py-3 text-sm font-medium text-ink transition hover:border-ink/30" data-ph="signin-google">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
                <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z" />
                <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.5-5.8c-2.1 1.4-4.8 2.3-8.1 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
              </svg>
              Continue with Google
            </button>
          </form>

          {error && <div className="mt-4 rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] leading-relaxed text-err">{ERRORS[error] ?? "Something went wrong signing in. Try again."}</div>}

          <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
            By continuing you agree to the{" "}
            <Link href="/legal/terms" className="underline underline-offset-2 hover:text-ink">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-ink">
              Privacy Policy
            </Link>
            . Invite-only during early access.
          </p>
        </div>

        <p className="mt-6 text-center text-[12px] text-muted">
          Prefer to run it yourself?{" "}
          <a href="https://github.com/SyedSaribSultan/syrup" className="underline underline-offset-2 hover:text-ink" target="_blank" rel="noreferrer">
            syrup is open source
          </a>
          .
        </p>
      </div>
    </div>
  )
}
