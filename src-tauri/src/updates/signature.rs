// Authenticode check for the update installer: a valid signature plus a pinned signer leaf cert.
// Self-signed release certs fail Windows trust elsewhere, so the pin is the real trust anchor (#794).

use std::path::Path;

/// Accepted SHA-256 pins of the signer leaf cert. A list so a rotation can ship one transitional
/// release that old and new clients both accept. Each pin is an exact DER byte match (#837).
pub const SIGNING_CERT_SHA256_PINS: &[&str] =
    &["3eb35b51305f032a9678eb5628912f951ec3ed7ccdb59d61503263f069ed8e83"];

/// The one message for every rejection, so probing the update path reveals which check failed.
pub const SIGNATURE_REJECTED_MESSAGE: &str =
    "The update installer isn't signed by Refract's certificate.";

/// Verifies `path`'s signature and signer pin. Runs the blocking Win32 calls off the async
/// runtime; a panic in that task fails closed with the same message.
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
            // Never block on CRL/OCSP or AIA network fetches; the pin is the trust anchor (#837).
            dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
            dwUIContext: Default::default(),
            pSignatureSettings: std::ptr::null_mut(),
        };

        // Safety: all pointed-to locals outlive this call. VERIFY writes `hWVTStateData`, closed below.
        let mut action_id = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let result = unsafe {
            WinVerifyTrust(
                HWND::default(),
                &mut action_id,
                &mut trust_data as *mut WINTRUST_DATA as *mut core::ffi::c_void,
            )
        };

        let outcome = evaluate(result, trust_data.hWVTStateData);

        // Close the state handle on success and failure paths alike.
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

    /// Accepts `0`, or `CERT_E_UNTRUSTEDROOT` with no other chain error bit, and only with a pin
    /// match. Everything else fails closed.
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

    /// Leaf certificate SHA-256 (hex) and its chain's error status.
    struct SignerChainInfo {
        leaf_sha256: String,
        chain_error_status: u32,
    }

    /// Hashes the leaf cert's DER bytes. A missing chain reads as all error bits (`u32::MAX`), so it fails closed.
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
