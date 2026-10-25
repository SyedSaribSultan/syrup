import Link from "next/link"
import { redirect } from "next/navigation"
import { btnClass } from "@/components/ui/s"
import { env } from "@/server/env"

const ERRORS: Record<string, string> = {
  blocked: "This account has been suspended. If you think that's a mistake, open an issue on syrup's GitHub.",
  unverified: "Google reports this email as unverified. Verify it with Google and try again.",
  email: "Google did not share an email address for this account.",
  OAuthAccountNotLinked: "This email is already linked to another sign-in method.",
  AccessDenied: "Sign-in was refused.",
  Configuration: "Sign-in is misconfigured on the server. This is our fault, not yours.",
}

/**
 * The Sarib sign-in pattern (sarib-design 03 B20, seam rule 5): a P2 card on the canvas, no shadow; 32 logo + name
 * (Flex 500), hero-sm with one accent word, body lede, md block buttons (Google is syrup's only method: outline), and a
 * link-neutral sm foot link.
 */
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
    // Scrolls on a short screen (a phone in landscape); centred otherwise. Clears the notch and home bar.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="s-auth min-h-full pt-[max(4rem,env(safe-area-inset-top))] pb-[max(4rem,env(safe-area-inset-bottom))]">
        <div className="flex w-full max-w-[400px] flex-col items-center gap-6">
          <div className="s-auth__card">
            <span className="s-auth__brand">
              {/* syrup's mark (app/icon.svg, the favicon and home-screen icon) at 32. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.svg" alt="" width={32} height={32} className="s-auth__logo size-8" />
              syrup
            </span>
            <div className="flex flex-col gap-2">
              <h1 className="s-auth__title">
                Sign <em>in</em>
              </h1>
              <p className="s-auth__lede">A coding agent powered by your own API keys.</p>
            </div>

            <form action={google}>
              <button type="submit" className={btnClass({ variant: "outline", block: true })} data-ph="signin-google">
                {/* Google's own mark, in its own colours (public/google.svg). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/google.svg" alt="" width={16} height={16} />
                <span className="s-btn__label">Continue with Google</span>
              </button>
            </form>

            {error && (
              <div role="alert" className="s-alert s-alert--critical">
                <div className="s-alert__body">
                  <p className="s-alert__desc">{ERRORS[error] ?? "Something went wrong signing in. Try again."}</p>
                </div>
              </div>
            )}

            <p className="s-help text-center">
              By continuing you agree to the{" "}
              <Link href="/legal/terms" className="s-link">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/legal/privacy" className="s-link">
                Privacy Policy
              </Link>
              .
            </p>

            <div className="s-auth__foot">
              <a href="https://github.com/SyedSaribSultan/syrup" className="s-btn s-btn--link-neutral s-btn--sm" target="_blank" rel="noreferrer">
                <span className="s-btn__label">Run it yourself: syrup is open source</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
