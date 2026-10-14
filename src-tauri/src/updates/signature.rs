// Authenticode signature verification for the update installer (lane R11d, follow-up to #794).
// Stuart decided (2026-10-14) to sign releases locally with a self-signed code-signing
// certificate (`scripts/release-local.mjs`) rather than buy a CA-issued one; that certificate is
// trusted only on Stuart's own machine, so a plain `WinVerifyTrust` trust decision is not enough
// by itself -- every OTHER machine's root store rejects it (`CERT_E_UNTRUSTEDROOT`), and a
// stranger's own self-signed cert would otherwise "validly" sign a hostile installer. The real
// check this module makes is: the file carries a structurally valid Authenticode signature AND
// its signer's leaf certificate is byte-for-byte the one pinned below -- `CERT_E_UNTRUSTEDROOT`
// is accepted ONLY alongside that pin match; every other `WinVerifyTrust` outcome, and any pin
// mismatch, fails closed.
//
// `installer.rs` calls this once right after the downloaded installer's SHA-256 checksum
// matches; `install_on_quit.rs` calls it again immediately before the install-on-quit hand-off.
// Neither call replaces the existing checksum check -- the checksum defends against a corrupted
// or substituted download between `gh release download` and disk, this defends against a
// download whose bytes (and checksum) were never Refract's own signed build in the first place.

use std::path::Path;

/// SHA-256 of `certs/refract-codesign.cer`'s DER bytes (the whole certificate file, hashed
/// byte-for-byte -- the same digest `Get-FileHash -Algorithm SHA256` or `sha256sum` would report
/// for that file). Computed 2026-10-14 against the certificate Stuart created in
/// `Cert:\CurrentUser\My`:
/// - SHA-1 thumbprint: `31B95999D331BD33210126432FAB3FF18ECA5DBD`
/// - Subject: `CN=Stuart Hopwood (Refract Code Signing)`
/// - Expires: 2031-10-14
///
/// Rotate this constant (and `certs/refract-codesign.cer`) together with a new certificate
/// before the expiry above; an installer signed with an expired or replaced certificate will no
/// longer match this pin and every update will fail closed with `SIGNATURE_REJECTED_MESSAGE`.
pub const SIGNING_CERT_SHA256: &str =
    "3eb35b51305f032a9678eb5628912f951ec3ed7ccdb59d61503263f069ed8e83";

/// Surfaced as `UpdateState.last_error` for every rejected signature, regardless of the exact
/// Win32 failure reason (unsigned, tampered, wrong signer, or a `WinVerifyTrust`/chain-helper
/// call failing outright) -- none of those distinctions are actionable for the renderer's badge
/// UI, and a more specific message would hand an attacker probing the update path a free oracle
/// for which check tripped.
pub const SIGNATURE_REJECTED_MESSAGE: &str =
    "The update installer isn't signed by Refract's certificate.";

/// Verifies `path`'s Authenticode signature and pinned signer certificate (this module's own doc
/// comment above). Runs the blocking Win32 calls on a `spawn_blocking` thread, the same pattern
/// `checksum::hex_digest_file` already uses for its own blocking file I/O.
pub async fn verify_installer_signature(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || imp::verify(&path))
        .await
        .map_err(|err| format!("signature verification task panicked: {err}"))?
}

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use sha2::{Digest, Sha256};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CERT_E_UNTRUSTEDROOT, HANDLE, HWND};
    use windows::Win32::Security::Cryptography::CERT_CONTEXT;
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
        WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
        WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
        WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    use super::{SIGNATURE_REJECTED_MESSAGE, SIGNING_CERT_SHA256};

    pub fn verify(path: &Path) -> Result<(), String> {
        let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide_path.push(0);

        let mut file_info = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: PCWSTR(wide_path.as_ptr()),
            hFile: HANDLE::default(),
            pgKnownSubject: std::ptr::null_mut(),
        };

        let mut trust_data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            pPolicyCallbackData: std::ptr::null_mut(),
            pSIPClientData: std::ptr::null_mut(),
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 {
                pFile: &mut file_info,
            },
            dwStateAction: WTD_STATEACTION_VERIFY,
            hWVTStateData: HANDLE::default(),
            pwszURLReference: PWSTR::null(),
            dwProvFlags: Default::default(),
            dwUIContext: Default::default(),
            pSignatureSettings: std::ptr::null_mut(),
        };

        // Safety: `action_id` and `trust_data` are both local, correctly-sized stack values that
        // outlive this call; `pcwszFilePath` points at `wide_path`, which also outlives it.
        // `dwStateAction: WTD_STATEACTION_VERIFY` tells `WinVerifyTrust` to write a state handle
        // back into `trust_data.hWVTStateData`, read below before it is released.
        let mut action_id = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let result = unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action_id,
                &mut trust_data as *mut WINTRUST_DATA as *mut core::ffi::c_void,
            )
        };

        let outcome = evaluate(result, trust_data.hWVTStateData);

        // Always releases the state `WinVerifyTrust` allocated above, regardless of `outcome` --
        // a leaked `hWVTStateData` handle is a resource leak on every single call, not just the
        // failure paths.
        trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
        unsafe {
            let _ = WinVerifyTrust(
                HWND::default(),
                &mut action_id,
                &mut trust_data as *mut WINTRUST_DATA as *mut core::ffi::c_void,
            );
        }

        outcome
    }

    /// `result` is `WinVerifyTrust`'s raw return value: `0` (`ERROR_SUCCESS`) means a fully
    /// trusted chain; `CERT_E_UNTRUSTEDROOT.0` is the one other value ever accepted, and only
    /// once the signer leaf certificate below is confirmed to match the pin -- every other
    /// result (no signature, a bad digest, an explicitly distrusted or revoked cert, any other
    /// chain-building failure) fails closed without inspecting the chain further.
    fn evaluate(result: i32, state_data: HANDLE) -> Result<(), String> {
        if result != 0 && result != CERT_E_UNTRUSTEDROOT.0 {
            return Err(SIGNATURE_REJECTED_MESSAGE.to_string());
        }

        let leaf_sha256 =
            leaf_cert_sha256(state_data).ok_or_else(|| SIGNATURE_REJECTED_MESSAGE.to_string())?;

        if leaf_sha256.eq_ignore_ascii_case(SIGNING_CERT_SHA256) {
            Ok(())
        } else {
            Err(SIGNATURE_REJECTED_MESSAGE.to_string())
        }
    }

    /// Walks `WTHelperProvDataFromStateData` -> the first (index 0, i.e. the end-entity/leaf,
    /// never a chain ancestor) signer -> that signer's own first certificate, then hashes the
    /// leaf's raw DER encoding (`CERT_CONTEXT::pbCertEncoded`/`cbCertEncoded`) -- the same bytes
    /// `certs/refract-codesign.cer` holds and `SIGNING_CERT_SHA256` was computed from. Returns
    /// `None` for a null pointer anywhere along that chain (an unsigned file, or `WinVerifyTrust`
    /// never having built a usable chain), which `evaluate` turns into the same rejection
    /// message as every other failure.
    fn leaf_cert_sha256(state_data: HANDLE) -> Option<String> {
        unsafe {
            let prov_data = WTHelperProvDataFromStateData(state_data);
            if prov_data.is_null() {
                return None;
            }
            let signer = WTHelperGetProvSignerFromChain(prov_data, 0, false, 0);
            if signer.is_null() {
                return None;
            }
            let cert = WTHelperGetProvCertFromChain(signer, 0);
            if cert.is_null() {
                return None;
            }
            let cert_context: *const CERT_CONTEXT = (*cert).pCert;
            if cert_context.is_null() {
                return None;
            }
            let der = std::slice::from_raw_parts(
                (*cert_context).pbCertEncoded,
                (*cert_context).cbCertEncoded as usize,
            );
            let digest = Sha256::digest(der);
            Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use std::path::Path;

    pub fn verify(_path: &Path) -> Result<(), String> {
        Err("Authenticode signature verification is Windows-only".to_string())
    }
}
