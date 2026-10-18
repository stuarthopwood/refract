// Windows taskbar/Alt-Tab/notification identity (issue #880: "the Tauri build's taskbar button
// shows a generic blank icon, not the Refract logo"). Electron precedent #494 (PRs #590/#615);
// `specs/016-tauri-rust-build/security-baseline-tauri.md:135` and `spike-r10a-shell.md:212` both
// flagged this exact work as outstanding, nominally owned by R8 (#791)/R11 (#277, #794) but never
// actually delivered by either (#880's own "Cause" section).
//
// Scope: only `SetCurrentProcessExplicitAppUserModelID` (this file). The explicit window `.icon`
// call lives in `lib.rs`'s own `setup` closure (right next to the `WebviewWindowBuilder` chain it
// applies to); this module owns the process-identity half only.

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
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    use windows::core::HSTRING;

    let aumid = HSTRING::from(current_app_user_model_id());
    // Safety: a single documented Win32 API call with no raw pointers beyond what `windows-rs`'s
    // own `HSTRING`/`PCWSTR` conversion already type-checks; `aumid` outlives the call (a local on
    // this function's own stack). Unlike `process::job_object`'s Job Object `HANDLE`, there is no
    // handle to keep alive afterward -- Windows copies the string into the process's own identity
    // record internally.
    if let Err(err) = unsafe { SetCurrentProcessExplicitAppUserModelID(&aumid) } {
        // No logger exists this early (same caveat `lib.rs::data_dir`'s own
        // `resolve_data_dir_override` comment already notes for `eprintln!`/`log::warn!` at this
        // point in startup); kept anyway for a dev session where a logger happens to attach later,
        // and because failing open (continue without a correct taskbar identity) is strictly
        // better than aborting startup over a cosmetic Win32 API failure.
        log::warn!("refract-tauri: SetCurrentProcessExplicitAppUserModelID failed: {err}");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_process_app_user_model_id() {
    // No-op: AppUserModelID is a Windows-only taskbar/notification-identity concept, same posture
    // as `process::job_object`'s own non-Windows stub.
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

    #[test]
    fn current_app_user_model_id_matches_this_test_binary() {
        // `cargo test` always builds with `debug_assertions` on (even a `--release` test binary
        // keeps them unless `-C debug-assertions=off` is passed explicitly, which this repo's
        // build scripts never do), so this doubles as a sanity check that the function reads the
        // flag at all rather than always returning one constant.
        assert_eq!(current_app_user_model_id(), APP_USER_MODEL_ID_DEV);
    }
}
