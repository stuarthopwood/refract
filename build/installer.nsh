; build/installer.nsh -- custom NSIS hooks for Refract's installer, picked up automatically by
; electron-builder's default `include` path (electron-builder.yml adds no explicit `include:`).
; specs/006-installer-and-updates/research.md decisions 1-2, tasks T006/T007.
;
; customUnInstall: asks whether to delete Refract's own settings and session list
; (%APPDATA%/pinion, README.md "Where state lives") before the rest of electron-builder's
; generated uninstaller removes Refract's program files, Desktop shortcut, and Start Menu
; entries. Default answer is No/keep (MB_DEFBUTTON2 on MB_YESNO: button 2 is No), matching
; FR-023 ("defaulting to keeping them"). Only Git for Windows, OMP, and the GitHub CLI are never
; touched by this uninstaller at all -- this macro only ever removes Refract's own data folder.
;
; customUnInit: refuses to start an uninstall while Refract is running, per FR-024, by checking
; for a running `Refract.exe` process with `tasklist`/`find` (electron-builder.yml's
; `win.executableName: Refract` fixes that name). research.md decision 2 names this as an
; alternative to querying Refract's own single-instance lock directly; that lock is Electron's
; `app.requestSingleInstanceLock()`, a lock-file mechanism, not a named Win32 mutex NSIS could
; query without extra plugins, so this file uses the process-name check instead -- it needs only
; `nsExec`, which ships with every NSIS build electron-builder uses.
;
; UNVERIFIED: gate T004 pending (whether this MessageBox actually appears and the default (No) is
; honoured both interactively, Settings > Apps/Start Menu, and under the silent uninstall switch;
; whether the customUnInit guard is reachable; and whether electron-builder's own one-click NSIS
; template already warns on a running instance without it).
;
; Quality-gate remediation (HIGH, security-auditor): neither MessageBox below used to carry a
; /SD (silent default) switch, and customUnInstall's data-deletion prompt ran unconditionally --
; including during the SILENT in-place upgrade every new version's install-on-quit helper runs
; (electron-builder's own uninstaller.nsh invokes the previous version's uninstaller as
; `/S --updated` on every upgrade, per app-builder-lib's installUtil.nsh). Un-silenced, that
; stopped a "silent" update on a modal dialog; answered Yes, it deleted %APPDATA%\pinion against
; FR-004/FR-023's own "upgrades ... without touching %APPDATA%/pinion".
; - customUnInstall is now skipped entirely during an upgrade (${isUpdated}, electron-builder's
;   own LogicLib variable, already set by the time this macro runs) -- the keep/delete prompt only
;   ever fires for a real, standalone uninstall, never a silent in-place upgrade.
; - Both MessageBox calls now carry /SD matching their own default button (IDNO for the YESNO
;   data-deletion prompt, matching MB_DEFBUTTON2/FR-023's own "defaulting to keeping them";
;   IDCANCEL for the RETRYCANCEL running-process guard, the same silent-default electron-builder's
;   own templates use for an equivalent RETRYCANCEL box, e.g. installUtil.nsh), so a silent
;   uninstall can never hang on either dialog.

!macro customUnInit
  refract_uninstall_check_running:
    nsExec::ExecToStack 'cmd /C tasklist /FI "IMAGENAME eq Refract.exe" /NH | find /I "Refract.exe"'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 refract_uninstall_not_running
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Refract is running. Close it, then try uninstalling again." /SD IDCANCEL IDRETRY refract_uninstall_check_running
      Abort
  refract_uninstall_not_running:
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_DEFBUTTON2 "Delete Refract's settings and session list?" /SD IDNO IDYES refract_uninstall_delete_data
    Goto refract_uninstall_keep_data
    refract_uninstall_delete_data:
      RMDir /r "$APPDATA\pinion"
    refract_uninstall_keep_data:
  ${endIf}
!macroend
