; src-tauri/installerHooks.nsh -- custom NSIS hook for Refract's Tauri installer (issue #794, lane
; R11b), wired via tauri.conf.json's bundle.windows.nsis.installerHooks.
;
; Gate finding (PR #829 round 1, code HIGH): deleted this file's own NSIS_HOOK_PREUNINSTALL
; running-process guard entirely. It used to match `tasklist` by IMAGE NAME ONLY
; (`refract-tauri.exe`), which is strictly WORSE than Tauri's own built-in check: `Section
; Uninstall` (and `Section Install`) already call `!insertmacro CheckIfAppIsRunning
; "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"` (crates/tauri-bundler/.../installer.nsi, confirmed by
; reading the real template at tag tauri-v2.10.2) immediately after this hook point, which checks
; via Windows Restart Manager against the SPECIFIC file at `$INSTDIR\refract-tauri.exe` -- precise
; to this one install, not every `refract-tauri.exe` process on the machine. The deleted guard
; only ever added FALSE positives (refusing to uninstall because of an unrelated dev/lane build on
; this shared machine, or blocking the GUI reinstall-uninstall-then-reinstall flow outright) with
; no correctness benefit the built-in check doesn't already provide.
;
; Gate finding (PR #829 round 1, Medium "one data-deletion question only"): deleted this file's
; own second "Delete Refract's settings and session list?" MessageBox too. The real template
; already has ONE data-deletion question -- the "Delete app data" checkbox on its own
; confirm-uninstall page (`un.ConfirmShow`/`$DeleteAppDataCheckboxState`) -- but that checkbox's
; own built-in RMDir targets `$APPDATA\${BUNDLEID}`/`$LOCALAPPDATA\${BUNDLEID}` (the bundle
; identifier, `com.stuarthopwood.refract.rust-preview`), never this build's REAL data folder
; (`%APPDATA%\refract-tauri`, src-tauri/src/lib.rs's own `data_dir()`, deliberately NOT derived
; from the bundle identifier). Rather than add a second prompt, this hook reads the SAME
; already-populated `$DeleteAppDataCheckboxState`/`$UpdateMode` pair the template's own RMDir
; checks (`Section Uninstall`, right before this hook point), and deletes the REAL folder under
; the exact same condition -- one question, asked once, on the template's own page, correctly
; wired to both folders. That confirm page is already skipped during any passive (`/P`) run and
; every MUI page is skipped during a silent (`/S`) run (NSIS's own built-in behaviour, including
; this app's own install-on-quit, which always passes `/S /UPDATE`), so
; `$DeleteAppDataCheckboxState` is never left checked by a user during either, and this hook
; never prompts or deletes data mid-upgrade.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\refract-tauri"
  ${EndIf}
!macroend
