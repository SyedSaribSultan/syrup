import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Opens the operating system's native folder dialog on the machine syrup runs
 * on and returns the chosen path. Works because syrup is self-hosted: the
 * browser and the server share a desktop. Resolves to null when cancelled,
 * throws when no dialog is available (headless / remote).
 */

let busy: Promise<string | null> | null = null

const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a workspace folder for syrup'
$d.UseDescriptionForTitle = $true
$d.ShowNewFolderButton = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`

async function open(): Promise<string | null> {
  const timeout = 10 * 60_000
  if (process.platform === "win32") {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT], { timeout, windowsHide: true })
    return stdout.trim() || null
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a workspace folder for syrup")'], { timeout })
      return stdout.trim().replace(/\/$/, "") || null
    } catch (err) {
      // osascript exits non-zero on cancel.
      if (err && typeof err === "object" && "stderr" in err && String((err as { stderr: string }).stderr).includes("-128")) return null
      throw err
    }
  }
  // Linux: zenity is common; kdialog as a second try.
  try {
    const { stdout } = await run("zenity", ["--file-selection", "--directory", "--title=Choose a workspace folder for syrup"], { timeout })
    return stdout.trim() || null
  } catch (err) {
    const code = (err as { code?: number | string })?.code
    if (code === 1) return null // cancelled
    const { stdout } = await run("kdialog", ["--getexistingdirectory", process.env.HOME ?? "/"], { timeout })
    return stdout.trim() || null
  }
}

export function pickFolder(): Promise<string | null> {
  if (!busy) {
    busy = open().finally(() => {
      busy = null
    })
  }
  return busy
}
