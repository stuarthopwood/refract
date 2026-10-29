// `ApprovalMode` extracted out of `settings.rs` (#496, #806 file-size ratchet: settings.rs sits
// near the 600-line soft cap). Re-exported from `settings.rs` so every caller keeps importing it
// from `crate::store::settings::ApprovalMode`, unchanged.

use serde::{Deserialize, Serialize};

/// `src/shared/model.ts`'s `ApprovalMode`. `AskAndRemember` (#496) is OMP's
/// `--approval-mode always-ask-cached`; `Ask` stays the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Ask,
    AskAndRemember,
    EditFreely,
    Auto,
}
