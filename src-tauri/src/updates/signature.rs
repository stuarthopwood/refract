// Authenticode signature verification for the update installer (lane R11d, follow-up to #794).
// Stuart decided (2026-10-14) to sign releases locally with a self-signed code-signing
// certificate (`scripts/release-local.mjs`) rather than buy a CA-issued one; that certificate is
// trusted only on Stuart's own machine, so a plain `WinVerifyTrust` trust decision is not enough
// by itself -- every OTHER machine's root store rejects it (`CERT_E_UNTRUSTEDROOT`), and a
// stranger's own self-signed cert would otherwise "validly" sign a hostile installer. The real
// check this module makes is: the file carries a structurally valid Authenticode signature AND
// its signer's leaf certificate is byte-for-byte one of the pins below -- `CERT_E_UNTRUSTEDROOT`
// is accepted ONLY alongside a pin match AND no other chain error bit; every other
// `WinVerifyTrust` outcome, any other chain error, and any pin mismatch, fails closed.
//
// `installer.rs` calls this once right after the downloaded installer's SHA-256 checksum
// matches; `install_on_quit.rs` calls it again immediately before the install-on-quit hand-off
// (under a 10s timeout there -- gate finding, PR #837 round 1 perf Medium: `stop_all()`'s own
// quit path is already time-bounded, and this check must never make quitting hang on a stalled
// Win32 call). Neither call replaces the existing checksum check -- the checksum defends against
// a corrupted or substituted download between `gh release download` and disk, this defends
// against a download whose bytes (and checksum) were never Refract's own signed build in the
// first place.

use std::path::Path;

/// SHA-256 pins accepted for the installer's signer leaf certificate -- a slice, not a single
/// value (gate finding, PR #837 round 1, Medium), so a certificate ROTATION can ship one
/// transitional release signed with the OLD certificate while this list already carries BOTH
/// pins: every already-installed client (still only holding the old pin) accepts that one
/// release, and from then on carries the new pin too. Rotating straight to a single new pin
/// would instead strand every existing install -- they would reject the very release meant to
/// carry them across.
///
/// Computed 2026-10-14 against `certs/refract-codesign.cer`'s DER bytes (the whole certificate
/// file, hashed byte-for-byte -- the same digest `Get-FileHash -Algorithm SHA256` or
/// `sha256sum` would report for that file), for the certificate Stuart created in
/// `Cert:\CurrentUser\My`:
/// - SHA-1 thumbprint: `31B95999D331BD33210126432FAB3FF18ECA5DBD`
/// - Subject: `CN=Stuart Hopwood (Refract Code Signing)`
/// - Expires: 2031-10-14
///
/// This pin is an exact byte match against the certificate's own DER, not a chain/expiry
/// decision (gate finding, PR #837 round 1: the previous wording here was wrong) -- a signature
/// timestamped before expiry (`scripts/release-local.mjs`'s own `/tr` flag) stays verifiable by
/// `WinVerifyTrust` after the certificate itself expires, so expiry alone does not invalidate
/// anything already released. Rotation (README.md's own "Releasing" section has the full
/// procedure): add the new certificate's SHA-256 here ALONGSIDE this one, cut one transitional
/// release signed with the OLD certificate, then once every client has picked that release up,
/// drop the old entry and switch new releases to signing with the new certificate.
pub const SIGNING_CERT_SHA256_PINS: &[&str] =
    &["3eb35b51305f032a9678eb5628912f951ec3ed7ccdb59d61503263f069ed8e83"];

/// Surfaced as `UpdateState.last_error` for every rejected signature, regardless of the exact
/// Win32 failure reason (unsigned, tampered, wrong signer, a timed-out check, or a
/// `WinVerifyTrust`/chain-helper call failing outright) -- none of those distinctions are
/// actionable for the renderer's badge UI, and a more specific message would hand an attacker
/// probing the update path a free oracle for which check tripped.
pub const SIGNATURE_REJECTED_MESSAGE: &str =
    "The update installer isn't signed by Refract's certificate.";

/// Verifies `path`'s Authenticode signature and pinned signer certificate (this module's own doc
/// comment above). Runs the blocking Win32 calls on a `spawn_blocking` thread, the same pattern
/// `checksum::hex_digest_file` already uses for its own blocking file I/O. A panic inside that
/// task (an internal bug, never a caller-controlled condition) still fails closed through the
/// same constant message, logging the real detail instead of leaking it into `last_error` (gate
/// finding, PR #837 round 1, Low).
pub async fn verify_installer_signature(path: &Path) -> Result<(), String> {
    let path = path.to_path_buf();
    match tokio::task::spawn_blocking(move || imp::verify(&path)).await {
        Ok(result) => result,
        Err(join_err) => {
            log::error!("signature verification task panicked: {join_err}");
            Err(SIGNATURE_REJECTED_MESSAGE.to_string())
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use sha2::{Digest, Sha256};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CERT_E_UNTRUSTEDROOT, HANDLE, HWND};
    use windows::Win32::Security::Cryptography::{CERT_CONTEXT, CERT_TRUST_IS_UNTRUSTED_ROOT};
    use windows::Win32::Security::WinTrust::{
        WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
        WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
        WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL,
        WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
        WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    };

    use super::{SIGNATURE_REJECTED_MESSAGE, SIGNING_CERT_SHA256_PINS};

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
            // The pin is this check's own trust anchor; neither a CRL/OCSP response nor an
            // AIA-chased issuer cert fetched over the network changes that decision, so both are
            // disabled here -- `WTD_REVOCATION_CHECK_NONE` (a provider flag, distinct from
            // `fdwRevocationChecks` above, which only covers the revocation-check KIND) and
            // `WTD_CACHE_ONLY_URL_RETRIEVAL` together ensure `WinVerifyTrust` never blocks on a
            // network call (gate finding, PR #837 round 1, perf Medium: on an offline or
            // captive-portal network this could otherwise stall for Windows' own ~15s
            // URL-retrieval timeout, possibly more than once, on every download and every quit).
            dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
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
    /// once the chain has no OTHER error bit (gate finding, PR #837 round 1, Medium: a revoked
    /// or otherwise broken chain could previously hide behind the untrusted-root carve-out) and
    /// the signer leaf certificate matches a pin -- every other result (no signature, a bad
    /// digest, an explicitly distrusted or revoked cert, any other chain-building failure) fails
    /// closed without inspecting the chain further.
    fn evaluate(result: i32, state_data: HANDLE) -> Result<(), String> {
        if result != 0 && result != CERT_E_UNTRUSTEDROOT.0 {
            return Err(SIGNATURE_REJECTED_MESSAGE.to_string());
        }

        let signer_chain =
            signer_chain_info(state_data).ok_or_else(|| SIGNATURE_REJECTED_MESSAGE.to_string())?;

        if result == CERT_E_UNTRUSTEDROOT.0
            && (signer_chain.chain_error_status & !CERT_TRUST_IS_UNTRUSTED_ROOT) != 0
        {
            return Err(SIGNATURE_REJECTED_MESSAGE.to_string());
        }

        if SIGNING_CERT_SHA256_PINS
            .iter()
            .any(|pin| signer_chain.leaf_sha256.eq_ignore_ascii_case(pin))
        {
            Ok(())
        } else {
            Err(SIGNATURE_REJECTED_MESSAGE.to_string())
        }
    }

    /// The signer leaf certificate's own SHA-256 (hex) plus its chain's `dwErrorStatus`, read
    /// together since both come off the same `CRYPT_PROVIDER_SGNR` pointer.
    struct SignerChainInfo {
        leaf_sha256: String,
        chain_error_status: u32,
    }

    /// Walks `WTHelperProvDataFromStateData` -> the first (index 0, i.e. the end-entity/leaf,
    /// never a chain ancestor) signer -> that signer's own first certificate, then hashes the
    /// leaf's raw DER encoding (`CERT_CONTEXT::pbCertEncoded`/`cbCertEncoded`) -- the same bytes
    /// `certs/refract-codesign.cer` holds and `SIGNING_CERT_SHA256_PINS` was computed from --
    /// and reads that same signer's `pChainContext`'s `TrustStatus.dwErrorStatus`. Returns `None`
    /// for a null pointer anywhere along the signer/cert chain (an unsigned file, or
    /// `WinVerifyTrust` never having built a usable chain), which `evaluate` turns into the same
    /// rejection message as every other failure. A null `pChainContext` specifically (a signer
    /// was found, but no chain was built for it) reads as `u32::MAX` -- every error bit set --
    /// rather than 0, since `evaluate` only ever consults this field on the
    /// `CERT_E_UNTRUSTEDROOT` path, a result that implies a chain WAS built; a missing chain
    /// there is itself the anomaly, so it must fail the "no other error bit" check, not pass it
    /// by default.
    fn signer_chain_info(state_data: HANDLE) -> Option<SignerChainInfo> {
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
            let leaf_sha256 = Sha256::digest(der)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();

            let chain_context = (*signer).pChainContext;
            let chain_error_status = if chain_context.is_null() {
                u32::MAX
            } else {
                (*chain_context).TrustStatus.dwErrorStatus
            };

            Some(SignerChainInfo {
                leaf_sha256,
                chain_error_status,
            })
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
