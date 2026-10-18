// Windows taskbar/Alt-Tab/notification identity (issue #880: "the Tauri build's taskbar button
// shows a generic blank icon, not the Refract logo"). Electron precedent #494 (PRs #590/#615);
// `specs/016-tauri-rust-build/security-baseline-tauri.md:135` and `spike-r10a-shell.md:212` both
// flagged this exact work as outstanding, nominally owned by R8 (#791)/R11 (#277, #794) but never
// actually delivered by either (#880's own "Cause" section).
//
// Gate round 1 (Code+Test combined finding, 2026-10-18): the original fix here was the process-
// wide AppUserModelID call plus an explicit `WebviewWindowBuilder::icon(...)` call in `lib.rs`.
// That `.icon(...)` call was removed (it only duplicated Tauri's own built-in default-icon
// auto-apply, `tauri-2.12.3`'s `manager/window.rs:74-77` -- a no-op either way) once the real
// cause was found: Tauri's cross-platform icon path only ever reaches tao's `Window::
// set_window_icon` on Windows, which sends `WM_SETICON` for `ICON_SMALL` only -- `ICON_BIG`,
// the one the taskbar button itself prefers, is never reached by any public Tauri API. This
// module now also owns the real fix: `apply_to_window`, called once from `lib.rs`'s own `setup`
// closure right after the window is built, sends `WM_SETICON` for BOTH icon sizes from the exe's
// own resource and sets the window's own `PKEY_AppUserModel_ID` property directly. See each
// function's own doc comment for the full chain of evidence.

/// The packaged AppUserModelID. MUST equal `tauri.conf.json`'s `identifier` field verbatim: the
/// Start Menu/Desktop shortcuts Tauri's own NSIS installer creates are pinned to exactly this
/// string, unmodified, by `tauri-bundler`'s own bundler code and installer template (confirmed
/// 2026-10-18 by reading `tauri-apps/tauri`'s `dev` branch directly -- `tauri-bundler` is a
/// build-tool dependency of the separate `tauri-cli` binary, not of this crate, so it is not
/// present in this machine's cargo registry to grep locally):
///   - `crates/tauri-bundler/src/bundle/windows/nsis/mod.rs:283-284`:
///     `let bundle_id = settings.bundle_identifier();` -- read straight from this same
///     `tauri.conf.json` `identifier` field, then `data.insert("bundle_id", to_json(bundle_id));`
///     (line 308) feeds the template below.
///   - `.../nsis/installer.nsi`: `!define BUNDLEID "{{bundle_id}}"`.
///   - `.../nsis/utils.nsh`'s `SetLnkAppUserModelId` macro (called on both the Start Menu and
///     Desktop shortcut `.lnk` files `installer.nsi`'s own `CreateOrUpdateStartMenuShortcut`/
///     `CreateOrUpdateDesktopShortcut` create): allocates `${BUNDLEID}` as a `BSTR`
///     (`Oleaut32::SysAllocString`), wraps it in a `PROPVARIANT`, and calls
///     `${IPropertyStore::SetValue}` with `PKEY_AppUserModel_ID` on the shortcut's own
///     `IPropertyStore` -- i.e. exactly `PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-
///     E1D42DE1D5F3}, pid 5` (`windows` crate's own
///     `Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID` constant, confirmed against this
///     machine's cached `windows-0.62.2` source), the same property
///     `scripts/verify-880-taskbar-icon-helpers.mjs` reads back live via
///     `SHGetPropertyStoreForWindow`.
///
/// A running window pinned to any OTHER id would never group with the shortcut Windows already
/// created at install time. Literal, not read from `tauri.conf.json` at runtime: this value is
/// needed before `tauri::Builder` -- let alone an `AppHandle`/`Config` -- exists at all (see
/// `set_process_app_user_model_id`'s own call site, the very top of `lib.rs::run()`), and the
/// Electron precedent (`index.ts`'s own `APP_USER_MODEL_ID_PACKAGED` const, PR #615) made the
/// identical choice for the identical reason. If `tauri.conf.json`'s `identifier` ever changes,
/// this constant MUST change with it in the same commit.
pub const APP_USER_MODEL_ID_PACKAGED: &str = "com.stuarthopwood.refract.rust-preview";

/// Dev/unpackaged id. **Decided (Skippy, delegated by Stuart 2026-10-18), issue #880:** reuse the
/// Electron precedent's own fix exactly (#494, PR #615, 2026-10-09 finding), rather than design a
/// new split -- a shared id risks a Windows-cached BAD taskbar icon association poisoning the
/// real, installed identity from a dev run. That is the literal failure #615 reproduced live and
/// fixed by splitting the id (no in-process repair worked there either: `setAppDetails` did not
/// help even combined with `setIcon`), so a dev run must never be able to do it here either. The
/// reasoning that settled #494 carries over unchanged, so no new discussion was needed.
pub const APP_USER_MODEL_ID_DEV: &str = "com.stuarthopwood.refract.rust-preview.dev";

/// Picks [`APP_USER_MODEL_ID_DEV`] for a debug build, [`APP_USER_MODEL_ID_PACKAGED`] otherwise.
/// **Decided (Skippy, delegated by Stuart 2026-10-18), issue #880:** `cfg!(debug_assertions)`, not
/// an exe-path-under-the-install-dir test -- this exact dev/packaged split already gates two other
/// things on this same posture in this same `setup` path (`lib.rs`'s own `tauri_plugin_log` level,
/// and `REFRACT_DATA_DIR`'s override gate via `single_instance::is_scratch_instance`), so this
/// stays the one convention rather than adding a second, path-based test that could disagree with
/// those at the edges -- e.g. a debug exe copied into a scratch "install" directory, exactly what
/// `scripts/verify-880-taskbar-icon.mjs` does to drive a real build. `pnpm tauri build` (no
/// `--debug`) is the only path that ever ships [`APP_USER_MODEL_ID_PACKAGED`].
pub fn current_app_user_model_id() -> &'static str {
    if cfg!(debug_assertions) {
        APP_USER_MODEL_ID_DEV
    } else {
        APP_USER_MODEL_ID_PACKAGED
    }
}

/// Sets this process's explicit AppUserModelID (issue #880; Electron precedent
/// `app.setAppUserModelId`, #494/#615). Must run before any window is created --
/// `lib.rs::run()`'s own call site, right after the `NoDefaultCurrentDirectoryInExePath` env var
/// (that comment's own "as the very first thing `run()` does" applies here too): Windows resolves
/// a window's taskbar/Alt-Tab/notification identity from whatever
/// `SetCurrentProcessExplicitAppUserModelID` last set for the WHOLE process by the time its first
/// top-level window is shown, so setting it any later would be a race against that window's own
/// first paint.
#[cfg(target_os = "windows")]
pub fn set_process_app_user_model_id() {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let aumid = HSTRING::from(current_app_user_model_id());
    // Safety: a single documented Win32 API call with no raw pointers beyond what `windows-rs`'s
    // own `HSTRING`/`PCWSTR` conversion already type-checks; `aumid` outlives the call (a local on
    // this function's own stack). Unlike `process::job_object`'s Job Object `HANDLE`, there is no
    // handle to keep alive afterward -- Windows copies the string into the process's own identity
    // record internally.
    if let Err(err) = unsafe { SetCurrentProcessExplicitAppUserModelID(&aumid) } {
        // No logger exists yet at this point in startup (`lib.rs::run()`'s own call site is
        // right after the `NoDefaultCurrentDirectoryInExePath` env var, before `tauri::Builder`
        // -- let alone `tauri_plugin_log` -- exists), so `log::warn!` would be silently dropped
        // (same caveat `lib.rs::data_dir`'s own `resolve_data_dir_override` comment already notes
        // for this exact point in startup): `eprintln!` instead, same as that sibling case.
        // Failing open (continue without a correct taskbar identity) is strictly better than
        // aborting startup over a cosmetic Win32 API failure.
        eprintln!("refract-tauri: SetCurrentProcessExplicitAppUserModelID failed: {err}");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_process_app_user_model_id() {
    // No-op: AppUserModelID is a Windows-only taskbar/notification-identity concept, same posture
    // as `process::job_object`'s own non-Windows stub.
}

/// Applies the real fixes this module exists for to an already-built window (gate round 1
/// finding): the taskbar/Alt-Tab icon (`set_window_icons`) and the window's own
/// `PKEY_AppUserModel_ID` property (`set_window_app_user_model_id`). Call once, right after the
/// window is built -- `lib.rs::run()`'s own `setup` closure, immediately after `window_builder
/// .build()?` -- see each function's own doc comment for why both are needed on top of
/// `set_process_app_user_model_id` and Tauri's own built-in default-icon wiring.
/// Windows only -- `windows::Win32::Foundation::HWND` does not exist on another target, and
/// `tauri::WebviewWindow::hwnd()` itself is `#[cfg(windows)]`-only (same as this crate's own
/// Cargo.toml `target.'cfg(target_os = "windows")'.dependencies` `windows` crate); `lib.rs`'s own
/// call site is `#[cfg(windows)]`-gated for the same reason, matching that method's own gate.
#[cfg(target_os = "windows")]
pub fn apply_to_window(hwnd: windows::Win32::Foundation::HWND) {
    set_window_icons(hwnd);
    set_window_app_user_model_id(hwnd);
}

/// Sends `WM_SETICON` for BOTH `ICON_BIG` and `ICON_SMALL`, loading the icon straight from this
/// exe's own embedded resource (`tauri_utils::platform::WINDOWS_APP_ICON_RESOURCE_ID` -- the SAME
/// id `tauri-build` embeds it under, `tauri-build-2.7.2`'s own `lib.rs`:
/// `res.set_icon_with_id(&window_icon_path, &WINDOWS_APP_ICON_RESOURCE_ID.to_string())`, not a
/// guessed id, and the SAME resource `app.default_window_icon()`/Tauri's own built-in
/// default-icon auto-apply already read -- confirmed 2026-10-18).
///
/// Why this manual step exists at all, on top of the window already carrying SOME icon: Tauri's
/// cross-platform `WebviewWindowBuilder::icon`/`WindowBuilder::icon` -- and so Tauri's own
/// built-in default-icon auto-apply too, since both funnel through the SAME tao call
/// (`tauri-2.12.3`'s `manager/window.rs:74-77`) -- only ever reach tao's `Window::
/// set_window_icon` on Windows (`tao-0.37.1`'s own `window.rs:846-855`), which sends
/// `WM_SETICON` for `IconType::Small` ONLY. `IconType::Big` -- the one `WM_GETICON`/
/// `GetClassLongPtr(GCLP_HICON)` lookup the Windows taskbar button itself prefers -- is only ever
/// set by tao's SEPARATE `Window::set_taskbar_icon` (`window.rs:858-867`), fed from a
/// Windows-only `pl_attribs.taskbar_icon` platform attribute that Tauri's public API never
/// populates and never exposes a setter for (checked `tauri-2.12.3`'s `window`/`webview_window`
/// modules directly, 2026-10-18: no method anywhere reaches it). So neither this fix's original
/// `.icon(...)` call (removed, this file's own header comment) nor Tauri's automatic default-icon
/// application ever reached `ICON_BIG` -- the actual cause of #880's blank taskbar glyph.
///
/// The window's own CLASS icons (`GCLP_HICON`/`GCLP_HICONSM`, the LAST fallback Windows consults
/// if a window never answers `WM_GETICON`) are registered null by tao's `RegisterClassExW` call
/// (`window.rs:1434-1441`, `hIcon`/`hIconSm` both `HICON::default()`) and never updated
/// afterward -- irrelevant here since `WM_SETICON` makes the window answer `WM_GETICON` directly,
/// which Windows checks FIRST; `scripts/verify-880-taskbar-icon-helpers.mjs`'s own
/// `GetClassLongPtr` read is expected to still show null/0 and is informational only, not
/// asserted on, for that reason.
#[cfg(target_os = "windows")]
fn set_window_icons(hwnd: windows::Win32::Foundation::HWND) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        LR_DEFAULTSIZE, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };

    // `tauri_utils::platform::WINDOWS_APP_ICON_RESOURCE_ID` (re-exported as `tauri::utils::
    // platform::...`) -- a plain `u16`, inlined as a literal here rather than adding a direct
    // `tauri-utils` dependency for one constant this crate already pulls in transitively via
    // `tauri`.
    const WINDOWS_APP_ICON_RESOURCE_ID: u16 = 32512;

    // Safety: `GetModuleHandleW(None)` returns this process's own already-loaded module handle
    // (always valid while the process runs, never freed); the resource id argument is the
    // standard `MAKEINTRESOURCEW`-style integer-as-pointer cast, the same one `tao-0.37.1`'s own
    // `WinIcon::from_resource` (`icon.rs:94-109`) uses for its own icon resource loads.
    let hinstance = match unsafe { GetModuleHandleW(PCWSTR::null()) } {
        Ok(module) => Some(module.into()),
        Err(err) => {
            log::warn!("refract-tauri: GetModuleHandleW failed: {err}");
            None
        }
    };
    let resource = PCWSTR::from_raw(WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16);
    let metric = |index| {
        let n = unsafe { GetSystemMetrics(index) };
        if n > 0 {
            n
        } else {
            32
        }
    };
    let load =
        |cx, cy| unsafe { LoadImageW(hinstance, resource, IMAGE_ICON, cx, cy, LR_DEFAULTSIZE) };

    let big = load(metric(SM_CXICON), metric(SM_CYICON))
        .inspect_err(|err| log::warn!("refract-tauri: failed to load the big taskbar icon: {err}"))
        .ok()
        .map(|h| HICON(h.0));
    let small = load(metric(SM_CXSMICON), metric(SM_CYSMICON))
        .inspect_err(|err| {
            log::warn!("refract-tauri: failed to load the small taskbar icon: {err}")
        })
        .ok()
        .map(|h| HICON(h.0));

    if let Some(icon) = big {
        let _ = unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_BIG as usize)),
                Some(LPARAM(icon.0 as isize)),
            )
        };
    }
    if let Some(icon) = small {
        let _ = unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_SMALL as usize)),
                Some(LPARAM(icon.0 as isize)),
            )
        };
    }

    // Kept alive for the process's lifetime (never `DestroyIcon`d): the window keeps reading
    // these back via `WM_GETICON` for as long as it exists, and this call happens once, at
    // startup -- same "leak it on purpose, document why" posture as `process::job_object`'s own
    // `JOB_HANDLE`.
    static WINDOW_ICONS: std::sync::OnceLock<WindowIcons> = std::sync::OnceLock::new();
    struct WindowIcons(
        #[allow(dead_code)] Option<HICON>,
        #[allow(dead_code)] Option<HICON>,
    );
    // Safety: `HICON` wraps a plain `Copy` GDI handle; this module never dereferences the
    // pointer it wraps, only passes it back to Win32 APIs, which is sound to do from any thread.
    unsafe impl Send for WindowIcons {}
    unsafe impl Sync for WindowIcons {}
    let _ = WINDOW_ICONS.set(WindowIcons(big, small));
}

/// Sets `PKEY_AppUserModel_ID` on this window's own `IPropertyStore` (via
/// `SHGetPropertyStoreForWindow`), to the SAME value `set_process_app_user_model_id` already set
/// process-wide. Belt-and-braces: `SetCurrentProcessExplicitAppUserModelID` is normally
/// sufficient on its own (every top-level window a process creates inherits the process-wide
/// explicit AUMID unless it sets its own), but setting it explicitly on the window too means
/// `scripts/verify-880-taskbar-icon-helpers.mjs`'s own `SHGetPropertyStoreForWindow` read -- the
/// same API Windows' own taskbar uses -- can confirm it directly against the window itself, not
/// only against the process (gate round 1 finding).
#[cfg(target_os = "windows")]
fn set_window_app_user_model_id(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow,
    };

    let store: windows::core::Result<IPropertyStore> = unsafe { SHGetPropertyStoreForWindow(hwnd) };
    let store = match store {
        Ok(store) => store,
        Err(err) => {
            log::warn!("refract-tauri: SHGetPropertyStoreForWindow failed: {err}");
            return;
        }
    };
    // `From<&str> for PROPVARIANT` allocates a `BSTR` (`VT_BSTR`) -- the SAME variant type
    // `tauri-bundler`'s own NSIS `SetLnkAppUserModelId` macro uses when writing this property
    // onto the Start Menu/Desktop shortcut (`Oleaut32::SysAllocString` + `VT_BSTR`, this file's
    // own top doc comment).
    let value = PROPVARIANT::from(current_app_user_model_id());
    if let Err(err) = unsafe { store.SetValue(&PKEY_AppUserModel_ID, &value) } {
        log::warn!("refract-tauri: IPropertyStore::SetValue(PKEY_AppUserModel_ID) failed: {err}");
        return;
    }
    if let Err(err) = unsafe { store.Commit() } {
        log::warn!("refract-tauri: IPropertyStore::Commit failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_and_dev_ids_are_distinct_and_dev_is_a_suffixed_variant() {
        assert_ne!(APP_USER_MODEL_ID_PACKAGED, APP_USER_MODEL_ID_DEV);
        assert_eq!(
            APP_USER_MODEL_ID_DEV,
            format!("{APP_USER_MODEL_ID_PACKAGED}.dev")
        );
    }

    // Gate round 1 (LOW finding): gated, not just commented -- if this repo's build scripts ever
    // change `[profile.test]`/`[profile.release]` `debug-assertions` settings, this test simply
    // stops running instead of asserting something that would then be false.
    #[cfg(debug_assertions)]
    #[test]
    fn current_app_user_model_id_matches_this_test_binary() {
        // `cargo test` always builds with `debug_assertions` on by default (even a `--release`
        // test binary keeps them unless `-C debug-assertions=off` is passed explicitly, which
        // this repo's build scripts never do), so this doubles as a sanity check that the
        // function reads the flag at all rather than always returning one constant.
        assert_eq!(current_app_user_model_id(), APP_USER_MODEL_ID_DEV);
    }
}
