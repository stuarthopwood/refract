# Quickstart: verify the right-panel terminal

Run against a build slot, not Stuart's real data (see `skill://refract-tauri-live-check-isolation`). Windows 11, `pwsh` installed.

1. **Probe (T012, gate T013).** Run the channel-in-args probe; it must print the same bytes Rust sent. If it fails, stop and read research.md R-1.
2. **Shell and streaming (US1, SC-001).** Open a Session, open the Terminal rail button: a prompt appears within 2 s. Run `Get-Location` (the Session folder), `1..2000 | % { "line $_" }`, then drag the pane wider; the display re-wraps and `$Host.UI.RawUI.WindowSize` matches.
3. **Fallbacks (US1-4).** Rename `pwsh.exe` out of `PATH` in the slot's environment: new tab is Windows PowerShell. Set `PATH` to nothing useful and hide `powershell.exe`: new tab is `%COMSPEC%`.
4. **Tabs (US2).** Add 3 tabs, run `ping -t localhost` in tab 1, switch tab, Panel, Session, reload the window (Ctrl+R in a dev build): the ping keeps counting and tab 1 shows its earlier output. Rename a tab; quit and relaunch: the name survives. A 9th tab is refused with the reason.
5. **Lifecycle (US3, SC-002).** Close the `ping` tab: a confirmation appears; an idle tab closes silently. Archive a Session with tabs, then delete another: `Get-Process pwsh,powershell,cmd,conhost,OpenConsole` shows none left from them. Quit Refract from the window, from the tray/menu if any, and by `taskkill /F /PID <refract>`: no shell remains. Relaunch: tabs return as fresh shells.
6. **Agent access (US4, SC-006).** Select text, right-click, "Add to chat": a quoted block is in the composer and nothing sent. Run `Get-Item nope`, right-click with no selection, "Ask agent about this": a turn is sent containing the error. In `%COMSPEC%` it sends the last 200 lines. Print `1..5000`, ask: the truncation line shows and a toast says so.
7. **Failures (US5).** Type `exit`: the tab says the shell ended with code 0 and offers "Restart shell". Delete a Session's folder, open a tab: a plain error names the folder.
8. **Privacy (SC-005).** Print the marker `PRIVACY-MARKER-144`, quit, then `Select-String -Path <data dir>\* -Pattern PRIVACY-MARKER-144 -Recurse` and the same for the logs folder: no hits.
9. **Responsiveness (SC-003).** Run `yes`-like flood (`while($true){ "x"*200 }`) in one tab; type in the composer and switch tabs: no stall; Task Manager shows Refract memory stable.
