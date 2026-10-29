# Tasks: Chat navigation (wave 4)

Spec: `spec.md`. Plan: `plan.md`. No new tests (prototyping phase). Commit and push after every task. Every worker reports changed files. Safe deletion: literal absolute paths only, nothing deleted inside the repo except named scratch files. No cargo or tauri command until the director grants the build slot.

## WP-A Foundation (#750)
- [x] T1 Probe row ids vs navigable messages (user, `assistant-text`, grouped Note rows); record in `probe-notes.md`.
- [x] T2 Pure `messageIndex` builder and per-session nav store with the scroller bridge.
- [x] T3 `Transcript.tsx` registers the bridge; `jumpToMessage` reveals windowed turns, lands, detaches autoscroll, highlights, announces once.

## WP-B Previous/Next (#751)
- [x] T4 Step target rule, `MessageStepButtons`, floating layer, scroll-reveal and focus-reveal, 2 s fade, reduced motion.
- [x] T5 Alt+Up/Alt+Down in transcript and composer; Scroll to end uses `ArrowDownToLineIcon`.

## WP-C Outline (#752)
- [ ] T6 `outline` panel id, registry entry, active-pane Session follow.
- [ ] T7 Outline list model, windowed list, roving tabindex, current marker, collapse and Collapse all / Expand all, empty state.

## WP-D Search (#753)
- [ ] T8 Probe the Custom Highlight API on WebView2; matcher (chunked, cancellable, 500 cap, case toggle).
- [ ] T9 `FindBar`, results list, highlight painter, Ctrl+F scoped to chat panes, header ghost icon, per-pane state.

## WP-E Map (#754)
- [ ] T10 Canvas `ScrollbarMap`: offsets, merge, hit-test, window, drag, tooltip, stub.
- [ ] T11 Settings toggle "Show scrollbar map" (Chat group, default on).

## WP-F Contrast and docs
- [ ] T12 Contrast pairs and tokens; `components.md`; `docs/PLAN.md` row; `check:ui-text` and `check:theme-contrast` pass.
