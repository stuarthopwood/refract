// Spec 060 header.

pub const COPILOT_PROVIDER: &str = "github-copilot";

pub fn credits_for(provider: &str, cost_total: f64) -> Option<f64> {
    (provider == COPILOT_PROVIDER && cost_total.is_finite()).then_some(cost_total * 100.0)
}
