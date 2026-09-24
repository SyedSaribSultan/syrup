import Link from "next/link"

export function CloudHome({ name, connected }: { name: string | null; connected: string[] }) {
  const first = name?.split(" ")[0]
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-6 py-12">
        <h1 className="font-serif text-[2rem] font-medium tracking-tight text-ink">{first ? `Hi ${first}.` : "Welcome."}</h1>
        <p className="mt-2 max-w-[560px] text-[15px] leading-relaxed text-ink-2">
          You are in syrup&apos;s early access. Create a workspace from a Git repository and the agent runs inside an isolated sandbox made for it, using the provider keys you add here.
        </p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <Card title="Provider keys" href="/settings/providers" cta={connected.length ? "Manage keys" : "Add a key"}>
            {connected.length ? (
              <>
                Connected: <span className="text-ink">{connected.join(", ")}</span>. The router will use these when workspaces open.
              </>
            ) : (
              <>No keys yet. Google AI Studio is free and takes a minute. Keys are encrypted with a key unique to your account.</>
            )}
          </Card>
          <Card title="Workspaces" href="/workspaces" cta="Open workspaces">
            Point syrup at a Git repository and chat with an agent that reads, edits and runs code inside a sandbox made for that workspace. It sleeps when you leave and wakes when you return.
          </Card>
          <Card title="Privacy controls" href="/settings" cta="Open settings">
            Analytics opt-out, research consent, data export and account deletion. Everything in the Privacy Policy has a button behind it.
          </Card>
          <Card title="What this costs" cta="Free">
            The hosted service is free during early access. You pay your model providers directly; syrup shows you what each session used.
          </Card>
        </div>

        <p className="mt-10 text-xs text-muted">
          syrup is open source: <a href="https://github.com/SyedSaribSultan/syrup" className="underline underline-offset-2 hover:text-ink" target="_blank" rel="noreferrer">github.com/SyedSaribSultan/syrup</a>. Found a problem? See the security policy there.
        </p>
      </div>
    </div>
  )
}

function Card({ title, href, cta, disabled, children }: { title: string; href?: string; cta: string; disabled?: boolean; children: React.ReactNode }) {
  const body = (
    <div className={`flex h-full flex-col rounded-xl border border-line bg-surface p-4 shadow-card transition ${href && !disabled ? "hover:border-line-2" : ""}`}>
      <div className="text-sm font-medium text-ink">{title}</div>
      <p className="mt-1 flex-1 text-[13px] leading-relaxed text-ink-2">{children}</p>
      <div className={`mt-3 text-xs font-medium ${disabled ? "text-muted" : "text-accent"}`}>{cta} {!disabled && href ? "→" : ""}</div>
    </div>
  )
  return href && !disabled ? <Link href={href}>{body}</Link> : body
}
