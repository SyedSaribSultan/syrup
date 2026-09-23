export async function register() {
  // Only the Node.js server runtime can spawn processes and open SQLite.
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { engine } = await import("./server/engine/opencode")
  const { startLedger } = await import("./server/ledger")
  try {
    await engine()
  } catch (err) {
    console.error("[syrup] could not start OpenCode. Is it installed? `npm i -g opencode-ai`", err)
    return
  }
  // Runs in the background for the life of the process.
  void startLedger()
}
