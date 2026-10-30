// Native Win32 inspection of the launched pid's window icon state (WM_GETICON, class icons, AppUserModel.ID, PrintWindow screenshot),
// run via a PowerShell Add-Type snippet. Windows are found by pid, never by image name.
import { spawnSync } from 'node:child_process';

// PKEY_AppUserModel_ID and IID_IPropertyStore GUIDs below match the windows-0.62.2 crate sources.
const PS_SCRIPT = `
# Gate round 2 (live-run finding): \`-ReferencedAssemblies 'System.Drawing.dll'\` on the
# \`Add-Type -TypeDefinition\` call itself -- a separate, earlier \`Add-Type -AssemblyName
# System.Drawing\` command does NOT make the compiler backing a LATER, independent
# \`-TypeDefinition\` invocation see that assembly; without this, \`ScreenshotWindow\`'s own
# Bitmap/Graphics/PixelFormat/ImageFormat references fail to compile (confirmed on both
# Windows PowerShell 5.1 and PowerShell 7 on this machine), which silently takes the WHOLE
# class down with it -- including the unrelated \`FindWindowsForPid\`, which is why every
# call this script ever made looked exactly like "no window found", never like a compile
# error (PowerShell's own Add-Type failure is a non-terminating error by default, so the
# script kept running past it with \`[Refract880]\` simply never having been defined).
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
"@ -ReferencedAssemblies 'System.Drawing.dll'

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

/** Runs the Win32 inspection against `pid`'s window and writes a native screenshot. Returns
 * `{ hwnd, wmGetIconBig, wmGetIconSmall, classLongHicon, classLongHiconSm, aumid }`; class icons
 * are informational only because tao registers them null. Throws if PowerShell fails or finds no window. */
export function readWindowIconState(pid, screenshotPath) {
  const script = PS_SCRIPT.replace('__TARGET_PID__', String(pid));
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    // The path travels as an env var so quotes/backticks/dollars need no PowerShell escaping.
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

/** Polls `readWindowIconState` until the window exists: the renderer can paint (CDP sees the DOM)
 * before the native window is visible. 60s default because a freshly built exe gets a slow
 * Defender first-run scan. Non-"no window" errors rethrow immediately. */
export async function waitForWindowIconState(pid, screenshotPath, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
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
