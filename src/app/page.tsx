"use client"

import { useRouter } from "next/navigation"
import { Composer } from "@/components/composer"
import { useEngine } from "@/lib/engine-store"

export default function Home() {
  const router = useRouter()
  const { createSession, send, models } = useEngine()

  async function onSend(text: string) {
    const s = await createSession()
    router.push(`/s/${s.id}`)
    await send(s.id, text)
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <div className="w-full max-w-[720px]">
        <h1 className="mb-6 text-center font-serif text-[2rem] font-medium tracking-tight text-ink">What are we building?</h1>
        <Composer onSend={onSend} autoFocus />
        <p className="mt-4 text-center text-xs text-muted">
          {models.length > 0 ? (
            <>
              {models.filter((m) => m.free).length} free models ready. Add your own keys for more.
            </>
          ) : (
            "Connecting to engine…"
          )}
        </p>
      </div>
    </div>
  )
}
