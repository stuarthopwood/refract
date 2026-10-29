// Rust port of `src/main/store/` (`atomic_json.rs`: `atomicJson.ts`'s write-tmp-fsync-rename and
// corrupt-file quarantine pattern; `registry.rs`: `registry.ts`; `settings.rs`: `settings.ts`),
// tasks.md T013 to T015. Replaces the Phase 1 scaffold's minimal, non-validating
// `ipc::read_settings`/`ipc::read_bootstrap_theme` outright (`ipc::mod`'s own real,
// store-backed `settings_get`/theme bootstrap now go through `SettingsStore` directly).

pub mod approval_mode;
pub mod atomic_json;
pub mod chat_width;
pub mod holiday_touches;
pub mod import;
pub mod profile_cache;
pub mod registry;
pub mod settings;
pub mod theme_id;
