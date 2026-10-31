# Plan: spec 102

Renderer-only change. `pull-requests-store.ts` owns the badge count (`partial`, `sharesActiveCountSearch`, in-flight dedupe). `ViewsNavGroup.tsx` renders the label. `PullRequestList.tsx` and the shared `ProjectListPane.tsx` own the cap note and focus handling. `issues-store.ts` and `IssuesView.tsx` own the create flow. Live check: `scripts/verify-tauri-102.mjs` with the spec 093 fake `gh`.
