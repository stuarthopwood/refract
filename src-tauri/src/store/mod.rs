// Rust port of `src/main/store/` (`atomic_json.rs`: `atomicJson.ts`'s write-tmp-fsync-rename and
// corrupt-file quarantine pattern; `registry.rs`: `registry.ts`; `settings.rs`: `settings.ts`).
// Not yet implemented -- scaffold placeholder for a later milestone-1 slice (plan.md Project
// Structure). `ipc::read_settings`/`ipc::read_bootstrap_theme` carry a minimal, non-validating
// read of `settings.json` in the meantime, just enough to boot the renderer themed (FR-010,
// FR-011) -- they are deliberately NOT routed through this module, so the real port below can
// replace them outright rather than needing to stay compatible with a placeholder shape.
