import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { env } from "./env"

/**
 * Encrypts provider API keys at rest with AES-256-GCM (local mode).
 * The master key comes from SYRUP_VAULT_KEY, or is generated once and kept
 * in the user config dir (env.configDir), outside any workspace the agent
 * might be pointed at. Older installs kept it in data/vault.key; that file
 * is moved on first use.
 */

let master: Buffer | undefined

function masterKey(): Buffer {
  if (master) return master
  if (env.vaultKey) {
    master = Buffer.from(env.vaultKey, "base64")
  } else {
    const dir = env.configDir
    const file = path.join(dir, "vault.key")
    const legacyDir = env.dbUrl.startsWith("file:") ? path.dirname(path.resolve(env.dbUrl.slice(5))) : path.resolve("data")
    const legacy = path.join(legacyDir, "vault.key")
    if (!fs.existsSync(file) && fs.existsSync(legacy)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(legacy, file)
      fs.rmSync(legacy)
    }
    if (fs.existsSync(file)) {
      master = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64")
    } else {
      fs.mkdirSync(dir, { recursive: true })
      master = crypto.randomBytes(32)
      fs.writeFileSync(file, master.toString("base64"), { mode: 0o600 })
    }
  }
  if (master.length !== 32) throw new Error("SYRUP_VAULT_KEY must be 32 bytes, base64 encoded")
  return master
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv)
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")
}

export function open(sealed: string): string {
  const buf = Buffer.from(sealed, "base64")
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8")
}

/** Last 4 characters, for display. */
export function hint(plain: string): string {
  return plain.length > 8 ? `…${plain.slice(-4)}` : "••••"
}
