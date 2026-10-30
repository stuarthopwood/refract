// Windows taskbar, Alt-Tab and notification identity (#880). Tauri's public icon API only sets
// `ICON_SMALL`, so `apply_to_window` sends `WM_SETICON` for both sizes and sets the window AUMID.

/// Packaged AppUserModelID. Must equal `tauri.conf.json`'s `identifier`, since the installer pins
/// its shortcuts to it; a literal because it is needed before the Tauri config exists.
pub const APP_USER_MODEL_ID_PACKAGED: &str = "com.stuarthopwood.refract.rust-preview";

/// Dev AppUserModelID, split from the packaged one so a dev run cannot poison the installed icon (#880).
pub const APP_USER_MODEL_ID_DEV: &str = "com.stuarthopwood.refract.rust-preview.dev";

/// Returns the dev ID for debug builds and the packaged ID otherwise.
pub fn current_app_user_model_id() -> &'static str {
    if cfg!(debug_assertions) {
        APP_USER_MODEL_ID_DEV
    } else {
        APP_USER_MODEL_ID_PACKAGED
    }
}

/// Sets the process AppUserModelID. Must run before the first window is shown, or Windows
/// may keep the old identity for the taskbar.
#[cfg(target_os = "windows")]
pub fn set_process_app_user_model_id() {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let aumid = HSTRING::from(current_app_user_model_id());
    // Safety: one documented call; `aumid` outlives it and Windows copies the string internally.
    if let Err(err) = unsafe { SetCurrentProcessExplicitAppUserModelID(&aumid) } {
        // No logger exists this early in startup, so report on stderr and continue.
        eprintln!("refract-tauri: SetCurrentProcessExplicitAppUserModelID failed: {err}");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_process_app_user_model_id() {
}

/// Applies the taskbar icon and window AUMID to a built window. Windows only.
#[cfg(target_os = "windows")]
pub fn apply_to_window(hwnd: windows::Win32::Foundation::HWND) {
    set_window_icons(hwnd);
    set_window_app_user_model_id(hwnd);
}

/// Sends `WM_SETICON` for both sizes from the exe's embedded icon resource. Tauri's public API
/// only sets the small icon, so the taskbar's big icon needs this step (#880).
#[cfg(target_os = "windows")]
fn set_window_icons(hwnd: windows::Win32::Foundation::HWND) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        LR_DEFAULTSIZE, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };

    // Same resource id `tauri-build` embeds the app icon under.
    const WINDOWS_APP_ICON_RESOURCE_ID: u16 = 32512;

    // Safety: the module handle is this process's own, and the integer resource id cast is the
    // standard `MAKEINTRESOURCEW` form.
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

    // Kept alive for the process lifetime, since the window reads them back via `WM_GETICON`.
    static WINDOW_ICONS: std::sync::OnceLock<WindowIcons> = std::sync::OnceLock::new();
    struct WindowIcons(
        #[allow(dead_code)] Option<HICON>,
        #[allow(dead_code)] Option<HICON>,
    );
    // Safety: `HICON` is an opaque GDI handle only passed back to Win32, so sharing it is sound.
    unsafe impl Send for WindowIcons {}
    unsafe impl Sync for WindowIcons {}
    let _ = WINDOW_ICONS.set(WindowIcons(big, small));
}

/// Sets `PKEY_AppUserModel_ID` on this window too, matching the process-wide value.
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
    // The `VT_BSTR` variant matches what the installer writes onto its shortcuts.
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

    // Runs only when debug assertions are on, so it never asserts a false value.
    #[cfg(debug_assertions)]
    #[test]
    fn current_app_user_model_id_matches_this_test_binary() {
        assert_eq!(current_app_user_model_id(), APP_USER_MODEL_ID_DEV);
    }
}
