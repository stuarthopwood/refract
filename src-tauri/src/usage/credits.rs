// Spec 060 (S1-04): AI credits per call, the definition `session/ai_credits.rs` (#1238) uses:
// 1 credit = $0.01, so `cost.total` x 100, and only for GitHub Copilot. Every other provider
// shows list-price USD only.

pub const COPILOT_PROVIDER: &str = "github-copilot";

pub fn credits_for(provider: &str, cost_total: f64) -> Option<f64> {
    (provider == COPILOT_PROVIDER && cost_total.is_finite()).then_some(cost_total * 100.0)
}
