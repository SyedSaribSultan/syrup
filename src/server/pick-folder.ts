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

// Windows: the modern Explorer-style picker (IFileOpenDialog with
// FOS_PICKFOLDERS), called through COM. WinForms FolderBrowserDialog would give
// the legacy tree dialog on Windows PowerShell 5.1 / .NET Framework.
// The dialog is owned by an invisible TopMost form so it stays on top. Windows
// only lets the foreground process take focus, so a harmless Alt keypress is
// sent first (the classic workaround), then the owner is activated.
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SyrupPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(IntPtr owner, string title, string startIn) {
    IFileDialog d = (IFileDialog)new FileOpenDialog();
    uint fos;
    d.GetOptions(out fos);
    d.SetOptions(fos | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    d.SetTitle(title);
    d.SetOkButtonLabel("Select folder");
    if (!String.IsNullOrEmpty(startIn)) {
      try {
        IShellItem start;
        SHCreateItemFromParsingName(startIn, IntPtr.Zero, typeof(IShellItem).GUID, out start);
        d.SetFolder(start);
      } catch { }
    }
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // cancelled
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem result;
    d.GetResult(out result);
    string path;
    result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
'@
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
$start = ''
if ($env:SYRUP_PICK_START -and (Test-Path -LiteralPath $env:SYRUP_PICK_START)) { $start = $env:SYRUP_PICK_START }
[Console]::Error.Write('dialog-shown')
$path = [SyrupPicker]::Pick($owner.Handle, 'Choose a workspace folder for syrup', $start)
$owner.Close()
if ($path) { [Console]::Out.Write($path) }
`

function runDialog(startIn?: string, linux: "zenity" | "kdialog" = "zenity"): { proc: ChildProcess; promise: Promise<string | null> } {
  let cmd: string
  let args: string[]
  if (process.platform === "win32") {
    cmd = "powershell.exe"
    args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT]
  } else if (process.platform === "darwin") {
    cmd = "osascript"
    args = ["-e", `POSIX path of (choose folder with prompt "Choose a workspace folder for syrup"${startIn ? ` default location POSIX file "${startIn.replace(/[\\"]/g, (c) => `\\${c}`)}"` : ""})`]
  } else if (linux === "kdialog") {
    cmd = "kdialog"
    args = ["--getexistingdirectory", startIn ?? process.env.HOME ?? "/", "--title", "Choose a workspace folder for syrup"]
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
  return run.promise
    .catch((err: NodeJS.ErrnoException) => {
      // Linux without zenity: try kdialog (KDE).
      if (process.platform === "win32" || process.platform === "darwin" || err.code !== "ENOENT") throw err
      const kde = runDialog(startIn, "kdialog")
      if (current === run) current = kde
      return kde.promise.finally(() => {
        if (current === kde) current = null
      })
    })
    .finally(() => {
      if (current === run) current = null
    })
}
