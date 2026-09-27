"use client"

import Link from "next/link"
import { CloudAddForm } from "./workspace-switcher"

/** First run in cloud mode: no workspace yet, so no chat to start. Once one exists, / goes straight to it. */
export function CloudHome({ name, hasKeys }: { name: string | null; hasKeys: boolean }) {
  const first = name?.split(" ")[0]
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <div className="w-full max-w-[520px]">
        <h1 className="text-center font-serif text-[2rem] font-medium tracking-tight text-ink">{first ? `Hi ${first}. What are we building?` : "What are we building?"}</h1>
        <p className="mt-2 mb-6 text-center text-[14px] leading-relaxed text-ink-2">Add your first workspace. The agent works on it inside a sandbox of its own.</p>
        <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <CloudAddForm />
        </div>
        {!hasKeys && (
          <div className="mt-6 rounded-xl border border-accent/30 bg-accent-soft/40 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">No API keys yet.</span> The agent needs at least one provider key.{" "}
            <Link href="/settings/providers" className="text-accent underline underline-offset-2">
              Add a key
            </Link>{" "}
            — Google AI Studio is free and takes a minute.
          </div>
        )}
      </div>
    </div>
  )
}
