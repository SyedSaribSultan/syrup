import { redirect } from "next/navigation"
import { PrivacySettings } from "@/components/privacy-settings"
import { env } from "@/server/env"

export default async function SettingsPage() {
  if (!env.isCloud) redirect("/settings/providers")

  async function out() {
    "use server"
    const { signOut } = await import("@/auth")
    await signOut({ redirectTo: "/signin" })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-8">
        <h1 className="font-serif text-[1.75rem] font-medium tracking-tight text-ink">Account & privacy</h1>
        <p className="mt-1 max-w-[600px] text-sm text-muted">Every promise in the Privacy Policy has a control here. Changes take effect immediately and are recorded in your account&apos;s audit log.</p>
        <PrivacySettings />
        <section className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-card">
          <h2 className="text-sm font-medium text-ink">Session</h2>
          <p className="mt-1 text-[13px] text-ink-2">Signs you out on this device. Your data stays.</p>
          <form action={out} className="mt-3">
            <button type="submit" className="rounded-lg border border-line bg-bg px-3 py-2 text-xs font-medium text-ink transition hover:border-line-2">
              Sign out
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
