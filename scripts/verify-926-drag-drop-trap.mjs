// Helper for scripts/verify-926-attach-any-file.mjs (#806 "no god files": kept the main script
// under its own 600-line cap by extracting this self-contained piece into a sibling module,
// the same pattern verify-947-938-helpers.mjs already uses for its own script).
//
// Native OS drag-drop capture (Test2 HIGH 5c, genuinely attempted): injected via
// `Page.addScriptToEvaluateOnNewDocument` (fires at the start of every new document, BEFORE
// any bundled script), then a reload makes it apply to this run. Traps `entry.ts`'s own
// plain `window.refract = refract` assignment and wraps `attachments.onFileDrop` -- the
// function `useTauriFileDrop.ts`'s single-flight `ensureSubscribed()` calls exactly once
// with the REAL registered callback -- capturing that callback on `window.__capturedFileDropHandler`
// for direct invocation later. Bypasses only wry's own native-event production (CDP cannot
// synthesize an OS-level drag-drop), never any of this app's own code.
export async function injectDragDropCaptureTrap(cdp) {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function () {
      let realRefract;
      window.__capturedFileDropHandler = null;
      Object.defineProperty(window, 'refract', {
        configurable: true,
        enumerable: true,
        get() { return realRefract; },
        set(value) {
          if (value && value.attachments && typeof value.attachments.onFileDrop === 'function') {
            const original = value.attachments.onFileDrop;
            value.attachments.onFileDrop = function (handler) {
              window.__capturedFileDropHandler = handler;
              return original(handler);
            };
          }
          realRefract = value;
        }
      });
    })();`
  });
  await cdp.send('Page.reload', {});
  // Gate round 3 (Test3 Medium): waits for the TRAP MARKER itself, not `document.readyState`
  // -- `readyState === 'complete'` only proves the page finished loading, never that the
  // injected script ran at all. This wait proves only that MUCH: `window.__capturedFileDropHandler`
  // exists as a property (set to `null` at the very top of the injected IIFE, before the
  // `Object.defineProperty` trap is even installed). The SEPARATE `typeof ... === 'function'`
  // check the caller makes later (once the composer mounts) is what actually proves the
  // injection-ORDERING bug this trap depends on never happened -- that the trap's
  // `Object.defineProperty` ran, and was still in place, BEFORE `entry.ts`'s own
  // `window.refract = refract` assignment, so the real `onFileDrop` callback was captured
  // rather than lost to a stale `realRefract` closure.
  await cdp.waitFor(`'__capturedFileDropHandler' in window`, { timeoutMs: 30_000, label: 'page reloaded with the drag-drop capture trap active' });
}
