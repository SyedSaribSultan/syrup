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

// Windows Shell folder dialog via COM. Works from a plain console PowerShell
// without a WinForms message loop, on Windows PowerShell 5.1 and PowerShell 7.
// BIF flags: 0x40 NEWDIALOGSTYLE | 0x10 EDITBOX | 0x1 RETURNONLYFSDIRS.
const PS_SCRIPT = `
$shell = New-Object -ComObject Shell.Application
$start = 0
if ($env:SYRUP_PICK_START -and (Test-Path -LiteralPath $env:SYRUP_PICK_START)) { $start = $env:SYRUP_PICK_START }
$folder = $shell.BrowseForFolder(0, 'Choose a workspace folder for syrup', 0x51, $start)
if ($folder -ne $null) { [Console]::Out.Write($folder.Self.Path) }
`

let pwshChecked: string | null | undefined

/** PowerShell 7 gives the modern folder dialog; fall back to Windows PowerShell. */
async function powershell(): Promise<string> {
  if (pwshChecked === undefined) {
    try {
      await run("pwsh.exe", ["-NoProfile", "-Command", "exit 0"], { timeout: 15_000 })
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
    // No windowsHide: it can keep the dialog from ever being shown.
    const { stdout } = await run(exe, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT], {
      timeout,
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
