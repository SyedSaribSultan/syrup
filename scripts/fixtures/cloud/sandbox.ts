/**
 * Stand-in for @vercel/sandbox in scripts/test-cloud.mjs: VMs in memory, keyed by name. The engine answers
 * /global/health only for the password its latest `opencode serve` was started with (the test's fetch asks vms()).
 * A test can hold a VM's creation (createGate) or its engine start (gate), make delete fail, or stop a VM behind the
 * app's back.
 */

export type FakeVm = {
  name: string
  status: "running" | "stopped"
  statusUpdatedAt: Date
  password: string | null
  starts: number
  deleted: boolean
  failDelete?: boolean
  gate?: Promise<void>
}

const g = globalThis as unknown as { __fakeVms?: Map<string, FakeVm>; __createGate?: Promise<void> }
export function vms(): Map<string, FakeVm> {
  return (g.__fakeVms ??= new Map())
}

export class APIError extends Error {
  response: Response
  constructor(response: Response, options?: { message?: string }) {
    super(options?.message ?? `HTTP ${response.status}`)
    this.response = response
  }
}

const done = (stdout = "") => ({ exitCode: 0, stdout: async () => stdout, stderr: async () => "" })

export class Sandbox {
  constructor(private vm: FakeVm) {}
  get status() {
    return this.vm.status
  }
  get statusUpdatedAt() {
    return this.vm.statusUpdatedAt
  }
  get region() {
    return "fra1"
  }
  get expiresAt() {
    return new Date(Date.now() + 60_000)
  }
  domain(port: number) {
    return `https://${this.vm.name}-${port}.sandbox.test`
  }
  async update() {}
  async writeFiles() {}
  async extendTimeout() {}
  async runCommand(c: { cmd: string; args?: string[]; env?: Record<string, string>; detached?: boolean }) {
    const script = c.args?.join(" ") ?? ""
    if (c.detached && script.includes("opencode\" serve")) {
      if (this.vm.gate) await this.vm.gate
      this.vm.password = c.env?.OPENCODE_SERVER_PASSWORD ?? null
      this.vm.starts++
    }
    if (c.cmd === "curl") return done(JSON.stringify({ bundle: g2.__sidecarHash }))
    return done()
  }
  async stop() {
    this.vm.status = "stopped"
    this.vm.statusUpdatedAt = new Date()
    this.vm.password = null
    return { activeCpuDurationMs: 1000, snapshot: { status: "created" } }
  }
  async delete() {
    if (this.vm.failDelete) throw new Error("platform unavailable")
    this.vm.deleted = true
    vms().delete(this.vm.name)
  }
  static async get(o: { name: string }) {
    const vm = vms().get(o.name)
    if (!vm) throw new APIError(new Response(null, { status: 404 }), { message: "sandbox not found" })
    return new Sandbox(vm)
  }
  static async getOrCreate(o: { name: string; onCreate?: (sb: Sandbox) => Promise<void> }) {
    let vm = vms().get(o.name)
    if (vm) {
      if (vm.status === "stopped") Object.assign(vm, { status: "running", statusUpdatedAt: new Date() })
      return new Sandbox(vm)
    }
    if (g.__createGate) await g.__createGate
    vm = { name: o.name, status: "running", statusUpdatedAt: new Date(), password: null, starts: 0, deleted: false }
    vms().set(o.name, vm)
    const sb = new Sandbox(vm)
    await o.onCreate?.(sb)
    return sb
  }
}

const g2 = globalThis as unknown as { __sidecarHash?: string }
