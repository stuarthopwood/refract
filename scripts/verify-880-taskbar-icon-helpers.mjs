// #880 ("Tauri build's taskbar button shows a generic blank icon, not the Refract logo") live-check
// helper, split out of `verify-880-taskbar-icon.mjs` (AGENTS.md: an over-cap file must never grow;
// a baseline raise is not an acceptable fix) into its own sibling module, the same pattern
// `verify-926-launch-helpers.mjs` already uses.
//
// Everything here runs ONE native Win32 inspection via a PowerShell `Add-Type` C# snippet (never a
// shell tool a CDP page script could reach): finds the launched pid's own visible top-level window
// (never by image name -- `EnumWindows` + `GetWindowThreadProcessId`, matching this repo's own
// never-by-name process rule), reads `WM_GETICON` (`ICON_BIG`/`ICON_SMALL`) and
// `GetClassLongPtr(GCLP_HICON/GCLP_HICONSM)` (the two places Windows' own taskbar/Alt-Tab icon
// resolution reads from), reads the window's `System.AppUserModel.ID` property via
// `SHGetPropertyStoreForWindow` + `PKEY_AppUserModel_ID` (the exact property
// `shell::app_identity`'s own doc comment cites Tauri's NSIS installer as writing onto the
// Start Menu/Desktop shortcut), and `PrintWindow` (`PW_RENDERFULLCONTENT`, needed for a
// GPU-composited WebView2 window) a screenshot of the window's own native chrome (title bar icon
// included) to a PNG file.
import { spawnSync } from 'node:child_process';

// `PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5` and
// `IID_IPropertyStore = {886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}` -- both confirmed against this
// machine's cached `windows-0.62.2` crate source (`Win32::Storage::EnhancedStorage::
// PKEY_AppUserModel_ID`, `Win32::UI::Shell::IPropertyStore`'s own `define_interface!` GUID), the
// same source `shell::app_identity.rs`'s own doc comment cites.
const PS_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class Refract880 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeoutA(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrA")]
    public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    public static List<IntPtr> FindWindowsForPid(uint pid) {
        var found = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint windowPid;
            GetWindowThreadProcessId(hWnd, out windowPid);
            if (windowPid == pid && IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) {
                found.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY { public Guid fmtid; public int pid; }

    // Sized correctly on both x86 (16 bytes: 8-byte header + two 4-byte IntPtrs) and x64 (24
    // bytes: 8-byte header + two 8-byte IntPtrs) -- matches the real Win32 PROPVARIANT's own
    // size on each, enough to read the vt tag plus one pointer-sized value (VT_LPWSTR=31, the
    // tag PKEY_AppUserModel_ID is always stored as).
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPVARIANT {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr ptr;
        public IntPtr ptr2;
    }

    [DllImport("shell32.dll")]
    public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore ppv);

    [DllImport("ole32.dll")]
    public static extern int PropVariantClear(ref PROPVARIANT pvar);

    public static string GetWindowAppUserModelId(IntPtr hWnd) {
        var riid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        int hr = SHGetPropertyStoreForWindow(hWnd, ref riid, out store);
        if (hr != 0 || store == null) return null;
        var key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        PROPVARIANT pv;
        store.GetValue(ref key, out pv);
        string result = (pv.vt == 31 && pv.ptr != IntPtr.Zero) ? Marshal.PtrToStringUni(pv.ptr) : null;
        PropVariantClear(ref pv);
        return result;
    }

    public static void ScreenshotWindow(IntPtr hWnd, string outPath) {
        RECT rect;
        GetWindowRect(hWnd, out rect);
        int width = Math.Max(1, rect.Right - rect.Left);
        int height = Math.Max(1, rect.Bottom - rect.Top);
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        using (var graphics = Graphics.FromImage(bitmap)) {
            IntPtr hdc = graphics.GetHdc();
            // PW_RENDERFULLCONTENT (2): required for a GPU-composited WebView2 window --
            // PW_CLIENTONLY/0 silently produces a blank bitmap for DWM-composited content.
            PrintWindow(hWnd, hdc, 2);
            graphics.ReleaseHdc(hdc);
            bitmap.Save(outPath, ImageFormat.Png);
        }
    }
}
"@

$targetPid = __TARGET_PID__
# Gate round 1 (LOW finding): the screenshot path arrives via an env var, not interpolated into
# this script's own text -- a path containing a quote/backtick/dollar sign would otherwise need
# its own escaping pass (the PID substitution above is safe as-is: FindWindowsForPid's own
# caller, readWindowIconState, only ever passes a Number, never arbitrary text).
$outPath = $env:REFRACT_880_SCREENSHOT_PATH

$windows = [Refract880]::FindWindowsForPid([uint32]$targetPid)
if ($windows.Count -eq 0) {
    @{ error = 'no visible top-level window found for pid' } | ConvertTo-Json -Compress
    exit
}
$hwnd = $windows[0]

$WM_GETICON = 0x007F
$SMTO_ABORTIFHUNG = 0x0002
$resultBig = [IntPtr]::Zero
$resultSmall = [IntPtr]::Zero
[Refract880]::SendMessageTimeoutA($hwnd, $WM_GETICON, [IntPtr]1, [IntPtr]0, $SMTO_ABORTIFHUNG, 1000, [ref]$resultBig) | Out-Null
[Refract880]::SendMessageTimeoutA($hwnd, $WM_GETICON, [IntPtr]0, [IntPtr]0, $SMTO_ABORTIFHUNG, 1000, [ref]$resultSmall) | Out-Null

$classBig = [Refract880]::GetClassLongPtr($hwnd, -14)   # GCLP_HICON
$classSmall = [Refract880]::GetClassLongPtr($hwnd, -34) # GCLP_HICONSM

$aumid = [Refract880]::GetWindowAppUserModelId($hwnd)

[Refract880]::ScreenshotWindow($hwnd, $outPath)

@{
    hwnd = $hwnd.ToInt64()
    wmGetIconBig = $resultBig.ToInt64()
    wmGetIconSmall = $resultSmall.ToInt64()
    classLongHicon = $classBig.ToInt64()
    classLongHiconSm = $classSmall.ToInt64()
    aumid = $aumid
} | ConvertTo-Json -Compress
`.trim();

/** Runs the Win32 inspection above against `pid`'s own visible top-level window, writing a
 * native (title-bar-included) screenshot to `screenshotPath`. Throws if PowerShell itself failed
 * or returned no window; otherwise returns `{ hwnd, wmGetIconBig, wmGetIconSmall,
 * classLongHicon, classLongHiconSm, aumid }` (every icon handle as a `number`, `0` meaning null/
 * unset; `aumid` the real `System.AppUserModel.ID` string, or `null` if the window carries none).
 * `classLongHicon`/`classLongHiconSm` are informational only (gate round 1 finding: tao always
 * registers the window CLASS icons null, see `shell::app_identity::set_window_icons`'s own doc
 * comment) -- the caller asserts on `wmGetIconBig`/`wmGetIconSmall` and `aumid` only. */
export function readWindowIconState(pid, screenshotPath) {
  const script = PS_SCRIPT.replace('__TARGET_PID__', String(pid));
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    // Gate round 1 (LOW finding): the screenshot path travels as an env var, never interpolated
    // into the PowerShell script text itself -- a path containing a quote/backtick/dollar sign
    // would otherwise need its own escaping pass against PowerShell's own quoting rules.
    env: { ...process.env, REFRACT_880_SCREENSHOT_PATH: screenshotPath }
  });
  if (result.status !== 0) {
    throw new Error(`readWindowIconState: powershell exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`readWindowIconState: could not parse powershell output as JSON: ${err}. stdout: ${result.stdout}`);
  }
  if (parsed.error) {
    throw new Error(`readWindowIconState: ${parsed.error}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `readWindowIconState` until it finds the window, instead of a single fixed-timing call
 * (gate round 3 fix, live-run finding): CDP's own `Runtime.evaluate` can observe the renderer's
 * DOM (so `cdp.waitFor('[data-readiness-primary]')` resolves) over WebView2's remote-debugging
 * port independent of whether the HOST window has actually been marked visible at the OS level
 * yet -- there is no ordering guarantee between "the renderer painted" and "EnumWindows/
 * IsWindowVisible can see the native window" across the two separate OS message-pump/process
 * boundaries involved, so the very first check can race a real, already-correct window that
 * just has not been observed yet. Re-throws immediately on any error OTHER than "no visible
 * top-level window found for pid" (a real failure must never be swallowed behind a retry loop). */
export async function waitForWindowIconState(pid, screenshotPath, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return readWindowIconState(pid, screenshotPath);
    } catch (err) {
      lastErr = err;
      if (!String(err.message).includes('no visible top-level window found for pid')) throw err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitForWindowIconState: timed out after ${timeoutMs}ms waiting for a visible top-level window for pid ${pid}: ${lastErr}`);
}
