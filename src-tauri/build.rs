// Embeds a Common Controls v6 manifest into EVERY binary this crate links -- the real app exe,
// AND `cargo test`'s own separately-linked harness exe -- via explicit linker arguments, rather
// than relying solely on `tauri_build`'s own `WindowsAttributes::app_manifest` resource
// embedding (which only reaches the app's own `bin` target, not the test harness).
//
// Root cause (Main's diagnosis, 2026-10-14): any Tauri dialog API (`tauri-plugin-dialog`/`rfd`,
// reachable once this crate's dependency graph links them in) imports `TaskDialogIndirect` from
// Common Controls v6. Without a manifest declaring that dependency, Windows resolves the import
// against Common Controls v5 instead and the import fails at PROCESS LOAD time with
// `STATUS_ENTRYPOINT_NOT_FOUND` -- for `cargo test` this means every test binary fails before a
// single test runs, with no compiler/linker error at all (`cargo check`/`cargo clippy` never
// link a runnable binary, so they never see it).
//
// `windows-app-manifest.xml` (checked in, next to this file) is the exact content
// `tauri-build`'s own default `WindowsAttributes::new()` would otherwise embed only into the app
// binary (verified against `tauri-build 2.7.2`'s own `src/windows-app-manifest.xml`: the Common
// Controls v6 dependency, no other content). `new_without_app_manifest()` below disables that
// automatic resource-based embedding so this file's own linker-arg embedding is the only
// manifest resource ever linked in -- never two conflicting `RT_MANIFEST` resources.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");

    // `CARGO_MANIFEST_DIR` is this crate's own directory (where this file and the manifest XML
    // both live), so `/MANIFESTINPUT` gets a real absolute path regardless of the invocation's
    // working directory. `/MANIFEST:EMBED`/`/MANIFESTINPUT` are MSVC `link.exe`-specific flags
    // (gate round 2): guarded so a GNU-toolchain build (`*-pc-windows-gnu`, never produced by
    // this crate's own CI today but not impossible) never passes them to `ld`/`gcc`, which
    // would reject them outright rather than silently ignore them.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={manifest_path}");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest_path}");
    }
}
