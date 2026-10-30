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
