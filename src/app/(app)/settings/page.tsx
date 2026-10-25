import { redirect } from "next/navigation"
import { Connections } from "@/components/connections"
import { PrivacySettings } from "@/components/privacy-settings"
import { SharedLinks } from "@/components/share-dialog"
import { btnClass } from "@/components/ui/s"
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
      <div className="mx-auto w-full max-w-[760px] px-4 py-8 medium:px-6">
        <h1 className="font-display text-heading font-normal text-ink">Account & privacy</h1>
        <p className="mt-2 max-w-[600px] text-base text-ink-2">Every promise in the Privacy Policy has a control here. Changes take effect immediately and are recorded in your account&apos;s audit log.</p>
        <PrivacySettings />
        <SharedLinks />
        <Connections />
        <section className="s-settings__group mt-6">
          <div className="s-settings__head">
            <h2 className="s-settings__title">Session</h2>
            <p className="s-settings__desc">Signs you out on this device. Your data stays.</p>
          </div>
          <form action={out}>
            <button type="submit" className={btnClass({ variant: "secondary", className: "w-full medium:w-auto" })}>
              <span className="s-btn__label">Sign out</span>
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
