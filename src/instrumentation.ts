export async function register() {
  // Only the Node.js server runtime can spawn processes and open SQLite.
  // Everything Node-specific lives in server/boot so the Edge compile of this file stays clean.
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { boot } = await import("./server/boot")
  await boot()
}
