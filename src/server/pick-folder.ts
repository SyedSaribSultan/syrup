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

// Runs under Windows PowerShell 5.1 (.NET Framework, classic tree dialog) and
// PowerShell 7 (.NET, modern dialog). Properties that only exist on one are guarded.
const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose a workspace folder for syrup'
$d.ShowNewFolderButton = $true
if ($d.PSObject.Properties['UseDescriptionForTitle']) { $d.UseDescriptionForTitle = $true }
if ($env:SYRUP_PICK_START -and (Test-Path -LiteralPath $env:SYRUP_PICK_START)) { $d.SelectedPath = $env:SYRUP_PICK_START }
$r = $d.ShowDialog($owner)
$owner.Close()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
`

let pwshChecked: string | null | undefined

/** PowerShell 7 gives the modern folder dialog; fall back to Windows PowerShell. */
async function powershell(): Promise<string> {
  if (pwshChecked === undefined) {
    try {
      await run("pwsh.exe", ["-NoProfile", "-Command", "exit 0"], { timeout: 15_000, windowsHide: true })
      pwshChecked = "pwsh.exe"
    } catch {
      pwshChecked = null
    }
  }
  return pwshChecked ?? "powershell.exe"
}

async function open(startIn?: string): Promise<string | null> {
  const timeout = 10 * 60_000
  if (process.platform === "win32") {
    const exe = await powershell()
    const { stdout } = await run(exe, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT], {
      timeout,
      windowsHide: true,
      env: { ...process.env, SYRUP_PICK_START: startIn ?? "" },
    })
    return stdout.trim() || null
  }
  if (process.platform === "darwin") {
    try {
      const args = ["-e", `POSIX path of (choose folder with prompt "Choose a workspace folder for syrup"${startIn ? ` default location POSIX file "${startIn.replace(/"/g, '\\"')}"` : ""})`]
      const { stdout } = await run("osascript", args, { timeout })
      return stdout.trim().replace(/\/$/, "") || null
    } catch (err) {
      // osascript exits non-zero on cancel (-128).
      if (err && typeof err === "object" && "stderr" in err && String((err as { stderr: string }).stderr).includes("-128")) return null
      throw err
    }
  }
  // Linux: zenity is common; kdialog as a second try.
  try {
    const { stdout } = await run("zenity", ["--file-selection", "--directory", "--title=Choose a workspace folder for syrup", ...(startIn ? [`--filename=${startIn}/`] : [])], { timeout })
    return stdout.trim() || null
  } catch (err) {
    const code = (err as { code?: number | string })?.code
    if (code === 1) return null // cancelled
    const { stdout } = await run("kdialog", ["--getexistingdirectory", startIn ?? process.env.HOME ?? "/"], { timeout })
    return stdout.trim() || null
  }
}

export function pickFolder(startIn?: string): Promise<string | null> {
  if (!busy) {
    busy = open(startIn).finally(() => {
      busy = null
    })
  }
  return busy
}
