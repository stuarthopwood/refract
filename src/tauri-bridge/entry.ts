// Tauri/Rust build's renderer entry point (plan.md Project Structure). Assigns `window.refract`
// BEFORE the renderer's own entry module ever runs, so `main.tsx`'s very first line --
// `window.refract.themeBootstrap()` -- always sees it defined, the same ordering guarantee
// Electron's preload script gives for free by running in a separate, earlier-loading context.
//
// Exception to static-import-only: ES module imports are hoisted and fully evaluated (including
// every top-level statement in the imported module) before ANY of this file's OWN top-level
// code runs, regardless of where the `import` statement is textually written -- a static
// `import '../renderer/main'` would run `main.tsx`'s `themeBootstrap()` call before the
// `window.refract = refract` assignment below ever executes, defeating the one thing this file
// exists to guarantee. The dynamic `import()` below is the only way to defer evaluation of
// `main.tsx` until after that assignment has actually run.
import { refract } from './index'
import { installExternalLinkHandler } from './externalLinks'

window.refract = refract
// Issue #793 security baseline: external-link policy (only http/https through the opener
// plugin), wired before the renderer mounts so the very first rendered `<a target="_blank">`
// is already covered.
installExternalLinkHandler()

await import('../renderer/main')
