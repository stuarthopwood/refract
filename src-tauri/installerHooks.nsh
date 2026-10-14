; src-tauri/installerHooks.nsh -- custom NSIS hooks for Refract's Tauri installer (issue #794,
; lane R11b), wired via tauri.conf.json's bundle.windows.nsis.installerHooks. Ported from the
; Electron prototype's build/installer.nsh (git show origin/spec-006-impl:build/installer.nsh),
; which already documents in its own comments the two quality-gate fixes this port carries over
; (the /SD silent-default switches and the isUpdated-equivalent upgrade-skip guard below); this
; file follows the FIXED behaviour those comments describe, not a defect.
;
; Hook points confirmed against the installed tauri 2.12.3 / @tauri-apps/cli 2.12.2's own
; NsisConfig::installer_hooks doc comment (tauri-utils-2.10.1/src/config.rs) and the real
; template that consumes them (tauri-bundler-v2.10.2's
; crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi, fetched directly from
; github.com/tauri-apps/tauri at that tag): NSIS_HOOK_PREINSTALL, NSIS_HOOK_POSTINSTALL,
; NSIS_HOOK_PREUNINSTALL, NSIS_HOOK_POSTUNINSTALL. These are Tauri's own hook names -- NOT
; electron-builder's customUnInit/customUnInstall, which do not exist in this template at all.
;
; Executable name: `refract-tauri.exe`, taken from Cargo.toml's `[package] name = "refract-tauri"`
; (this build's actual MAINBINARYNAME, confirmed against the Cargo manifest) -- never
; `Refract.exe`, the separate Electron build's own executable name.
;
; NSIS_HOOK_PREUNINSTALL (FR-024): refuses to start an uninstall while Refract is running, using
; the same tasklist/find process-name check build/installer.nsh's customUnInit used (nsExec, a
; stock NSIS plugin, no extra `!include` needed), looping on Retry. The MB_RETRYCANCEL/IDCANCEL
; `/SD` switch below matches the mined file's own quality-gate fix: a silent uninstall (`/S`) can
; never hang on this dialog.
;
; NSIS_HOOK_POSTUNINSTALL (FR-023): asks whether to delete Refract's own settings and session
; list (`%APPDATA%\refract-tauri`, src-tauri/src/lib.rs's own `data_dir()` doc comment -- NOT
; `%APPDATA%\pinion`, the separate Electron build's own data folder, never touched here) before
; the generated uninstaller finishes. Default answer is No/keep (MB_DEFBUTTON2 on MB_YESNO:
; button 2 is No), matching FR-023's "defaulting to keeping them", with the same /SD IDNO
; silent-default fix the mined file's own comments describe. (Tauri's own standard uninstall
; confirm page already offers an unrelated "delete app data" checkbox of its own, gated on
; `$DeleteAppDataCheckboxState`, that targets `$APPDATA\<bundle identifier>` -- NOT this build's
; real data folder, since `data_dir()`'s own doc comment explains the Rust code deliberately
; never uses Tauri's identifier-derived `app_data_dir()`. This hook does not rely on that
; checkbox at all; it owns its own prompt and its own RMDir against the real path.)
;
; Upgrade-skip guard: Tauri's own installer.nsi declares `Var UpdateMode`, set from the `/UPDATE`
; command-line switch in both `.onInit` and `un.onInit` -- this is the closest equivalent this
; template exposes to electron-builder's own `${isUpdated}` LogicLib variable, and the guard
; below uses it the same comparison style the real template itself uses elsewhere
; (`${If} $UpdateMode <> 1`), mirroring build/installer.nsh's own `${ifNot} ${isUpdated}` fix.
; Honesty note (installer-probes.md's own open question on this, now resolved): in Tauri's real
; template, `PageLeaveReinstall` already skips invoking `Section Uninstall` at all for a plain
; in-place `/UPDATE` install over an existing install -- it overwrites files directly via
; `Section Install` instead, per that function's own `${If} $UpdateMode = 1 ${|} Goto
; reinst_done ${|}` branch -- so this file's NSIS_HOOK_POSTUNINSTALL is not normally reached
; during an update at all. The `$UpdateMode <> 1` check below is kept anyway as the same
; defensive belt-and-braces guard electron-builder's own fix used, in case some future update
; path (e.g. an explicit uninstall-then-reinstall) ever does reach this hook with `/UPDATE` set.

!macro NSIS_HOOK_PREUNINSTALL
  refract_uninstall_check_running:
    nsExec::ExecToStack 'cmd /C tasklist /FI "IMAGENAME eq refract-tauri.exe" /NH | find /I "refract-tauri.exe"'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 refract_uninstall_not_running
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Refract is running. Close it, then try uninstalling again." /SD IDCANCEL IDRETRY refract_uninstall_check_running
      Abort
  refract_uninstall_not_running:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    MessageBox MB_YESNO|MB_DEFBUTTON2 "Delete Refract's settings and session list?" /SD IDNO IDYES refract_uninstall_delete_data
    Goto refract_uninstall_keep_data
    refract_uninstall_delete_data:
      RMDir /r "$APPDATA\refract-tauri"
    refract_uninstall_keep_data:
  ${EndIf}
!macroend
