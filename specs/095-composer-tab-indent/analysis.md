# Analysis (spec 095)

- Every FR maps to a task (FR-1/3/6/7 to T1, FR-4/5 to T2 and T4, FR-2 to T3); the live check in T5 covers the five behaviours named in the story.
- Risk: Ctrl+M reserved by WebView2. Mitigation: T5 proves it live.
- Risk: `MessageInput.tsx` growth. Mitigation: logic lives in new files; T3 only adds call sites, and `check:file-size` guards it.
- No overlap with lane AE's files (ChatHeader, panel-registry, readout, shared/model, theme-contrast-pairs).
