import { spawn, type ChildProcess } from "node:child_process"
import { slog } from "./log"

/**
 * Opens the operating system's native folder dialog on the machine syrup runs
 * on and returns the chosen path. Works because syrup is self-hosted: the
 * browser and the server share a desktop. Resolves to null when cancelled,
 * throws when no dialog is available (headless / remote).
 *
 * Only one dialog at a time. A new request while one is open abandons the old
 * one, so a dialog that got lost behind other windows never blocks the user.
 */

const TIMEOUT_MS = 3 * 60_000

let current: { proc: ChildProcess; promise: Promise<string | null> } | null = null

// Windows: WinForms FolderBrowserDialog owned by an invisible TopMost form, so
// the dialog itself stays on top. Windows only lets the foreground process take
// focus, so a harmless Alt keypress is sent first (the classic workaround),
// then the owner is activated. Runs on Windows PowerShell 5.1 and PowerShell 7.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'syrup'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01
$owner.Show()
[System.Windows.Forms.SendKeys]::SendWait('%')
$owner.Activate()
$owner.BringToFront()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a workspace folder for syrup'
$d.ShowNewFolderButton = $true
$d.RootFolder = [System.Environment+SpecialFolder]::MyComputer
if ($d.PSObject.Properties['UseDescriptionForTitle']) { $d.UseDescriptionForTitle = $true }
if ($env:SYRUP_PICK_START -and (Test-Path -LiteralPath $env:SYRUP_PICK_START)) { $d.SelectedPath = $env:SYRUP_PICK_START }
[Console]::Error.Write('dialog-shown')
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`

function runDialog(startIn?: string): { proc: ChildProcess; promise: Promise<string | null> } {
  let cmd: string
  let args: string[]
  if (process.platform === "win32") {
    cmd = "powershell.exe"
    args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT]
  } else if (process.platform === "darwin") {
    cmd = "osascript"
    args = ["-e", `POSIX path of (choose folder with prompt "Choose a workspace folder for syrup"${startIn ? ` default location POSIX file "${startIn.replace(/"/g, '\\"')}"` : ""})`]
  } else {
    cmd = "zenity"
    args = ["--file-selection", "--directory", "--title=Choose a workspace folder for syrup", ...(startIn ? [`--filename=${startIn}/`] : [])]
  }

  const proc = spawn(cmd, args, { env: { ...process.env, SYRUP_PICK_START: startIn ?? "" }, stdio: ["ignore", "pipe", "pipe"] })
  slog("workspace", "pick.spawned", { cmd, pid: proc.pid, startIn })

  const promise = new Promise<string | null>((resolve, reject) => {
    let out = ""
    let err = ""
    proc.stdout?.on("data", (c) => (out += c))
    proc.stderr?.on("data", (c) => {
      err += c
      if (String(c).includes("dialog-shown")) slog("workspace", "pick.dialog_shown", { pid: proc.pid })
    })
    const timer = setTimeout(() => {
      slog("workspace", "pick.timeout", { pid: proc.pid, ms: TIMEOUT_MS }, { level: "warn" })
      proc.kill()
    }, TIMEOUT_MS)
    proc.on("error", (e) => {
      clearTimeout(timer)
      slog("workspace", "pick.spawn_error", e, { level: "error" })
      reject(e)
    })
    proc.on("exit", (code, signal) => {
      clearTimeout(timer)
      const stderr = err.replace("dialog-shown", "").trim()
      slog("workspace", "pick.exited", { pid: proc.pid, code, signal, stdout: out.trim(), stderr }, { level: code === 0 || code === null ? "info" : "warn" })
      if (signal) return resolve(null) // killed: timed out or superseded
      // macOS cancel and zenity cancel exit non-zero without output.
      if (code !== 0 && out.trim() === "" && (process.platform !== "win32" || !stderr)) return resolve(null)
      if (code !== 0 && stderr) return reject(new Error(stderr.slice(0, 500)))
      resolve(out.trim().replace(/\/$/, "") || null)
    })
  })
  return { proc, promise }
}

export function pickFolder(startIn?: string): Promise<string | null> {
  if (current) {
    // The previous dialog was never answered (probably hidden). Drop it and open a fresh one.
    slog("workspace", "pick.superseded", { pid: current.proc.pid }, { level: "warn" })
    current.proc.kill()
    current = null
  }
  const run = runDialog(startIn)
  current = run
  return run.promise.finally(() => {
    if (current === run) current = null
  })
}
