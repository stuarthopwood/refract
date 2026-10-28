# Plan 031

`MessageInput.tsx` tracks whether the Stop button has focus (`onFocus`/`onBlur` into a ref; Chromium fires no blur when a focused element unmounts, so the ref still reads true at unmount). An effect keyed on `isWorking` focuses `textareaRef` when `isWorking` becomes false, the ref is true, and `document.activeElement` is `body` or null, then clears the ref. No new files. `MessageInput.tsx` is under its baseline cap (1567 of 1632), so no baseline change.

Analyze: consistent with spec 030 FR-005 (focus already moves on Stop). No shared component change needed; Stop uses the existing `Button`.
